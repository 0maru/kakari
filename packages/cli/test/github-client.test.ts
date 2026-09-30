import { describe, expect, it } from 'vitest';
import {
  ConditionalCache,
  GitHubClient,
  GitHubError,
  parseNextLink,
  RateLimiter,
} from '../src/github/client.ts';
import {
  type GhRequest,
  type GhResponse,
  type GhTransport,
  parseIncludeOutput,
} from '../src/github/transport.ts';

class FakeTransport implements GhTransport {
  readonly calls: { host: string; token: string; request: GhRequest }[] = [];
  private readonly handler: (req: GhRequest, n: number) => GhResponse | Promise<GhResponse>;

  constructor(handler: (req: GhRequest, n: number) => GhResponse | Promise<GhResponse>) {
    this.handler = handler;
  }
  async request(host: string, token: string, request: GhRequest): Promise<GhResponse> {
    this.calls.push({ host, token, request });
    return this.handler(request, this.calls.length);
  }
}

function ok(body: unknown, headers: Record<string, string> = {}): GhResponse {
  return {
    status: 200,
    headers: {
      'x-ratelimit-remaining': '4999',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-resource': 'core',
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

function makeClient(
  transport: GhTransport,
  opts: { limiter?: RateLimiter; now?: () => number } = {},
) {
  return new GitHubClient({
    transport,
    host: 'github.com',
    principal: 'alice',
    token: async () => 'tok-1',
    cacheScope: 'default',
    limiter: opts.limiter ?? new RateLimiter(opts.now),
    cache: new ConditionalCache(),
    now: opts.now,
  });
}

describe('parseIncludeOutput', () => {
  it('ステータス行・ヘッダー・本文を分けて読む', () => {
    // Arrange
    const raw = 'HTTP/2.0 200 OK\r\nEtag: "abc"\r\nX-Ratelimit-Remaining: 10\r\n\r\n{"a":1}';

    // Act
    const res = parseIncludeOutput(raw);

    // Assert
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBe('"abc"');
    expect(res.headers['x-ratelimit-remaining']).toBe('10');
    expect(res.body).toBe('{"a":1}');
  });

  it('本文のない304を読む', () => {
    // Act
    const res = parseIncludeOutput('HTTP/2.0 304 Not Modified\nEtag: "abc"\n\n');

    // Assert
    expect(res.status).toBe(304);
    expect(res.body).toBe('');
  });
});

describe('parseNextLink', () => {
  it('rel="next" をAPIパスとクエリに変換する', () => {
    // Arrange
    const link =
      '<https://api.github.com/repositories/1/pulls/2/reviews?per_page=100&page=2>; rel="next", <https://api.github.com/repositories/1/pulls/2/reviews?per_page=100&page=5>; rel="last"';

    // Act
    const next = parseNextLink(link, 'github.com');

    // Assert
    expect(next).toEqual({
      path: 'repositories/1/pulls/2/reviews',
      query: { per_page: '100', page: '2' },
    });
  });

  it('別ホストへのリンクは辿らない', () => {
    // Act / Assert
    expect(
      parseNextLink('<https://evil.example.com/x?page=2>; rel="next"', 'github.com'),
    ).toBeNull();
  });
});

describe('GitHubClient', () => {
  it('条件付きGETが304を返したら保存済み本文を使う（AC-60）', async () => {
    // Arrange
    const transport = new FakeTransport((_req, n) =>
      n === 1
        ? ok({ number: 1 }, { etag: '"v1"' })
        : { status: 304, headers: { etag: '"v1"' }, body: '' },
    );
    const client = makeClient(transport);
    await client.get('repos/o/r/pulls/1');

    // Act
    const res = await client.get<{ number: number }>('repos/o/r/pulls/1');

    // Assert
    expect(res.notModified).toBe(true);
    expect(res.data.number).toBe(1);
    expect(transport.calls[1]?.request.headers?.['If-None-Match']).toBe('"v1"');
  });

  it('保存済み本文がない304は空結果にせず条件を外して再取得する（AC-60）', async () => {
    // Arrange
    const cache = new ConditionalCache();
    const transport = new FakeTransport((req) =>
      req.headers?.['If-None-Match']
        ? { status: 304, headers: {}, body: '' }
        : ok({ number: 2 }, { etag: '"v2"' }),
    );
    const client = new GitHubClient({
      transport,
      host: 'github.com',
      principal: 'alice',
      token: async () => 'tok',
      cacheScope: 'default',
      limiter: new RateLimiter(),
      cache,
    });
    // 本文を失ったキャッシュ項目を作る
    await client.get('repos/o/r/pulls/2');
    const key = [
      'default',
      'github.com',
      'alice',
      'repos/o/r/pulls/2',
      'application/vnd.github+json',
      '2022-11-28',
    ].join('|');
    const entry = cache.get(key);
    expect(entry).toBeDefined();
    cache.delete(key);

    // Act
    const res = await client.get<{ number: number }>('repos/o/r/pulls/2');

    // Assert
    expect(res.data.number).toBe(2);
  });

  it('残量0なら reset まで呼び出しを止め、依頼0件として扱わない（AC-59）', async () => {
    // Arrange
    let now = 1_000_000;
    const transport = new FakeTransport(() => ({
      status: 403,
      headers: {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.floor(now / 1000) + 600),
        'x-ratelimit-resource': 'core',
      },
      body: '{"message":"API rate limit exceeded"}',
    }));
    const client = makeClient(transport, { now: () => now });

    // Act
    const first = await client.get('repos/o/r/pulls/1').catch((e) => e);
    const second = await client.get('repos/o/r/pulls/2').catch((e) => e);

    // Assert
    expect(first).toBeInstanceOf(GitHubError);
    expect(first.kind).toBe('rate_limited');
    expect(second.kind).toBe('rate_limited');
    expect(transport.calls).toHaveLength(1);
    now += 601_000;
    await client.get('repos/o/r/pulls/3').catch(() => undefined);
    expect(transport.calls).toHaveLength(2);
  });

  it('secondary rate limit では retry-after に従って待機する（AC-59）', async () => {
    // Arrange
    const now = 5_000_000;
    const transport = new FakeTransport(() => ({
      status: 403,
      headers: { 'retry-after': '120' },
      body: '{"message":"You have exceeded a secondary rate limit"}',
    }));
    const client = makeClient(transport, { now: () => now });

    // Act
    const err = await client.get('repos/o/r/pulls/1').catch((e) => e);

    // Assert
    expect(err.kind).toBe('secondary_rate_limited');
    expect(err.retryAt.getTime()).toBe(now + 120_000);
  });

  it('同じ認証主体の予算は複数プロファイルで共有する（AC-61）', async () => {
    // Arrange
    const limiter = new RateLimiter(() => 1_000_000);
    const transport = new FakeTransport(() => ({
      status: 403,
      headers: {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '99999999',
        'x-ratelimit-resource': 'core',
      },
      body: '{"message":"API rate limit exceeded"}',
    }));
    const a = new GitHubClient({
      transport,
      host: 'github.com',
      principal: 'alice',
      token: async () => 't',
      cacheScope: 'profile-a',
      limiter,
      cache: new ConditionalCache(),
    });
    const b = new GitHubClient({
      transport,
      host: 'github.com',
      principal: 'alice',
      token: async () => 't',
      cacheScope: 'profile-b',
      limiter,
      cache: new ConditionalCache(),
    });
    await a.get('repos/o/r/pulls/1').catch(() => undefined);

    // Act
    const err = await b.get('repos/o/r/pulls/9').catch((e) => e);

    // Assert
    expect(err.kind).toBe('rate_limited');
    expect(transport.calls).toHaveLength(1);
  });

  it('同じPRの同時取得を1回にまとめる（AC-63）', async () => {
    // Arrange
    const transport = new FakeTransport(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return ok({ number: 1 });
    });
    const client = makeClient(transport);

    // Act
    await Promise.all([
      client.get('repos/o/r/pulls/1'),
      client.get('repos/o/r/pulls/1'),
      client.get('repos/o/r/pulls/1'),
    ]);

    // Assert
    expect(transport.calls).toHaveLength(1);
  });

  it('403/404 はそれぞれ権限不足・取得不能として分類する', async () => {
    // Arrange
    const transport = new FakeTransport((req) =>
      req.path.endsWith('/1')
        ? { status: 403, headers: {}, body: '{"message":"Resource not accessible"}' }
        : { status: 404, headers: {}, body: '{"message":"Not Found"}' },
    );
    const client = makeClient(transport);

    // Act
    const forbidden = await client.get('repos/o/r/pulls/1').catch((e) => e);
    const notFound = await client.get('repos/o/r/pulls/2').catch((e) => e);

    // Assert
    expect(forbidden.syncStatus).toBe('forbidden');
    expect(notFound.syncStatus).toBe('not_found');
  });

  it('検索の不完全応答を完了扱いにしない（6.2）', async () => {
    // Arrange
    const transport = new FakeTransport(() =>
      ok(
        {
          total_count: 1,
          incomplete_results: true,
          items: [{ number: 1, repository_url: 'https://api.github.com/repos/o/r' }],
        },
        { 'x-ratelimit-resource': 'search' },
      ),
    );
    const client = makeClient(transport);

    // Act
    const res = await client.searchPullRequests('is:pr');

    // Assert
    expect(res.complete).toBe(false);
    expect(res.items).toHaveLength(1);
  });

  it('ページネーションでLinkを辿る', async () => {
    // Arrange
    const transport = new FakeTransport((req) =>
      req.query?.page === '2'
        ? ok([{ id: 2 }])
        : ok([{ id: 1 }], {
            link: '<https://api.github.com/repos/o/r/pulls/1/reviews?per_page=100&page=2>; rel="next"',
          }),
    );
    const client = makeClient(transport);

    // Act
    const res = await client.paginate<{ id: number }>('repos/o/r/pulls/1/reviews');

    // Assert
    expect(res.items.map((i) => i.id)).toEqual([1, 2]);
    expect(res.complete).toBe(true);
  });
});
