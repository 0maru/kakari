import { type Json, type KakariClient, toKakariError } from '@kakari/shared';

/** worker用DB関数の呼び出し。認可・状態遷移の検証はDB側で行う。 */
export class WorkerDb {
  readonly client: KakariClient;
  readonly workerId: string;

  constructor(client: KakariClient, workerId: string) {
    this.client = client;
    this.workerId = workerId;
  }

  private async call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    // biome-ignore lint/suspicious/noExplicitAny: 関数名は各メソッドで固定している
    const { data, error } = await (this.client.rpc as any)(fn, {
      p_worker_id: this.workerId,
      ...args,
    });
    if (error) throw toKakariError(error);
    return data as T;
  }

  heartbeat(capabilities?: Record<string, unknown>) {
    return this.call<{ worker_id: string; roles: string[]; profiles: string[]; now: string }>(
      'worker_heartbeat',
      { p_capabilities: (capabilities ?? null) as Json },
    );
  }

  setReviewerIdentity(profileId: string, githubId: string) {
    return this.call<null>('worker_set_reviewer_identity', {
      p_profile_id: profileId,
      p_github_id: githubId,
    });
  }

  recordDiscovery(profileId: string, status: string, error: string | null, incomplete: unknown[]) {
    return this.call<null>('worker_record_discovery', {
      p_profile_id: profileId,
      p_status: status,
      p_error: error,
      p_incomplete_scopes: incomplete,
    });
  }

  recordRateLimits(rows: unknown[]) {
    return this.call<null>('worker_record_rate_limits', { p_rows: rows });
  }

  syncPullRequest(profileId: string, pr: SyncPrPayload, request: SyncRequestPayload) {
    return this.call<SyncResult>('worker_sync_pull_request', {
      p_profile_id: profileId,
      p_pr: pr,
      p_request: request,
    });
  }

  markPullRequestSyncFailed(pullRequestId: string, status: string, error: string) {
    return this.call<null>('worker_mark_pull_request_sync_failed', {
      p_pull_request_id: pullRequestId,
      p_status: status,
      p_error: error,
    });
  }

  acquireJob() {
    return this.call<AcquireResult>('worker_acquire_job', {});
  }

  renewLease(executionId: string, leaseToken: string) {
    return this.call<{ ok: boolean; lease_expires_at?: string; status?: string }>(
      'worker_renew_lease',
      {
        p_execution_id: executionId,
        p_lease_token: leaseToken,
      },
    );
  }

  markLaunched(executionId: string, leaseToken: string, snapshot: Record<string, unknown>) {
    return this.call<{ ok: boolean; status?: string }>('worker_mark_launched', {
      p_execution_id: executionId,
      p_lease_token: leaseToken,
      p_snapshot: snapshot,
    });
  }

  releaseJob(
    executionId: string,
    leaseToken: string,
    disposition: 'requeue' | 'superseded' | 'cancelled' | 'blocked' | 'failed',
    errorClass: string,
    errorMessage: string,
    retryAfterSeconds?: number,
    poolBlock?: { until: string | null; reason: string },
  ) {
    return this.call<{ ok: boolean; status: string }>('worker_release_job', {
      p_execution_id: executionId,
      p_lease_token: leaseToken,
      p_disposition: disposition,
      p_error_class: errorClass,
      p_error_message: errorMessage,
      p_retry_after_seconds: retryAfterSeconds ?? null,
      p_pool_block: poolBlock ?? null,
    });
  }

  completeAttempt(executionId: string, leaseToken: string, payload: CompletePayload) {
    return this.call<CompleteResult>('worker_complete_attempt', {
      p_execution_id: executionId,
      p_lease_token: leaseToken,
      p_payload: payload,
    });
  }

  resolveUnknown(
    executionId: string,
    leaseToken: string,
    resolution: 'not_launched' | 'failed',
    message: string,
  ) {
    return this.call<{ ok: boolean; status?: string }>('worker_resolve_unknown', {
      p_execution_id: executionId,
      p_lease_token: leaseToken,
      p_resolution: resolution,
      p_error_message: message,
    });
  }

  blockUsagePool(poolId: string, until: string | null, reason: string) {
    return this.call<null>('worker_block_usage_pool', {
      p_pool_id: poolId,
      p_until: until,
      p_reason: reason,
    });
  }

  applyRetention() {
    return this.call<{ results_body_deleted: number; attempt_logs_cleared: number }>(
      'worker_apply_retention',
      {},
    );
  }

  planNotification(profileId: string, slotAt: Date, excludeStale = false) {
    return this.call<PlanResult>('worker_plan_notification', {
      p_profile_id: profileId,
      p_slot_at: slotAt.toISOString(),
      p_exclude_stale: excludeStale,
    });
  }

  raiseOpsAlert(profileId: string, kind: string, message: string) {
    return this.call<{ status: string }>('worker_raise_ops_alert', {
      p_profile_id: profileId,
      p_kind: kind,
      p_message: message,
    });
  }

  claimEvents(limit = 10) {
    return this.call<ClaimedEvent[]>('notifier_claim_events', { p_limit: limit });
  }

  recordDelivery(
    eventId: string,
    claimToken: string,
    outcome: 'delivered' | 'failed' | 'unknown',
    error?: string,
  ) {
    return this.call<{ ok: boolean; state?: string }>('notifier_record_delivery', {
      p_event_id: eventId,
      p_claim_token: claimToken,
      p_outcome: outcome,
      p_error: error ?? null,
    });
  }
}

export interface SyncPrPayload {
  github_host: string;
  repository_id: string;
  repository_full_name: string;
  pr_number: number;
  url: string;
  title: string;
  author_login: string | null;
  head_sha: string;
  head_ref: string;
  base_sha: string;
  base_ref: string;
  body_hash: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
}

export interface SyncRequestPayload {
  reviewer_github_id: string;
  reviewer_login: string;
  requested: boolean | null;
  request_event: { id: string; created_at: string } | null;
  review: {
    id: string;
    submitted_at: string | null;
    state: string;
    commit_id: string | null;
  } | null;
}

export interface SyncResult {
  pull_request_id: string;
  task_id: string | null;
  task_created: boolean;
  generation_changed?: boolean;
  human_state_changed?: boolean;
  head_changed?: boolean;
  request_generation?: number;
  job_id?: string | null;
  job_created?: boolean;
}

export interface AcquiredJob {
  status: 'acquired';
  execution_id: string;
  attempt_number: number;
  lease_token: string;
  lease_expires_at: string;
  execution_timeout_seconds: number;
  usage_pool_id: string;
  job: {
    id: string;
    review_task_id: string;
    profile_id: string;
    head_sha: string;
    base_sha: string | null;
    review_config_version: string;
    provider: string;
    manual_generation: number;
    manual_reason: string | null;
  };
}

export type AcquireResult =
  | AcquiredJob
  | { status: 'idle' | 'no_capacity' | 'daily_limit' | 'pool_blocked'; [k: string]: unknown };

export interface CompletePayload {
  outcome: 'succeeded' | 'failed' | 'timeout';
  provider_session_id?: string | null;
  cli_version?: string | null;
  usage?: unknown;
  error_class?: string | null;
  error_message?: string | null;
  pool_block?: { until: string | null; reason: string } | null;
  result?: {
    structured: boolean;
    quality_status: string;
    summary: string | null;
    result: unknown;
    raw_output: string;
    findings_count: number | null;
    max_severity: string | null;
    result_hash: string;
    pr_body_hash: string | null;
  };
}

export interface CompleteResult {
  status: 'recorded' | 'already_recorded' | 'rejected';
  job_status?: string;
  result_id?: string | null;
  adopted?: boolean;
  late?: boolean;
  reason?: string;
}

export type PlanResult =
  | { status: 'planned'; event_id: string; count: number; excluded_stale: number }
  | { status: 'needs_sync'; pull_request_ids: string[] }
  | { status: 'nothing' | 'already_planned' | 'no_destination'; excluded_stale?: number };

export interface NotificationItem {
  task_id: string;
  result_id: string;
  request_generation: number;
  head_sha: string;
  previously_notified: boolean;
  repository_full_name?: string;
  pr_number?: number;
  pr_title?: string;
}

export interface ClaimedEvent {
  event_id: string;
  event_type: 'review_results' | 'ops_alert';
  claim_token: string;
  scheduled_slot_at: string | null;
  payload: {
    profile_id: string;
    profile_name: string;
    counts?: { total: number; new: number; carried_over: number };
    items?: NotificationItem[];
    detail_level?: string;
    kind?: string;
    message?: string;
  };
}
