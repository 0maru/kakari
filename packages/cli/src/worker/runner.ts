import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { normalizeReviewOutput } from '@kakari/shared';
import type { KakariConfig, ProfileConfig } from '../config/schema.ts';
import { type GitHubClient, GitHubError } from '../github/client.ts';
import { type Snapshot, SnapshotError, type SnapshotRequest } from '../input/snapshot.ts';
import type { Logger } from '../log.ts';
import type { ReviewProvider } from '../providers/types.ts';
import type { AcquiredJob, CompletePayload, WorkerDb } from './db-api.ts';
import { bodyHash } from './detector.ts';
import type { ExecutionJournal } from './journal.ts';

export interface RunnerDeps {
  db: WorkerDb;
  journal: ExecutionJournal;
  config: KakariConfig;
  github: (profile: ProfileConfig) => GitHubClient;
  provider: (profile: ProfileConfig) => Promise<ReviewProvider>;
  prompt: (profile: ProfileConfig) => Promise<string>;
  snapshot: (
    profile: ProfileConfig,
    req: Omit<SnapshotRequest, 'gitPath' | 'cacheDir' | 'token'>,
  ) => Promise<Snapshot>;
  runsDir: string;
  log: Logger;
  /** 実行権の更新間隔 */
  heartbeatMs: number;
  /** DB保存の再試行（AC-09） */
  saveRetryDelaysMs?: number[];
}

export type RunOnceResult =
  | { status: 'idle' | 'no_capacity' | 'daily_limit' | 'pool_blocked' }
  | { status: 'released'; jobId: string; disposition: string; reason: string }
  | {
      status: 'completed';
      jobId: string;
      outcome: string;
      dbStatus: string;
      resultId: string | null;
    }
  | { status: 'save_pending'; jobId: string };

interface TaskContext {
  repository_full_name: string;
  pr_number: number;
  reviewer_github_id: string;
  previous_review: unknown;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * ジョブを1件取得して実行する（7.1・9章）。
 * 重複実行しないことを、無条件に処理を継続することより優先する。
 */
export class ReviewRunner {
  private readonly deps: RunnerDeps;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
  }

  async runOnce(): Promise<RunOnceResult> {
    const acquired = await this.deps.db.acquireJob();
    if (acquired.status !== 'acquired') {
      return { status: acquired.status as 'idle' };
    }
    return this.execute(acquired as AcquiredJob);
  }

  private async loadTask(job: AcquiredJob['job']): Promise<TaskContext> {
    const { data, error } = await this.deps.db.client
      .from('review_tasks')
      .select(
        'reviewer_github_id, current_result_id, pull_requests(repository_full_name, pr_number)',
      )
      .eq('id', job.review_task_id)
      .single();
    if (error || !data)
      throw new Error(`レビュー項目を取得できません: ${error?.message ?? 'not found'}`);
    const pr = data.pull_requests as unknown as { repository_full_name: string; pr_number: number };
    let previous: unknown = null;
    if (data.current_result_id) {
      const r = await this.deps.db.client
        .from('review_results')
        .select('head_sha, summary, result, created_at')
        .eq('id', data.current_result_id)
        .maybeSingle();
      if (r.data?.result) previous = r.data;
    }
    return {
      repository_full_name: pr.repository_full_name,
      pr_number: pr.pr_number,
      reviewer_github_id: data.reviewer_github_id,
      previous_review: previous,
    };
  }

  private async release(
    a: AcquiredJob,
    disposition: 'requeue' | 'superseded' | 'cancelled' | 'blocked' | 'failed',
    errorClass: string,
    reason: string,
    extra: {
      retryAfterSeconds?: number;
      poolBlock?: { until: string | null; reason: string };
    } = {},
  ): Promise<RunOnceResult> {
    this.deps.log.info('job released before launch', {
      job: a.job.id,
      disposition,
      error_class: errorClass,
    });
    await this.deps.journal.append(a.execution_id, {
      type: 'released',
      at: new Date().toISOString(),
      disposition,
      reason,
    });
    await this.deps.db.releaseJob(
      a.execution_id,
      a.lease_token,
      disposition,
      errorClass,
      reason,
      extra.retryAfterSeconds,
      extra.poolBlock,
    );
    if (errorClass === 'blocked_auth' || errorClass === 'auth' || errorClass === 'usage_limit') {
      await this.deps.db
        .raiseOpsAlert(
          a.job.profile_id,
          `review_${errorClass}`,
          `AIレビューを保留しています: ${reason}`,
        )
        .catch(() => undefined);
    }
    return { status: 'released', jobId: a.job.id, disposition, reason };
  }

  private async execute(a: AcquiredJob): Promise<RunOnceResult> {
    const { log, journal, db } = this.deps;
    await journal.append(a.execution_id, {
      type: 'reserved',
      at: new Date().toISOString(),
      execution_id: a.execution_id,
      lease_token: a.lease_token,
      job_id: a.job.id,
      task_id: a.job.review_task_id,
      profile_id: a.job.profile_id,
      head_sha: a.job.head_sha,
      worker_id: db.workerId,
    });

    const abort = new AbortController();
    let leaseLost = false;
    const timer = setInterval(() => {
      db.renewLease(a.execution_id, a.lease_token)
        .then((r) => {
          if (!r.ok) {
            leaseLost = true;
            abort.abort();
          }
        })
        .catch((error) => {
          // DBへ接続できない間は実行権を維持できない。期限が切れたら安全停止する（9.4）
          log.warn('lease renewal failed', { job: a.job.id, error: (error as Error).message });
          if (Date.now() > new Date(a.lease_expires_at).getTime()) {
            leaseLost = true;
            abort.abort();
          }
        });
    }, this.deps.heartbeatMs);
    timer.unref();

    try {
      const profile = this.deps.config.profiles.find((p) => p.id === a.job.profile_id);
      if (!profile?.review.allowed_workers.includes(db.workerId)) {
        return await this.release(
          a,
          'blocked',
          'config',
          'このworkerの設定にプロファイルがありません',
        );
      }
      if (!profile.enabled || !profile.review.send_to_provider_approved) {
        return await this.release(
          a,
          'blocked',
          'safety',
          'プロファイルが無効、またはAIへの送信が許可されていません',
        );
      }
      const task = await this.loadTask(a.job);

      // CLI起動前にGitHubの状態を確認する（7.1・AC-12）
      const gh = this.deps.github(profile);
      const [owner, repo] = task.repository_full_name.split('/') as [string, string];
      let pr: Awaited<ReturnType<GitHubClient['getPull']>>;
      try {
        pr = await gh.getPull(owner, repo, task.pr_number);
        if (pr.head.sha !== a.job.head_sha) {
          return await this.release(
            a,
            'superseded',
            'head_changed',
            `headが ${pr.head.sha} に変わりました`,
          );
        }
        if (pr.state !== 'open' || pr.draft) {
          return await this.release(
            a,
            'cancelled',
            'not_eligible',
            'PRがopenかつ非draftではありません',
          );
        }
        const reviewers = await gh.getRequestedReviewers(owner, repo, task.pr_number);
        if (!reviewers.users.some((u) => String(u.id) === task.reviewer_github_id)) {
          return await this.release(
            a,
            'cancelled',
            'request_removed',
            'レビュー依頼が見つかりません',
          );
        }
      } catch (error) {
        const retryAt = error instanceof GitHubError ? error.retryAt : null;
        return await this.release(a, 'requeue', 'github_unavailable', (error as Error).message, {
          retryAfterSeconds: retryAt
            ? Math.max(60, Math.ceil((retryAt.getTime() - Date.now()) / 1000))
            : 300,
        });
      }

      // サブスク認証・安全性の確認（5.4）
      const provider = await this.deps.provider(profile);
      const preflight = await provider.preflight();
      if (!preflight.ok) {
        const errorClass = preflight.errorClass ?? 'blocked_auth';
        const blockPool = errorClass === 'blocked_auth' || errorClass === 'auth';
        return await this.release(
          a,
          'blocked',
          errorClass,
          preflight.message ?? 'preflight failed',
          {
            ...(blockPool
              ? { poolBlock: { until: null, reason: preflight.message ?? errorClass } }
              : {}),
          },
        );
      }

      // 入力の固定（7.3）
      let snapshot: Snapshot;
      try {
        snapshot = await this.deps.snapshot(profile, {
          outputDir: join(this.deps.runsDir, a.execution_id),
          host: profile.github.host,
          repositoryFullName: task.repository_full_name,
          prNumber: task.pr_number,
          headSha: a.job.head_sha,
          baseSha: pr.base.sha,
          maxInputBytes: profile.review.max_input_bytes,
          metadata: {
            repository: task.repository_full_name,
            pr_number: task.pr_number,
            title: pr.title,
            body: pr.body ?? '',
            author: pr.user?.login ?? null,
            head_ref: pr.head.ref,
            base_ref: pr.base.ref,
            fork: pr.head.repo?.full_name !== pr.base.repo.full_name,
            previous_review: task.previous_review,
          },
        });
      } catch (error) {
        const retryable = error instanceof SnapshotError ? error.retryable : true;
        return await this.release(
          a,
          retryable ? 'requeue' : 'failed',
          'input_error',
          (error as Error).message,
          {
            retryAfterSeconds: 300,
          },
        );
      }

      await journal.append(a.execution_id, {
        type: 'launching',
        at: new Date().toISOString(),
        input_hash: snapshot.inputHash,
        cli_version: preflight.cliVersion,
      });
      const marked = await db.markLaunched(a.execution_id, a.lease_token, {
        head_sha: a.job.head_sha,
        base_sha: snapshot.baseSha,
        merge_base_sha: snapshot.mergeBaseSha,
        manifest: {
          included_files: snapshot.manifest.included.length,
          excluded: snapshot.manifest.excluded,
          untrusted_config: snapshot.manifest.untrusted_config,
          diff: snapshot.manifest.diff,
          limitations: snapshot.manifest.limitations,
        },
        input_hash: snapshot.inputHash,
        cli_version: preflight.cliVersion,
      });
      if (!marked.ok) {
        // 実行権を失っている。CLIは起動しない。
        await journal.append(a.execution_id, {
          type: 'released',
          at: new Date().toISOString(),
          disposition: 'lease_lost',
          reason: `job status ${marked.status ?? 'unknown'}`,
        });
        return {
          status: 'released',
          jobId: a.job.id,
          disposition: 'lease_lost',
          reason: 'lease lost',
        };
      }
      await journal.append(a.execution_id, {
        type: 'launched',
        at: new Date().toISOString(),
        pid: null,
      });
      log.info('review started', {
        job: a.job.id,
        execution: a.execution_id,
        head: a.job.head_sha.slice(0, 7),
      });

      const exec = await provider.run(
        {
          executionId: a.execution_id,
          dir: snapshot.dir,
          prompt: await this.deps.prompt(profile),
          timeoutMs: a.execution_timeout_seconds * 1000,
          model: profile.review.model,
        },
        abort.signal,
      );

      const payload = this.toPayload(
        exec,
        preflight.cliVersion,
        snapshot,
        leaseLost,
        bodyHash(pr.body),
      );
      await journal.append(a.execution_id, {
        type: 'finished',
        at: new Date().toISOString(),
        payload,
      });
      log.info('review finished', {
        job: a.job.id,
        outcome: exec.outcome,
        error_class: exec.errorClass,
      });
      if (exec.errorClass === 'usage_limit' || exec.errorClass === 'auth') {
        await db
          .raiseOpsAlert(
            a.job.profile_id,
            `review_${exec.errorClass}`,
            exec.errorMessage ?? exec.errorClass,
          )
          .catch(() => undefined);
      }
      return await this.save(a.execution_id, a.lease_token, a.job.id, payload);
    } finally {
      clearInterval(timer);
    }
  }

  private toPayload(
    exec: Awaited<ReturnType<ReviewProvider['run']>>,
    cliVersion: string | null,
    snapshot: Snapshot,
    leaseLost: boolean,
    prBodyHash: string,
  ): CompletePayload {
    const base = {
      provider_session_id: exec.sessionId,
      cli_version: cliVersion,
      usage: exec.usage,
    };
    if (exec.outcome === 'succeeded') {
      const normalized = normalizeReviewOutput(exec.structured);
      const result = normalized.result
        ? {
            ...normalized.result,
            // 入力側で把握している制限を必ず残す
            limitations: [...normalized.result.limitations, ...snapshot.manifest.limitations],
          }
        : null;
      return {
        ...base,
        outcome: 'succeeded',
        result: {
          structured: normalized.structured,
          quality_status:
            normalized.structured &&
            snapshot.manifest.limitations.length > 0 &&
            normalized.qualityStatus === 'complete'
              ? 'partial'
              : normalized.qualityStatus,
          summary: normalized.summary,
          result,
          raw_output: exec.rawOutput,
          findings_count: normalized.findingsCount,
          max_severity: normalized.maxSeverity,
          result_hash: sha256(exec.rawOutput),
          pr_body_hash: prBodyHash,
        },
      };
    }
    const errorClass = leaseLost ? 'lease_lost' : (exec.errorClass ?? 'cli_error');
    return {
      ...base,
      outcome: exec.outcome,
      error_class: errorClass,
      error_message: exec.errorMessage ?? null,
      pool_block:
        exec.errorClass === 'usage_limit' || exec.errorClass === 'auth'
          ? {
              until: exec.retryAt ? exec.retryAt.toISOString() : null,
              reason: exec.errorMessage ?? exec.errorClass,
            }
          : null,
    };
  }

  /** 結果をDBへ保存する。失敗してもAIは呼び直さず、保存だけを再試行する（AC-09） */
  async save(
    executionId: string,
    leaseToken: string,
    jobId: string,
    payload: CompletePayload,
  ): Promise<RunOnceResult> {
    const delays = this.deps.saveRetryDelaysMs ?? [1000, 5000, 15000];
    let lastError: unknown = null;
    for (let i = 0; i <= delays.length; i++) {
      try {
        const res = await this.deps.db.completeAttempt(executionId, leaseToken, payload);
        await this.deps.journal.append(executionId, {
          type: 'recorded',
          at: new Date().toISOString(),
          status: res.status,
          result_id: res.result_id ?? null,
        });
        return {
          status: 'completed',
          jobId,
          outcome: payload.outcome,
          dbStatus: res.status,
          resultId: res.result_id ?? null,
        };
      } catch (error) {
        lastError = error;
        const kind = (error as { kind?: string }).kind;
        if (kind === 'forbidden' || kind === 'invalid') break;
        const delay = delays[i];
        if (delay !== undefined) await sleep(delay);
      }
    }
    this.deps.log.error('result save failed; kept in local journal', {
      job: jobId,
      execution: executionId,
      error: (lastError as Error)?.message,
    });
    return { status: 'save_pending', jobId };
  }

  /** 未保存の退避結果をDBへ保存し直す */
  async flushPending(): Promise<number> {
    let saved = 0;
    for (const s of await this.deps.journal.pendingUploads()) {
      if (!s.reserved || !s.finished) continue;
      const res = await this.save(
        s.executionId,
        s.reserved.lease_token,
        s.reserved.job_id,
        s.finished.payload,
      );
      if (res.status === 'completed') saved++;
    }
    return saved;
  }
}
