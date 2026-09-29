import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from './database.types.ts';
import type { DisplayState } from './display.ts';
import { KakariError, toKakariError } from './errors.ts';

export type KakariClient = SupabaseClient<Database>;

type PublicSchema = Database['public'];
export type TaskOverview = PublicSchema['Views']['task_overview']['Row'];
export type ReviewResultRow = PublicSchema['Tables']['review_results']['Row'];
export type ReviewJobRow = PublicSchema['Tables']['review_jobs']['Row'];
export type ReviewAttemptRow = PublicSchema['Tables']['review_attempts']['Row'];
export type TaskOperationRow = PublicSchema['Tables']['task_operations']['Row'];
export type RequestSignalRow = PublicSchema['Tables']['review_request_signals']['Row'];
export type ProfileRow = PublicSchema['Tables']['profiles']['Row'];
export type WorkerRow = PublicSchema['Tables']['workers']['Row'];
export type UsagePoolRow = PublicSchema['Tables']['usage_pools']['Row'];
export type ProfileSyncStateRow = PublicSchema['Tables']['profile_sync_states']['Row'];
export type RateLimitRow = PublicSchema['Tables']['github_rate_limits']['Row'];
export type OutboxEventRow = PublicSchema['Tables']['outbox_events']['Row'];

export const DEFAULT_PAGE_SIZE = 50;

/** 操作IDを作る。送信前にローカルへ保存し、同じ要求の再送に使う（16.1）。 */
export function newOperationId(): string {
  return `op-${crypto.randomUUID()}`;
}

// ---------------------------------------------------------------------------
// 読み取り
// ---------------------------------------------------------------------------

export interface TaskListFilter {
  profileId?: string | undefined;
  repository?: string | undefined;
  displayStates?: readonly DisplayState[] | undefined;
  /** 未確認の最新結果があるものだけ */
  unackedOnly?: boolean | undefined;
  /** 1始まり */
  page?: number | undefined;
  pageSize?: number | undefined;
}

export interface TaskListPage {
  rows: TaskOverview[];
  total: number | null;
  page: number;
  pageSize: number;
}

export async function listTasks(
  client: KakariClient,
  filter: TaskListFilter = {},
): Promise<TaskListPage> {
  const page = Math.max(1, Math.floor(filter.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Math.floor(filter.pageSize ?? DEFAULT_PAGE_SIZE)));
  let query = client.from('task_overview').select('*', { count: 'exact' });
  if (filter.profileId) query = query.eq('profile_id', filter.profileId);
  if (filter.repository) query = query.eq('repository_full_name', filter.repository);
  if (filter.displayStates && filter.displayStates.length > 0) {
    query = query.in('display_state', [...filter.displayStates]);
  }
  if (filter.unackedOnly) query = query.eq('display_state', 'awaiting_ack');
  // 安定した並び順: 未確認を先頭に、同じ区分では更新日時の新しい順
  query = query
    .order('sort_group', { ascending: true })
    .order('updated_at', { ascending: false })
    .order('task_id', { ascending: true })
    .range((page - 1) * pageSize, page * pageSize - 1);
  const { data, error, count } = await query;
  if (error) throw toKakariError(error);
  return { rows: data ?? [], total: count ?? null, page, pageSize };
}

export type ResultSummaryRow = Omit<ReviewResultRow, 'result' | 'raw_output'>;

export interface TaskDetail {
  task: TaskOverview;
  results: ResultSummaryRow[];
  jobs: ReviewJobRow[];
  attempts: ReviewAttemptRow[];
  operations: TaskOperationRow[];
  signals: RequestSignalRow[];
}

const RESULT_SUMMARY_COLUMNS =
  'id, attempt_id, job_id, review_task_id, profile_id, head_sha, base_sha, merge_base_sha, pr_body_hash, review_config_version, manual_generation, provider, cli_version, structured, quality_status, summary, findings_count, max_severity, result_hash, body_deleted_at, created_at';

export async function getTaskDetail(client: KakariClient, taskId: string): Promise<TaskDetail> {
  const { data: task, error } = await client
    .from('task_overview')
    .select('*')
    .eq('task_id', taskId)
    .maybeSingle();
  if (error) throw toKakariError(error);
  if (!task) throw new KakariError('not_found', 'task not found');

  const [results, jobs, operations, signals] = await Promise.all([
    client
      .from('review_results')
      .select(RESULT_SUMMARY_COLUMNS)
      .eq('review_task_id', taskId)
      .order('created_at', { ascending: false })
      .limit(100),
    client
      .from('review_jobs')
      .select('*')
      .eq('review_task_id', taskId)
      .order('created_at', { ascending: false })
      .limit(100),
    client
      .from('task_operations')
      .select('*')
      .eq('review_task_id', taskId)
      .order('created_at', { ascending: false })
      .limit(100),
    client
      .from('review_request_signals')
      .select('*')
      .eq('review_task_id', taskId)
      .order('observed_at', { ascending: false })
      .limit(100),
  ]);
  for (const r of [results, jobs, operations, signals]) {
    if (r.error) throw toKakariError(r.error);
  }
  const jobIds = (jobs.data ?? []).map((j) => j.id);
  let attempts: ReviewAttemptRow[] = [];
  if (jobIds.length > 0) {
    const a = await client
      .from('review_attempts')
      .select('*')
      .in('job_id', jobIds)
      .order('reserved_at', { ascending: false });
    if (a.error) throw toKakariError(a.error);
    attempts = a.data ?? [];
  }
  return {
    task,
    results: (results.data ?? []) as ResultSummaryRow[],
    jobs: jobs.data ?? [],
    attempts,
    operations: operations.data ?? [],
    signals: signals.data ?? [],
  };
}

export async function getResult(client: KakariClient, resultId: string): Promise<ReviewResultRow> {
  const { data, error } = await client
    .from('review_results')
    .select('*')
    .eq('id', resultId)
    .maybeSingle();
  if (error) throw toKakariError(error);
  if (!data) throw new KakariError('not_found', 'result not found');
  return data;
}

// ---------------------------------------------------------------------------
// 状態変更（10.4）
// ---------------------------------------------------------------------------

export type OperationStatus =
  | 'applied'
  | 'recorded_only'
  | 'conflict'
  | 'rejected'
  | 'confirmation_required';

export interface OperationResponse {
  status: OperationStatus;
  operation_id: string;
  replayed: boolean;
  task_id?: string;
  revision?: number;
  job_id?: string;
  changed?: boolean;
  message?: string;
  [key: string]: unknown;
}

async function callOperation(
  client: KakariClient,
  fn: keyof PublicSchema['Functions'],
  args: Record<string, unknown>,
): Promise<OperationResponse> {
  // biome-ignore lint/suspicious/noExplicitAny: RPC名と引数は呼び出し側の関数で型付けしている
  const { data, error } = await (client.rpc as any)(fn, args);
  if (error) throw toKakariError(error);
  const response = data as OperationResponse | null;
  if (!response || typeof response !== 'object' || typeof response.status !== 'string') {
    throw new KakariError('unknown', 'unexpected operation response', data);
  }
  return response;
}

export interface AcknowledgeInput {
  taskId: string;
  resultId: string;
  requestGeneration: number;
  expectedRevision: number;
  operationId: string;
}

export function acknowledgeResult(client: KakariClient, input: AcknowledgeInput) {
  return callOperation(client, 'acknowledge_result', {
    p_task_id: input.taskId,
    p_result_id: input.resultId,
    p_request_generation: input.requestGeneration,
    p_expected_revision: input.expectedRevision,
    p_operation_id: input.operationId,
  });
}

export interface SnoozeInput {
  taskId: string;
  /** null で解除 */
  until: Date | null;
  expectedRevision: number;
  operationId: string;
}

export function setTaskSnooze(client: KakariClient, input: SnoozeInput) {
  return callOperation(client, 'set_task_snooze', {
    p_task_id: input.taskId,
    p_until: input.until ? input.until.toISOString() : null,
    p_expected_revision: input.expectedRevision,
    p_operation_id: input.operationId,
  });
}

export interface CompleteInput {
  taskId: string;
  requestGeneration: number;
  reason: string;
  expectedRevision: number;
  operationId: string;
}

export function completeReviewTask(client: KakariClient, input: CompleteInput) {
  return callOperation(client, 'complete_review_task', {
    p_task_id: input.taskId,
    p_request_generation: input.requestGeneration,
    p_reason: input.reason,
    p_expected_revision: input.expectedRevision,
    p_operation_id: input.operationId,
  });
}

export interface RetryInput {
  jobId: string;
  expectedRevision: number;
  acknowledgePossibleExtraUsage: boolean;
  operationId: string;
}

export function requestReviewRetry(client: KakariClient, input: RetryInput) {
  return callOperation(client, 'request_review_retry', {
    p_job_id: input.jobId,
    p_expected_revision: input.expectedRevision,
    p_confirm: {
      acknowledge_possible_extra_usage: input.acknowledgePossibleExtraUsage,
    } satisfies Json,
    p_operation_id: input.operationId,
  });
}

export interface ManualReviewInput {
  jobId: string;
  reason: string;
  expectedRevision: number;
  acknowledgeExtraUsage: boolean;
  operationId: string;
}

export function requestManualReview(client: KakariClient, input: ManualReviewInput) {
  return callOperation(client, 'request_manual_review', {
    p_job_id: input.jobId,
    p_reason: input.reason,
    p_expected_revision: input.expectedRevision,
    p_confirm: { acknowledge_extra_usage: input.acknowledgeExtraUsage } satisfies Json,
    p_operation_id: input.operationId,
  });
}

export function setProfilePaused(
  client: KakariClient,
  input: { profileId: string; paused: boolean; operationId: string },
) {
  return callOperation(client, 'set_profile_paused', {
    p_profile_id: input.profileId,
    p_paused: input.paused,
    p_operation_id: input.operationId,
  });
}

export function clearUsagePoolBlock(
  client: KakariClient,
  input: { poolId: string; operationId: string },
) {
  return callOperation(client, 'clear_usage_pool_block', {
    p_pool_id: input.poolId,
    p_operation_id: input.operationId,
  });
}

// ---------------------------------------------------------------------------
// 状態確認（kakari status / UIの同期情報）
// ---------------------------------------------------------------------------

export interface SystemStatus {
  profiles: ProfileRow[];
  workers: WorkerRow[];
  usagePools: UsagePoolRow[];
  syncStates: ProfileSyncStateRow[];
  rateLimits: RateLimitRow[];
  jobCounts: Record<string, number>;
  recentOutbox: OutboxEventRow[];
}

export async function getSystemStatus(
  client: KakariClient,
  profileId?: string,
): Promise<SystemStatus> {
  const profilesQ = client.from('profiles').select('*').order('id');
  const syncQ = client.from('profile_sync_states').select('*');
  const outboxQ = client
    .from('outbox_events')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20);
  const jobsQ = client.from('review_jobs').select('status, profile_id');
  const [profiles, workers, pools, sync, rateLimits, jobs, outbox] = await Promise.all([
    profileId ? profilesQ.eq('id', profileId) : profilesQ,
    client.from('workers').select('*').order('id'),
    client.from('usage_pools').select('*').order('id'),
    profileId ? syncQ.eq('profile_id', profileId) : syncQ,
    client.from('github_rate_limits').select('*').order('resource'),
    profileId
      ? jobsQ
          .eq('profile_id', profileId)
          .in('status', ['queued', 'running', 'blocked', 'unknown', 'failed'])
      : jobsQ.in('status', ['queued', 'running', 'blocked', 'unknown', 'failed']),
    profileId ? outboxQ.eq('profile_id', profileId) : outboxQ,
  ]);
  for (const r of [profiles, workers, pools, sync, rateLimits, jobs, outbox]) {
    if (r.error) throw toKakariError(r.error);
  }
  const jobCounts: Record<string, number> = {};
  for (const j of jobs.data ?? []) {
    jobCounts[j.status] = (jobCounts[j.status] ?? 0) + 1;
  }
  return {
    profiles: profiles.data ?? [],
    workers: workers.data ?? [],
    usagePools: pools.data ?? [],
    syncStates: sync.data ?? [],
    rateLimits: rateLimits.data ?? [],
    jobCounts,
    recentOutbox: outbox.data ?? [],
  };
}
