import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addScriptNonce, createUiServer } from '../src/ui-server.ts';

let server: Server;
let port: number;

function get(
  path: string,
  host?: string,
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, headers: { host: host ?? `127.0.0.1:${port}` } },
      (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  const dist = await mkdtemp(join(tmpdir(), 'kakari-ui-'));
  await mkdir(join(dist, 'assets'));
  await writeFile(
    join(dist, '_shell.html'),
    '<html><body><script>1</script><script type="module" src="/assets/a.js"></script></body></html>',
  );
  await writeFile(join(dist, 'assets', 'a.js'), 'console.log(1)');
  await writeFile(join(tmpdir(), 'kakari-secret.txt'), 'secret');
  server = await createUiServer({
    host: '127.0.0.1',
    port: 0,
    distDir: dist,
    publicConfig: {
      supabaseUrl: 'http://127.0.0.1:54321',
      publishableKey: 'sb_publishable_x',
      refreshIntervalSeconds: 30,
      pageSize: 50,
      appName: 'kakari',
    },
    allowedHosts: [],
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
  // 実際の待受ポートを許可リストに入れ直す
  await new Promise<void>((r) => server.close(() => r()));
  server = await createUiServer({
    host: '127.0.0.1',
    port,
    distDir: dist,
    publicConfig: {
      supabaseUrl: 'http://127.0.0.1:54321',
      publishableKey: 'sb_publishable_x',
      refreshIntervalSeconds: 30,
      pageSize: 50,
      appName: 'kakari',
    },
    allowedHosts: [`127.0.0.1:${port}`],
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('UIサーバー', () => {
  it('SPAのルートにはシェルを返し、scriptへnonceを付ける', async () => {
    // Act
    const res = await get('/tasks/abc');

    // Assert
    expect(res.status).toBe(200);
    const csp = String(res.headers['content-security-policy']);
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(res.body).toContain(`<script nonce="${nonce}">1</script>`);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self' http://127.0.0.1:54321");
  });

  it('公開可能な接続設定だけを配信する（AC-45）', async () => {
    // Act
    const res = await get('/kakari-config.json');

    // Assert
    expect(JSON.parse(res.body)).toEqual({
      supabaseUrl: 'http://127.0.0.1:54321',
      publishableKey: 'sb_publishable_x',
      refreshIntervalSeconds: 30,
      pageSize: 50,
      appName: 'kakari',
    });
  });

  it('設定したHost以外は受け付けない（DNS rebinding 対策）', async () => {
    // Act
    const res = await get('/tasks', 'attacker.example.com');

    // Assert
    expect(res.status).toBe(421);
  });

  it('配信ディレクトリの外のファイルを返さない', async () => {
    // Act
    const res = await get('/..%2f..%2fkakari-secret.txt');

    // Assert
    expect(res.status).not.toBe(200);
    expect(res.body).not.toContain('secret');
  });

  it('存在しない静的ファイルは404にする', async () => {
    // Act
    const res = await get('/assets/missing.js');

    // Assert
    expect(res.status).toBe(404);
  });
});

describe('addScriptNonce', () => {
  it('既存のnonceは上書きしない', () => {
    // Act / Assert
    expect(addScriptNonce('<script nonce="a"></script><script>x</script>', 'b')).toBe(
      '<script nonce="a"></script><script nonce="b">x</script>',
    );
  });
});
