import { acknowledgeResult, setTaskSnooze } from '@kakari/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createWorld,
  NOTIFIER,
  overview,
  rpc,
  runReview,
  sha,
  sql,
  syncPr,
  WORKER,
  type World,
} from './helpers.ts';

let world: World;

beforeEach(async () => {
  world = await createWorld();
});

function plan(slot: Date, excludeStale = false) {
  return rpc(world.worker, 'worker_plan_notification', {
    p_worker_id: WORKER,
    p_profile_id: 'default',
    p_slot_at: slot.toISOString(),
    p_exclude_stale: excludeStale,
  });
}

function claim() {
  return rpc(world.notifier, 'notifier_claim_events', { p_worker_id: NOTIFIER });
}

function record(event: { event_id: string; claim_token: string }, outcome: string) {
  return rpc(world.notifier, 'notifier_record_delivery', {
    p_worker_id: NOTIFIER,
    p_event_id: event.event_id,
    p_claim_token: event.claim_token,
    p_outcome: outcome,
    p_error: outcome === 'delivered' ? null : 'error',
  });
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

async function reviewed() {
  const res = await syncPr(world.worker);
  const { done } = await runReview(world);
  return { taskId: res.task_id as string, resultId: done.result_id as string };
}

describe('通知準備と配送', () => {
  it('未確認の結果を通知枠でoutboxへ保存し、通知クライアントが自分宛てに取得する', async () => {
    // Arrange
    const { taskId, resultId } = await reviewed();

    // Act
    const planned = await plan(minutesAgo(1));
    const events = await claim();

    // Assert
    expect(planned.status).toBe('planned');
    expect(events).toHaveLength(1);
    expect(events[0].payload.profile_name).toBe('Default');
    expect(events[0].payload.items).toEqual([
      expect.objectContaining({
        task_id: taskId,
        result_id: resultId,
        request_generation: 1,
        repository_full_name: 'example-org/app',
        pr_number: 12,
        pr_title: 'Add feature',
      }),
    ]);
    expect(events[0].payload.counts).toEqual({ total: 1, new: 1, carried_over: 0 });
  });

  it('同じ通知枠は重複して作らない（13.4）', async () => {
    // Arrange
    await reviewed();
    const slot = minutesAgo(1);
    await plan(slot);

    // Act
    const again = await plan(slot);

    // Assert
    expect(again.status).toBe('already_planned');
  });

  it('未確認のまま次の通知枠になると保存済み結果を再通知し、AIは起動しない（AC-03）', async () => {
    // Arrange
    await reviewed();
    await plan(minutesAgo(10));
    const [first] = await claim();
    await record(first, 'delivered');

    // Act
    const next = await plan(minutesAgo(1));
    const events = await claim();

    // Assert
    expect(next.status).toBe('planned');
    expect(events[0].payload.counts).toEqual({ total: 1, new: 0, carried_over: 1 });
    const { rows } = await sql.query('select count(*)::int as n from public.review_attempts');
    expect(rows[0].n).toBe(1);
  });

  it('表示前にackされた通知は取り消す（AC-41）', async () => {
    // Arrange
    const { taskId, resultId } = await reviewed();
    await plan(minutesAgo(1));
    const task = await overview(world.owner, taskId);
    await acknowledgeResult(world.owner, {
      taskId,
      resultId,
      requestGeneration: 1,
      expectedRevision: task.revision ?? 0,
      operationId: 'op-ack-notify',
    });

    // Act
    const events = await claim();

    // Assert
    expect(events).toHaveLength(0);
    const { rows } = await sql.query('select state, hold_reason from public.outbox_events');
    expect(rows[0]).toMatchObject({ state: 'cancelled', hold_reason: 'no_longer_applicable' });
  });

  it('表示前にheadが更新された通知は取り消す（AC-41）', async () => {
    // Arrange
    await reviewed();
    await plan(minutesAgo(1));
    await syncPr(world.worker, { head_sha: sha('c') });

    // Act
    const events = await claim();

    // Assert
    expect(events).toHaveLength(0);
  });

  it('スヌーズ中は通知しない（AC-28）', async () => {
    // Arrange
    const { taskId } = await reviewed();
    const task = await overview(world.owner, taskId);
    await setTaskSnooze(world.owner, {
      taskId,
      until: new Date(Date.now() + 3_600_000),
      expectedRevision: task.revision ?? 0,
      operationId: 'op-snooze-n1',
    });

    // Act
    const planned = await plan(minutesAgo(1));

    // Assert
    expect(planned.status).toBe('nothing');
  });

  it('GitHubの最終同期が鮮度上限を超えていれば通知を保留する（AC-42）', async () => {
    // Arrange
    await reviewed();
    await sql.query(
      "update public.pull_requests set last_synced_at = now() - interval '30 minutes'",
    );

    // Act
    const planned = await plan(minutesAgo(1));

    // Assert
    expect(planned.status).toBe('needs_sync');
    expect(planned.pull_request_ids).toHaveLength(1);

    // Arrange: 通知作成後に古くなった場合は配送側で保留する
    await syncPr(world.worker);
    await plan(minutesAgo(1));
    await sql.query(
      "update public.pull_requests set last_synced_at = now() - interval '30 minutes'",
    );

    // Act
    const events = await claim();

    // Assert
    expect(events).toHaveLength(0);
    const { rows } = await sql.query('select state, hold_reason from public.outbox_events');
    expect(rows[0]).toMatchObject({ state: 'pending', hold_reason: 'stale' });
  });

  it('逃した過去の通知枠を一括で送らない（AC-32）', async () => {
    // Arrange
    await reviewed();

    // Act
    await plan(minutesAgo(300));
    await plan(minutesAgo(120));
    await plan(minutesAgo(5));
    const events = await claim();

    // Assert
    expect(events).toHaveLength(1);
    const { rows } = await sql.query(
      "select count(*)::int as n from public.outbox_events where state = 'superseded'",
    );
    expect(rows[0].n).toBe(2);
  });

  it('表示要求の失敗は成功と記録せず、結果が不明なら自動再送しない（AC-39・13.4）', async () => {
    // Arrange
    await reviewed();
    await plan(minutesAgo(1));
    const [event] = await claim();

    // Act
    await record(event, 'unknown');
    const again = await claim();

    // Assert
    expect(again).toHaveLength(0);
    const { rows } = await sql.query('select state from public.outbox_events');
    expect(rows[0].state).toBe('unknown');
  });

  it('取得権の期限切れは不明扱いにして自動再送しない', async () => {
    // Arrange
    await reviewed();
    await plan(minutesAgo(1));
    await claim();
    await sql.query(
      "update public.outbox_events set claim_expires_at = now() - interval '1 second'",
    );

    // Act
    const again = await claim();

    // Assert
    expect(again).toHaveLength(0);
    const { rows } = await sql.query('select state from public.outbox_events');
    expect(rows[0].state).toBe('unknown');
  });

  it('同一障害の運用通知は1日1回以下にまとめる（13.1）', async () => {
    // Act
    const first = await rpc(world.worker, 'worker_raise_ops_alert', {
      p_worker_id: WORKER,
      p_profile_id: 'default',
      p_kind: 'auth_expired',
      p_message: 'Claude Codeの認証を確認してください',
    });
    const second = await rpc(world.worker, 'worker_raise_ops_alert', {
      p_worker_id: WORKER,
      p_profile_id: 'default',
      p_kind: 'auth_expired',
      p_message: 'Claude Codeの認証を確認してください',
    });

    // Assert
    expect(first.status).toBe('queued');
    expect(second.status).toBe('suppressed');
  });

  it('対応終了した項目は通知しない', async () => {
    // Arrange
    const { taskId } = await reviewed();
    const task = await overview(world.owner, taskId);
    await rpc(world.owner, 'complete_review_task', {
      p_task_id: taskId,
      p_request_generation: 1,
      p_reason: 'done',
      p_expected_revision: task.revision,
      p_operation_id: 'op-done-notify',
    });

    // Act
    const planned = await plan(minutesAgo(1));

    // Assert
    expect(planned.status).toBe('nothing');
  });
});
