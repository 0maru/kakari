import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_NAME } from '@kakari/shared';
import { uiBaseUrl } from './config/load.ts';
import type { AppContext } from './context.ts';
import { publishableKey } from './db.ts';
import { CliError } from './errors.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export function defaultUiDist(env: NodeJS.ProcessEnv = process.env): string {
  if (env.KAKARI_UI_DIST) return resolve(env.KAKARI_UI_DIST);
  const pkg = fileURLToPath(import.meta.resolve('@kakari/ui/package.json'));
  return join(dirname(pkg), 'dist', 'client');
}

/** シェルHTMLのすべての script 要素に nonce を付ける */
export function addScriptNonce(html: string, nonce: string): string {
  return html.replace(/<script(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`);
}

export interface UiServerOptions {
  host: string;
  port: number;
  distDir: string;
  /** ブラウザへ渡す公開可能な設定だけ（11.5・AC-45） */
  publicConfig: {
    supabaseUrl: string;
    publishableKey: string;
    refreshIntervalSeconds: number;
    pageSize: number;
    appName: string;
  };
  /** 受け付ける Host ヘッダー（DNS rebinding 対策） */
  allowedHosts: string[];
}

export interface RunningUiServer {
  url: string;
  close(): Promise<void>;
}

export async function createUiServer(options: UiServerOptions): Promise<Server> {
  const dist = resolve(options.distDir);
  let shellName = 'index.html';
  let shell = await readFile(join(dist, shellName), 'utf8').catch(() => null);
  if (shell === null) {
    shellName = '_shell.html';
    shell = await readFile(join(dist, shellName), 'utf8').catch(() => null);
  }
  if (shell === null) {
    throw new CliError(
      'runtime',
      `UIのビルドが見つかりません: ${dist}（pnpm build を実行してください）`,
    );
  }
  const supabaseOrigin = new URL(options.publicConfig.supabaseUrl).origin;
  // シェルのscriptには要求ごとの nonce を付け、そこから読み込まれるscriptだけを許可する
  const cspFor = (nonce: string) =>
    [
      "default-src 'self'",
      `script-src 'nonce-${nonce}' 'strict-dynamic'`,
      "style-src 'self' 'unsafe-inline'",
      // 外部画像の自動読み込みを許可しない（11.6）
      "img-src 'self' data:",
      `connect-src 'self' ${supabaseOrigin}`,
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ');
  const allowed = new Set(options.allowedHosts.map((h) => h.toLowerCase()));
  const configBody = JSON.stringify(options.publicConfig);

  return createServer(async (req, res) => {
    const nonce = randomBytes(16).toString('base64');
    const send = (status: number, body: string | Buffer, type: string, cache = 'no-store') => {
      res.writeHead(status, {
        'Content-Type': type,
        'Cache-Control': cache,
        'Content-Security-Policy': cspFor(nonce),
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'X-Frame-Options': 'DENY',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    try {
      if (!allowed.has((req.headers.host ?? '').toLowerCase())) {
        return send(421, 'misdirected request', 'text/plain; charset=utf-8');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send(405, 'method not allowed', 'text/plain; charset=utf-8');
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/healthz') return send(200, 'ok', 'text/plain; charset=utf-8');
      if (url.pathname === '/kakari-config.json') return send(200, configBody, MIME['.json'] ?? '');

      const decoded = decodeURIComponent(url.pathname);
      if (decoded.includes('\0')) return send(400, 'bad request', 'text/plain; charset=utf-8');
      const target = normalize(join(dist, decoded));
      if (target !== dist && !target.startsWith(dist + sep)) {
        return send(403, 'forbidden', 'text/plain; charset=utf-8');
      }
      const info = extname(decoded) ? await stat(target).catch(() => null) : null;
      if (info?.isFile()) {
        const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
        const immutable = decoded.startsWith('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-store';
        return send(200, await readFile(target), type, immutable);
      }
      if (extname(decoded) && decoded !== '/')
        return send(404, 'not found', 'text/plain; charset=utf-8');
      // SPAのルート（/tasks 等）はシェルを返す
      return send(200, addScriptNonce(shell ?? '', nonce), MIME['.html'] ?? '');
    } catch {
      return send(500, 'internal error', 'text/plain; charset=utf-8');
    }
  });
}

export async function startUiServer(ctx: AppContext, distDir?: string): Promise<RunningUiServer> {
  const { ui, storage } = ctx.loaded.config;
  const base = uiBaseUrl(ctx.loaded);
  const allowedHosts = new Set([`${ui.host}:${ui.port}`, new URL(base).host]);
  if (ui.host === '127.0.0.1') allowedHosts.add(`localhost:${ui.port}`);
  const server = await createUiServer({
    host: ui.host,
    port: ui.port,
    distDir: distDir ?? defaultUiDist(ctx.env),
    publicConfig: {
      supabaseUrl: storage.project_url,
      publishableKey: await publishableKey(ctx.loaded, ctx.secrets),
      refreshIntervalSeconds: ui.refresh_interval_seconds,
      pageSize: ui.page_size,
      appName: APP_NAME,
    },
    allowedHosts: [...allowedHosts],
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', (error) =>
      reject(
        new CliError('runtime', `UIを ${ui.host}:${ui.port} で起動できません: ${error.message}`),
      ),
    );
    server.listen(ui.port, ui.host, () => resolvePromise());
  });
  ctx.log.info('ui started', { url: base });
  return {
    url: base,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
