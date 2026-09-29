import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse } from 'yaml';
import type { z } from 'zod';
import { CliError } from '../errors.ts';
import {
  configSchema,
  type KakariConfig,
  type LocalConfig,
  localSchema,
  type ProfileConfig,
} from './schema.ts';

export interface LoadedConfig {
  config: KakariConfig;
  local: LocalConfig;
  configPath: string;
  localPath: string | null;
  configDir: string;
  stateDir: string;
}

export interface ConfigPathOptions {
  config?: string | undefined;
  local?: string | undefined;
}

export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.KAKARI_CONFIG_DIR) return resolve(env.KAKARI_CONFIG_DIR);
  const base = env.XDG_CONFIG_HOME ? resolve(env.XDG_CONFIG_HOME) : join(homedir(), '.config');
  return join(base, 'kakari');
}

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.KAKARI_STATE_DIR) return resolve(env.KAKARI_STATE_DIR);
  const base = env.XDG_STATE_HOME
    ? resolve(env.XDG_STATE_HOME)
    : join(homedir(), '.local', 'state');
  return join(base, 'kakari');
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
}

function formatZodError(file: string, error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `  - ${path}: ${issue.message}`;
  });
  return `${file} の設定が不正です:\n${lines.join('\n')}`;
}

function readYaml(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new CliError('config', `設定ファイルを読めません: ${path} (${(error as Error).message})`);
  }
  try {
    return parse(text, { prettyErrors: true });
  } catch (error) {
    throw new CliError('config', `${path} のYAMLを解析できません: ${(error as Error).message}`);
  }
}

export function parseConfig(raw: unknown, file = 'config.yaml'): KakariConfig {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new CliError('config', formatZodError(file, parsed.error));
  const problems = validateReferences(parsed.data);
  if (problems.length > 0) {
    throw new CliError(
      'config',
      `${file} の参照整合性に問題があります:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }
  return parsed.data;
}

export function parseLocal(raw: unknown, file = 'local.yaml'): LocalConfig {
  const parsed = localSchema.safeParse(raw ?? { schema_version: 1 });
  if (!parsed.success) throw new CliError('config', formatZodError(file, parsed.error));
  return parsed.data;
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) dup.add(v);
    seen.add(v);
  }
  return [...dup];
}

/** 対象リポジトリの集合。null は owner 内の全リポジトリ（除外分を除く）。 */
function repositoryScope(p: ProfileConfig): Set<string> | null {
  if (p.github.include_repositories.length === 0) return null;
  const excluded = new Set(p.github.exclude_repositories.map((r) => r.toLowerCase()));
  return new Set(
    p.github.include_repositories.map((r) => r.toLowerCase()).filter((r) => !excluded.has(r)),
  );
}

function scopeContains(p: ProfileConfig, scope: Set<string> | null, repo: string): boolean {
  if (scope) return scope.has(repo);
  return !p.github.exclude_repositories.some((r) => r.toLowerCase() === repo);
}

/** 同じPRが複数プロファイルに重複マッチし得るか（5.1） */
function profileScopesOverlap(a: ProfileConfig, b: ProfileConfig): boolean {
  if (a.github.host !== b.github.host) return false;
  if (a.github.reviewer_login.toLowerCase() !== b.github.reviewer_login.toLowerCase()) return false;
  const ownersB = new Set(b.github.owners.map((o) => o.toLowerCase()));
  const sharedOwners = a.github.owners.map((o) => o.toLowerCase()).filter((o) => ownersB.has(o));
  if (sharedOwners.length === 0) return false;
  const scopeA = repositoryScope(a);
  const scopeB = repositoryScope(b);
  if (!scopeA && !scopeB) return true;
  const inSharedOwner = (repo: string) => sharedOwners.some((o) => repo.startsWith(`${o}/`));
  const candidates = [...(scopeA ?? []), ...(scopeB ?? [])].filter(inSharedOwner);
  return candidates.some((r) => scopeContains(a, scopeA, r) && scopeContains(b, scopeB, r));
}

/** 参照整合性を検証する（15章）。問題の一覧を返す。 */
export function validateReferences(config: KakariConfig): string[] {
  const problems: string[] = [];
  const workers = new Map(config.workers.map((w) => [w.id, w]));
  const pools = new Map(config.usage_pools.map((p) => [p.id, p]));
  const profileIds = new Set(config.profiles.map((p) => p.id));

  for (const [label, ids] of [
    ['worker', config.workers.map((w) => w.id)],
    ['usage pool', config.usage_pools.map((p) => p.id)],
    ['profile', config.profiles.map((p) => p.id)],
  ] as const) {
    for (const d of duplicates(ids)) problems.push(`${label} ID が重複しています: ${d}`);
  }

  for (const w of config.workers) {
    if (w.roles.includes('notifier') && w.roles.length > 1) {
      problems.push(`worker ${w.id}: notifier は他の役割と分けてください（13.3）`);
    }
    for (const p of w.allowed_profiles) {
      if (!profileIds.has(p)) problems.push(`worker ${w.id}: 未定義の profile ${p}`);
    }
  }
  const dbRefs = config.workers.map((w) => w.db_session_ref);
  for (const d of duplicates(dbRefs)) {
    problems.push(`db_session_ref が複数のworkerで共有されています: ${d}`);
  }

  for (const p of config.profiles) {
    const pool = pools.get(p.review.usage_pool_id);
    if (!pool) {
      problems.push(`profile ${p.id}: 未定義の usage pool ${p.review.usage_pool_id}`);
    } else if (pool.provider !== p.review.provider) {
      problems.push(
        `profile ${p.id}: usage pool ${pool.id} の provider (${pool.provider}) と一致しません`,
      );
    }
    if (p.review.provider !== 'claude') {
      problems.push(`profile ${p.id}: provider ${p.review.provider} は未実装です`);
    }
    for (const wid of p.review.allowed_workers) {
      const w = workers.get(wid);
      if (!w) {
        problems.push(`profile ${p.id}: 未定義の worker ${wid}`);
      } else {
        if (!w.roles.includes('reviewer')) {
          problems.push(`profile ${p.id}: worker ${wid} に reviewer 役割がありません`);
        }
        if (!w.allowed_profiles.includes(p.id)) {
          problems.push(`profile ${p.id}: worker ${wid} の allowed_profiles に含まれていません`);
        }
      }
    }
    const reviewers = config.workers.filter(
      (w) => w.allowed_profiles.includes(p.id) && w.roles.includes('reviewer'),
    );
    if (reviewers.length > 1) {
      problems.push(`profile ${p.id}: レビューを実行できるworkerは1台にしてください（5.2）`);
    }
    const dest = workers.get(p.notifications.destination_worker_id);
    if (!dest) {
      problems.push(`profile ${p.id}: 未定義の通知先 ${p.notifications.destination_worker_id}`);
    } else {
      if (!dest.roles.includes('notifier')) {
        problems.push(`profile ${p.id}: 通知先 ${dest.id} に notifier 役割がありません`);
      }
      if (!dest.allowed_profiles.includes(p.id)) {
        problems.push(`profile ${p.id}: 通知先 ${dest.id} の allowed_profiles に含まれていません`);
      }
    }
    if (p.enabled && !p.review.send_to_provider_approved) {
      problems.push(
        `profile ${p.id}: enabled にするには review.send_to_provider_approved: true が必要です（14.2）`,
      );
    }
    for (const repo of [...p.github.include_repositories, ...p.github.exclude_repositories]) {
      const owner = repo.split('/')[0]?.toLowerCase();
      if (!p.github.owners.some((o) => o.toLowerCase() === owner)) {
        problems.push(`profile ${p.id}: ${repo} は owners に含まれていません`);
      }
    }
  }

  for (let i = 0; i < config.profiles.length; i++) {
    for (let j = i + 1; j < config.profiles.length; j++) {
      const a = config.profiles[i];
      const b = config.profiles[j];
      if (a && b && profileScopesOverlap(a, b)) {
        problems.push(
          `profile ${a.id} と ${b.id} が同じPRに重複してマッチします（5.1）。対象リポジトリを分けてください`,
        );
      }
    }
  }
  return problems;
}

export function loadConfig(
  options: ConfigPathOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): LoadedConfig {
  const configDir = defaultConfigDir(env);
  const configPath = resolve(
    expandHome(options.config ?? env.KAKARI_CONFIG ?? join(configDir, 'config.yaml')),
  );
  const explicitLocal = options.local ?? env.KAKARI_LOCAL_CONFIG;
  const localCandidate = resolve(
    expandHome(explicitLocal ?? join(dirname(configPath), 'local.yaml')),
  );
  const config = parseConfig(readYaml(configPath), configPath);
  let local: LocalConfig;
  let localPath: string | null = localCandidate;
  try {
    local = parseLocal(readYaml(localCandidate), localCandidate);
  } catch (error) {
    if (!explicitLocal && error instanceof CliError && /読めません/.test(error.message)) {
      local = parseLocal(undefined);
      localPath = null;
    } else {
      throw error;
    }
  }
  const stateDir = local.paths.state_dir
    ? resolve(expandHome(local.paths.state_dir))
    : defaultStateDir(env);
  return { config, local, configPath, localPath, configDir: dirname(configPath), stateDir };
}

export function resolveConfigRelative(loaded: LoadedConfig, p: string): string {
  const expanded = expandHome(p);
  return isAbsolute(expanded) ? expanded : resolve(loaded.configDir, expanded);
}

export function findProfile(config: KakariConfig, id: string): ProfileConfig {
  const profile = config.profiles.find((p) => p.id === id);
  if (!profile) throw new CliError('usage', `未定義のプロファイルです: ${id}`);
  return profile;
}

export function findWorker(config: KakariConfig, id: string) {
  const worker = config.workers.find((w) => w.id === id);
  if (!worker) throw new CliError('usage', `未定義のworkerです: ${id}`);
  return worker;
}

export function uiBaseUrl(loaded: LoadedConfig): string {
  return (
    loaded.local.ui.public_base_url ?? `http://${loaded.config.ui.host}:${loaded.config.ui.port}`
  ).replace(/\/+$/, '');
}
