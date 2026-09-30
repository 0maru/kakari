import { randomUUID } from 'node:crypto';
import type { Database, KakariClient } from '@kakari/shared';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { inject } from 'vitest';

export const env = inject('supabase');

export const sql = new pg.Pool({ connectionString: env.dbUrl, max: 4 });

const admin = createClient<Database>(env.apiUrl, env.secretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export function sha(ch: string): string {
  return ch.repeat(40);
}

export const TABLES = [
  'outbox_events',
  'task_operations',
  'review_results',
  'review_attempts',
  'review_jobs',
  'review_request_signals',
  'review_tasks',
  'pull_requests',
  'profile_sync_states',
  'github_rate_limits',
  'worker_profiles',
  'profiles',
  'workers',
  'usage_pools',
  'app_users',
];

export async function resetData(): Promise<void> {
  await sql.query(
    `update public.review_tasks set current_result_id = null, acked_result_id = null`,
  );
  await sql.query(`truncate ${TABLES.map((t) => `public.${t}`).join(', ')} cascade`);
  await sql.query(`delete from auth.users where email like '%@kakari.test'`);
  await sql.query(
    `update public.app_settings set timezone = 'UTC', max_concurrent_reviews = 1, max_auto_starts_per_day = 10,
       debounce_seconds = 0, lease_seconds = 300, execution_timeout_seconds = 1800, max_auto_retries = 3`,
  );
}

async function createUser(label: string): Promise<{ id: string; email: string; password: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@kakari.test`;
  const password = `pw-${randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error('createUser failed');
  return { id: data.user.id, email, password };
}

export function anonClient(): KakariClient {
  return createClient<Database>(env.apiUrl, env.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function signedIn(user: { email: string; password: string }): Promise<KakariClient> {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword(user);
  if (error) throw error;
  return client;
}

export interface World {
  ownerId: string;
  owner: KakariClient;
  worker: KakariClient;
  /** 同じworkerアカウントの別プロセス */
  worker2: KakariClient;
  notifier: KakariClient;
  other: KakariClient;
  otherWorker: KakariClient;
  anon: KakariClient;
}

export const PROFILE = 'default';
export const WORKER = 'review-worker-1';
export const NOTIFIER = 'notification-client-1';
export const OTHER_WORKER = 'other-worker';

/** 本人・レビューworker・通知クライアント・別の利用者を用意する */
export async function createWorld(): Promise<World> {
  await resetData();
  const [owner, worker, notifier, other, otherWorker] = await Promise.all([
    createUser('owner'),
    createUser('worker'),
    createUser('notifier'),
    createUser('other'),
    createUser('otherworker'),
  ]);
  await sql.query('insert into public.app_users (user_id) values ($1), ($2)', [owner.id, other.id]);
  await sql.query(
    `insert into public.usage_pools (id, owner_id, provider, max_concurrent) values
       ('pool-a', $1, 'claude', 1), ('pool-other', $2, 'claude', 1)`,
    [owner.id, other.id],
  );
  await sql.query(
    `insert into public.workers (id, owner_id, auth_user_id, roles) values
       ($1, $2, $3, array['detector','reviewer','notification_planner']),
       ($4, $2, $5, array['notifier']),
       ($6, $7, $8, array['detector','reviewer','notification_planner'])`,
    [WORKER, owner.id, worker.id, NOTIFIER, notifier.id, OTHER_WORKER, other.id, otherWorker.id],
  );
  await sql.query(
    `insert into public.profiles (id, owner_id, name, enabled, github_host, reviewer_login, reviewer_github_id,
       provider, review_config_version, usage_pool_id, notify_destination_worker_id, notify_detail_level)
     values
       ($1, $2, 'Default', true, 'github.com', 'alice', '1001', 'claude', 'review-v1', 'pool-a', $3, 'title'),
       ('other', $4, 'Other', true, 'github.com', 'carol', '2002', 'claude', 'review-v1', 'pool-other', null, 'repository')`,
    [PROFILE, owner.id, NOTIFIER, other.id],
  );
  await sql.query(
    `insert into public.worker_profiles (worker_id, profile_id) values ($1, $2), ($3, 'other')`,
    [WORKER, PROFILE, OTHER_WORKER],
  );
  const [ownerC, workerC, worker2C, notifierC, otherC, otherWorkerC] = await Promise.all([
    signedIn(owner),
    signedIn(worker),
    signedIn(worker),
    signedIn(notifier),
    signedIn(other),
    signedIn(otherWorker),
  ]);
  return {
    ownerId: owner.id,
    owner: ownerC,
    worker: workerC,
    worker2: worker2C,
    notifier: notifierC,
    other: otherC,
    otherWorker: otherWorkerC,
    anon: anonClient(),
  };
}

// biome-ignore lint/suspicious/noExplicitAny: テスト用の汎用RPC呼び出し
export async function rpc<T = any>(
  client: KakariClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<T> {
  // biome-ignore lint/suspicious/noExplicitAny: 任意の関数名を呼ぶため
  const { data, error } = await (client.rpc as any)(fn, args);
  if (error) {
    const err = new Error(`${fn}: ${error.message}`) as Error & { code?: string };
    err.code = error.code;
    throw err;
  }
  return data as T;
}

export function prPayload(overrides: Record<string, unknown> = {}) {
  return {
    github_host: 'github.com',
    repository_id: '500',
    repository_full_name: 'example-org/app',
    pr_number: 12,
    url: 'https://github.com/example-org/app/pull/12',
    title: 'Add feature',
    author_login: 'bob',
    head_sha: sha('a'),
    head_ref: 'feature',
    base_sha: sha('b'),
    base_ref: 'main',
    body_hash: 'body-1',
    state: 'open',
    draft: false,
    ...overrides,
  };
}

export function requestPayload(overrides: Record<string, unknown> = {}) {
  return {
    reviewer_github_id: '1001',
    reviewer_login: 'alice',
    requested: true,
    request_event: { id: '9001', created_at: '2026-09-29T00:00:00Z' },
    review: null,
    ...overrides,
  };
}

export function syncPr(
  client: KakariClient,
  pr: Record<string, unknown> = {},
  request: Record<string, unknown> = {},
  profile = PROFILE,
  worker = WORKER,
) {
  return rpc(client, 'worker_sync_pull_request', {
    p_worker_id: worker,
    p_profile_id: profile,
    p_pr: prPayload(pr),
    p_request: requestPayload(request),
  });
}

export function acquire(client: KakariClient, worker = WORKER) {
  return rpc(client, 'worker_acquire_job', { p_worker_id: worker });
}

export function launch(client: KakariClient, acquired: AcquiredJob) {
  return rpc(client, 'worker_mark_launched', {
    p_worker_id: WORKER,
    p_execution_id: acquired.execution_id,
    p_lease_token: acquired.lease_token,
    p_snapshot: {
      head_sha: acquired.job.head_sha,
      base_sha: acquired.job.base_sha,
      merge_base_sha: acquired.job.base_sha,
      manifest: { files: [] },
      input_hash: 'input-hash',
      cli_version: '2.1.0',
    },
  });
}

export interface AcquiredJob {
  status: 'acquired';
  execution_id: string;
  lease_token: string;
  job: { id: string; head_sha: string; base_sha: string; review_task_id: string };
}

export function successPayload(summary = 'ok') {
  return {
    outcome: 'succeeded',
    cli_version: '2.1.0',
    provider_session_id: 'sess-1',
    result: {
      structured: true,
      quality_status: 'complete',
      summary,
      result: {
        schema_version: 1,
        summary,
        findings: [],
        questions: [],
        limitations: [],
        quality_status: 'complete',
      },
      raw_output: '{}',
      findings_count: 0,
      max_severity: null,
      result_hash: `hash-${summary}`,
      pr_body_hash: 'body-1',
    },
  };
}

export function complete(client: KakariClient, acquired: AcquiredJob, payload = successPayload()) {
  return rpc(client, 'worker_complete_attempt', {
    p_worker_id: WORKER,
    p_execution_id: acquired.execution_id,
    p_lease_token: acquired.lease_token,
    p_payload: payload,
  });
}

/** 検出 → 実行 → 結果保存まで進める */
export async function runReview(world: World, summary = 'ok') {
  const acquired = (await acquire(world.worker)) as AcquiredJob;
  if (acquired.status !== 'acquired') throw new Error(`not acquired: ${JSON.stringify(acquired)}`);
  await launch(world.worker, acquired);
  const done = await complete(world.worker, acquired, successPayload(summary));
  return { acquired, done };
}

export async function overview(client: KakariClient, taskId: string) {
  const { data, error } = await client
    .from('task_overview')
    .select('*')
    .eq('task_id', taskId)
    .single();
  if (error) throw error;
  return data;
}

export async function jobsOf(taskId: string) {
  const { rows } = await sql.query(
    'select * from public.review_jobs where review_task_id = $1 order by created_at',
    [taskId],
  );
  return rows;
}
