import { JSON_SCHEMA_VERSION } from '@kakari/shared';

/** 標準出力には要求されたデータだけを出す（16.3） */
export function printJson(data: Record<string, unknown>): void {
  process.stdout.write(
    `${JSON.stringify({ schema_version: JSON_SCHEMA_VERSION, ...data }, null, 2)}\n`,
  );
}

export function printText(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

/** 診断・進行情報は標準エラー出力へ出す */
export function info(text: string): void {
  process.stderr.write(`${text}\n`);
}

export function formatTime(value: string | null | undefined, timeZone?: string): string {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
}

export function pad(text: string, width: number): string {
  let w = 0;
  for (const ch of text) w += /[ᄀ-￿]/.test(ch) ? 2 : 1;
  return w >= width ? text : text + ' '.repeat(width - w);
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
