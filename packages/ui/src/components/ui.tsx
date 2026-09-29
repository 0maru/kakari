import {
  DISPLAY_STATE_LABELS,
  type DisplayState,
  isDisplayState,
  SEVERITY_LABELS,
} from '@kakari/shared';
import type { ReactNode } from 'react';

const STATE_STYLES: Record<DisplayState, string> = {
  preparing: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
  awaiting_ack: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  in_review: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200',
  waiting: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200',
  done: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  inactive: 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
};

export function StateBadge({ state }: { state: string | null }) {
  if (!isDisplayState(state)) return <span className="text-xs text-slate-500">{state ?? '-'}</span>;
  return (
    <span
      className={`inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ${STATE_STYLES[state]}`}
    >
      {DISPLAY_STATE_LABELS[state]}
    </span>
  );
}

const SEVERITY_STYLES: Record<string, string> = {
  critical: 'bg-red-600 text-white',
  high: 'bg-orange-500 text-white',
  medium: 'bg-amber-400 text-slate-900',
  low: 'bg-slate-300 text-slate-900',
  info: 'bg-slate-200 text-slate-700',
};

export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-xs font-semibold ${SEVERITY_STYLES[severity] ?? ''}`}
    >
      {SEVERITY_LABELS[severity] ?? severity}
    </span>
  );
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
}

export const displayTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * GitHubのPRリンク。未信頼データ由来のURLは許可したhostの形式だけをリンクにし、
 * 送信先を確認できるよう URL を表示する（11.6）。
 */
export function PrLink({ url, host }: { url: string | null; host: string | null }) {
  const h = host ?? 'github.com';
  const ok =
    url && new RegExp(`^https://${h.replace(/\./g, '\\.')}/[^/\\s]+/[^/\\s]+/pull/\\d+$`).test(url);
  if (!ok) return <span className="text-slate-500">{url ?? '-'}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="text-indigo-600 underline hover:text-indigo-800 dark:text-indigo-400"
    >
      GitHubで開く <span className="text-xs text-slate-500">({url})</span>
    </a>
  );
}

export function Card({
  title,
  children,
  actions,
}: {
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      {(title || actions) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && (
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{title}</h2>
          )}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
      データを取得できませんでした: {message}
    </div>
  );
}
