import { getSystemStatus } from '@kakari/shared';
import type { Command } from 'commander';
import { formatTime, printJson, printText } from '../output.ts';
import { contextFor, humanClient } from './common.ts';

function ago(value: string | null): string {
  if (!value) return '記録なし';
  const sec = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (sec < 60) return `${sec}秒前`;
  if (sec < 3600) return `${Math.round(sec / 60)}分前`;
  if (sec < 86400) return `${Math.round(sec / 3600)}時間前`;
  return `${Math.round(sec / 86400)}日前`;
}

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description(
      '同期時刻・レート制限・保留理由・実行中ジョブ・通知配送状態を表示する（GitHub同期は起動しない）',
    )
    .option('--profile <id>', 'プロファイル')
    .option('--json', 'JSONで出力する')
    .action(async (opts, cmd: Command) => {
      const ctx = contextFor(cmd);
      const client = await humanClient(ctx);
      const s = await getSystemStatus(client, opts.profile);
      if (opts.json) {
        printJson({
          profiles: s.profiles,
          workers: s.workers,
          usage_pools: s.usagePools,
          sync_states: s.syncStates,
          rate_limits: s.rateLimits,
          job_counts: s.jobCounts,
          recent_notifications: s.recentOutbox.map(({ payload: _p, ...rest }) => rest),
        });
        return;
      }
      const lines: string[] = [];
      lines.push('■ プロファイル');
      for (const p of s.profiles) {
        const sync = s.syncStates.find((x) => x.profile_id === p.id);
        lines.push(
          `- ${p.id} (${p.name}) ${p.enabled ? '有効' : '無効'}${p.paused ? '・自動レビュー停止中' : ''}  provider: ${p.provider}  設定: ${p.review_config_version}`,
          `  最終検出: ${ago(sync?.last_discovery_at ?? null)}（${sync?.discovery_status ?? '-'}）  最終成功: ${formatTime(sync?.last_discovery_success_at)}`,
        );
        if (sync?.discovery_error) lines.push(`  エラー: ${sync.discovery_error}`);
        const incomplete =
          (sync?.incomplete_scopes as { scope: string; reason: string }[] | null) ?? [];
        for (const i of incomplete) lines.push(`  取得できていない範囲: ${i.scope}（${i.reason}）`);
      }
      lines.push('', '■ 端末');
      for (const w of s.workers) {
        lines.push(`- ${w.id} [${w.roles.join(', ')}] 最終生存: ${ago(w.last_seen_at)}`);
      }
      lines.push('', '■ ジョブ');
      const counts = Object.entries(s.jobCounts);
      lines.push(
        counts.length === 0
          ? '- 待機・実行中のジョブはありません'
          : `- ${counts.map(([k, v]) => `${k}: ${v}`).join('  ')}`,
      );
      for (const pool of s.usagePools) {
        if (pool.blocked_manual || pool.blocked_until) {
          lines.push(
            `- 利用枠 ${pool.id} を保留中: ${pool.blocked_reason ?? ''}${pool.blocked_manual ? `（手動で再開: kakari resume --pool ${pool.id}）` : `（${formatTime(pool.blocked_until)} まで）`}`,
          );
        }
      }
      lines.push('', '■ GitHub レート制限');
      if (s.rateLimits.length === 0) lines.push('- 記録なし');
      for (const r of s.rateLimits) {
        lines.push(
          `- ${r.principal} ${r.resource}: 残り ${r.remaining ?? '?'}/${r.limit_value ?? '?'}  reset ${formatTime(r.reset_at)}${r.blocked_until ? `  待機中: ${formatTime(r.blocked_until)} まで（${r.wait_reason ?? ''}）` : ''}`,
        );
      }
      lines.push('', '■ 最近の通知');
      if (s.recentOutbox.length === 0) lines.push('- 記録なし');
      for (const e of s.recentOutbox.slice(0, 10)) {
        lines.push(
          `- ${formatTime(e.created_at)} ${e.event_type} → ${e.state}${e.hold_reason ? `（${e.hold_reason}）` : ''}${e.delivery_error ? ` ${e.delivery_error}` : ''}`,
        );
      }
      printText(lines.join('\n'));
    });
}
