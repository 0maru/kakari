import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { baseEnv, runProcess } from './process.ts';
import type { Binaries } from './secrets.ts';

export interface StoredSession {
  project_url: string;
  email: string;
  access_token: string;
  refresh_token: string;
}

const SERVICE = 'kakari-cli-session';

/**
 * 本人のCLI用DBセッションを保存する（16.1 login/logout）。
 * macOS ではキーチェーンに保存する。値はコマンドライン引数ではなく標準入力で渡す（16.3）。
 * それ以外の環境では状態ディレクトリの 0600 ファイルに保存する。
 */
export class SessionStore {
  private readonly stateDir: string;
  private readonly projectUrl: string;
  private readonly binaries: Binaries;
  private readonly platform: NodeJS.Platform;

  constructor(
    stateDir: string,
    projectUrl: string,
    binaries: Binaries,
    platform: NodeJS.Platform = process.platform,
  ) {
    this.stateDir = stateDir;
    this.projectUrl = projectUrl;
    this.binaries = binaries;
    this.platform = platform;
  }

  private get filePath(): string {
    return join(this.stateDir, 'cli-session.json');
  }

  get backend(): 'keychain' | 'file' {
    return this.platform === 'darwin' ? 'keychain' : 'file';
  }

  async load(): Promise<StoredSession | null> {
    let text: string | null = null;
    if (this.backend === 'keychain') {
      const security = await this.binaries.require('security');
      const res = await runProcess(
        security,
        ['find-generic-password', '-s', SERVICE, '-a', this.projectUrl, '-w'],
        { env: baseEnv(), timeoutMs: 30_000 },
      );
      if (res.code !== 0) return null;
      text = Buffer.from(res.stdout.toString('utf8').trim(), 'base64').toString('utf8');
    } else {
      text = await readFile(this.filePath, 'utf8').catch(() => null);
    }
    if (!text) return null;
    try {
      const parsed = JSON.parse(text) as StoredSession;
      return parsed.project_url === this.projectUrl ? parsed : null;
    } catch {
      return null;
    }
  }

  async save(session: StoredSession): Promise<void> {
    const text = JSON.stringify(session);
    if (this.backend === 'keychain') {
      const security = await this.binaries.require('security');
      const encoded = Buffer.from(text, 'utf8').toString('base64');
      // security -i は標準入力からコマンドを読む。値は base64 のため引用符を含まない。
      const command = `add-generic-password -U -s ${SERVICE} -a "${this.projectUrl.replace(/"/g, '')}" -w ${encoded}\n`;
      const res = await runProcess(security, ['-i'], {
        env: baseEnv(),
        input: command,
        timeoutMs: 30_000,
      });
      if (res.code !== 0) throw new Error('キーチェーンにセッションを保存できません');
      return;
    }
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await writeFile(this.filePath, text, { mode: 0o600 });
    await chmod(this.filePath, 0o600);
  }

  async clear(): Promise<void> {
    if (this.backend === 'keychain') {
      const security = await this.binaries.require('security');
      await runProcess(
        security,
        ['delete-generic-password', '-s', SERVICE, '-a', this.projectUrl],
        {
          env: baseEnv(),
          timeoutMs: 30_000,
        },
      );
      return;
    }
    await rm(this.filePath, { force: true });
  }
}
