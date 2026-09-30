import type { ConfigPathOptions, LoadedConfig } from './config/load.ts';
import { loadConfig } from './config/load.ts';
import type { ProfileConfig } from './config/schema.ts';
import { ConditionalCache, GitHubClient, RateLimiter } from './github/client.ts';
import { GhCliTransport, type GhTransport } from './github/transport.ts';
import { createLogger, type Logger } from './log.ts';
import { Binaries, SecretResolver } from './secrets.ts';
import { SessionStore } from './session-store.ts';

export interface AppContext {
  loaded: LoadedConfig;
  binaries: Binaries;
  secrets: SecretResolver;
  log: Logger;
  limiter: RateLimiter;
  caches: Map<string, ConditionalCache>;
  env: NodeJS.ProcessEnv;
}

export function createContext(
  options: ConfigPathOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): AppContext {
  const loaded = loadConfig(options, env);
  const binaries = new Binaries(loaded.local, env);
  return {
    loaded,
    binaries,
    secrets: new SecretResolver(loaded.local, binaries, env),
    log: createLogger(),
    limiter: new RateLimiter(),
    caches: new Map(),
    env,
  };
}

export function sessionStore(ctx: AppContext): SessionStore {
  return new SessionStore(ctx.loaded.stateDir, ctx.loaded.config.storage.project_url, ctx.binaries);
}

/** APIの予算を共有する認証主体の識別子（6.5）。トークンそのものは使わない */
export function githubPrincipal(ctx: AppContext, profile: ProfileConfig): string {
  const source = ctx.loaded.local.secrets[profile.github.auth.credential_ref];
  if (source?.startsWith('gh-account:'))
    return `gh:${source.slice('gh-account:'.length).toLowerCase()}`;
  return `ref:${profile.github.auth.credential_ref}`;
}

export async function githubTransport(ctx: AppContext): Promise<GhTransport> {
  return new GhCliTransport(await ctx.binaries.require('gh'), ctx.env);
}

export function githubClient(
  ctx: AppContext,
  profile: ProfileConfig,
  transport: GhTransport,
): GitHubClient {
  let cache = ctx.caches.get(profile.id);
  if (!cache) {
    cache = new ConditionalCache();
    ctx.caches.set(profile.id, cache);
  }
  return new GitHubClient({
    transport,
    host: profile.github.host,
    principal: githubPrincipal(ctx, profile),
    token: () =>
      ctx.secrets.resolveRef(profile.github.auth.credential_ref, { host: profile.github.host }),
    cacheScope: profile.id,
    limiter: ctx.limiter,
    cache,
  });
}
