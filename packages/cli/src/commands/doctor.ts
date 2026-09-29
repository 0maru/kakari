import { createServer } from 'node:net';
import type { Command } from 'commander';
import { findProfile } from '../config/load.ts';
import type { ProfileConfig } from '../config/schema.ts';
import { type AppContext, githubClient, githubTransport, sessionStore } from '../context.ts';
import { createDbClient, publishableKey, workerDbClient } from '../db.ts';
import { CliError } from '../errors.ts';
import { printJson, printText } from '../output.ts';
import { PAID_PATH_ENV } from '../providers/claude.ts';
import { createProvider } from '../worker/service.ts';
import { contextFor } from './common.ts';

type Level = 'ok' | 'warn' | 'error' | 'skip';

interface Check {
  area: string;
  name: string;
  level: Level;
  detail: string;
}

const MARK: Record<Level, string> = { ok: '✓', warn: '!', error: '✗', skip: '-' };

async function portFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

async function check(
  checks: Check[],
  area: string,
  name: string,
  fn: () => Promise<[Level, string]>,
) {
  try {
    const [level, detail] = await fn();
    checks.push({ area, name, level, detail });
  } catch (error) {
    checks.push({ area, name, level: 'error', detail: (error as Error).message });
  }
}

async function profileChecks(ctx: AppContext, profile: ProfileConfig, checks: Check[]) {
  const area = `profile:${profile.id}`;
  await check(checks, area, '有効化と送信許可', async () => {
    if (!profile.enabled)
      return ['warn', '無効です（送信許可・認証・設定を確認してから enabled: true にします）'];
    return ['ok', `AIへの送信を許可済み（provider: ${profile.review.provider}）`];
  });

  // GitHub（5.5）: 認証主体と対象レビュアーを分けて表示する
  await check(checks, area, 'GitHub認証主体', async () => {
    const source = ctx.loaded.local.secrets[profile.github.auth.credential_ref];
    if (!source)
      return [
        'error',
        `local.yaml の secrets に ${profile.github.auth.credential_ref} がありません`,
      ];
    const gh = githubClient(ctx, profile, await githubTransport(ctx));
    const me = await gh.getAuthenticatedUser();
    return ['ok', `API呼び出しの認証主体: ${me.login} (id ${me.id})`];
  });
  await check(checks, area, '対象レビュアー', async () => {
    const gh = githubClient(ctx, profile, await githubTransport(ctx));
    const user = await gh.getUser(profile.github.reviewer_login);
    return ['ok', `レビュー依頼を集める対象: ${user.login} (id ${user.id})`];
  });
  for (const repo of profile.github.include_repositories) {
    await check(checks, area, `リポジトリ ${repo}`, async () => {
      const gh = githubClient(ctx, profile, await githubTransport(ctx));
      await gh.getRepository(repo);
      return ['ok', '読み取りできます'];
    });
  }
  for (const owner of profile.github.owners) {
    await check(checks, area, `owner ${owner}`, async () => {
      const gh = githubClient(ctx, profile, await githubTransport(ctx));
      const u = await gh.getUser(owner);
      return ['ok', `${u.type}`];
    });
  }

  // AI実行の安全性（5.4・14.1）
  const reviewerHere = profile.review.allowed_workers.some((w) => {
    const cfg = ctx.loaded.config.workers.find((x) => x.id === w);
    return cfg && ctx.loaded.local.db_logins[cfg.db_session_ref];
  });
  if (reviewerHere) {
    await check(checks, area, 'AI CLI（サブスク認証）', async () => {
      const provider = await createProvider(ctx, profile);
      const res = await provider.preflight();
      for (const w of res.warnings)
        checks.push({ area, name: 'AI CLI の注意', level: 'warn', detail: w });
      if (!res.ok) return ['error', `${res.errorClass}: ${res.message}`];
      return ['ok', `claude ${res.cliVersion}  認証方式: ${res.authMethod}`];
    });
  } else {
    checks.push({
      area,
      name: 'AI CLI（サブスク認証）',
      level: 'skip',
      detail: 'この端末にはレビューworkerのDBログインがありません',
    });
  }

  // 通知（13.3）
  await check(checks, area, '通知先', async () => {
    const dest = profile.notifications.destination_worker_id;
    const destCfg = ctx.loaded.config.workers.find((w) => w.id === dest);
    if (!destCfg) return ['error', `通知先 ${dest} が未定義です`];
    if (!ctx.loaded.local.db_logins[destCfg.db_session_ref]) {
      return ['skip', `通知先 ${dest} はこの端末ではありません`];
    }
    if (profile.notifications.delivery === 'console')
      return ['warn', '通知は標準エラー出力へ表示します（開発用）'];
    if (process.platform !== 'darwin') return ['error', 'macOS通知はmacOSでのみ利用できます'];
    const tn = await ctx.binaries.find('terminal_notifier');
    if (!tn)
      return ['error', 'terminal-notifier が見つかりません（brew install terminal-notifier）'];
    return ['ok', `${tn}（初回は通知の許可をシステム設定で確認してください）`];
  });
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('依存CLI・GitHub認証と権限・DB・UI・通知・AI実行の安全性を検査する')
    .option('--profile <id>', 'プロファイル')
    .option('--json', 'JSONで出力する')
    .action(async (opts, cmd: Command) => {
      const checks: Check[] = [];
      // 設定の読み込みに失敗した場合は、その内容を表示して終了コード2で終える
      const ctx = contextFor(cmd);
      checks.push({
        area: 'config',
        name: '設定ファイル',
        level: 'ok',
        detail: `${ctx.loaded.configPath}${ctx.loaded.localPath ? ` / ${ctx.loaded.localPath}` : '（local.yaml なし）'}`,
      });

      for (const bin of ['gh', 'git', 'claude'] as const) {
        await check(checks, 'binaries', bin, async () => {
          const p = await ctx.binaries.find(bin);
          return p
            ? ['ok', p]
            : [
                'warn',
                '見つかりません（この端末で使う役割に必要な場合はインストールしてください）',
              ];
        });
      }
      const inherited = PAID_PATH_ENV.filter((k) => process.env[k]);
      checks.push({
        area: 'environment',
        name: 'API課金経路の環境変数',
        level: inherited.length > 0 ? 'warn' : 'ok',
        detail:
          inherited.length > 0
            ? `${inherited.join(', ')} が設定されています（AI子プロセスには渡しません）`
            : '設定されていません',
      });

      await check(checks, 'database', 'publishable key', async () => {
        await publishableKey(ctx.loaded, ctx.secrets);
        return ['ok', ctx.loaded.config.storage.project_url];
      });
      await check(checks, 'database', '未認証アクセスの拒否', async () => {
        const anon = createDbClient(
          ctx.loaded.config.storage.project_url,
          await publishableKey(ctx.loaded, ctx.secrets),
        );
        const { data, error } = await anon.from('review_tasks').select('id').limit(1);
        if (error) return ['ok', `拒否されました (${error.code ?? error.message})`];
        return (data ?? []).length === 0
          ? ['ok', '未認証ではデータを取得できません']
          : ['error', '未認証でデータを取得できました'];
      });
      for (const w of ctx.loaded.config.workers) {
        if (!ctx.loaded.local.db_logins[w.db_session_ref]) continue;
        await check(checks, 'database', `worker ${w.id} のログイン`, async () => {
          const client = await workerDbClient(ctx.loaded, ctx.secrets, w.id);
          const { data } = await client
            .from('workers')
            .select('id, roles')
            .eq('id', w.id)
            .maybeSingle();
          if (!data)
            return [
              'error',
              'DBに worker が登録されていないか、認証主体が一致しません（kakari admin apply）',
            ];
          return ['ok', `roles: ${data.roles.join(', ')}`];
        });
      }
      await check(checks, 'database', '本人のCLIセッション', async () => {
        const store = sessionStore(ctx);
        const saved = await store.load();
        if (!saved) return ['warn', '未ログインです（kakari login）'];
        return [
          store.backend === 'keychain' ? 'ok' : 'warn',
          `${saved.email}（保存先: ${store.backend === 'keychain' ? 'キーチェーン' : '0600ファイル'}）`,
        ];
      });

      await check(
        checks,
        'ui',
        `配信先 ${ctx.loaded.config.ui.host}:${ctx.loaded.config.ui.port}`,
        async () => {
          const free = await portFree(ctx.loaded.config.ui.host, ctx.loaded.config.ui.port);
          return free
            ? ['ok', '利用できます']
            : ['warn', '使用中です（kakari ui が起動中なら問題ありません）'];
        },
      );

      const profiles = opts.profile
        ? [findProfile(ctx.loaded.config, opts.profile)]
        : ctx.loaded.config.profiles;
      for (const p of profiles) await profileChecks(ctx, p, checks);

      if (opts.json) {
        printJson({ checks });
      } else {
        let area = '';
        for (const c of checks) {
          if (c.area !== area) {
            area = c.area;
            printText(`\n[${area}]`);
          }
          printText(`${MARK[c.level]} ${c.name}: ${c.detail}`);
        }
      }
      if (checks.some((c) => c.level === 'error')) {
        throw new CliError(
          'runtime',
          `doctor: ${checks.filter((c) => c.level === 'error').length}件の問題があります`,
        );
      }
    });
}
