import type { Logger } from '../log.ts';
import type { WorkerDb } from '../worker/db-api.ts';
import type { Delivery } from './delivery.ts';
import { formatNotification } from './format.ts';

/**
 * 通知クライアント（13.3）。自分宛ての通知だけを取得し、OSに表示する。
 * gh や AI CLI は起動せず、レビューの実行権も取得しない（AC-38）。
 */
export class NotifierService {
  private readonly db: WorkerDb;
  private readonly deliveryFor: (profileId: string) => Delivery | null;
  private readonly uiBase: string;
  private readonly log: Logger;

  constructor(
    db: WorkerDb,
    deliveryFor: (profileId: string) => Delivery | null,
    uiBase: string,
    log: Logger,
  ) {
    this.db = db;
    this.deliveryFor = deliveryFor;
    this.uiBase = uiBase;
    this.log = log;
  }

  async tick(): Promise<{ delivered: number; failed: number; unknown: number }> {
    const counts = { delivered: 0, failed: 0, unknown: 0 };
    const events = await this.db.claimEvents();
    for (const event of events) {
      const delivery = this.deliveryFor(event.payload.profile_id);
      if (!delivery) {
        await this.db.recordDelivery(
          event.event_id,
          event.claim_token,
          'failed',
          'delivery is not configured',
        );
        counts.failed++;
        continue;
      }
      const result = await delivery.show(formatNotification(event, this.uiBase));
      await this.db
        .recordDelivery(event.event_id, event.claim_token, result.outcome, result.error)
        .catch((error) => {
          this.log.warn('failed to record delivery', {
            event: event.event_id,
            error: (error as Error).message,
          });
        });
      counts[result.outcome]++;
      if (result.outcome !== 'delivered') {
        this.log.warn('notification not delivered', {
          event: event.event_id,
          outcome: result.outcome,
          error: result.error,
        });
      }
    }
    return counts;
  }
}
