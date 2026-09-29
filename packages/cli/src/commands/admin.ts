import type { Database } from '@kakari/shared';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Command } from 'commander';
import type { KakariConfig } from '../config/schema.ts';
import type { AppContext } from '../context.ts';
import { CliError } from '../errors.ts';
import { info, printText } from '../output.ts';
import { askSecret, isInteractive } from '../prompt.ts';
import { contextFor } from './common.ts';

type Admin = SupabaseClient<Database>;

async function findUserByEmail(admin: Admin, email: string) {
  const target = email.toLowerCase();
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new CliError('runtime', `ユーザー一覧を取得できません: ${error.message}`);
    const found = data.users.find((u) => u.email?.toLowerCase() === target);
    if (found) return found;
    if (data.users.length < 200) return null;
  }
  return null;
}

async function ensureUser(
  admin: Admin,
  email: string,
  password: () => Promise<string>,
  dryRun: boolean,
  resetPassword: boolean,
): Promise<string | null> {
  const existing = await findUserByEmail(admin, email);
  if (existing) {
    if (resetPassword && !dryRun) {
      const { error } = await admin.auth.admin.updateUserById(existing.id, {
        password: await password(),
      });
      if (error)
        throw new CliError('runtime', `${email} のパスワードを更新できません: ${error.message}`);
      info(`  ${email}: パスワードを更新しました`);
    }
    return existing.id;
  }
  if (dryRun) {
    info(`  ${email}: 作成します（dry-run）`);
    return null;
  }
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: await password(),
    email_confirm: true,
  });
  if (error || !data.user)
    throw new CliError('runtime', `${email} を作成できません: ${error?.message}`);
  info(`  ${email}: 作成しました`);
  return data.user.id;
}

function profileRow(ownerId: string, p: KakariConfig['profiles'][number]) {
  return {
    id: p.id,
    owner_id: ownerId,
    name: p.name,
    enabled: p.enabled,
    github_host: p.github.host,
    reviewer_login: p.github.reviewer_login,
    auth_mode: p.github.auth.mode,
    provider: p.review.provider,
    review_config_version: p.review.config_version,
    usage_pool_id: p.review.usage_pool_id,
    notify_destination_worker_id: p.notifications.destination_worker_id,
    notify_timezone: p.notifications.timezone,
    notify_weekdays: p.notifications.weekdays,
    notify_times: p.notifications.times,
    notify_max_state_age_seconds: p.notifications.max_state_age_seconds,
    notify_repeat_until_acknowledged: p.notifications.repeat_until_acknowledged,
    notify_detail_level: p.notifications.detail_level,
    retention_results_days: p.retention.results_days,
    retention_logs_days: p.retention.logs_days,
    updated_at: new Date().toISOString(),
  };
}

async function apply(ctx: AppContext, opts: { dryRun?: boolean; resetPasswords?: boolean }) {
  const { config, local } = ctx.loaded;
  if (!local.admin) {
    throw new CliError(
      'config',
      'local.yaml に admin.secret_key_ref を設定してください（管理用の secret key）',
    );
  }
  const secretKey = await ctx.secrets.resolveSource(local.admin.secret_key_ref);
  const admin: Admin = createClient<Database>(config.storage.project_url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const dryRun = Boolean(opts.dryRun);
  const unwrap = <T>(res: { error: { message: string } | null; data?: T }, what: string) => {
    if (res.error) throw new CliError('runtime', `${what}: ${res.error.message}`);
    return res.data;
  };

  info('本人アカウント');
  const ownerId = await ensureUser(
    admin,
    config.owner.email,
    async () => {
      if (local.admin?.owner_password_ref)
        return ctx.secrets.resolveSource(local.admin.owner_password_ref);
      if (!isInteractive()) {
        throw new CliError(
          'usage',
          '本人アカウントのパスワードを入力するため対話的に実行するか、admin.owner_password_ref を設定してください',
        );
      }
      const pw = await askSecret(`${config.owner.email} のパスワード（12文字以上）: `);
      if (pw.length < 12) throw new CliError('usage', 'パスワードは12文字以上にしてください');
      return pw;
    },
    dryRun,
    false,
  );

  info('worker・通知クライアントのアカウント');
  const workerUserIds = new Map<string, string | null>();
  for (const w of config.workers) {
    const login = local.db_logins[w.db_session_ref];
    if (!login) {
      info(
        `  ${w.id}: local.yaml の db_logins に ${w.db_session_ref} がないためアカウントを登録しません`,
      );
      workerUserIds.set(w.id, null);
      continue;
    }
    if (login.email.toLowerCase() === config.owner.email.toLowerCase()) {
      throw new CliError(
        'config',
        `${w.id} に本人アカウントは使えません。worker専用のアカウントを用意してください`,
      );
    }
    workerUserIds.set(
      w.id,
      await ensureUser(
        admin,
        login.email,
        () => ctx.secrets.resolveSource(login.password_ref),
        dryRun,
        Boolean(opts.resetPasswords),
      ),
    );
  }

  if (dryRun) {
    printText('dry-run のためDBは変更していません。');
    return;
  }
  if (!ownerId) throw new CliError('runtime', '本人アカウントを作成できませんでした');

  unwrap(
    await admin
      .from('app_users')
      .upsert({ user_id: ownerId, display_name: config.owner.display_name ?? null }),
    'app_users',
  );
  const g = config.global;
  unwrap(
    await admin
      .from('app_settings')
      .update({
        timezone: g.timezone,
        max_concurrent_reviews: g.max_concurrent_reviews,
        max_auto_starts_per_day: g.max_auto_starts_per_day,
        debounce_seconds: g.debounce_seconds,
        lease_seconds: g.lease_seconds,
        execution_timeout_seconds: g.execution_timeout_seconds,
        max_auto_retries: g.max_auto_retries,
        updated_at: new Date().toISOString(),
      })
      .eq('id', true),
    'app_settings',
  );
  unwrap(
    await admin.from('usage_pools').upsert(
      config.usage_pools.map((p) => ({
        id: p.id,
        owner_id: ownerId,
        provider: p.provider,
        max_concurrent: p.max_concurrent,
        updated_at: new Date().toISOString(),
      })),
    ),
    'usage_pools',
  );
  for (const w of config.workers) {
    const authUserId = workerUserIds.get(w.id);
    const row: Database['public']['Tables']['workers']['Insert'] = {
      id: w.id,
      owner_id: ownerId,
      roles: w.roles,
      updated_at: new Date().toISOString(),
    };
    if (authUserId) row.auth_user_id = authUserId;
    unwrap(await admin.from('workers').upsert(row), `workers ${w.id}`);
  }
  unwrap(
    await admin.from('profiles').upsert(config.profiles.map((p) => profileRow(ownerId, p))),
    'profiles',
  );
  // 許可プロファイルを設定どおりに置き換える（権限を外す変更も反映する）
  for (const w of config.workers) {
    unwrap(
      await admin.from('worker_profiles').delete().eq('worker_id', w.id),
      `worker_profiles ${w.id}`,
    );
    if (w.allowed_profiles.length > 0) {
      unwrap(
        await admin
          .from('worker_profiles')
          .insert(w.allowed_profiles.map((profile_id) => ({ worker_id: w.id, profile_id }))),
        `worker_profiles ${w.id}`,
      );
    }
  }

  const { data: dbProfiles } = await admin.from('profiles').select('id');
  const { data: dbWorkers } = await admin.from('workers').select('id');
  const stale = [
    ...(dbProfiles ?? [])
      .filter((p) => !config.profiles.some((c) => c.id === p.id))
      .map((p) => `profile ${p.id}`),
    ...(dbWorkers ?? [])
      .filter((w) => !config.workers.some((c) => c.id === w.id))
      .map((w) => `worker ${w.id}`),
  ];
  if (stale.length > 0) {
    info(`設定にない行がDBに残っています（自動では削除しません）: ${stale.join(', ')}`);
  }
  printText(
    `DBへ反映しました: profiles ${config.profiles.length}件 / workers ${config.workers.length}件 / usage pools ${config.usage_pools.length}件`,
  );
}

export function registerAdminCommands(program: Command): void {
  const admin = program
    .command('admin')
    .description('初期設定・管理（secret key を使う。管理端末でのみ実行する）');
  admin
    .command('apply')
    .description(
      'config.yaml の本人・worker・プロファイル・利用枠をDBへ反映し、アカウントを登録する',
    )
    .option('--dry-run', '変更内容だけを表示する')
    .option('--reset-passwords', 'workerアカウントのパスワードを local.yaml の値で更新する')
    .action(async (opts, cmd: Command) => {
      await apply(contextFor(cmd), opts);
    });
}
