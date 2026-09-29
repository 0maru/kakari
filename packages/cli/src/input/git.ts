import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { baseEnv, runProcess } from '../process.ts';

export interface GitEnvOptions {
  /** HTTPS取得に使うトークン。環境変数経由でだけ渡し、設定やURLに保存しない（5.5） */
  token?: string | undefined;
  host?: string | undefined;
  parentEnv?: NodeJS.ProcessEnv | undefined;
}

/**
 * 外部diff・textconv・hook・LFS・利用者のグローバル設定を無効にしたgitの環境（7.3）
 */
export function gitEnv(options: GitEnvOptions = {}): Record<string, string> {
  const parent = options.parentEnv ?? process.env;
  const env: Record<string, string> = {
    ...baseEnv(parent),
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_ASKPASS: '/usr/bin/false',
    SSH_ASKPASS: '/usr/bin/false',
  };
  if (parent.GIT_SSL_CAINFO) env.GIT_SSL_CAINFO = parent.GIT_SSL_CAINFO;
  const config: [string, string][] = [
    ['core.hooksPath', '/dev/null'],
    ['core.fsmonitor', 'false'],
    ['credential.helper', ''],
    ['fetch.recurseSubmodules', 'false'],
    ['submodule.recurse', 'false'],
    ['diff.external', ''],
    ['core.attributesFile', '/dev/null'],
    ['advice.detachedHead', 'false'],
  ];
  if (options.token) {
    const host = options.host ?? 'github.com';
    const basic = Buffer.from(`x-access-token:${options.token}`, 'utf8').toString('base64');
    config.push([`http.https://${host}/.extraheader`, `AUTHORIZATION: basic ${basic}`]);
  }
  env.GIT_CONFIG_COUNT = String(config.length);
  config.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return env;
}

export class GitError extends Error {
  readonly stderr: string;

  constructor(message: string, stderr: string) {
    super(message);
    this.stderr = stderr;
    this.name = 'GitError';
  }
}

export class Git {
  readonly gitPath: string;
  readonly gitDir: string;
  private readonly env: Record<string, string>;

  constructor(gitPath: string, gitDir: string, env: Record<string, string>) {
    this.gitPath = gitPath;
    this.gitDir = gitDir;
    this.env = env;
  }

  async run(args: string[], options: { timeoutMs?: number; maxOutputBytes?: number } = {}) {
    const res = await runProcess(this.gitPath, ['--git-dir', this.gitDir, ...args], {
      env: this.env,
      timeoutMs: options.timeoutMs ?? 10 * 60_000,
      maxOutputBytes: options.maxOutputBytes,
    });
    if (res.code !== 0) {
      throw new GitError(
        `git ${args[0]} failed (exit ${res.code}${res.timedOut ? ', timeout' : ''})`,
        res.stderr.slice(0, 2000),
      );
    }
    return res.stdout;
  }

  async text(args: string[], options: { timeoutMs?: number; maxOutputBytes?: number } = {}) {
    return (await this.run(args, options)).toString('utf8');
  }

  async tryRun(args: string[]): Promise<boolean> {
    const res = await runProcess(this.gitPath, ['--git-dir', this.gitDir, ...args], {
      env: this.env,
      timeoutMs: 60_000,
    });
    return res.code === 0;
  }

  batch(): GitBatchReader {
    return new GitBatchReader(this.gitPath, this.gitDir, this.env);
  }
}

/** `git cat-file --batch` で blob を順に読む */
export class GitBatchReader {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private waiters: (() => void)[] = [];
  private ended = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(gitPath: string, gitDir: string, env: Record<string, string>) {
    this.child = spawn(gitPath, ['--git-dir', gitDir, 'cat-file', '--batch'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.wake();
    });
    this.child.stdout.on('end', () => {
      this.ended = true;
      this.wake();
    });
    this.child.stderr.resume();
    this.child.on('error', () => {
      this.ended = true;
      this.wake();
    });
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn();
  }

  private async need(predicate: () => boolean): Promise<void> {
    while (!predicate()) {
      if (this.ended) throw new GitError('git cat-file --batch が終了しました', '');
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }

  read(sha: string): Promise<{ type: string; content: Buffer } | null> {
    const next = this.queue.then(async () => {
      this.child.stdin.write(`${sha}\n`);
      await this.need(() => this.buffer.indexOf(0x0a) !== -1);
      const nl = this.buffer.indexOf(0x0a);
      const header = this.buffer.subarray(0, nl).toString('utf8');
      this.buffer = this.buffer.subarray(nl + 1);
      if (header.endsWith(' missing')) return null;
      const [, type, sizeStr] = header.split(' ');
      const size = Number(sizeStr);
      await this.need(() => this.buffer.length >= size + 1);
      const content = Buffer.from(this.buffer.subarray(0, size));
      this.buffer = this.buffer.subarray(size + 1);
      return { type: type ?? '', content };
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill('SIGTERM');
  }
}
