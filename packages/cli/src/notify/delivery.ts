import { baseEnv, runProcess } from '../process.ts';

export interface OsNotification {
  title: string;
  subtitle?: string | undefined;
  message: string;
  url?: string | undefined;
  group?: string | undefined;
}

export interface DeliveryResult {
  outcome: 'delivered' | 'failed' | 'unknown';
  error?: string;
}

export interface Delivery {
  readonly name: string;
  show(notification: OsNotification): Promise<DeliveryResult>;
}

/**
 * macOS の通知センターへ表示する（terminal-notifier）。
 * 表示要求の成功は「人間が見た」「確認済み」を意味しない（13.3）。
 */
export class MacDelivery implements Delivery {
  readonly name = 'macos_native';

  private readonly terminalNotifier: string;

  constructor(terminalNotifier: string) {
    this.terminalNotifier = terminalNotifier;
  }

  async show(n: OsNotification): Promise<DeliveryResult> {
    const args = ['-title', n.title, '-message', n.message];
    if (n.subtitle) args.push('-subtitle', n.subtitle);
    if (n.group) args.push('-group', n.group);
    if (n.url) args.push('-open', n.url);
    try {
      const res = await runProcess(this.terminalNotifier, args, {
        env: baseEnv(),
        timeoutMs: 20_000,
      });
      if (res.timedOut) return { outcome: 'unknown', error: 'terminal-notifier timed out' };
      if (res.code === 0) return { outcome: 'delivered' };
      return {
        outcome: 'failed',
        error: `terminal-notifier exit ${res.code}: ${res.stderr.trim().slice(0, 200)}`,
      };
    } catch (error) {
      return { outcome: 'failed', error: (error as Error).message };
    }
  }
}

/** 開発・検証用: 標準エラー出力へ表示する */
export class ConsoleDelivery implements Delivery {
  readonly name = 'console';

  private readonly write: (line: string) => void;

  constructor(write: (line: string) => void = (l) => process.stderr.write(`${l}\n`)) {
    this.write = write;
  }

  async show(n: OsNotification): Promise<DeliveryResult> {
    this.write(
      `[${n.title}]${n.subtitle ? ` ${n.subtitle}` : ''}\n${n.message}${n.url ? `\n${n.url}` : ''}`,
    );
    return { outcome: 'delivered' };
  }
}
