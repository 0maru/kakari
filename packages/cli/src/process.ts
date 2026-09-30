import { spawn } from 'node:child_process';

export interface RunOptions {
  cwd?: string | undefined;
  /** 子プロセスの環境。親の環境は継承しない（5.4・5.5）。 */
  env: Record<string, string | undefined>;
  input?: string | Buffer | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  /** 標準出力の上限（バイト）。超えたら打ち切って失敗扱いにする */
  maxOutputBytes?: number | undefined;
  /** 標準出力をファイル等へ流す場合に使う */
  onStdout?: ((chunk: Buffer) => void) | undefined;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  outputLimitExceeded: boolean;
  pid: number | undefined;
}

export class SpawnError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'SpawnError';
    this.code = code;
  }
}

/** 最低限の実行環境だけを持つ環境変数を作る。資格情報は明示的に追加する。 */
export function baseEnv(parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ'];
  const env: Record<string, string> = {};
  for (const key of keep) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  // プロキシ・独自CAは通信に必要なので引き継ぐ（資格情報ではない）
  for (const key of [
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'https_proxy',
    'http_proxy',
    'no_proxy',
    'SSL_CERT_FILE',
    'NODE_EXTRA_CA_CERTS',
  ]) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * 引数配列で子プロセスを起動する。シェルは使わない（8.2）。
 */
export function runProcess(file: string, args: readonly string[], options: RunOptions) {
  return new Promise<RunResult>((resolvePromise, reject) => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(options.env)) {
      if (v !== undefined) env[k] = v;
    }
    const child = spawn(file, args, {
      cwd: options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: false,
    });
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let outputLimitExceeded = false;
    const maxOut = options.maxOutputBytes ?? 64 * 1024 * 1024;

    const kill = () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 5000).unref();
      }
    };

    const timer =
      options.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            kill();
          }, options.timeoutMs)
        : undefined;
    timer?.unref();

    const onAbort = () => {
      aborted = true;
      kill();
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOut) {
        if (!outputLimitExceeded) {
          outputLimitExceeded = true;
          kill();
        }
        return;
      }
      if (options.onStdout) options.onStdout(chunk);
      else stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8');
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(new SpawnError(`${file} を起動できません: ${error.message}`, error.code));
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolvePromise({
        code,
        signal,
        stdout: Buffer.concat(stdoutChunks),
        stderr,
        timedOut,
        aborted,
        outputLimitExceeded,
        pid: child.pid,
      });
    });
    child.stdin.on('error', () => {
      // 子プロセスが入力を読まずに終了した場合
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

/** PATH から実行ファイルの絶対パスを探す */
export async function which(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const { access, constants } = await import('node:fs/promises');
  const { delimiter, join } = await import('node:path');
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 次の候補
    }
  }
  return null;
}
