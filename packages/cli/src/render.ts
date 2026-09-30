import {
  DISPLAY_STATE_LABELS,
  describeWaitingReason,
  type Finding,
  isDisplayState,
  type ReviewResultRow,
  reviewResultSchema,
  SEVERITIES,
  SEVERITY_LABELS,
  shortSha,
  type TaskDetail,
  type TaskOverview,
} from '@kakari/shared';
import { formatTime, pad, truncate } from './output.ts';

export function stateLabel(state: string | null): string {
  return isDisplayState(state) ? DISPLAY_STATE_LABELS[state] : (state ?? '-');
}

export function renderTaskList(
  rows: TaskOverview[],
  total: number | null,
  page: number,
  pageSize: number,
): string {
  if (rows.length === 0) return '該当するレビュー項目はありません。';
  const lines = rows.map((r) => {
    const pr = `${r.repository_full_name}#${r.pr_number}`;
    const summary =
      r.result_is_current && r.result_quality_status === 'unstructured'
        ? '要確認（構造化できない結果）'
        : r.result_is_current
          ? `${r.result_findings_count ?? '?'}件の指摘${r.result_max_severity ? `（最大: ${SEVERITY_LABELS[r.result_max_severity] ?? r.result_max_severity}）` : ''}`
          : r.current_result_id
            ? '最新結果待ち'
            : '-';
    return [
      pad(stateLabel(r.display_state), 10),
      pad(truncate(pr, 40), 40),
      pad(truncate(r.pr_title ?? '', 40), 40),
      pad(shortSha(r.head_sha), 8),
      pad(summary, 24),
      r.task_id,
    ].join(' ');
  });
  const header = [
    pad('状態', 10),
    pad('PR', 40),
    pad('タイトル', 40),
    pad('head', 8),
    pad('結果', 24),
    'task ID',
  ].join(' ');
  const pages = total !== null ? Math.max(1, Math.ceil(total / pageSize)) : null;
  return [
    header,
    ...lines,
    '',
    `${page}${pages ? `/${pages}` : ''} ページ（全${total ?? '?'}件）`,
  ].join('\n');
}

function findingLines(f: Finding, md: boolean): string[] {
  const loc = f.path
    ? `${f.path}${f.start_line ? `:${f.start_line}${f.end_line && f.end_line !== f.start_line ? `-${f.end_line}` : ''}` : ''}`
    : '(場所なし)';
  const sev = SEVERITY_LABELS[f.severity] ?? f.severity;
  const out = md
    ? [`### [${sev}] ${f.title}`, '', `- 場所: \`${loc}\``, `- 確度: ${f.confidence}`, '', f.reason]
    : [
        `[${sev}] ${f.title}`,
        `  場所: ${loc}  確度: ${f.confidence}`,
        ...f.reason.split('\n').map((l) => `  ${l}`),
      ];
  if (f.suggestion) {
    out.push(
      ...(md ? ['', `**確認・修正の方向性**: ${f.suggestion}`, ''] : [`  → ${f.suggestion}`]),
    );
  }
  return out;
}

export function renderResultBody(result: ReviewResultRow, md: boolean): string[] {
  const lines: string[] = [];
  if (result.body_deleted_at) {
    lines.push(
      md ? '_保存期限により本文を削除しました。_' : '（保存期限により本文を削除しました）',
    );
    return lines;
  }
  const parsed = reviewResultSchema.safeParse(result.result);
  if (!result.structured || !parsed.success) {
    lines.push(
      md
        ? '> **要確認**: 結果を構造化できませんでした。元の出力を表示します。'
        : '【要確認】結果を構造化できませんでした。元の出力を表示します。',
    );
    lines.push(md ? '```' : '', result.raw_output ?? '(出力なし)', md ? '```' : '');
    return lines;
  }
  const r = parsed.data;
  lines.push(md ? '## 要約' : '■ 要約', r.summary, '');
  lines.push(md ? `## 指摘（${r.findings.length}件）` : `■ 指摘（${r.findings.length}件）`);
  if (r.findings.length === 0) {
    lines.push(
      r.quality_status === 'complete'
        ? '指摘はありません。'
        : '指摘はありませんが、分析は一部に限られています。',
    );
  }
  const sorted = [...r.findings].sort(
    (a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity),
  );
  for (const f of sorted) lines.push(...findingLines(f, md), '');
  if (r.questions.length > 0) {
    lines.push(md ? '## 確認事項' : '■ 確認事項', ...r.questions.map((q) => `- ${q}`), '');
  }
  if (r.limitations.length > 0 || r.quality_status !== 'complete') {
    lines.push(md ? '## 分析上の制限' : '■ 分析上の制限');
    if (r.quality_status !== 'complete') lines.push('- 分析は一部に限られています（partial）');
    lines.push(...r.limitations.map((l) => `- ${l}`), '');
  }
  return lines;
}

export function renderTaskDetail(
  detail: TaskDetail,
  result: ReviewResultRow | null,
  format: 'text' | 'markdown',
): string {
  const t = detail.task;
  const md = format === 'markdown';
  const h = (s: string) => (md ? `## ${s}` : `■ ${s}`);
  const lines: string[] = [];
  lines.push(
    md
      ? `# ${t.repository_full_name}#${t.pr_number} ${t.pr_title ?? ''}`
      : `${t.repository_full_name}#${t.pr_number} ${t.pr_title ?? ''}`,
  );
  lines.push('');
  lines.push(
    `状態: ${stateLabel(t.display_state)}${t.waiting_reason ? `（${describeWaitingReason(t.waiting_reason)}）` : ''}`,
  );
  if (t.done_reason)
    lines.push(
      `対応終了の理由: ${t.done_reason}${t.done_source === 'github_review' ? '（GitHubでレビュー提出）' : ''}`,
    );
  lines.push(
    `PR: ${t.pr_url}  （${t.pr_state}${t.pr_draft ? ', draft' : ''}） 作成者: ${t.pr_author_login ?? '-'}`,
  );
  lines.push(
    `現在head: ${shortSha(t.head_sha)}  base: ${shortSha(t.base_sha)}  依頼世代: ${t.request_generation}  revision: ${t.revision}`,
  );
  lines.push(
    `GitHub最終確認: ${formatTime(t.last_synced_at)}${t.sync_status !== 'ok' ? `（${t.sync_status}）` : ''}`,
  );
  if (t.snoozed_until) lines.push(`スヌーズ: ${formatTime(t.snoozed_until)} まで`);
  lines.push(`task ID: ${t.task_id}`);
  lines.push('');

  if (result) {
    const isCurrent = result.id === t.current_result_id;
    const job = detail.jobs.find((j) => j.id === result.job_id);
    lines.push(h(`レビュー結果${isCurrent ? '' : '（履歴の結果）'}`));
    lines.push(`result ID: ${result.id}`);
    lines.push(
      `対象SHA: ${shortSha(result.head_sha)}  base: ${shortSha(result.base_sha)}  merge-base: ${shortSha(result.merge_base_sha)}`,
    );
    lines.push(
      `provider: ${result.provider}  CLI: ${result.cli_version ?? '-'}  設定: ${result.review_config_version}  実行: ${formatTime(result.created_at)}${result.manual_generation > 0 ? `  手動世代: ${result.manual_generation}${job?.manual_reason ? `（${job.manual_reason}）` : ''}` : ''}`,
    );
    if (!isCurrent)
      lines.push(
        '※ この結果は現在の採用結果ではありません。最新結果と内容が異なる場合があります。',
      );
    if (result.head_sha !== t.head_sha)
      lines.push(`※ 現在のhead（${shortSha(t.head_sha)}）とは異なるSHAの結果です。`);
    if (isCurrent && t.premise_changed)
      lines.push('※ レビュー時から base または PR本文が変わっています（前提変更あり）。');
    lines.push('');
    lines.push(...renderResultBody(result, md));
    if (isCurrent && t.display_state === 'awaiting_ack') {
      lines.push(
        `確認済みにする: kakari ack ${result.id} --request-generation ${t.request_generation}`,
      );
    }
  } else {
    lines.push(
      h('レビュー結果'),
      t.current_job_status ? `AIレビュー: ${t.current_job_status}` : 'まだ結果がありません。',
    );
  }
  lines.push('');

  if (detail.results.length > 0) {
    lines.push(h('結果履歴'));
    for (const r of detail.results) {
      lines.push(
        `- ${formatTime(r.created_at)} ${shortSha(r.head_sha)} ${r.quality_status} 指摘${r.findings_count ?? '?'}件${r.manual_generation > 0 ? ` 手動${r.manual_generation}` : ''}${r.id === t.current_result_id ? ' (採用中)' : ''} ${r.id}`,
      );
    }
    lines.push('');
  }
  if (detail.operations.length > 0) {
    lines.push(h('操作履歴'));
    for (const o of detail.operations.slice(0, 20)) {
      lines.push(
        `- ${formatTime(o.created_at)} ${o.op_type} → ${o.outcome}${o.target_generation ? ` 世代${o.target_generation}` : ''}`,
      );
    }
  }
  return lines.join('\n');
}
