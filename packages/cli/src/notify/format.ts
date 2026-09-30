import { APP_NAME } from '@kakari/shared';
import type { ClaimedEvent } from '../worker/db-api.ts';
import type { OsNotification } from './delivery.ts';

/** 表示するURLは作業端末のUI配信先から組み立てる（13.3・AC-54） */
export function taskUrl(
  base: string,
  taskId: string,
  resultId?: string,
  generation?: number,
): string {
  const url = new URL(`${base}/tasks/${encodeURIComponent(taskId)}`);
  if (resultId) url.searchParams.set('result', resultId);
  if (generation !== undefined) url.searchParams.set('generation', String(generation));
  return url.toString();
}

export function listUrl(base: string, profileId: string): string {
  const url = new URL(`${base}/tasks`);
  url.searchParams.set('profile', profileId);
  url.searchParams.set('state', 'awaiting_ack');
  return url.toString();
}

/** 通知文はDBの値とテンプレートで作る。AIは呼ばない（13.2） */
export function formatNotification(event: ClaimedEvent, uiBase: string): OsNotification {
  const p = event.payload;
  if (event.event_type === 'ops_alert') {
    return {
      title: APP_NAME,
      subtitle: `[${p.profile_name}] 運用通知`,
      message: p.message ?? '運用上の問題があります。kakari status で確認してください。',
      url: listUrl(uiBase, p.profile_id),
      group: `kakari-ops-${p.profile_id}`,
    };
  }
  const counts = p.counts ?? { total: 0, new: 0, carried_over: 0 };
  const items = p.items ?? [];
  const lines = [
    `確認待ちのAIレビュー結果が${counts.total}件あります。`,
    `新しい結果: ${counts.new}件 / 前回から未確認: ${counts.carried_over}件`,
  ];
  if (p.detail_level !== 'count_only') {
    for (const item of items.slice(0, 3)) {
      if (!item.repository_full_name) continue;
      const label = `${item.repository_full_name}#${item.pr_number}`;
      const title = item.pr_title ? ` ${item.pr_title.slice(0, 60)}` : '';
      lines.push(
        `${label}${title} — ${item.previously_notified ? '前回から未確認' : '最新結果を準備済み'}`,
      );
    }
    if (items.length > 3) lines.push(`ほか${items.length - 3}件はレビュー一覧で確認してください`);
  }
  const single = items.length === 1 ? items[0] : undefined;
  return {
    title: APP_NAME,
    subtitle: `[${p.profile_name}]`,
    message: lines.join('\n'),
    url: single
      ? taskUrl(uiBase, single.task_id, single.result_id, single.request_generation)
      : listUrl(uiBase, p.profile_id),
    group: `kakari-${p.profile_id}`,
  };
}
