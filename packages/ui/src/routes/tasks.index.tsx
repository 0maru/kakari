import {
  DISPLAY_STATE_LABELS,
  DISPLAY_STATES,
  type DisplayState,
  describeWaitingReason,
  isDisplayState,
  listTasks,
  shortSha,
} from '@kakari/shared';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Card, ErrorBox, formatTime, StateBadge } from '../components/ui.tsx';
import { useApp } from '../lib/app.tsx';

interface ListSearch {
  profile?: string;
  repo?: string;
  state?: DisplayState;
  unacked?: boolean;
  page?: number;
}

export const Route = createFileRoute('/tasks/')({
  validateSearch: (s: Record<string, unknown>): ListSearch => ({
    profile: typeof s.profile === 'string' && s.profile ? s.profile : undefined,
    repo: typeof s.repo === 'string' && s.repo ? s.repo : undefined,
    state: isDisplayState(s.state) ? s.state : undefined,
    unacked: s.unacked === true || s.unacked === 'true' ? true : undefined,
    page: typeof s.page === 'number' && s.page > 1 ? Math.floor(s.page) : undefined,
  }),
  component: TaskListPage,
});

function SyncInfo() {
  const { client } = useApp();
  const q = useQuery({
    queryKey: ['sync-info'],
    queryFn: async () => {
      const [sync, workers] = await Promise.all([
        client.from('profile_sync_states').select('*'),
        client.from('workers').select('id, roles, last_seen_at'),
      ]);
      if (sync.error) throw sync.error;
      if (workers.error) throw workers.error;
      return { sync: sync.data, workers: workers.data };
    },
  });
  if (!q.data) return null;
  const stale = (t: string | null, minutes: number) =>
    !t || Date.now() - new Date(t).getTime() > minutes * 60_000;
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-500">
      {q.data.sync.map((s) => (
        <span
          key={s.profile_id}
          className={s.discovery_status && s.discovery_status !== 'ok' ? 'text-rose-600' : ''}
        >
          {s.profile_id}: GitHub最終同期 {formatTime(s.last_discovery_success_at)}
          {s.discovery_status && s.discovery_status !== 'ok' ? `（${s.discovery_status}）` : ''}
        </span>
      ))}
      {q.data.workers.map((w) => (
        <span key={w.id} className={stale(w.last_seen_at, 5) ? 'text-rose-600' : ''}>
          {w.id}: {stale(w.last_seen_at, 5) ? '停止中の可能性' : '稼働中'}（
          {formatTime(w.last_seen_at)}）
        </span>
      ))}
    </div>
  );
}

function TaskListPage() {
  const { client, config } = useApp();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: '/tasks/' });
  const page = search.page ?? 1;

  const profiles = useQuery({
    queryKey: ['profiles'],
    queryFn: async () => {
      const { data, error } = await client.from('profiles').select('id, name').order('id');
      if (error) throw error;
      return data;
    },
  });

  const tasks = useQuery({
    queryKey: ['tasks', search],
    queryFn: () =>
      listTasks(client, {
        profileId: search.profile,
        repository: search.repo,
        displayStates: search.state ? [search.state] : undefined,
        unackedOnly: search.unacked,
        page,
        pageSize: config.pageSize,
      }),
    placeholderData: (prev) => prev,
  });

  const update = (patch: Partial<ListSearch>) =>
    void navigate({ search: (prev) => ({ ...prev, ...patch, page: patch.page }) });

  const totalPages = tasks.data?.total
    ? Math.max(1, Math.ceil(tasks.data.total / config.pageSize))
    : 1;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-xl font-semibold">レビュー一覧</h1>
        <SyncInfo />
      </div>
      <Card>
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label className="flex flex-col gap-1">
            プロファイル
            <select
              className="rounded border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-800"
              value={search.profile ?? ''}
              onChange={(e) => update({ profile: e.target.value || undefined })}
            >
              <option value="">すべて</option>
              {profiles.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            リポジトリ
            <input
              className="rounded border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-800"
              placeholder="owner/repo"
              defaultValue={search.repo ?? ''}
              onKeyDown={(e) => {
                if (e.key === 'Enter') update({ repo: e.currentTarget.value.trim() || undefined });
              }}
              onBlur={(e) => update({ repo: e.currentTarget.value.trim() || undefined })}
            />
          </label>
          <label className="flex flex-col gap-1">
            表示状態
            <select
              className="rounded border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-800"
              value={search.state ?? ''}
              onChange={(e) =>
                update({ state: isDisplayState(e.target.value) ? e.target.value : undefined })
              }
            >
              <option value="">すべて</option>
              {DISPLAY_STATES.map((s) => (
                <option key={s} value={s}>
                  {DISPLAY_STATE_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 pb-1">
            <input
              type="checkbox"
              checked={Boolean(search.unacked)}
              onChange={(e) => update({ unacked: e.target.checked || undefined })}
            />
            未確認の結果のみ
          </label>
        </div>
      </Card>

      {tasks.error ? (
        <ErrorBox error={tasks.error} />
      ) : !tasks.data ? (
        <p className="text-sm text-slate-500">読み込み中…</p>
      ) : tasks.data.rows.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-500">条件に一致するレビュー項目はありません。</p>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-800/50">
              <tr>
                <th className="px-3 py-2">状態</th>
                <th className="px-3 py-2">PR</th>
                <th className="px-3 py-2">作成者</th>
                <th className="px-3 py-2">現在head</th>
                <th className="px-3 py-2">レビュー済みSHA</th>
                <th className="px-3 py-2">結果</th>
                <th className="px-3 py-2">更新</th>
              </tr>
            </thead>
            <tbody>
              {tasks.data.rows.map((t) => (
                <tr
                  key={t.task_id}
                  className="border-t border-slate-100 align-top hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/40"
                >
                  <td className="px-3 py-2">
                    <StateBadge state={t.display_state} />
                    {t.waiting_reason && (
                      <div className="mt-1 text-xs text-rose-600">
                        {describeWaitingReason(t.waiting_reason)}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Link
                      to="/tasks/$taskId"
                      params={{ taskId: t.task_id ?? '' }}
                      className="font-medium text-indigo-700 hover:underline dark:text-indigo-300"
                    >
                      {t.repository_full_name}#{t.pr_number}
                    </Link>
                    <div className="max-w-md truncate text-slate-600 dark:text-slate-300">
                      {t.pr_title}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-slate-600">{t.pr_author_login ?? '-'}</td>
                  <td className="px-3 py-2 font-mono text-xs">{shortSha(t.head_sha)}</td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {shortSha(t.result_head_sha)}
                    {t.current_result_id && !t.result_is_current && (
                      <div className="font-sans text-xs text-amber-700">最新結果待ち</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {!t.current_result_id ? (
                      '-'
                    ) : t.result_quality_status === 'unstructured' ? (
                      <span className="text-rose-700">要確認</span>
                    ) : (
                      <span>
                        指摘 {t.result_findings_count ?? '?'} 件
                        {t.result_quality_status === 'partial' && (
                          <span className="ml-1 text-amber-700">（一部のみ分析）</span>
                        )}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-500">
                    {formatTime(t.updated_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tasks.data && tasks.data.rows.length > 0 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-500">
            全 {tasks.data.total ?? '?'} 件 / {page} / {totalPages} ページ
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page <= 1}
              className="rounded border border-slate-300 px-3 py-1 disabled:opacity-40 dark:border-slate-700"
              onClick={() => update({ page: page - 1 > 1 ? page - 1 : undefined })}
            >
              前へ
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              className="rounded border border-slate-300 px-3 py-1 disabled:opacity-40 dark:border-slate-700"
              onClick={() => update({ page: page + 1 })}
            >
              次へ
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
