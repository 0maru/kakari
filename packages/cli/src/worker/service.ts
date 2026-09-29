import { join } from 'node:path';
import { resolveConfigRelative } from '../config/load.ts';
import type { ProfileConfig, WorkerConfig } from '../config/schema.ts';
import { type AppContext, githubClient, githubTransport } from '../context.ts';
import type { GhTransport } from '../github/transport.ts';
import { prepareSnapshot, pruneSnapshots } from '../input/snapshot.ts';
import { NotificationPlanner } from '../notify/planner.ts';
import { ClaudeProvider } from '../providers/claude.ts';
import { buildPrompt } from '../providers/prompt.ts';
import type { ReviewProvider } from '../providers/types.ts';
import type { WorkerDb } from './db-api.ts';
import {
  Detector,
  type DetectorSink,
  type DetectorSource,
  type TrackedPullRequest,
} from './detector.ts';
import { ExecutionJournal } from './journal.ts';
import { ReviewRunner } from './runner.ts';

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

const jitter = (ms: number) => ms + Math.floor(Math.random() * ms * 0.1);

export function dbSource(db: WorkerDb): DetectorSource {
  return {
    async reviewerGithubId(profileId) {
      const { data, error } = await db.client
        .from('profiles')
        .select('reviewer_github_id')
        .eq('id', profileId)
        .single();
      if (error) throw new Error(`プロファイルを取得できません: ${error.message}`);
      return data.reviewer_github_id;
    },
    async trackedPullRequests(profileId) {
      const { data, error } = await db.client
        .from('review_tasks')
        .select(
          'human_state, request_state, pull_requests(id, repository_full_name, pr_number, state, sync_status)',
        )
        .eq('profile_id', profileId);
      if (error) throw new Error(`追跡中のPRを取得できません: ${error.message}`);
      const out = new Map<string, TrackedPullRequest>();
      for (const row of data ?? []) {
        const pr = row.pull_requests as unknown as {
          id: string;
          repository_full_name: string;
          pr_number: number;
          state: string;
          sync_status: string;
        } | null;
        if (!pr) continue;
        const active =
          row.human_state === 'open' && row.request_state !== 'removed' && pr.state === 'open';
        if (active || pr.sync_status !== 'ok') {
          out.set(pr.id, {
            id: pr.id,
            repository_full_name: pr.repository_full_name,
            pr_number: pr.pr_number,
          });
        }
      }
      return [...out.values()];
    },
  };
}

export function dbSink(db: WorkerDb): DetectorSink {
  return {
    setReviewerIdentity: async (p, id) => {
      await db.setReviewerIdentity(p, id);
    },
    recordDiscovery: async (p, s, e, i) => {
      await db.recordDiscovery(p, s, e, i);
    },
    syncPullRequest: (p, pr, req) => db.syncPullRequest(p, pr, req),
    markPullRequestSyncFailed: async (id, s, e) => {
      await db.markPullRequestSyncFailed(id, s, e);
    },
  };
}

export async function createProvider(
  ctx: AppContext,
  profile: ProfileConfig,
): Promise<ReviewProvider> {
  if (profile.review.provider !== 'claude') {
    throw new Error(`provider ${profile.review.provider} は未実装です`);
  }
  return new ClaudeProvider({
    claudePath: await ctx.binaries.require('claude'),
    allowedAuthMethods: profile.review.allowed_auth_methods,
    oauthToken: profile.review.credential_ref
      ? await ctx.secrets.resolveRef(profile.review.credential_ref)
      : undefined,
    parentEnv: ctx.env,
  });
}

/**
 * 常駐プロセス（kakari run）。workerの役割に応じて検出・レビュー・通知準備を動かす。
 * UIやブラウザを閉じても停止しない（4章）。
 */
export class WorkerService {
  private transport: GhTransport | null = null;
  private readonly journal: ExecutionJournal;
  private readonly runsDir: string;

  private readonly ctx: AppContext;
  private readonly worker: WorkerConfig;
  private readonly db: WorkerDb;

  constructor(ctx: AppContext, worker: WorkerConfig, db: WorkerDb) {
    this.ctx = ctx;
    this.worker = worker;
    this.db = db;
    this.journal = new ExecutionJournal(join(ctx.loaded.stateDir, 'journal', worker.id));
    this.runsDir = join(ctx.loaded.stateDir, 'runs');
  }

  private profiles(): ProfileConfig[] {
    return this.ctx.loaded.config.profiles.filter(
      (p) => p.enabled && this.worker.allowed_profiles.includes(p.id),
    );
  }

  private async gh(profile: ProfileConfig) {
    this.transport ??= await githubTransport(this.ctx);
    return githubClient(this.ctx, profile, this.transport);
  }

  async detector(profile: ProfileConfig): Promise<Detector> {
    return new Detector(
      await this.gh(profile),
      profile,
      dbSource(this.db),
      dbSink(this.db),
      this.ctx.log,
    );
  }

  async runner(): Promise<ReviewRunner> {
    const gitPath = await this.ctx.binaries.require('git');
    const cacheDir = join(this.ctx.loaded.stateDir, 'cache');
    if (!this.transport) this.transport = await githubTransport(this.ctx);
    const transport = this.transport;
    return new ReviewRunner({
      db: this.db,
      journal: this.journal,
      config: this.ctx.loaded.config,
      github: (profile) => githubClient(this.ctx, profile, transport),
      provider: (profile) => createProvider(this.ctx, profile),
      prompt: (profile) =>
        buildPrompt(
          profile.review.prompt_file
            ? resolveConfigRelative(this.ctx.loaded, profile.review.prompt_file)
            : undefined,
        ),
      snapshot: async (profile, req) =>
        prepareSnapshot({
          ...req,
          gitPath,
          cacheDir,
          token: await this.ctx.secrets.resolveRef(profile.github.auth.credential_ref, {
            host: profile.github.host,
          }),
          parentEnv: this.ctx.env,
        }),
      runsDir: this.runsDir,
      log: this.ctx.log,
      heartbeatMs: this.ctx.loaded.config.global.heartbeat_seconds * 1000,
    });
  }

  async run(signal: AbortSignal, extraLoops: Promise<void>[] = []): Promise<void> {
    const { log } = this.ctx;
    const g = this.ctx.loaded.config.global;
    const loops: Promise<void>[] = [...extraLoops];
    log.info('worker started', { worker: this.worker.id, roles: this.worker.roles.join(',') });

    loops.push(
      this.loop('heartbeat', g.heartbeat_seconds * 1000, signal, async () => {
        await this.db.heartbeat({
          roles: this.worker.roles,
          platform: process.platform,
          node: process.version,
        });
      }),
    );

    if (this.worker.roles.includes('detector')) {
      for (const profile of this.profiles()) {
        loops.push(
          this.loop(
            `discovery:${profile.id}`,
            g.discovery_interval_seconds * 1000,
            signal,
            async () => {
              const report = await (await this.detector(profile)).run();
              const synced = report.outcomes.filter((o) => o.action === 'synced').length;
              log.info('discovery finished', {
                profile: profile.id,
                candidates: report.outcomes.length,
                synced,
                complete: report.searchComplete,
              });
              await this.db.recordRateLimits(this.ctx.limiter.snapshots()).catch(() => undefined);
            },
          ),
        );
      }
    }

    if (this.worker.roles.includes('reviewer')) {
      const runner = await this.runner();
      loops.push(
        this.loop('reviews', 15_000, signal, async () => {
          await runner.flushPending();
          // 実行できるジョブがなくなるまで続ける
          for (;;) {
            if (signal.aborted) return;
            const res = await runner.runOnce();
            if (res.status !== 'completed' && res.status !== 'released') return;
          }
        }),
      );
      loops.push(
        this.loop('maintenance', 3600_000, signal, async () => {
          const retention = await this.db.applyRetention();
          const hours = Math.min(...this.profiles().map((p) => p.retention.local_input_hours), 24);
          const days = Math.max(...this.profiles().map((p) => p.retention.logs_days), 7);
          const pruned = await pruneSnapshots(this.runsDir, hours * 3600_000);
          const journals = await this.journal.prune(days * 86_400_000);
          log.info('maintenance finished', {
            ...retention,
            snapshots_removed: pruned,
            journals_removed: journals,
          });
        }),
      );
    }

    if (this.worker.roles.includes('notification_planner')) {
      const planner = new NotificationPlanner(
        this.db,
        async (profile, prIds) => {
          const { data } = await this.db.client
            .from('pull_requests')
            .select('id, repository_full_name, pr_number')
            .in('id', prIds);
          await (await this.detector(profile)).resync(data ?? []);
        },
        log,
      );
      loops.push(
        this.loop('notification-planner', 60_000, signal, async () => {
          for (const profile of this.profiles()) {
            await planner.refreshHeld(profile);
            await planner.tick(profile);
          }
        }),
      );
    }

    await Promise.all(loops);
    log.info('worker stopped', { worker: this.worker.id });
  }

  /** 失敗しても次の周期で再試行する。DBへ接続できない間は新しいレビューを開始しない（9.4） */
  async loop(
    name: string,
    intervalMs: number,
    signal: AbortSignal,
    body: () => Promise<void>,
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        await body();
      } catch (error) {
        this.ctx.log.warn(`${name} failed`, { error: (error as Error).message });
      }
      await sleep(jitter(intervalMs), signal);
    }
  }

  get journalStore(): ExecutionJournal {
    return this.journal;
  }
}
