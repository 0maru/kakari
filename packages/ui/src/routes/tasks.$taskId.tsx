import {
  acknowledgeResult,
  completeReviewTask,
  describeWaitingReason,
  getResult,
  getTaskDetail,
  OPERATION_LABELS,
  OPERATION_OUTCOME_LABELS,
  requestManualReview,
  requestReviewRetry,
  setTaskSnooze,
  shortSha,
} from '@kakari/shared';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { findingKey, parseResult, ResultView } from '../components/result-view.tsx';
import {
  Card,
  displayTimeZone,
  ErrorBox,
  formatTime,
  PrLink,
  StateBadge,
} from '../components/ui.tsx';
import { useApp } from '../lib/app.tsx';
import { useOperation } from '../lib/operation.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface DetailSearch {
  result?: string;
  generation?: number;
}

export const Route = createFileRoute('/tasks/$taskId')({
  // URLには識別子だけを渡す（11.3）
  validateSearch: (s: Record<string, unknown>): DetailSearch => ({
    result: typeof s.result === 'string' && UUID.test(s.result) ? s.result : undefined,
    generation:
      typeof s.generation === 'number' && Number.isInteger(s.generation) && s.generation > 0
        ? s.generation
        : undefined,
  }),
  component: TaskDetailPage,
});

function TaskDetailPage() {
  const { taskId } = Route.useParams();
  const search = Route.useSearch();
  const { client } = useApp();

  const detail = useQuery({
    queryKey: ['task', taskId],
    queryFn: () => getTaskDetail(client, taskId),
    enabled: UUID.test(taskId),
  });

  // 表示する結果と依頼世代を固定する。バックグラウンド更新で差し替えない（12.2・AC-48）
  const [pinned, setPinned] = useState<{ resultId: string | null; generation: number } | null>(
    null,
  );
  useEffect(() => {
    if (!detail.data) return;
    if (search.result) {
      setPinned({
        resultId: search.result,
        generation: search.generation ?? detail.data.task.request_generation ?? 1,
      });
    } else if (!pinned) {
      setPinned({
        resultId: detail.data.task.current_result_id,
        generation: detail.data.task.request_generation ?? 1,
      });
    }
  }, [detail.data, search.result, search.generation, pinned]);

  const shownResult = useQuery({
    queryKey: ['task', taskId, 'result', pinned?.resultId],
    queryFn: () => getResult(client, pinned?.resultId ?? ''),
    enabled: Boolean(pinned?.resultId),
  });
  const currentResult = useQuery({
    queryKey: ['task', taskId, 'result', detail.data?.task.current_result_id],
    queryFn: () => getResult(client, detail.data?.task.current_result_id ?? ''),
    enabled: Boolean(
      detail.data?.task.current_result_id &&
        detail.data.task.current_result_id !== pinned?.resultId,
    ),
  });

  if (!UUID.test(taskId)) return <ErrorBox error="task ID の形式が不正です" />;
  if (detail.error) return <ErrorBox error={detail.error} />;
  if (!detail.data || !pinned) return <p className="text-sm text-slate-500">読み込み中…</p>;

  const t = detail.data.task;
  const result = shownResult.data ?? null;
  const isCurrent = Boolean(result && result.id === t.current_result_id);
  const newerAvailable = Boolean(t.current_result_id && t.current_result_id !== pinned.resultId);

  return (
    <div className="space-y-4">
      <div>
        <Link to="/tasks" className="text-sm text-indigo-600 hover:underline">
          ← レビュー一覧
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <StateBadge state={t.display_state} />
          <h1 className="text-xl font-semibold">
            {t.repository_full_name}#{t.pr_number} <span className="font-normal">{t.pr_title}</span>
          </h1>
        </div>
        {t.waiting_reason && (
          <p className="mt-1 text-sm text-rose-600">{describeWaitingReason(t.waiting_reason)}</p>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="元PR">
          <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
            <dt className="text-slate-500">リポジトリ</dt>
            <dd>{t.repository_full_name}</dd>
            <dt className="text-slate-500">作成者</dt>
            <dd>{t.pr_author_login ?? '-'}</dd>
            <dt className="text-slate-500">状態</dt>
            <dd>
              {t.pr_state}
              {t.pr_draft ? '（draft）' : ''}
            </dd>
            <dt className="text-slate-500">リンク</dt>
            <dd className="break-all">
              <PrLink url={t.pr_url} host={t.github_host} />
            </dd>
          </dl>
        </Card>
        <Card title="対象">
          <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
            <dt className="text-slate-500">現在head</dt>
            <dd className="font-mono">{shortSha(t.head_sha)}</dd>
            <dt className="text-slate-500">レビュー対象SHA</dt>
            <dd className="font-mono">{shortSha(result?.head_sha)}</dd>
            <dt className="text-slate-500">base / merge-base</dt>
            <dd className="font-mono">
              {shortSha(result?.base_sha ?? t.base_sha)} / {shortSha(result?.merge_base_sha)}
            </dd>
            <dt className="text-slate-500">依頼世代</dt>
            <dd>{t.request_generation}</dd>
            <dt className="text-slate-500">GitHub最終確認</dt>
            <dd>
              {formatTime(t.last_synced_at)}
              {t.sync_status !== 'ok' && (
                <span className="ml-1 text-rose-600">（{t.sync_status}）</span>
              )}
            </dd>
            {t.snoozed_until && (
              <>
                <dt className="text-slate-500">スヌーズ</dt>
                <dd>
                  {formatTime(t.snoozed_until)} まで（{displayTimeZone}）
                </dd>
              </>
            )}
          </dl>
        </Card>
      </div>

      {newerAvailable && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
          {pinned.resultId ? 'この画面を開いた後に新しい結果ができました。' : '結果ができました。'}
          <button
            type="button"
            className="ml-2 font-medium text-indigo-700 underline"
            onClick={() =>
              setPinned({ resultId: t.current_result_id, generation: t.request_generation ?? 1 })
            }
          >
            最新の結果を表示
          </button>
        </div>
      )}
      {result && !isCurrent && !newerAvailable && (
        <div className="rounded border border-slate-300 bg-slate-100 p-3 text-sm dark:border-slate-700 dark:bg-slate-800">
          これは履歴の結果です。
        </div>
      )}
      {result && !isCurrent && currentResult.data && (
        <ResultDiff older={result} latest={currentResult.data} />
      )}
      {isCurrent && t.premise_changed && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
          レビュー時から base または
          PR本文が変わっています（前提変更あり）。必要なら明示的に再レビューしてください。
        </div>
      )}
      {result && result.head_sha !== t.head_sha && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
          現在のhead（{shortSha(t.head_sha)}）とは異なるSHA（{shortSha(result.head_sha)}
          ）の結果です。最新headの結果を待っています。
        </div>
      )}

      <Actions
        taskId={taskId}
        detail={detail.data}
        resultId={result?.id ?? null}
        generation={pinned.generation}
      />

      <Card
        title={result ? `レビュー結果${isCurrent ? '' : '（履歴）'}` : 'レビュー結果'}
        actions={
          result && (
            <span className="text-xs text-slate-500">
              {result.provider} / CLI {result.cli_version ?? '-'} / 設定{' '}
              {result.review_config_version} / {formatTime(result.created_at)}
              {result.manual_generation > 0 && ` / 手動世代 ${result.manual_generation}`}
            </span>
          )
        }
      >
        {result ? (
          <ResultView result={result} />
        ) : (
          <p className="text-sm text-slate-500">
            {t.current_job_status
              ? `AIレビュー: ${t.current_job_status}`
              : 'まだ結果がありません。'}
          </p>
        )}
      </Card>

      <History detail={detail.data} taskId={taskId} />
    </div>
  );
}

function ResultDiff({
  older,
  latest,
}: {
  older: Parameters<typeof parseResult>[0];
  latest: Parameters<typeof parseResult>[0];
}) {
  const a = parseResult(older);
  const b = parseResult(latest);
  if (!a || !b) return null;
  const oldKeys = new Set(a.findings.map(findingKey));
  const newKeys = new Set(b.findings.map(findingKey));
  const added = b.findings.filter((f) => !oldKeys.has(findingKey(f)));
  const resolved = a.findings.filter((f) => !newKeys.has(findingKey(f)));
  return (
    <Card title="最新結果との差">
      <p className="text-sm">
        最新結果（{shortSha(latest?.head_sha)}）: 指摘 {b.findings.length} 件 ／ この結果（
        {shortSha(older?.head_sha)}）: 指摘 {a.findings.length} 件
      </p>
      {added.length > 0 && (
        <p className="mt-1 text-sm">
          最新結果にだけある指摘: {added.map((f) => f.title).join('、')}
        </p>
      )}
      {resolved.length > 0 && (
        <p className="mt-1 text-sm">
          この結果にだけある指摘: {resolved.map((f) => f.title).join('、')}
        </p>
      )}
    </Card>
  );
}

function Actions({
  taskId,
  detail,
  resultId,
  generation,
}: {
  taskId: string;
  detail: Awaited<ReturnType<typeof getTaskDetail>>;
  resultId: string | null;
  generation: number;
}) {
  const { client } = useApp();
  const op = useOperation(taskId);
  const t = detail.task;
  const revision = t.revision ?? 0;
  const [snoozeUntil, setSnoozeUntil] = useState('');
  const [doneReason, setDoneReason] = useState('');
  const [rerunOpen, setRerunOpen] = useState(false);
  const [rerunReason, setRerunReason] = useState('');
  const [rerunApproved, setRerunApproved] = useState(false);
  const [retryApproved, setRetryApproved] = useState(false);
  const job = detail.jobs.find((j) => j.id === t.current_job_id) ?? null;
  const baseJobId = t.current_job_id ?? detail.jobs[0]?.id ?? null;
  const isDone = t.human_state === 'done';
  const retryNeedsApproval = job?.status === 'unknown' || job?.status === 'failed';

  return (
    <Card title="操作">
      <div className="flex flex-wrap items-end gap-4 text-sm">
        {t.is_acked && resultId === t.current_result_id && (
          <span className="self-center rounded bg-sky-100 px-2 py-1 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200">
            この結果は確認済みです
          </span>
        )}
        <button
          type="button"
          disabled={
            op.state.busy ||
            !resultId ||
            isDone ||
            (t.is_acked === true && resultId === t.current_result_id)
          }
          className="rounded bg-indigo-600 px-3 py-1.5 font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
          onClick={() =>
            resultId &&
            void op.run(
              `ack:${resultId}:${generation}`,
              { resultId, generation, revision },
              (a, operationId) =>
                acknowledgeResult(client, {
                  taskId,
                  resultId: a.resultId,
                  requestGeneration: a.generation,
                  expectedRevision: a.revision,
                  operationId,
                }),
              {
                applied: '確認済みにしました。',
                recorded_only:
                  '表示中の結果は最新ではないため履歴にだけ記録しました。最新の結果は未確認のままです。',
              },
            )
          }
        >
          表示中の結果を確認済みにする
        </button>

        <div className="flex items-end gap-2">
          <label className="flex flex-col gap-1">
            <span>スヌーズ期限（{displayTimeZone}）</span>
            <input
              type="datetime-local"
              className="rounded border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-800"
              value={snoozeUntil}
              onChange={(e) => setSnoozeUntil(e.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={op.state.busy || !snoozeUntil}
            className="rounded border border-slate-300 px-3 py-1.5 disabled:opacity-40 dark:border-slate-700"
            onClick={() => {
              const until = new Date(snoozeUntil);
              if (Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) {
                window.alert('未来の日時を指定してください');
                return;
              }
              void op.run(
                `snooze:${until.toISOString()}`,
                { until: until.toISOString(), revision },
                (a, operationId) =>
                  setTaskSnooze(client, {
                    taskId,
                    until: new Date(a.until),
                    expectedRevision: a.revision,
                    operationId,
                  }),
                { applied: '通知を一時停止しました（レビュー実行は続きます）。' },
              );
            }}
          >
            スヌーズ
          </button>
          {t.snoozed_until && (
            <button
              type="button"
              disabled={op.state.busy}
              className="rounded border border-slate-300 px-3 py-1.5 disabled:opacity-40 dark:border-slate-700"
              onClick={() =>
                void op.run(
                  'unsnooze',
                  { revision },
                  (a, operationId) =>
                    setTaskSnooze(client, {
                      taskId,
                      until: null,
                      expectedRevision: a.revision,
                      operationId,
                    }),
                  { applied: 'スヌーズを解除しました。' },
                )
              }
            >
              スヌーズ解除
            </button>
          )}
        </div>

        {!isDone && (
          <div className="flex items-end gap-2">
            <label className="flex flex-col gap-1">
              <span>対応終了の理由</span>
              <input
                className="rounded border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-800"
                value={doneReason}
                maxLength={500}
                onChange={(e) => setDoneReason(e.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={op.state.busy || !doneReason.trim()}
              className="rounded border border-slate-300 px-3 py-1.5 disabled:opacity-40 dark:border-slate-700"
              onClick={() =>
                void op.run(
                  `done:${t.request_generation}`,
                  { generation: t.request_generation ?? 1, reason: doneReason.trim(), revision },
                  (a, operationId) =>
                    completeReviewTask(client, {
                      taskId,
                      requestGeneration: a.generation,
                      reason: a.reason,
                      expectedRevision: a.revision,
                      operationId,
                    }),
                  { applied: '対応終了にしました（GitHubには何もしていません）。' },
                )
              }
            >
              対応終了
            </button>
          </div>
        )}
      </div>

      {job && ['failed', 'blocked', 'unknown'].includes(job.status) && (
        <div className="mt-4 rounded border border-rose-200 p-3 text-sm dark:border-rose-900">
          <p>
            最新headのAIレビューは <strong>{job.status}</strong> です
            {job.error_class ? `（${job.error_class}）` : ''}。
            {job.error_message && <span className="text-slate-600"> {job.error_message}</span>}
          </p>
          {retryNeedsApproval && (
            <label className="mt-2 flex items-center gap-2">
              <input
                type="checkbox"
                checked={retryApproved}
                onChange={(e) => setRetryApproved(e.target.checked)}
              />
              AI CLIが起動済みだった可能性があり、追加の利用枠を消費する可能性があることを承認する
            </label>
          )}
          <button
            type="button"
            disabled={op.state.busy || (retryNeedsApproval && !retryApproved)}
            className="mt-2 rounded border border-slate-300 px-3 py-1.5 disabled:opacity-40 dark:border-slate-700"
            onClick={() =>
              void op.run(
                `retry:${job.id}`,
                { jobId: job.id, revision, approved: retryApproved },
                (a, operationId) =>
                  requestReviewRetry(client, {
                    jobId: a.jobId,
                    expectedRevision: a.revision,
                    acknowledgePossibleExtraUsage: a.approved,
                    operationId,
                  }),
                { applied: '再試行を登録しました。' },
              )
            }
          >
            再試行
          </button>
        </div>
      )}

      <div className="mt-4">
        {!rerunOpen ? (
          <button
            type="button"
            disabled={!baseJobId || t.pr_state !== 'open'}
            className="text-sm text-slate-600 underline disabled:opacity-40"
            onClick={() => setRerunOpen(true)}
          >
            明示的に再レビューする（追加消費あり）
          </button>
        ) : (
          <div className="space-y-2 rounded border border-slate-300 p-3 text-sm dark:border-slate-700">
            <p className="font-medium">再レビューの確認</p>
            <p>
              対象SHA: <span className="font-mono">{t.head_sha}</span> ／ provider:{' '}
              {detail.jobs.find((j) => j.id === baseJobId)?.provider ?? '-'}
            </p>
            <label className="flex flex-col gap-1">
              理由（必須）
              <input
                className="rounded border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-800"
                value={rerunReason}
                maxLength={500}
                onChange={(e) => setRerunReason(e.target.value)}
              />
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={rerunApproved}
                onChange={(e) => setRerunApproved(e.target.checked)}
              />
              追加の利用枠を消費することを承認する
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={op.state.busy || !rerunReason.trim() || !rerunApproved || !baseJobId}
                className="rounded bg-slate-800 px-3 py-1.5 text-white disabled:opacity-40 dark:bg-slate-200 dark:text-slate-900"
                onClick={() =>
                  baseJobId &&
                  void op
                    .run(
                      `rerun:${baseJobId}:${rerunReason.trim()}`,
                      { jobId: baseJobId, reason: rerunReason.trim(), revision },
                      (a, operationId) =>
                        requestManualReview(client, {
                          jobId: a.jobId,
                          reason: a.reason,
                          expectedRevision: a.revision,
                          acknowledgeExtraUsage: true,
                          operationId,
                        }),
                      { applied: '再レビューを登録しました。' },
                    )
                    .then((res) => {
                      if (res?.status === 'applied') setRerunOpen(false);
                    })
                }
              >
                再レビューを登録
              </button>
              <button type="button" className="px-3 py-1.5" onClick={() => setRerunOpen(false)}>
                キャンセル
              </button>
            </div>
          </div>
        )}
      </div>

      {op.state.message && (
        <p className="mt-3 text-sm text-emerald-700 dark:text-emerald-300">{op.state.message}</p>
      )}
      {op.state.error && (
        <p className="mt-3 text-sm text-rose-700 dark:text-rose-300">{op.state.error}</p>
      )}
      {op.state.resendable && (
        <p className="mt-1 text-xs text-slate-500">同じボタンをもう一度押すと再送します。</p>
      )}
    </Card>
  );
}

function History({
  detail,
  taskId,
}: {
  detail: Awaited<ReturnType<typeof getTaskDetail>>;
  taskId: string;
}) {
  const t = detail.task;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="結果履歴">
        {detail.results.length === 0 ? (
          <p className="text-sm text-slate-500">まだ結果がありません。</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {detail.results.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2">
                <Link
                  to="/tasks/$taskId"
                  params={{ taskId }}
                  search={{ result: r.id, generation: t.request_generation ?? 1 }}
                  className="text-indigo-700 hover:underline dark:text-indigo-300"
                >
                  {formatTime(r.created_at)}
                </Link>
                <span className="font-mono text-xs">{shortSha(r.head_sha)}</span>
                <span className="text-xs text-slate-500">
                  {r.quality_status} / 指摘 {r.findings_count ?? '?'} 件
                  {r.manual_generation > 0 && ` / 手動${r.manual_generation}`}
                  {r.body_deleted_at && ' / 本文削除済み'}
                </span>
                {r.id === t.current_result_id && (
                  <span className="text-xs text-emerald-700">採用中</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {detail.jobs.some((j) => j.manual_reason) && (
          <div className="mt-3 text-xs text-slate-500">
            {detail.jobs
              .filter((j) => j.manual_reason)
              .map((j) => (
                <p key={j.id}>
                  手動世代 {j.manual_generation}: {j.manual_reason}（{j.status}）
                </p>
              ))}
          </div>
        )}
      </Card>
      <Card title="操作履歴">
        {detail.operations.length === 0 ? (
          <p className="text-sm text-slate-500">操作はまだありません。</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {detail.operations.map((o) => (
              <li key={o.id}>
                <span className="text-slate-500">{formatTime(o.created_at)}</span>{' '}
                {OPERATION_LABELS[o.op_type] ?? o.op_type} →{' '}
                {OPERATION_OUTCOME_LABELS[o.outcome] ?? o.outcome}
                {o.target_generation ? `（世代 ${o.target_generation}）` : ''}
              </li>
            ))}
          </ul>
        )}
        {t.done_reason && (
          <p className="mt-2 text-sm">
            対応終了: {t.done_reason}
            {t.done_source === 'github_review' ? '（GitHubでレビュー提出）' : ''}
          </p>
        )}
      </Card>
    </div>
  );
}
