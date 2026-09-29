import {
  acknowledgeResult,
  clearUsagePoolBlock,
  completeReviewTask,
  type KakariClient,
  type OperationResponse,
  requestManualReview,
  requestReviewRetry,
  setProfilePaused,
  setTaskSnooze,
  shortSha,
  type TaskOverview,
  toKakariError,
} from '@kakari/shared';
import type { Command } from 'commander';
import { CliError } from '../errors.ts';
import { info, printJson } from '../output.ts';
import { confirm, isInteractive } from '../prompt.ts';
import { contextFor, humanClient, parseIntOption, pendingOps, requireUuid } from './common.ts';

async function overview(client: KakariClient, taskId: string): Promise<TaskOverview> {
  const { data, error } = await client
    .from('task_overview')
    .select('*')
    .eq('task_id', taskId)
    .maybeSingle();
  if (error) throw toKakariError(error);
  if (!data) throw new CliError('usage', 'レビュー項目が見つかりません');
  return data;
}

async function jobOf(client: KakariClient, jobId: string) {
  const { data, error } = await client
    .from('review_jobs')
    .select('*')
    .eq('id', jobId)
    .maybeSingle();
  if (error) throw toKakariError(error);
  if (!data) throw new CliError('usage', 'ジョブが見つかりません');
  return data;
}

/** 操作の応答を表示し、終了コードに反映する */
function report(
  res: OperationResponse,
  json: boolean,
  messages: Partial<Record<string, string>>,
): void {
  if (json) printJson({ operation: res });
  if (res.status === 'conflict') {
    throw new CliError(
      'conflict',
      `別の操作で状態が変わっています（revision ${res.revision}）。最新の状態を確認してから再実行してください${res.message ? `: ${res.message}` : ''}`,
    );
  }
  if (res.status === 'rejected') {
    throw new CliError('usage', `操作を受け付けませんでした: ${res.message ?? ''}`);
  }
  if (res.status === 'confirmation_required') {
    throw new CliError('confirmation', `追加消費の承認が必要です: ${res.message ?? ''}`);
  }
  if (!json) {
    info(messages[res.status] ?? `操作を適用しました（${res.status}）`);
    if (res.replayed) info('（同じ操作IDの記録済みの結果です）');
  }
}

/** 追加消費を伴う操作の承認（16.3） */
async function approveExtraUsage(
  opts: { yes?: boolean; operationId?: string },
  summary: string[],
): Promise<void> {
  for (const line of summary) info(line);
  if (opts.yes) {
    if (!isInteractive() && !opts.operationId) {
      throw new CliError(
        'usage',
        '非対話で追加消費を承認するには --operation-id も指定してください',
      );
    }
    return;
  }
  if (!isInteractive()) {
    throw new CliError(
      'confirmation',
      '追加消費の承認が必要です。内容を確認して --yes と --operation-id を指定してください',
    );
  }
  if (!(await confirm('追加の利用枠を消費する可能性があります。実行しますか？'))) {
    throw new CliError('confirmation', '中止しました');
  }
}

function withOperationId(cmd: Command): Command {
  return cmd
    .option('--operation-id <id>', '操作ID（同じ要求の再送に使う）')
    .option('--json', 'JSONで出力する');
}

export function registerOpsCommands(program: Command): void {
  withOperationId(
    program
      .command('ack <result-id>')
      .description('特定の結果を確認済みにする')
      .requiredOption(
        '--request-generation <n>',
        '依頼世代',
        parseIntOption('--request-generation'),
      ),
  ).action(async (resultIdArg: string, opts, cmd: Command) => {
    const ctx = contextFor(cmd);
    const client = await humanClient(ctx);
    const resultId = requireUuid(resultIdArg, 'result ID');
    const res = await pendingOps(ctx).run(
      `ack:${resultId}:${opts.requestGeneration}`,
      opts.operationId,
      async () => {
        const { data, error } = await client
          .from('review_results')
          .select('review_task_id')
          .eq('id', resultId)
          .maybeSingle();
        if (error) throw toKakariError(error);
        if (!data) throw new CliError('usage', '結果が見つかりません');
        const task = await overview(client, data.review_task_id);
        return { taskId: data.review_task_id, expectedRevision: task.revision ?? 0 };
      },
      (req, operationId) =>
        acknowledgeResult(client, {
          taskId: req.taskId,
          resultId,
          requestGeneration: opts.requestGeneration,
          expectedRevision: req.expectedRevision,
          operationId,
        }),
    );
    report(res, opts.json, {
      applied: '確認済みにしました。',
      recorded_only:
        'この結果は現在の結果・依頼世代ではないため、履歴にだけ記録しました。最新の結果は未確認のままです。',
    });
  });

  withOperationId(
    program
      .command('snooze <task-id>')
      .description('通知を一時停止する（レビュー実行は止めない）')
      .requiredOption('--until <RFC3339>', '停止期限（例: 2026-10-01T09:00:00+09:00）'),
  ).action(async (taskIdArg: string, opts, cmd: Command) => {
    const until = new Date(opts.until);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(opts.until) || Number.isNaN(until.getTime())) {
      throw new CliError('usage', '--until にはタイムゾーン付きのRFC3339形式を指定してください');
    }
    if (until.getTime() <= Date.now()) throw new CliError('usage', '過去の期限は指定できません');
    const ctx = contextFor(cmd);
    const client = await humanClient(ctx);
    const taskId = requireUuid(taskIdArg, 'task ID');
    const res = await pendingOps(ctx).run(
      `snooze:${taskId}:${until.toISOString()}`,
      opts.operationId,
      async () => ({ expectedRevision: (await overview(client, taskId)).revision ?? 0 }),
      (req, operationId) =>
        setTaskSnooze(client, {
          taskId,
          until,
          expectedRevision: req.expectedRevision,
          operationId,
        }),
    );
    report(res, opts.json, { applied: `${until.toISOString()} まで通知を停止しました。` });
  });

  withOperationId(
    program.command('unsnooze <task-id>').description('通知の一時停止を解除する'),
  ).action(async (taskIdArg: string, opts, cmd: Command) => {
    const ctx = contextFor(cmd);
    const client = await humanClient(ctx);
    const taskId = requireUuid(taskIdArg, 'task ID');
    const res = await pendingOps(ctx).run(
      `unsnooze:${taskId}`,
      opts.operationId,
      async () => ({ expectedRevision: (await overview(client, taskId)).revision ?? 0 }),
      (req, operationId) =>
        setTaskSnooze(client, {
          taskId,
          until: null,
          expectedRevision: req.expectedRevision,
          operationId,
        }),
    );
    report(res, opts.json, { applied: '通知の一時停止を解除しました。' });
  });

  withOperationId(
    program
      .command('done <task-id>')
      .description('現在の依頼への対応を終了する（GitHubへのレビュー提出は行わない）')
      .requiredOption(
        '--request-generation <n>',
        '依頼世代',
        parseIntOption('--request-generation'),
      )
      .requiredOption('--reason <text>', '理由'),
  ).action(async (taskIdArg: string, opts, cmd: Command) => {
    const ctx = contextFor(cmd);
    const client = await humanClient(ctx);
    const taskId = requireUuid(taskIdArg, 'task ID');
    const res = await pendingOps(ctx).run(
      `done:${taskId}:${opts.requestGeneration}`,
      opts.operationId,
      async () => ({ expectedRevision: (await overview(client, taskId)).revision ?? 0 }),
      (req, operationId) =>
        completeReviewTask(client, {
          taskId,
          requestGeneration: opts.requestGeneration,
          reason: opts.reason,
          expectedRevision: req.expectedRevision,
          operationId,
        }),
    );
    report(res, opts.json, {
      applied:
        '対応終了にしました。この依頼の自動レビューと通常通知を停止します（GitHubには何もしていません）。',
    });
  });

  withOperationId(
    program
      .command('retry <job-id>')
      .description('失敗・保留・結果不明のジョブを再試行する')
      .option('--yes', '追加消費の可能性を承認する'),
  ).action(async (jobIdArg: string, opts, cmd: Command) => {
    const ctx = contextFor(cmd);
    const client = await humanClient(ctx);
    const jobId = requireUuid(jobIdArg, 'job ID');
    const job = await jobOf(client, jobId);
    const { data: attempts } = await client
      .from('review_attempts')
      .select('launch_state, outcome')
      .eq('job_id', jobId);
    const maybeLaunched =
      job.status === 'unknown' ||
      (attempts ?? []).some(
        (a) => a.launch_state !== 'not_launched' && a.outcome !== 'not_launched',
      );
    if (maybeLaunched) {
      await approveExtraUsage(opts, [
        `対象: job ${jobId}（${job.status}${job.error_class ? `: ${job.error_class}` : ''}）`,
        `対象SHA: ${shortSha(job.head_sha)}  provider: ${job.provider}`,
        'AI CLIが起動済みだった可能性があり、再試行すると追加の利用枠を消費する可能性があります。',
      ]);
    }
    const res = await pendingOps(ctx).run(
      `retry:${jobId}`,
      opts.operationId,
      async () => ({
        expectedRevision: (await overview(client, job.review_task_id)).revision ?? 0,
      }),
      (req, operationId) =>
        requestReviewRetry(client, {
          jobId,
          expectedRevision: req.expectedRevision,
          acknowledgePossibleExtraUsage: maybeLaunched,
          operationId,
        }),
    );
    report(res, opts.json, {
      applied: '再試行を登録しました。起動前の条件確認を経て実行されます。',
    });
  });

  withOperationId(
    program
      .command('rerun <job-id>')
      .description('成功済みでも明示的に再レビューする（理由と確認が必須）')
      .requiredOption('--reason <text>', '再レビューの理由')
      .option('--yes', '追加消費を承認する'),
  ).action(async (jobIdArg: string, opts, cmd: Command) => {
    const ctx = contextFor(cmd);
    const client = await humanClient(ctx);
    const jobId = requireUuid(jobIdArg, 'job ID');
    const job = await jobOf(client, jobId);
    await approveExtraUsage(opts, [
      `対象SHA: ${job.head_sha}`,
      `provider: ${job.provider}  レビュー設定: ${job.review_config_version}`,
      `理由: ${opts.reason}`,
      '手動再レビューは追加の利用枠を消費します。',
    ]);
    const res = await pendingOps(ctx).run(
      `rerun:${jobId}:${opts.reason}`,
      opts.operationId,
      async () => ({
        expectedRevision: (await overview(client, job.review_task_id)).revision ?? 0,
      }),
      (req, operationId) =>
        requestManualReview(client, {
          jobId,
          reason: opts.reason,
          expectedRevision: req.expectedRevision,
          acknowledgeExtraUsage: true,
          operationId,
        }),
    );
    report(res, opts.json, {
      applied: `手動再レビュー（世代 ${String(res.manual_generation ?? '')}）を登録しました。`,
    });
  });

  for (const [name, paused] of [
    ['pause', true],
    ['resume', false],
  ] as const) {
    withOperationId(
      program
        .command(name)
        .description(
          paused
            ? 'プロファイルの新規自動レビューを停止する'
            : 'プロファイルの新規自動レビューを再開する',
        )
        .option('--profile <id>', 'プロファイル')
        .option(
          '--pool <id>',
          paused ? '(使用しない)' : '利用上限・認証切れで保留中の利用枠を再開する',
        ),
    ).action(async (opts, cmd: Command) => {
      const ctx = contextFor(cmd);
      const client = await humanClient(ctx);
      if (!opts.profile && !opts.pool) throw new CliError('usage', '--profile を指定してください');
      if (opts.pool && !paused) {
        const res = await pendingOps(ctx).run(
          `pool-resume:${opts.pool}`,
          opts.operationId,
          async () => ({}),
          (_r, operationId) => clearUsagePoolBlock(client, { poolId: opts.pool, operationId }),
        );
        report(res, opts.json, { applied: `利用枠 ${opts.pool} の保留を解除しました。` });
      }
      if (opts.profile) {
        const res = await pendingOps(ctx).run(
          `${name}:${opts.profile}`,
          opts.pool ? undefined : opts.operationId,
          async () => ({}),
          (_r, operationId) =>
            setProfilePaused(client, { profileId: opts.profile, paused, operationId }),
        );
        report(res, opts.json, {
          applied: paused
            ? `プロファイル ${opts.profile} の新規自動レビューを停止しました。`
            : `プロファイル ${opts.profile} の新規自動レビューを再開しました。`,
        });
      }
    });
  }
}
