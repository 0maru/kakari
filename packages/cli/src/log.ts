export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * 診断ログは標準エラー出力へ出す（16.3）。
 * 認証情報・コード全文・AIの生出力は渡さない（14.3）。件数・状態・IDを中心にする。
 */
export function createLogger(
  level: LogLevel = (process.env.KAKARI_LOG_LEVEL as LogLevel) ?? 'info',
  format: 'text' | 'json' = process.env.KAKARI_LOG_FORMAT === 'json' ? 'json' : 'text',
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Logger {
  const min = ORDER[level] ?? ORDER.info;
  const emit = (lvl: LogLevel, message: string, input?: Record<string, unknown>) => {
    let fields = input;
    if (ORDER[lvl] < min) return;
    const time = new Date().toISOString();
    if (fields) {
      fields = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    }
    if (format === 'json') {
      write(JSON.stringify({ time, level: lvl, message, ...fields }));
      return;
    }
    const extra = fields
      ? Object.entries(fields)
          .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join(' ')
      : '';
    write(`${time} ${lvl.toUpperCase()} ${message}${extra ? ` ${extra}` : ''}`);
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
