import type { ProfileConfig } from '../config/schema.ts';
import type { Logger } from '../log.ts';
import type { PlanResult, WorkerDb } from '../worker/db-api.ts';
import { latestDueSlot } from './schedule.ts';

export type Resync = (profile: ProfileConfig, pullRequestIds: string[]) => Promise<void>;

/**
 * 通知準備（13.3の1）。通知枠に到達したら、鮮度を確認してからoutboxへ保存する。
 */
export class NotificationPlanner {
  private readonly db: WorkerDb;
  private readonly resync: Resync;
  private readonly log: Logger;
  private readonly now: () => Date;

  constructor(db: WorkerDb, resync: Resync, log: Logger, now: () => Date = () => new Date()) {
    this.db = db;
    this.resync = resync;
    this.log = log;
    this.now = now;
  }

  private async lastPlanned(profileId: string): Promise<Date | null> {
    const { data } = await this.db.client
      .from('profile_sync_states')
      .select('last_planned_slot_at')
      .eq('profile_id', profileId)
      .maybeSingle();
    return data?.last_planned_slot_at ? new Date(data.last_planned_slot_at) : null;
  }

  async tick(profile: ProfileConfig): Promise<PlanResult | null> {
    const slot = latestDueSlot(this.now(), profile.notifications);
    if (!slot) return null;
    const last = await this.lastPlanned(profile.id);
    if (last && slot.getTime() <= last.getTime()) return null;

    let res = await this.db.planNotification(profile.id, slot);
    if (res.status === 'needs_sync') {
      // 通知前にGitHub状態を再同期する（13.1）
      await this.resync(profile, res.pull_request_ids).catch((error) => {
        this.log.warn('resync before notification failed', {
          profile: profile.id,
          error: (error as Error).message,
        });
      });
      res = await this.db.planNotification(profile.id, slot);
      if (res.status === 'needs_sync') {
        // 同期できなかった項目は除外し、古い状態を最新と断定した通知は送らない
        res = await this.db.planNotification(profile.id, slot, true);
      }
    }
    this.log.info('notification planned', {
      profile: profile.id,
      slot: slot.toISOString(),
      status: res.status,
    });
    return res;
  }

  /** 鮮度不足で配送側が保留した通知の対象PRを再同期する */
  async refreshHeld(profile: ProfileConfig): Promise<void> {
    const { data } = await this.db.client
      .from('outbox_events')
      .select('payload')
      .eq('profile_id', profile.id)
      .eq('state', 'pending')
      .eq('hold_reason', 'stale');
    const taskIds = new Set<string>();
    for (const e of data ?? []) {
      const items = (e.payload as { items?: { task_id: string }[] } | null)?.items ?? [];
      for (const i of items) taskIds.add(i.task_id);
    }
    if (taskIds.size === 0) return;
    const { data: tasks } = await this.db.client
      .from('review_tasks')
      .select('pull_request_id')
      .in('id', [...taskIds]);
    const prIds = [...new Set((tasks ?? []).map((t) => t.pull_request_id))];
    if (prIds.length > 0) await this.resync(profile, prIds);
  }
}
