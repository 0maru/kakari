import { type Finding, type ReviewResultRow, reviewResultSchema, SEVERITIES } from '@kakari/shared';
import { SeverityBadge } from './ui.tsx';

export function findingKey(f: Finding): string {
  return `${f.path ?? ''}|${f.title}`;
}

export function parseResult(row: ReviewResultRow | null | undefined) {
  if (!row || row.body_deleted_at || !row.structured) return null;
  const parsed = reviewResultSchema.safeParse(row.result);
  return parsed.success ? parsed.data : null;
}

/** 未信頼データ（AI出力）をテキストとして表示する。HTMLやリンクとして解釈しない（11.6） */
export function ResultView({ result }: { result: ReviewResultRow }) {
  if (result.body_deleted_at) {
    return (
      <p className="text-sm text-slate-500">
        保存期限により本文を削除しました。成功履歴は保持しています。
      </p>
    );
  }
  const parsed = parseResult(result);
  if (!parsed) {
    return (
      <div className="space-y-2">
        <p className="rounded bg-rose-50 p-2 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-200">
          要確認: 結果を構造化できませんでした。指摘0件ではありません。元の出力を表示します。
        </p>
        <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded bg-slate-100 p-3 text-xs dark:bg-slate-800">
          {result.raw_output ?? '(出力なし)'}
        </pre>
      </div>
    );
  }
  const findings = [...parsed.findings].sort(
    (a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity),
  );
  return (
    <div className="space-y-4 text-sm">
      <div>
        <h3 className="mb-1 font-semibold">要約</h3>
        <p className="whitespace-pre-wrap">{parsed.summary}</p>
      </div>
      <div>
        <h3 className="mb-2 font-semibold">指摘（{findings.length}件）</h3>
        {findings.length === 0 && (
          <p className="text-slate-500">
            {parsed.quality_status === 'complete'
              ? '指摘はありません。'
              : '指摘はありませんが、分析は一部に限られています（問題なしとは限りません）。'}
          </p>
        )}
        <ul className="space-y-3">
          {findings.map((f) => (
            <li
              key={findingKey(f)}
              className="rounded border border-slate-200 p-3 dark:border-slate-700"
            >
              <div className="flex flex-wrap items-center gap-2">
                <SeverityBadge severity={f.severity} />
                <span className="font-medium">{f.title}</span>
                <span className="text-xs text-slate-500">確度: {f.confidence}</span>
              </div>
              <div className="mt-1 font-mono text-xs text-slate-600 dark:text-slate-400">
                {f.path ?? '(場所なし)'}
                {f.start_line
                  ? `:${f.start_line}${f.end_line && f.end_line !== f.start_line ? `-${f.end_line}` : ''}`
                  : ''}
              </div>
              <p className="mt-2 whitespace-pre-wrap">{f.reason}</p>
              {f.suggestion && (
                <p className="mt-2 whitespace-pre-wrap text-slate-700 dark:text-slate-300">
                  <span className="font-medium">確認・修正の方向性: </span>
                  {f.suggestion}
                </p>
              )}
            </li>
          ))}
        </ul>
      </div>
      {parsed.questions.length > 0 && (
        <div>
          <h3 className="mb-1 font-semibold">確認事項</h3>
          <ul className="list-disc space-y-1 pl-5">
            {parsed.questions.map((q) => (
              <li key={q} className="whitespace-pre-wrap">
                {q}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(parsed.limitations.length > 0 || parsed.quality_status !== 'complete') && (
        <div>
          <h3 className="mb-1 font-semibold">分析上の制限</h3>
          <ul className="list-disc space-y-1 pl-5 text-slate-600 dark:text-slate-400">
            {parsed.quality_status !== 'complete' && <li>分析は一部に限られています（partial）</li>}
            {parsed.limitations.map((l) => (
              <li key={l} className="whitespace-pre-wrap">
                {l}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
