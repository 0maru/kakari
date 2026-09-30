import { join } from 'node:path';
import type { KakariClient } from '@kakari/shared';
import type { Command } from 'commander';
import { findProfile, findWorker, uiBaseUrl } from '../config/load.ts';
import type { ProfileConfig } from '../config/schema.ts';
import { type AppContext, githubClient, githubTransport } from '../context.ts';
import { workerDbClient } from '../db.ts';
import { CliError } from '../errors.ts';
import { ConsoleDelivery, type Delivery, MacDelivery } from '../notify/delivery.ts';
import { formatNotification, listUrl } from '../notify/format.ts';
import { NotifierService } from '../notify/notifier.ts';
import { latestDueSlot } from '../notify/schedule.ts';
import { info, printJson, printText } from '../output.ts';
import { confirm, isInteractive } from '../prompt.ts';
import { startUiServer } from '../ui-server.ts';
import { WorkerDb } from '../worker/db-api.ts';
import {
  type CandidateOutcome,
  Detector,
  type DetectorSink,
  type DetectorSource,
} from '../worker/detector.ts';
import { ExecutionJournal } from '../worker/journal.ts';
import { WorkerService } from '../worker/service.ts';
import { contextFor, humanClient, requireUuid } from './common.ts';

function signalController(): AbortController {
  const controller = new AbortController();
  const stop = () => {
    if (!controller.signal.aborted) {
      info('停止しています…（実行中のAIレビューは中断して結果不明として扱います）');
      controller.abort();
    }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return controller;
}

async function deliveryFactory(ctx: AppContext, workerId: string) {
  const byProfile = new Map<string, Delivery | null>();
  for (const p of ctx.loaded.config.profiles) {
    if (p.notifications.destination_worker_id !== workerId) continue;
    if (p.notifications.delivery === 'console') {
      byProfile.set(p.id, new ConsoleDelivery());
    } else {
      const path = await ctx.binaries.find('terminal_notifier');
      if (!path || process.platform !== 'darwin') {
        ctx.log.error('macOS通知を利用できません（terminal-notifier が必要です）', {
          profile: p.id,
        });
        byProfile.set(p.id, null);
      } else {
        byProfile.set(p.id, new MacDelivery(path));
      }
    }
  }
  return (profileId: string) => byProfile.get(profileId) ?? null;
}

async function runNotifier(ctx: AppContext, workerId: string, db: WorkerDb, signal: AbortSignal) {
  const profiles = ctx.loaded.config.profiles.filter(
    (p) => p.notifications.destination_worker_id === workerId,
  );
  const intervalMs =
    Math.min(...profiles.map((p) => p.notifications.poll_interval_seconds), 60) * 1000;
  const service = new NotifierService(
    db,
    await deliveryFactory(ctx, workerId),
    uiBaseUrl(ctx.loaded),
    ctx.log,
  );
  const worker = new WorkerService(ctx, findWorker(ctx.loaded.config, workerId), db);
  const loops = [
    worker.loop('notifier', intervalMs, signal, async () => {
      const res = await service.tick();
      if (res.delivered + res.failed + res.unknown > 0)
        ctx.log.info('notifications processed', res);
    }),
    worker.loop(
      'heartbeat',
      ctx.loaded.config.global.heartbeat_seconds * 1000,
      signal,
      async () => {
        await db.heartbeat({ roles: ['notifier'], platform: process.platform });
      },
    ),
  ];
  await Promise.all(loops);
}

/** dry-run 用: DBへ書き込まず、何が起きるかを記録する（AC-34） */
class DryRunSink implements DetectorSink {
  readonly synced: { pr: unknown; request: unknown }[] = [];
  async setReviewerIdentity(): Promise<void> {}
  async recordDiscovery(): Promise<void> {}
  async markPullRequestSyncFailed(): Promise<void> {}
  async syncPullRequest(_profileId: string, pr: unknown, request: unknown) {
    this.synced.push({ pr, request });
    return null;
  }
}

function readOnlySource(client: KakariClient | null): DetectorSource {
  return {
    async reviewerGithubId(profileId) {
      if (!client) return null;
      const { data } = await client
        .from('profiles')
        .select('reviewer_github_id')
        .eq('id', profileId)
        .maybeSingle();
      return data?.reviewer_github_id ?? null;
    },
    async trackedPullRequests(profileId) {
      if (!client) return [];
      const { data } = await client
        .from('task_overview')
        .select('pull_request_id, repository_full_name, pr_number, display_state')
        .eq('profile_id', profileId)
        .not('display_state', 'in', '(done,inactive)');
      return (data ?? []).map((r) => ({
        id: r.pull_request_id ?? '',
        repository_full_name: r.repository_full_name ?? '',
        pr_number: r.pr_number ?? 0,
      }));
    },
  };
}

async function planFor(client: KakariClient | null, profile: ProfileConfig, o: CandidateOutcome) {
  if (o.action !== 'synced' || !o.requested)
    return o.reason ?? (o.requested === false ? '依頼なし' : '-');
  if (!client) return `レビュー対象（head ${o.headSha?.slice(0, 7)}）`;
  const { data } = await client
    .from('task_overview')
    .select('result_head_sha, result_config_version, current_job_status, human_state')
    .eq('profile_id', profile.id)
    .eq('repository_full_name', o.repository)
    .eq('pr_number', o.number)
    .maybeSingle();
  if (data?.human_state === 'done') return '対応終了済み（自動レビューしない）';
  if (
    data?.result_head_sha === o.headSha &&
    data?.result_config_version === profile.review.config_version
  ) {
    return '同じSHA・設定の結果あり（AIは起動しない）';
  }
  if (data?.current_job_status === 'running') return '実行中';
  return `AIレビュー開始予定（head ${o.headSha?.slice(0, 7)}）`;
}

export function registerRunCommands(program: Command): void {
  program
    .command('run')
    .description('常駐プロセスを起動する（レビューworker、または作業端末の通知クライアント）')
    .requiredOption('--worker <id>', 'worker ID')
    .action(async (opts, cmd: Command) => {
      const ctx = contextFor(cmd);
      const worker = findWorker(ctx.loaded.config, opts.worker);
      const client = await workerDbClient(ctx.loaded, ctx.secrets, worker.id);
      const db = new WorkerDb(client, worker.id);
      await db.heartbeat({ roles: worker.roles, platform: process.platform });
      const controller = signalController();
      if (worker.roles.includes('notifier')) {
        let ui: Awaited<ReturnType<typeof startUiServer>> | null = null;
        if (ctx.loaded.config.ui.start_with_notifier) {
          ui = await startUiServer(ctx).catch((error) => {
            // UI配信が失敗しても通知は続ける（13.3）
            ctx.log.error('UIを配信できません', { error: (error as Error).message });
            return null;
          });
        }
        await runNotifier(ctx, worker.id, db, controller.signal);
        await ui?.close();
        return;
      }
      await new WorkerService(ctx, worker, db).run(controller.signal);
    });

  program
    .command('scan')
    .description('対象候補と開始予定だけを表示する（AI起動・共有DB書き込みはしない）')
    .requiredOption('--profile <id>', 'プロファイル')
    .option('--dry-run', 'dry-run（必須）')
    .option('--json', 'JSONで出力する')
    .action(async (opts, cmd: Command) => {
      if (!opts.dryRun) throw new CliError('usage', 'scan は --dry-run でのみ実行できます');
      const ctx = contextFor(cmd);
      const profile = findProfile(ctx.loaded.config, opts.profile);
      let client: KakariClient | null = null;
      try {
        client = await humanClient(ctx);
      } catch {
        info(
          'DBへログインしていないため、既存の結果との照合は行いません（kakari login で照合できます）',
        );
      }
      const gh = githubClient(ctx, profile, await githubTransport(ctx));
      const sink = new DryRunSink();
      const report = await new Detector(gh, profile, readOnlySource(client), sink, ctx.log).run();
      const rows = [];
      for (const o of report.outcomes) {
        rows.push({ ...o, plan: await planFor(client, profile, o) });
      }
      if (opts.json) {
        printJson({
          profile: profile.id,
          search_complete: report.searchComplete,
          incomplete: report.incompleteScopes,
          error: report.error,
          candidates: rows.map(({ result: _r, ...rest }) => rest),
        });
        return;
      }
      if (report.error) info(`取得エラー: ${report.error}`);
      if (!report.searchComplete) {
        info(
          `検索結果が不完全です: ${report.incompleteScopes.map((s) => `${s.scope} (${s.reason})`).join(', ')}`,
        );
      }
      if (rows.length === 0) printText('候補はありません。');
      for (const r of rows) printText(`${r.repository}#${r.number}  ${r.plan}`);
    });

  program
    .command('notify')
    .description('候補結果と宛先を表示するだけで、通知は送らない')
    .requiredOption('--profile <id>', 'プロファイル')
    .option('--dry-run', 'dry-run（必須）')
    .action(async (opts, cmd: Command) => {
      if (!opts.dryRun) throw new CliError('usage', 'notify は --dry-run でのみ実行できます');
      const ctx = contextFor(cmd);
      const profile = findProfile(ctx.loaded.config, opts.profile);
      const client = await humanClient(ctx);
      const slot = latestDueSlot(new Date(), profile.notifications);
      const { data, error } = await client
        .from('task_overview')
        .select('*')
        .eq('profile_id', profile.id)
        .eq('display_state', 'awaiting_ack');
      if (error) throw new CliError('runtime', error.message);
      const now = Date.now();
      const items = (data ?? []).filter(
        (t) => !t.snoozed_until || new Date(t.snoozed_until).getTime() <= now,
      );
      const base = uiBaseUrl(ctx.loaded);
      printText(
        `宛先: ${profile.notifications.destination_worker_id}（${profile.notifications.delivery}）`,
      );
      printText(`直近の通知枠: ${slot ? slot.toISOString() : 'なし'}`);
      if (items.length === 0) {
        printText('通知対象の結果はありません。');
        return;
      }
      const preview = formatNotification(
        {
          event_id: 'dry-run',
          event_type: 'review_results',
          claim_token: 'dry-run',
          scheduled_slot_at: slot?.toISOString() ?? null,
          payload: {
            profile_id: profile.id,
            profile_name: profile.name,
            detail_level: profile.notifications.detail_level,
            counts: { total: items.length, new: items.length, carried_over: 0 },
            items: items.map((t) => ({
              task_id: t.task_id ?? '',
              result_id: t.current_result_id ?? '',
              request_generation: t.request_generation ?? 1,
              head_sha: t.head_sha ?? '',
              previously_notified: false,
              repository_full_name: t.repository_full_name ?? undefined,
              pr_number: t.pr_number ?? undefined,
              pr_title:
                profile.notifications.detail_level === 'title'
                  ? (t.pr_title ?? undefined)
                  : undefined,
            })),
          },
        },
        base,
      );
      printText(
        `--- 通知のプレビュー（送信しません） ---\n${preview.title} ${preview.subtitle ?? ''}\n${preview.message}\n${preview.url ?? listUrl(base, profile.id)}`,
      );
    });

  program
    .command('reconcile <job-id>')
    .description('結果不明の実行をローカル記録・DBと照合する（レビュー実行ホストで実行する）')
    .requiredOption('--worker <id>', 'レビューworker ID')
    .option('--discard', 'DBへ未保存の退避結果を破棄する')
    .option('--yes', '確認を省略する')
    .action(async (jobIdArg: string, opts, cmd: Command) => {
      const ctx = contextFor(cmd);
      const jobId = requireUuid(jobIdArg, 'job ID');
      const worker = findWorker(ctx.loaded.config, opts.worker);
      const client = await workerDbClient(ctx.loaded, ctx.secrets, worker.id);
      const db = new WorkerDb(client, worker.id);
      const { data: job, error } = await client
        .from('review_jobs')
        .select('*')
        .eq('id', jobId)
        .maybeSingle();
      if (error || !job) throw new CliError('usage', 'ジョブが見つかりません');
      const journal = new ExecutionJournal(join(ctx.loaded.stateDir, 'journal', worker.id));
      const entries = (await journal.findByJob(jobId)).sort((a, b) =>
        (a.lastAt ?? '').localeCompare(b.lastAt ?? ''),
      );
      const latest = entries.at(-1);
      info(`ジョブの状態: ${job.status}${job.error_class ? `（${job.error_class}）` : ''}`);
      if (!latest?.reserved) {
        throw new CliError(
          'runtime',
          'この端末にジョブの実行記録がありません。レビュー実行ホストで実行するか、kakari retry で再試行してください',
        );
      }
      const service = new WorkerService(ctx, worker, db);
      const runner = await service.runner();

      if (latest.finished && !latest.recorded) {
        if (opts.discard) {
          if (
            !opts.yes &&
            (!isInteractive() || !(await confirm('DBへ未保存の結果を破棄しますか？')))
          ) {
            throw new CliError('confirmation', '中止しました');
          }
          await journal.append(latest.executionId, {
            type: 'discarded',
            at: new Date().toISOString(),
          });
          info('退避結果を破棄しました。');
          return;
        }
        const res = await runner.save(
          latest.executionId,
          latest.reserved.lease_token,
          jobId,
          latest.finished.payload,
        );
        info(
          res.status === 'completed'
            ? `退避結果をDBへ保存しました（${res.dbStatus}）`
            : 'DBへ保存できませんでした',
        );
        return;
      }
      if (job.status !== 'unknown') {
        info('照合が必要な状態ではありません。');
        return;
      }
      if (!latest.launched) {
        await db.resolveUnknown(
          latest.executionId,
          latest.reserved.lease_token,
          'not_launched',
          'CLIは起動していません（ローカル記録で確認）',
        );
        await journal.append(latest.executionId, {
          type: 'resolved',
          at: new Date().toISOString(),
          resolution: 'not_launched',
        });
        info('CLIは起動していなかったため、実行待ちへ戻しました。');
        return;
      }
      info('AI CLIは起動済みですが、結果の記録がありません。');
      if (!opts.yes) {
        if (!isInteractive())
          throw new CliError(
            'confirmation',
            '元のプロセスが終了していることを確認し、--yes を付けて再実行してください',
          );
        if (
          !(await confirm(
            '元の kakari run / AI CLI のプロセスが終了していることを確認しましたか？',
          ))
        ) {
          throw new CliError('confirmation', '中止しました');
        }
      }
      await db.resolveUnknown(
        latest.executionId,
        latest.reserved.lease_token,
        'failed',
        '起動後に結果なしで終了（照合で確認）',
      );
      await journal.append(latest.executionId, {
        type: 'resolved',
        at: new Date().toISOString(),
        resolution: 'failed',
      });
      info('失敗として確定しました。再実行する場合は kakari retry で追加消費を承認してください。');
    });
}
