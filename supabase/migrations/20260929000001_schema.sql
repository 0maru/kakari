-- kakari MVP1 スキーマ
-- 仕様 10章の論理モデルを実装する。時刻はすべて timestamptz（UTC）で保存する。
-- クライアント（本人・worker・通知クライアント）はテーブルへ直接書き込まず、
-- 状態変更は用途別のDB関数（20260929000002_functions.sql）を通す。

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;

-- ---------------------------------------------------------------------------
-- 全体設定（1行のみ）
-- ---------------------------------------------------------------------------
create table public.app_settings (
  id boolean primary key default true check (id),
  timezone text not null default 'UTC',
  max_concurrent_reviews integer not null default 1 check (max_concurrent_reviews >= 1),
  max_auto_starts_per_day integer not null default 10 check (max_auto_starts_per_day >= 0),
  debounce_seconds integer not null default 120 check (debounce_seconds >= 0),
  lease_seconds integer not null default 300 check (lease_seconds >= 30),
  execution_timeout_seconds integer not null default 1800 check (execution_timeout_seconds >= 60),
  max_auto_retries integer not null default 3 check (max_auto_retries >= 0),
  updated_at timestamptz not null default now()
);

insert into public.app_settings (id) values (true);

-- ---------------------------------------------------------------------------
-- 本人（ブラウザ・CLIでログインする利用者）
-- ---------------------------------------------------------------------------
create table public.app_users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 利用枠
-- ---------------------------------------------------------------------------
create table public.usage_pools (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  owner_id uuid not null references public.app_users (user_id),
  provider text not null check (provider in ('claude', 'codex')),
  max_concurrent integer not null default 1 check (max_concurrent >= 1),
  -- 利用上限・認証切れによる保留。blocked_manual=true は復帰時刻不明で手動再開が必要
  blocked_until timestamptz,
  blocked_manual boolean not null default false,
  blocked_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- worker（レビューworker・通知クライアント）
-- ---------------------------------------------------------------------------
create table public.workers (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  owner_id uuid not null references public.app_users (user_id),
  auth_user_id uuid unique references auth.users (id) on delete set null,
  roles text[] not null check (
    cardinality(roles) > 0
    and roles <@ array['detector', 'reviewer', 'notification_planner', 'notifier']::text[]
  ),
  last_seen_at timestamptz,
  capabilities jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- プロファイル
-- ---------------------------------------------------------------------------
create table public.profiles (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  owner_id uuid not null references public.app_users (user_id),
  name text not null,
  enabled boolean not null default false,
  paused boolean not null default false,
  github_host text not null,
  reviewer_login text not null,
  reviewer_github_id text,
  auth_mode text not null default 'gh_user' check (auth_mode in ('gh_user')),
  provider text not null check (provider in ('claude', 'codex')),
  review_config_version text not null,
  usage_pool_id text not null references public.usage_pools (id),
  notify_destination_worker_id text references public.workers (id) on delete set null,
  notify_timezone text not null default 'UTC',
  notify_weekdays text[] not null default array['mon', 'tue', 'wed', 'thu', 'fri']::text[],
  notify_times text[] not null default array['11:00', '16:00']::text[],
  notify_max_state_age_seconds integer not null default 600 check (notify_max_state_age_seconds >= 60),
  notify_repeat_until_acknowledged boolean not null default true,
  -- 通知に載せる情報: count_only < repository < title
  notify_detail_level text not null default 'repository'
    check (notify_detail_level in ('count_only', 'repository', 'title')),
  retention_results_days integer not null default 90 check (retention_results_days >= 1),
  retention_logs_days integer not null default 7 check (retention_logs_days >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.worker_profiles (
  worker_id text not null references public.workers (id) on delete cascade,
  profile_id text not null references public.profiles (id) on delete cascade,
  primary key (worker_id, profile_id)
);

create index worker_profiles_profile_idx on public.worker_profiles (profile_id);

-- ---------------------------------------------------------------------------
-- PR
-- ---------------------------------------------------------------------------
create table public.pull_requests (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles (id) on delete cascade,
  github_host text not null,
  repository_id text not null,
  repository_full_name text not null,
  pr_number integer not null check (pr_number > 0),
  url text not null,
  title text not null default '',
  author_login text,
  head_sha text,
  head_ref text,
  base_sha text,
  base_ref text,
  body_hash text,
  state text not null check (state in ('open', 'closed', 'merged')),
  draft boolean not null default false,
  head_changed_at timestamptz,
  sync_status text not null default 'ok'
    check (sync_status in ('ok', 'unknown', 'rate_limited', 'forbidden', 'not_found', 'auth_error')),
  sync_error text,
  last_synced_at timestamptz,
  last_sync_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, github_host, repository_id, pr_number)
);

-- ---------------------------------------------------------------------------
-- レビュー項目（1 PR × 対象レビュアー）
-- ---------------------------------------------------------------------------
create table public.review_tasks (
  id uuid primary key default gen_random_uuid(),
  pull_request_id uuid not null references public.pull_requests (id) on delete cascade,
  profile_id text not null references public.profiles (id) on delete cascade,
  reviewer_github_id text not null,
  reviewer_login text not null,
  request_generation integer not null default 1 check (request_generation >= 1),
  request_state text not null default 'requested' check (request_state in ('requested', 'removed', 'unknown')),
  request_kind text not null default 'direct' check (request_kind in ('direct')),
  human_state text not null default 'open' check (human_state in ('open', 'done')),
  done_generation integer,
  done_reason text,
  done_source text check (done_source in ('github_review', 'manual')),
  done_at timestamptz,
  current_result_id uuid,
  acked_result_id uuid,
  acked_generation integer,
  acked_at timestamptz,
  snoozed_until timestamptz,
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (pull_request_id, reviewer_github_id)
);

create index review_tasks_profile_idx on public.review_tasks (profile_id);

create table public.review_request_signals (
  id uuid primary key default gen_random_uuid(),
  review_task_id uuid not null references public.review_tasks (id) on delete cascade,
  github_observation_id text not null,
  kind text not null default 'direct' check (kind in ('direct')),
  state text not null check (state in ('requested', 'removed', 'reviewed')),
  observed_at timestamptz not null default now(),
  event_at timestamptz,
  evidence jsonb not null default '{}'::jsonb,
  request_generation integer not null,
  unique (review_task_id, github_observation_id)
);

-- ---------------------------------------------------------------------------
-- AI実行管理
-- ---------------------------------------------------------------------------
create table public.review_jobs (
  id uuid primary key default gen_random_uuid(),
  review_task_id uuid not null references public.review_tasks (id) on delete cascade,
  profile_id text not null references public.profiles (id) on delete cascade,
  head_sha text not null,
  base_sha text,
  review_config_version text not null,
  provider text not null,
  manual_generation integer not null default 0 check (manual_generation >= 0),
  manual_reason text,
  requested_by uuid,
  status text not null default 'queued' check (
    status in ('queued', 'running', 'succeeded', 'blocked', 'failed', 'unknown', 'superseded', 'cancelled')
  ),
  not_before timestamptz not null default now(),
  worker_id text references public.workers (id) on delete set null,
  lease_token uuid,
  lease_expires_at timestamptz,
  current_attempt_id uuid,
  attempt_count integer not null default 0,
  auto_retry_count integer not null default 0,
  adopted_result_id uuid,
  -- 並列枠を保持しているか。running と、元プロセスを照合できていない unknown が保持する
  slot_held boolean not null default false,
  error_class text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (review_task_id, head_sha, review_config_version, manual_generation)
);

create index review_jobs_queue_idx on public.review_jobs (status, not_before) where status = 'queued';
create index review_jobs_slot_idx on public.review_jobs (profile_id) where slot_held;

create table public.review_attempts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.review_jobs (id) on delete cascade,
  attempt_number integer not null,
  execution_id uuid not null unique default gen_random_uuid(),
  worker_id text not null,
  lease_token uuid not null,
  provider text not null,
  usage_pool_id text not null,
  -- reserved: 実行権取得済み・CLI未起動 / launched: CLI起動 / not_launched: 起動せず終了
  launch_state text not null default 'reserved' check (launch_state in ('reserved', 'launched', 'not_launched')),
  reserved_at timestamptz not null default now(),
  launched_at timestamptz,
  finished_at timestamptz,
  head_sha text not null,
  base_sha text,
  merge_base_sha text,
  input_manifest jsonb,
  input_hash text,
  provider_session_id text,
  cli_version text,
  outcome text check (outcome in ('succeeded', 'failed', 'timeout', 'not_launched', 'abandoned')),
  error_class text,
  error_message text,
  usage jsonb,
  late boolean not null default false,
  late_payload jsonb,
  unique (job_id, attempt_number)
);

create index review_attempts_reserved_idx on public.review_attempts (reserved_at);

create table public.review_results (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null unique references public.review_attempts (id) on delete cascade,
  job_id uuid not null references public.review_jobs (id) on delete cascade,
  review_task_id uuid not null references public.review_tasks (id) on delete cascade,
  profile_id text not null references public.profiles (id) on delete cascade,
  head_sha text not null,
  base_sha text,
  merge_base_sha text,
  pr_body_hash text,
  review_config_version text not null,
  manual_generation integer not null,
  provider text not null,
  cli_version text,
  structured boolean not null,
  quality_status text not null check (quality_status in ('complete', 'partial', 'unstructured')),
  summary text,
  result jsonb,
  raw_output text,
  findings_count integer,
  max_severity text check (max_severity in ('critical', 'high', 'medium', 'low', 'info')),
  result_hash text not null,
  body_deleted_at timestamptz,
  created_at timestamptz not null default now()
);

create index review_results_task_idx on public.review_results (review_task_id, created_at desc);

alter table public.review_tasks
  add constraint review_tasks_current_result_fk
  foreign key (current_result_id) references public.review_results (id) on delete set null;
alter table public.review_tasks
  add constraint review_tasks_acked_result_fk
  foreign key (acked_result_id) references public.review_results (id) on delete set null;

-- ---------------------------------------------------------------------------
-- 操作履歴・通知
-- ---------------------------------------------------------------------------
create table public.task_operations (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null,
  operation_id text not null check (char_length(operation_id) between 8 and 128),
  op_type text not null,
  review_task_id uuid references public.review_tasks (id) on delete cascade,
  profile_id text references public.profiles (id) on delete cascade,
  target_result_id uuid,
  target_generation integer,
  target_job_id uuid,
  request_hash text not null,
  revision_before bigint,
  revision_after bigint,
  outcome text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  unique (actor_id, operation_id)
);

create index task_operations_task_idx on public.task_operations (review_task_id, created_at desc);

create table public.outbox_events (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles (id) on delete cascade,
  event_type text not null check (event_type in ('review_results', 'ops_alert')),
  idempotency_key text not null,
  destination_worker_id text not null references public.workers (id) on delete cascade,
  scheduled_slot_at timestamptz,
  payload jsonb not null,
  state text not null default 'pending' check (
    state in ('pending', 'claimed', 'delivered', 'failed', 'unknown', 'cancelled', 'superseded')
  ),
  hold_reason text,
  claim_token uuid,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  delivered_at timestamptz,
  delivery_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_type, idempotency_key)
);

create index outbox_events_dest_idx on public.outbox_events (destination_worker_id, state, next_attempt_at);

-- ---------------------------------------------------------------------------
-- 同期状態・レート制限
-- ---------------------------------------------------------------------------
create table public.profile_sync_states (
  profile_id text primary key references public.profiles (id) on delete cascade,
  last_discovery_at timestamptz,
  last_discovery_success_at timestamptz,
  discovery_status text,
  discovery_error text,
  incomplete_scopes jsonb not null default '[]'::jsonb,
  last_planned_slot_at timestamptz,
  updated_at timestamptz not null default now()
);

create table public.github_rate_limits (
  owner_id uuid not null references public.app_users (user_id) on delete cascade,
  github_host text not null,
  principal text not null,
  resource text not null,
  limit_value integer,
  remaining integer,
  reset_at timestamptz,
  blocked_until timestamptz,
  wait_reason text,
  observed_at timestamptz not null default now(),
  primary key (owner_id, github_host, principal, resource)
);

-- ---------------------------------------------------------------------------
-- 本人アカウントと worker アカウントを兼用させない（10.3）
-- ---------------------------------------------------------------------------
create function private.check_principal_separation() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name = 'workers' then
    if new.auth_user_id is not null
       and exists (select 1 from public.app_users u where u.user_id = new.auth_user_id) then
      raise exception 'kakari: worker account must not be an app user' using errcode = '23514';
    end if;
  elsif tg_table_name = 'app_users' then
    if exists (select 1 from public.workers w where w.auth_user_id = new.user_id) then
      raise exception 'kakari: app user must not be a worker account' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create trigger workers_principal_separation
  before insert or update of auth_user_id on public.workers
  for each row execute function private.check_principal_separation();

create trigger app_users_principal_separation
  before insert or update of user_id on public.app_users
  for each row execute function private.check_principal_separation();

-- 同じworkerに notifier と review 系の役割を混在させない（13.3）
alter table public.workers add constraint workers_notifier_separated check (
  not ('notifier' = any (roles)) or roles = array['notifier']::text[]
);
