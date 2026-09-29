import { buildPath, type GhResponse, type GhTransport, GhTransportError } from './transport.ts';

export type GitHubErrorKind =
  | 'auth'
  | 'rate_limited'
  | 'secondary_rate_limited'
  | 'forbidden'
  | 'not_found'
  | 'validation'
  | 'server'
  | 'network'
  | 'invalid_response';

export class GitHubError extends Error {
  readonly kind: GitHubErrorKind;
  readonly status: number | null;
  readonly retryAt: Date | null;

  constructor(
    kind: GitHubErrorKind,
    message: string,
    status: number | null,
    retryAt: Date | null = null,
  ) {
    super(message);
    this.name = 'GitHubError';
    this.kind = kind;
    this.status = status;
    this.retryAt = retryAt;
  }

  /** PRの同期状態（pull_requests.sync_status）への対応 */
  get syncStatus(): 'unknown' | 'rate_limited' | 'forbidden' | 'not_found' | 'auth_error' {
    switch (this.kind) {
      case 'auth':
        return 'auth_error';
      case 'rate_limited':
      case 'secondary_rate_limited':
        return 'rate_limited';
      case 'forbidden':
        return 'forbidden';
      case 'not_found':
        return 'not_found';
      default:
        return 'unknown';
    }
  }
}

export interface RateLimitSnapshot {
  github_host: string;
  principal: string;
  resource: string;
  limit: number | null;
  remaining: number | null;
  reset_at: string | null;
  blocked_until: string | null;
  wait_reason: string | null;
}

interface BudgetState {
  limit: number | null;
  remaining: number | null;
  resetAt: number | null;
  blockedUntil: number | null;
  waitReason: string | null;
  secondaryStrikes: number;
}

/**
 * 認証主体・APIリソース単位の予算（6.5）。
 * 同じ認証主体の要求は直列化し、制限中は呼び出しを止める。
 */
export class RateLimiter {
  private readonly budgets = new Map<string, BudgetState>();
  private readonly queues = new Map<string, Promise<unknown>>();

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private key(host: string, principal: string, resource: string) {
    return `${host}|${principal}|${resource}`;
  }

  private budget(host: string, principal: string, resource: string): BudgetState {
    const key = this.key(host, principal, resource);
    let b = this.budgets.get(key);
    if (!b) {
      b = {
        limit: null,
        remaining: null,
        resetAt: null,
        blockedUntil: null,
        waitReason: null,
        secondaryStrikes: 0,
      };
      this.budgets.set(key, b);
    }
    return b;
  }

  /** 制限中なら再開時刻を返す */
  blockedUntil(host: string, principal: string, resource: string): number | null {
    const b = this.budget(host, principal, resource);
    const t = this.now();
    if (b.blockedUntil !== null && b.blockedUntil > t) return b.blockedUntil;
    if (b.remaining === 0 && b.resetAt !== null && b.resetAt > t) return b.resetAt;
    return null;
  }

  /** 同じ認証主体の要求を直列化する */
  schedule<T>(host: string, principal: string, task: () => Promise<T>): Promise<T> {
    const qkey = `${host}|${principal}`;
    const prev = this.queues.get(qkey) ?? Promise.resolve();
    const next = prev.then(task, task);
    this.queues.set(
      qkey,
      next.catch(() => undefined),
    );
    return next;
  }

  observe(host: string, principal: string, fallbackResource: string, res: GhResponse): void {
    const resource = res.headers['x-ratelimit-resource'] ?? fallbackResource;
    const b = this.budget(host, principal, resource);
    const num = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : null);
    const limit = num(res.headers['x-ratelimit-limit']);
    const remaining = num(res.headers['x-ratelimit-remaining']);
    const reset = num(res.headers['x-ratelimit-reset']);
    if (limit !== null) b.limit = limit;
    if (remaining !== null) b.remaining = remaining;
    if (reset !== null) b.resetAt = reset * 1000;
    if (res.status < 400) {
      b.secondaryStrikes = 0;
      if (b.blockedUntil !== null && b.blockedUntil <= this.now()) {
        b.blockedUntil = null;
        b.waitReason = null;
      }
    }
  }

  block(
    host: string,
    principal: string,
    resource: string,
    until: number,
    reason: string,
    secondary = false,
  ) {
    const b = this.budget(host, principal, resource);
    b.blockedUntil = Math.max(b.blockedUntil ?? 0, until);
    b.waitReason = reason;
    if (secondary) b.secondaryStrikes += 1;
  }

  secondaryBackoffMs(host: string, principal: string, resource: string): number {
    const b = this.budget(host, principal, resource);
    // 1分から始めて倍々、上限30分
    return Math.min(60_000 * 2 ** b.secondaryStrikes, 30 * 60_000);
  }

  snapshots(): RateLimitSnapshot[] {
    const out: RateLimitSnapshot[] = [];
    for (const [key, b] of this.budgets) {
      const [host, principal, resource] = key.split('|');
      out.push({
        github_host: host ?? '',
        principal: principal ?? '',
        resource: resource ?? '',
        limit: b.limit,
        remaining: b.remaining,
        reset_at: b.resetAt ? new Date(b.resetAt).toISOString() : null,
        blocked_until:
          b.blockedUntil && b.blockedUntil > this.now()
            ? new Date(b.blockedUntil).toISOString()
            : null,
        wait_reason: b.blockedUntil && b.blockedUntil > this.now() ? b.waitReason : null,
      });
    }
    return out;
  }
}

interface CacheEntry {
  etag: string | null;
  lastModified: string | null;
  body: string;
  headers: Record<string, string>;
  /** x-poll-interval による次回取得の最短時刻 */
  notBefore: number;
  storedAt: number;
}

/** 条件付き取得のキャッシュ（6.6）。トークン文字列はキーにしない。 */
export class ConditionalCache {
  private readonly entries = new Map<string, CacheEntry>();

  private readonly maxEntries;

  constructor(maxEntries = 5000) {
    this.maxEntries = maxEntries;
  }

  get(key: string): CacheEntry | undefined {
    const e = this.entries.get(key);
    if (e) {
      this.entries.delete(key);
      this.entries.set(key, e);
    }
    return e;
  }

  set(key: string, entry: CacheEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

export interface GetOptions {
  query?: Record<string, string | number>;
  accept?: string;
  /** false なら条件付きリクエストを使わない */
  conditional?: boolean;
}

export interface GetResult<T> {
  status: number;
  data: T;
  headers: Record<string, string>;
  /** 304 で保存済み本文を使った */
  notModified: boolean;
}

export interface GitHubClientOptions {
  transport: GhTransport;
  host: string;
  /** API呼び出しの認証主体（ユーザーlogin等）。予算の共有単位 */
  principal: string;
  /** 呼び出し直前にトークンを解決する */
  token: () => Promise<string>;
  /** キャッシュを分けるプロファイル */
  cacheScope: string;
  limiter: RateLimiter;
  cache: ConditionalCache;
  now?: () => number;
}

const API_VERSION = '2022-11-28';
const DEFAULT_ACCEPT = 'application/vnd.github+json';

export interface SearchItem {
  number: number;
  repository_url: string;
  pull_request?: unknown;
}

export interface PullRequest {
  id: number;
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  merged_at: string | null;
  user: { login: string } | null;
  labels: { name: string }[];
  head: { sha: string; ref: string; repo: { full_name: string; id: number } | null };
  base: {
    sha: string;
    ref: string;
    repo: { full_name: string; id: number; owner: { login: string } };
  };
}

export interface RequestedReviewers {
  users: { id: number; login: string }[];
  teams: { id: number; slug: string }[];
}

export interface Review {
  id: number;
  user: { id: number; login: string } | null;
  state: string;
  submitted_at: string | null;
  commit_id: string | null;
}

export interface IssueEvent {
  id: number;
  event: string;
  created_at: string;
  requested_reviewer?: { id: number; login: string } | null;
}

/**
 * GitHubへのアクセスを集約するクライアント（4.2）。
 * 認証解決・ページネーション・レート制限・条件付き取得・エラー分類を担う。
 */
export class GitHubClient {
  private readonly inflight = new Map<string, Promise<GetResult<unknown>>>();
  private readonly now: () => number;

  private readonly options: GitHubClientOptions;

  constructor(options: GitHubClientOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  get host(): string {
    return this.options.host;
  }

  get principal(): string {
    return this.options.principal;
  }

  private resourceFor(path: string): string {
    return path.startsWith('search/') ? 'search' : 'core';
  }

  /** 同じURLの同時取得はまとめる（6.6・AC-63） */
  get<T>(path: string, opts: GetOptions = {}): Promise<GetResult<T>> {
    const accept = opts.accept ?? DEFAULT_ACCEPT;
    const cacheKey = [
      this.options.cacheScope,
      this.options.host,
      this.options.principal,
      buildPath({ path, query: opts.query }),
      accept,
      API_VERSION,
    ].join('|');
    const existing = this.inflight.get(cacheKey);
    if (existing) return existing as Promise<GetResult<T>>;
    const p = this.fetchWithCache<T>(path, opts, accept, cacheKey).finally(() => {
      this.inflight.delete(cacheKey);
    });
    this.inflight.set(cacheKey, p as Promise<GetResult<unknown>>);
    return p;
  }

  private async fetchWithCache<T>(
    path: string,
    opts: GetOptions,
    accept: string,
    cacheKey: string,
  ): Promise<GetResult<T>> {
    const { host, principal, limiter, cache } = this.options;
    const resource = this.resourceFor(path);
    const conditional = opts.conditional !== false;
    const cached = conditional ? cache.get(cacheKey) : undefined;

    if (cached && cached.notBefore > this.now()) {
      // x-poll-interval より短い間隔では再取得しない
      return {
        status: 200,
        data: parseJson<T>(cached.body),
        headers: cached.headers,
        notModified: true,
      };
    }

    const request = async (useCondition: boolean): Promise<GhResponse> => {
      const blocked = limiter.blockedUntil(host, principal, resource);
      if (blocked !== null) {
        throw new GitHubError(
          'rate_limited',
          `GitHub API (${resource}) のレート制限で ${new Date(blocked).toISOString()} まで待機中`,
          null,
          new Date(blocked),
        );
      }
      const headers: Record<string, string> = {
        Accept: accept,
        'X-GitHub-Api-Version': API_VERSION,
      };
      if (useCondition && cached?.etag) headers['If-None-Match'] = cached.etag;
      else if (useCondition && cached?.lastModified)
        headers['If-Modified-Since'] = cached.lastModified;
      let token: string;
      try {
        token = await this.options.token();
      } catch (error) {
        throw new GitHubError('auth', (error as Error).message, null);
      }
      let res: GhResponse;
      try {
        res = await this.options.transport.request(host, token, {
          path,
          query: opts.query,
          headers,
        });
      } catch (error) {
        if (error instanceof GhTransportError)
          throw new GitHubError('network', error.message, null);
        throw error;
      }
      limiter.observe(host, principal, resource, res);
      return res;
    };

    return limiter.schedule(host, principal, async () => {
      let res = await request(Boolean(cached));
      if (res.status === 304) {
        if (cached) {
          this.touch(cacheKey, cached, res);
          return {
            status: 304,
            data: parseJson<T>(cached.body),
            headers: { ...cached.headers, ...res.headers },
            notModified: true,
          };
        }
        // 保存済み本文がない 304 は空結果とせず、条件を外して再取得する
        res = await request(false);
      }
      this.raiseForStatus(res, resource);
      if (conditional && (res.headers.etag || res.headers['last-modified'])) {
        cache.set(cacheKey, {
          etag: res.headers.etag ?? null,
          lastModified: res.headers['last-modified'] ?? null,
          body: res.body,
          headers: res.headers,
          notBefore: this.pollNotBefore(res),
          storedAt: this.now(),
        });
      }
      return {
        status: res.status,
        data: parseJson<T>(res.body),
        headers: res.headers,
        notModified: false,
      };
    });
  }

  private pollNotBefore(res: GhResponse): number {
    const interval = res.headers['x-poll-interval'];
    return interval && /^\d+$/.test(interval) ? this.now() + Number(interval) * 1000 : 0;
  }

  private touch(key: string, entry: CacheEntry, res: GhResponse) {
    this.options.cache.set(key, { ...entry, notBefore: this.pollNotBefore(res) });
  }

  private raiseForStatus(res: GhResponse, resource: string): void {
    if (res.status >= 200 && res.status < 300) return;
    const { host, principal, limiter } = this.options;
    const message = extractMessage(res.body);
    const retryAfter = res.headers['retry-after'];
    if (res.status === 401) {
      throw new GitHubError('auth', `GitHub認証に失敗しました: ${message}`, res.status);
    }
    if (res.status === 403 || res.status === 429) {
      if (retryAfter && /^\d+$/.test(retryAfter)) {
        const until = this.now() + Number(retryAfter) * 1000;
        limiter.block(host, principal, resource, until, 'retry-after', true);
        throw new GitHubError('secondary_rate_limited', message, res.status, new Date(until));
      }
      if (res.headers['x-ratelimit-remaining'] === '0') {
        const reset = Number(res.headers['x-ratelimit-reset'] ?? '0') * 1000;
        const until = reset > this.now() ? reset : this.now() + 60_000;
        limiter.block(host, principal, resource, until, 'primary rate limit');
        throw new GitHubError('rate_limited', message, res.status, new Date(until));
      }
      if (/secondary rate limit|abuse/i.test(message)) {
        const until = this.now() + limiter.secondaryBackoffMs(host, principal, resource);
        limiter.block(host, principal, resource, until, 'secondary rate limit', true);
        throw new GitHubError('secondary_rate_limited', message, res.status, new Date(until));
      }
      throw new GitHubError('forbidden', message, res.status);
    }
    if (res.status === 404) throw new GitHubError('not_found', message, res.status);
    if (res.status === 422) throw new GitHubError('validation', message, res.status);
    if (res.status >= 500) throw new GitHubError('server', message, res.status);
    throw new GitHubError('invalid_response', `HTTP ${res.status}: ${message}`, res.status);
  }

  /** Link ヘッダーを使ってすべてのページを取得する（6.2） */
  async paginate<T>(
    path: string,
    opts: GetOptions = {},
    maxPages = 20,
  ): Promise<{ items: T[]; complete: boolean }> {
    const items: T[] = [];
    let nextPath: string | null = path;
    let query: Record<string, string | number> | undefined = {
      per_page: 100,
      ...(opts.query ?? {}),
    };
    for (let page = 0; page < maxPages && nextPath; page++) {
      const res: GetResult<T[]> = await this.get<T[]>(nextPath, { ...opts, query });
      if (!Array.isArray(res.data)) {
        throw new GitHubError('invalid_response', `${path} の応答が配列ではありません`, res.status);
      }
      items.push(...res.data);
      const next = parseNextLink(res.headers.link, this.options.host);
      nextPath = next?.path ?? null;
      query = next?.query;
    }
    return { items, complete: nextPath === null };
  }

  // -------------------------------------------------------------------------
  // エンドポイント
  // -------------------------------------------------------------------------

  async getUser(login: string) {
    const res = await this.get<{ id: number; login: string; type: string }>(
      `users/${encodeURIComponent(login)}`,
    );
    return res.data;
  }

  /** 検索（6.1）。取得上限・不完全応答は complete=false で返す */
  async searchPullRequests(q: string, maxPages = 10) {
    const items: SearchItem[] = [];
    let complete = true;
    let total = 0;
    let nextPath: string | null = 'search/issues';
    let query: Record<string, string | number> | undefined = { q, per_page: 100 };
    let page = 0;
    while (nextPath) {
      if (page >= maxPages) {
        complete = false;
        break;
      }
      const res: GetResult<{
        total_count: number;
        incomplete_results: boolean;
        items: SearchItem[];
      }> = await this.get(nextPath, { query, conditional: false });
      if (!res.data || !Array.isArray(res.data.items)) {
        throw new GitHubError('invalid_response', '検索APIの応答が不正です', res.status);
      }
      total = res.data.total_count;
      if (res.data.incomplete_results) complete = false;
      items.push(...res.data.items);
      const next = parseNextLink(res.headers.link, this.options.host);
      nextPath = next?.path ?? null;
      query = next?.query;
      page++;
    }
    if (total > items.length || total > 1000) complete = false;
    return { items, complete, total };
  }

  async getPull(owner: string, repo: string, number: number): Promise<PullRequest> {
    const res = await this.get<PullRequest>(`repos/${owner}/${repo}/pulls/${number}`);
    return res.data;
  }

  async getRequestedReviewers(
    owner: string,
    repo: string,
    number: number,
  ): Promise<RequestedReviewers> {
    const res = await this.get<RequestedReviewers>(
      `repos/${owner}/${repo}/pulls/${number}/requested_reviewers`,
    );
    return res.data;
  }

  async listReviews(owner: string, repo: string, number: number) {
    return this.paginate<Review>(`repos/${owner}/${repo}/pulls/${number}/reviews`);
  }

  async listIssueEvents(owner: string, repo: string, number: number) {
    return this.paginate<IssueEvent>(`repos/${owner}/${repo}/issues/${number}/events`);
  }
}

function parseJson<T>(body: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new GitHubError('invalid_response', 'GitHub APIの応答をJSONとして解析できません', null);
  }
}

function extractMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: string };
    return (parsed.message ?? '').slice(0, 300) || 'no message';
  } catch {
    return body.slice(0, 200) || 'no message';
  }
}

/** Link ヘッダーの rel="next" をAPIパスとクエリに変換する */
export function parseNextLink(
  link: string | undefined,
  host: string,
): { path: string; query: Record<string, string> } | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part.trim());
    if (!m?.[2]?.split(/\s+/).includes('next') || !m[1]) continue;
    const url = new URL(m[1]);
    const apiHost = host === 'github.com' ? 'api.github.com' : host;
    if (url.hostname !== apiHost && url.hostname !== `api.${host}`) return null;
    let path = url.pathname.replace(/^\/+/, '');
    if (path.startsWith('api/v3/')) path = path.slice('api/v3/'.length);
    const query: Record<string, string> = {};
    for (const [k, v] of url.searchParams) query[k] = v;
    return { path, query };
  }
  return null;
}
