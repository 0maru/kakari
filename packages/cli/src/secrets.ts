import { readFile, stat } from 'node:fs/promises';
import type { LocalConfig } from './config/schema.ts';
import { CliError } from './errors.ts';
import { baseEnv, runProcess, which } from './process.ts';

export type BinaryName = 'gh' | 'git' | 'claude' | 'op' | 'terminal_notifier' | 'security';

const BINARY_FILES: Record<BinaryName, string> = {
  gh: 'gh',
  git: 'git',
  claude: 'claude',
  op: 'op',
  terminal_notifier: 'terminal-notifier',
  security: 'security',
};

/** 信頼した実行ファイルの絶対パスを解決する（8.2）。local.yaml の指定を優先する。 */
export class Binaries {
  private readonly cache = new Map<BinaryName, string | null>();

  private readonly local: LocalConfig;
  private readonly env: NodeJS.ProcessEnv;

  constructor(local: LocalConfig, env: NodeJS.ProcessEnv = process.env) {
    this.local = local;
    this.env = env;
  }

  async find(name: BinaryName): Promise<string | null> {
    if (this.cache.has(name)) return this.cache.get(name) ?? null;
    const configured =
      name === 'security' ? undefined : this.local.binaries[name as keyof LocalConfig['binaries']];
    const path = configured ?? (await which(BINARY_FILES[name], this.env));
    this.cache.set(name, path);
    return path;
  }

  async require(name: BinaryName): Promise<string> {
    const path = await this.find(name);
    if (!path) {
      throw new CliError(
        'config',
        `${BINARY_FILES[name]} が見つかりません。インストールするか local.yaml の binaries.${name} に絶対パスを指定してください`,
      );
    }
    return path;
  }
}

interface CacheEntry {
  value: string;
  expiresAt: number;
}

/**
 * `*_ref` を端末側の設定（local.yaml の secrets）から解決する。
 * 解決した値はメモリ上にだけ保持し、ログやDBへ書き出さない。
 */
export class SecretResolver {
  private readonly cache = new Map<string, CacheEntry>();

  private readonly local: LocalConfig;
  private readonly binaries: Binaries;
  private readonly env: NodeJS.ProcessEnv;
  private readonly ttlMs;

  constructor(
    local: LocalConfig,
    binaries: Binaries,
    env: NodeJS.ProcessEnv = process.env,
    ttlMs = 10 * 60 * 1000,
  ) {
    this.local = local;
    this.binaries = binaries;
    this.env = env;
    this.ttlMs = ttlMs;
  }

  sourceOf(ref: string): string {
    const source = this.local.secrets[ref];
    if (!source) {
      throw new CliError(
        'config',
        `資格情報の参照 ${ref} が local.yaml の secrets に定義されていません`,
      );
    }
    return source;
  }

  async resolveRef(ref: string, options: { host?: string } = {}): Promise<string> {
    return this.resolveSource(this.sourceOf(ref), options);
  }

  async resolveSource(source: string, options: { host?: string } = {}): Promise<string> {
    const cacheKey = `${source}|${options.host ?? ''}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = await this.read(source, options);
    if (!value) throw new CliError('auth', `資格情報が空です (${describeSource(source)})`);
    this.cache.set(cacheKey, { value, expiresAt: Date.now() + this.ttlMs });
    return value;
  }

  invalidate(): void {
    this.cache.clear();
  }

  private async read(source: string, options: { host?: string }): Promise<string> {
    if (source.startsWith('value:')) return source.slice('value:'.length);
    if (source.startsWith('env:')) {
      const name = source.slice('env:'.length);
      const value = this.env[name];
      if (!value) throw new CliError('auth', `環境変数 ${name} が設定されていません`);
      return value;
    }
    if (source.startsWith('file:')) {
      const path = source.slice('file:'.length);
      const info = await stat(path).catch(() => null);
      if (!info) throw new CliError('auth', `資格情報ファイルがありません: ${path}`);
      if ((info.mode & 0o077) !== 0) {
        throw new CliError(
          'auth',
          `資格情報ファイルの権限が広すぎます（0600にしてください）: ${path}`,
        );
      }
      return (await readFile(path, 'utf8')).trim();
    }
    if (source.startsWith('op://')) {
      const op = await this.binaries.require('op');
      const env = baseEnv(this.env);
      for (const [k, v] of Object.entries(this.env)) {
        if (k.startsWith('OP_') && v !== undefined) env[k] = v;
      }
      const res = await runProcess(op, ['read', '--no-newline', source], {
        env,
        timeoutMs: 60_000,
      });
      if (res.code !== 0) {
        throw new CliError(
          'auth',
          `1Password から読み取れません: ${res.stderr.trim().slice(0, 200)}`,
        );
      }
      return res.stdout.toString('utf8');
    }
    if (source.startsWith('keychain:')) {
      const rest = source.slice('keychain:'.length);
      const slash = rest.indexOf('/');
      const service = rest.slice(0, slash);
      const account = rest.slice(slash + 1);
      const security = await this.binaries.require('security');
      const res = await runProcess(
        security,
        ['find-generic-password', '-s', service, '-a', account, '-w'],
        { env: baseEnv(this.env), timeoutMs: 30_000 },
      );
      if (res.code !== 0) {
        throw new CliError('auth', `キーチェーンから読み取れません: ${service}/${account}`);
      }
      return res.stdout.toString('utf8').replace(/\n$/, '');
    }
    if (source.startsWith('gh-account:')) {
      const login = source.slice('gh-account:'.length);
      const host = options.host ?? 'github.com';
      return ghAccountToken(await this.binaries.require('gh'), host, login, this.env);
    }
    throw new CliError('config', `未対応の資格情報の参照先です: ${describeSource(source)}`);
  }
}

/**
 * gh に登録済みの特定アカウントのトークンを取得する（5.5）。
 * アクティブアカウントを切り替えず、親プロセスの GH_TOKEN 等も渡さない。
 */
export async function ghAccountToken(
  gh: string,
  host: string,
  login: string,
  parentEnv: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const env = baseEnv(parentEnv);
  if (parentEnv.GH_CONFIG_DIR) env.GH_CONFIG_DIR = parentEnv.GH_CONFIG_DIR;
  const res = await runProcess(gh, ['auth', 'token', '--hostname', host, '--user', login], {
    env,
    timeoutMs: 30_000,
  });
  const token = res.stdout.toString('utf8').trim();
  if (res.code !== 0 || !token) {
    throw new CliError(
      'auth',
      `gh にアカウント ${login}@${host} の認証がありません。\`gh auth login --hostname ${host}\` を実行してください`,
    );
  }
  return token;
}

/** ログ・エラー表示用に参照先の種類だけを返す */
export function describeSource(source: string): string {
  const scheme = source.split(':')[0];
  if (scheme === 'value') return 'value:(inline)';
  if (scheme === 'op') return 'op://…';
  return `${scheme}:${source.slice(scheme ? scheme.length + 1 : 0).replace(/./g, (c, i) => (i < 24 ? c : ''))}`;
}
