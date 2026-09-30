import { baseEnv, runProcess, SpawnError } from '../process.ts';

export interface GhRequest {
  /** 'repos/o/r/pulls/1' のようなAPIパス（先頭の / なし、クエリなし） */
  path: string;
  query?: Record<string, string | number> | undefined;
  headers?: Record<string, string> | undefined;
}

export interface GhResponse {
  status: number;
  /** 小文字のヘッダー名 */
  headers: Record<string, string>;
  body: string;
}

export interface GhTransport {
  request(host: string, token: string, request: GhRequest): Promise<GhResponse>;
}

export class GhTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GhTransportError';
  }
}

export function buildPath(request: GhRequest): string {
  const path = request.path.replace(/^\/+/, '');
  if (!request.query || Object.keys(request.query).length === 0) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(request.query)) params.set(k, String(v));
  return `${path}?${params.toString()}`;
}

/** `gh api --include` の出力（ステータス行・ヘッダー・本文）を解析する */
export function parseIncludeOutput(output: string): GhResponse {
  let rest = output;
  // 1xx などの中間応答が先頭に付く場合を読み飛ばす
  for (;;) {
    const match = /^HTTP\/[\d.]+ (\d{3})[^\r\n]*\r?\n/.exec(rest);
    if (!match) throw new GhTransportError('gh api の応答にHTTPステータス行がありません');
    const status = Number(match[1]);
    const headerEnd = rest.search(/\r?\n\r?\n/);
    const headerBlock = headerEnd === -1 ? rest : rest.slice(0, headerEnd);
    const sepLength =
      headerEnd === -1 ? 0 : (/\r?\n\r?\n/.exec(rest.slice(headerEnd))?.[0].length ?? 0);
    const body = headerEnd === -1 ? '' : rest.slice(headerEnd + sepLength);
    if (status >= 100 && status < 200 && body.startsWith('HTTP/')) {
      rest = body;
      continue;
    }
    const headers: Record<string, string> = {};
    for (const line of headerBlock.split(/\r?\n/).slice(1)) {
      const idx = line.indexOf(':');
      if (idx <= 0) continue;
      headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
    return { status, headers, body };
  }
}

/**
 * gh CLI を使う通信層（4.2）。
 * トークンは対象の子プロセスの環境変数にだけ設定し、引数・設定ファイル・ログへ書かない（5.5）。
 */
export class GhCliTransport implements GhTransport {
  private readonly ghPath: string;
  private readonly parentEnv: NodeJS.ProcessEnv;

  constructor(ghPath: string, parentEnv: NodeJS.ProcessEnv = process.env) {
    this.ghPath = ghPath;
    this.parentEnv = parentEnv;
  }

  async request(host: string, token: string, request: GhRequest): Promise<GhResponse> {
    const env: Record<string, string> = {
      ...baseEnv(this.parentEnv),
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
      NO_COLOR: '1',
    };
    if (host === 'github.com' || host.endsWith('.ghe.com')) env.GH_TOKEN = token;
    else env.GH_ENTERPRISE_TOKEN = token;

    const args = ['api', '--hostname', host, '--method', 'GET', '--include'];
    for (const [k, v] of Object.entries(request.headers ?? {})) {
      args.push('-H', `${k}: ${v}`);
    }
    args.push(buildPath(request));

    let res: Awaited<ReturnType<typeof runProcess>>;
    try {
      res = await runProcess(this.ghPath, args, {
        env,
        timeoutMs: 60_000,
        maxOutputBytes: 32 * 1024 * 1024,
      });
    } catch (error) {
      if (error instanceof SpawnError) throw new GhTransportError(error.message);
      throw error;
    }
    if (res.timedOut) throw new GhTransportError('gh api がタイムアウトしました');
    const stdout = res.stdout.toString('utf8');
    if (!stdout.startsWith('HTTP/')) {
      // HTTP応答を得られなかった（ネットワーク障害など）。終了コードだけで空結果にしない。
      throw new GhTransportError(
        `gh api が失敗しました (exit ${res.code}): ${res.stderr.trim().slice(0, 300)}`,
      );
    }
    return parseIncludeOutput(stdout);
  }
}
