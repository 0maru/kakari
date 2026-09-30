import { z } from 'zod';

// 15章 設定例に対応する設定スキーマ。
// 未定義の設定キーはエラーにする（strict）。

const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, '英小文字・数字・_・- で64文字以内');

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM 形式');

const weekday = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const timezone = z.string().refine(isValidTimeZone, 'IANAタイムゾーン名を指定してください');

const repoFullName = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'owner/repository 形式');

export const WORKER_ROLES = ['detector', 'reviewer', 'notification_planner', 'notifier'] as const;

export const globalSchema = z.strictObject({
  timezone: timezone.default('UTC'),
  discovery_interval_seconds: z.number().int().min(60).default(300),
  debounce_seconds: z.number().int().min(0).default(120),
  max_concurrent_reviews: z.number().int().min(1).default(1),
  max_auto_starts_per_day: z.number().int().min(0).default(10),
  lease_seconds: z.number().int().min(30).default(300),
  heartbeat_seconds: z.number().int().min(5).default(30),
  execution_timeout_seconds: z.number().int().min(60).default(1800),
  max_auto_retries: z.number().int().min(0).default(3),
  db_failure_policy: z.literal('stop_new_reviews').default('stop_new_reviews'),
  ambiguous_execution_policy: z.literal('require_reconciliation').default('require_reconciliation'),
});

export const storageSchema = z.strictObject({
  backend: z.literal('supabase'),
  project_url: z.url({ protocol: /^https?$/ }),
  publishable_key_ref: z.string().min(1),
});

export const uiSchema = z.strictObject({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(4317),
  refresh_interval_seconds: z.number().int().min(5).default(30),
  page_size: z.number().int().min(1).max(200).default(50),
  start_with_notifier: z.boolean().default(true),
});

export const workerSchema = z.strictObject({
  id,
  roles: z.array(z.enum(WORKER_ROLES)).min(1),
  db_session_ref: z.string().min(1),
  allowed_profiles: z.array(id).default([]),
});

export const usagePoolSchema = z.strictObject({
  id,
  provider: z.enum(['claude', 'codex']),
  max_concurrent: z.number().int().min(1).default(1),
});

const githubAuthSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('gh_user'),
    credential_ref: z.string().min(1),
  }),
]);

export const profileSchema = z.strictObject({
  id,
  name: z.string().min(1).max(100),
  enabled: z.boolean().default(false),
  github: z.strictObject({
    host: z.literal('github.com').default('github.com'),
    reviewer_login: z.string().regex(/^[A-Za-z0-9-]{1,39}$/, 'GitHubのユーザー名'),
    auth: githubAuthSchema,
    owners: z.array(z.string().regex(/^[A-Za-z0-9-]{1,39}$/)).min(1),
    include_repositories: z.array(repoFullName).default([]),
    exclude_repositories: z.array(repoFullName).default([]),
    exclude_labels: z.array(z.string().min(1)).default([]),
    direct_review_requests: z.literal(true).default(true),
    include_team_review_requests: z.literal(false).default(false),
    include_drafts: z.literal(false).default(false),
  }),
  review: z.strictObject({
    provider: z.enum(['claude', 'codex']),
    credential_ref: z.string().min(1).optional(),
    usage_pool_id: id,
    config_version: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
    prompt_file: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    allowed_workers: z.array(id).min(1),
    allowed_auth_methods: z.array(z.string().min(1)).default(['claude.ai', 'oauth_token']),
    allow_paid_api_fallback: z.literal(false).default(false),
    run_tests: z.literal(false).default(false),
    send_to_provider_approved: z.boolean().default(false),
    max_input_bytes: z.number().int().min(10_000).default(2_000_000),
  }),
  notifications: z.strictObject({
    delivery: z.enum(['macos_native', 'console']).default('macos_native'),
    destination_worker_id: id,
    poll_interval_seconds: z.number().int().min(10).default(60),
    max_state_age_seconds: z.number().int().min(60).default(600),
    timezone,
    weekdays: z.array(weekday).min(1),
    times: z.array(hhmm).min(1),
    repeat_until_acknowledged: z.boolean().default(true),
    include_code: z.literal(false).default(false),
    detail_level: z.enum(['count_only', 'repository', 'title']).default('repository'),
    missed_slot_policy: z.literal('latest_only').default('latest_only'),
  }),
  retention: z
    .strictObject({
      results_days: z.number().int().min(1).default(90),
      logs_days: z.number().int().min(1).default(7),
      local_input_hours: z.number().int().min(1).default(24),
    })
    .default({ results_days: 90, logs_days: 7, local_input_hours: 24 }),
});

export const configSchema = z.strictObject({
  schema_version: z.literal(1),
  owner: z.strictObject({
    email: z.email(),
    display_name: z.string().min(1).max(100).optional(),
  }),
  global: globalSchema.default(globalSchema.parse({})),
  storage: storageSchema,
  ui: uiSchema.default(uiSchema.parse({})),
  workers: z.array(workerSchema).min(1),
  usage_pools: z.array(usagePoolSchema).min(1),
  profiles: z.array(profileSchema).min(1),
});

export type KakariConfig = z.infer<typeof configSchema>;
export type ProfileConfig = z.infer<typeof profileSchema>;
export type WorkerConfig = z.infer<typeof workerSchema>;

// ---------------------------------------------------------------------------
// 端末ごとの設定（local.yaml）: 資格情報の参照先・実行バイナリ・状態保存先
// ---------------------------------------------------------------------------

/**
 * 参照先の書式
 *   env:VAR_NAME                 環境変数
 *   op://vault/item/field        1Password CLI（op read）
 *   keychain:service/account     macOS キーチェーン（security find-generic-password）
 *   gh-account:login             gh に登録済みのアカウントのトークン（gh auth token --user）
 *   file:/absolute/path          権限 0600 のファイル
 *   value:...                    秘密ではない値（publishable key など）をそのまま書く
 */
export const secretSource = z
  .string()
  .regex(
    /^(env:[A-Za-z_][A-Za-z0-9_]*|op:\/\/.+|keychain:[^/]+\/.+|gh-account:[A-Za-z0-9-]{1,39}|file:\/.+|value:.*)$/,
    'env: / op:// / keychain: / gh-account: / file: / value: のいずれかで指定してください',
  );

export const localSchema = z.strictObject({
  schema_version: z.literal(1),
  secrets: z.record(z.string(), secretSource).default({}),
  db_logins: z
    .record(
      z.string(),
      z.strictObject({
        email: z.email(),
        password_ref: secretSource,
      }),
    )
    .default({}),
  admin: z
    .strictObject({
      secret_key_ref: secretSource,
      /** 本人アカウントを新規作成するときのパスワード（省略時は対話入力） */
      owner_password_ref: secretSource.optional(),
    })
    .optional(),
  binaries: z
    .strictObject({
      gh: z.string().startsWith('/').optional(),
      git: z.string().startsWith('/').optional(),
      claude: z.string().startsWith('/').optional(),
      op: z.string().startsWith('/').optional(),
      terminal_notifier: z.string().startsWith('/').optional(),
    })
    .default({}),
  paths: z
    .strictObject({
      state_dir: z.string().optional(),
    })
    .default({}),
  ui: z
    .strictObject({
      /** 通知からレビュー詳細を開くときのURL。未指定なら ui.host/ui.port から作る */
      public_base_url: z.url({ protocol: /^https?$/ }).optional(),
    })
    .default({}),
});

export type LocalConfig = z.infer<typeof localSchema>;
