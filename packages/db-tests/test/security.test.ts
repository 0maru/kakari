import { acknowledgeResult, listTasks } from '@kakari/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createWorld,
  OTHER_WORKER,
  overview,
  rpc,
  runReview,
  sql,
  syncPr,
  WORKER,
  type World,
} from './helpers.ts';

let world: World;

beforeEach(async () => {
  world = await createWorld();
});

describe('権限境界', () => {
  it('未ログインではレビュー情報を取得・変更できない（AC-44）', async () => {
    // Arrange
    const res = await syncPr(world.worker);

    // Act
    const { data } = await world.anon.from('task_overview').select('*');
    const { error } = await world.anon.rpc('complete_review_task', {
      p_task_id: res.task_id,
      p_request_generation: 1,
      p_reason: 'x',
      p_expected_revision: 1,
      p_operation_id: 'op-anon-0001',
    });

    // Assert
    expect(data ?? []).toHaveLength(0);
    expect(error).not.toBeNull();
  });

  it('別プロファイルの利用者はIDを指定しても閲覧・更新できない（AC-44）', async () => {
    // Arrange
    const res = await syncPr(world.worker);
    const { done } = await runReview(world);

    // Act
    const list = await listTasks(world.other);
    const direct = await world.other.from('review_results').select('*').eq('id', done.result_id);
    const [ack] = await Promise.allSettled([
      acknowledgeResult(world.other, {
        taskId: res.task_id,
        resultId: done.result_id,
        requestGeneration: 1,
        expectedRevision: 1,
        operationId: 'op-other-001',
      }),
    ]);

    // Assert
    expect(list.rows).toHaveLength(0);
    expect(direct.data).toHaveLength(0);
    expect(ack).toMatchObject({ status: 'rejected', reason: { kind: 'forbidden' } });
  });

  it('未許可workerは対象profileを取得・同期できない（AC-33）', async () => {
    // Arrange
    await syncPr(world.worker);

    // Act
    const [sync, spoof] = await Promise.allSettled([
      syncPr(world.otherWorker, {}, {}, 'default', OTHER_WORKER),
      syncPr(world.otherWorker, {}, {}, 'default', WORKER),
    ]);
    const acquired = await rpc(world.otherWorker, 'worker_acquire_job', {
      p_worker_id: OTHER_WORKER,
    });
    const { data: tasks } = await world.otherWorker.from('review_tasks').select('*');

    // Assert
    expect(sync).toMatchObject({ status: 'rejected', reason: { code: '42501' } });
    expect(spoof).toMatchObject({ status: 'rejected', reason: { code: '42501' } });
    expect(acquired.status).toBe('idle');
    expect(tasks).toHaveLength(0);
  });

  it('本人でもクライアントからテーブルを直接書き換えられない', async () => {
    // Arrange
    const res = await syncPr(world.worker);

    // Act
    const update = await world.owner
      .from('review_jobs')
      .update({ status: 'succeeded' })
      .eq('review_task_id', res.task_id)
      .select();
    const insert = await world.owner.from('review_tasks').insert({
      pull_request_id: res.pull_request_id,
      profile_id: 'default',
      reviewer_github_id: '5',
      reviewer_login: 'x',
    });

    // Assert
    expect(update.error).not.toBeNull();
    expect(insert.error).not.toBeNull();
    const { rows } = await sql.query(
      'select status from public.review_jobs where review_task_id = $1',
      [res.task_id],
    );
    expect(rows[0].status).toBe('queued');
  });

  it('workerや通知クライアントは本人の確認済み操作を行えない（10.3）', async () => {
    // Arrange
    const res = await syncPr(world.worker);
    const { done } = await runReview(world);
    const task = await overview(world.owner, res.task_id);

    // Act
    const [byWorker, byNotifier] = await Promise.allSettled([
      acknowledgeResult(world.worker, {
        taskId: res.task_id,
        resultId: done.result_id,
        requestGeneration: 1,
        expectedRevision: task.revision ?? 0,
        operationId: 'op-worker-01',
      }),
      acknowledgeResult(world.notifier, {
        taskId: res.task_id,
        resultId: done.result_id,
        requestGeneration: 1,
        expectedRevision: task.revision ?? 0,
        operationId: 'op-notify-01',
      }),
    ]);

    // Assert
    expect(byWorker).toMatchObject({ status: 'rejected', reason: { kind: 'forbidden' } });
    expect(byNotifier).toMatchObject({ status: 'rejected', reason: { kind: 'forbidden' } });
  });

  it('通知クライアントはレビュー起動・PR同期を行えず、レビュー項目も読めない（AC-38）', async () => {
    // Arrange
    await syncPr(world.worker);

    // Act
    const [acquireAttempt] = await Promise.allSettled([
      rpc(world.notifier, 'worker_acquire_job', { p_worker_id: 'notification-client-1' }),
    ]);
    const { data: tasks } = await world.notifier.from('review_tasks').select('*');

    // Assert
    expect(acquireAttempt).toMatchObject({ status: 'rejected', reason: { code: '42501' } });
    expect(tasks).toHaveLength(0);
  });

  it('本人アカウントをworkerとして登録できない（10.3）', async () => {
    // Arrange
    const { rows } = await sql.query('select user_id from public.app_users limit 1');

    // Act
    const [attempt] = await Promise.allSettled([
      sql.query(
        `insert into public.workers (id, owner_id, auth_user_id, roles) values ('dup', $1, $1, array['reviewer'])`,
        [rows[0].user_id],
      ),
    ]);

    // Assert
    expect(attempt.status).toBe('rejected');
    expect(String((attempt as PromiseRejectedResult).reason)).toMatch(/must not be an app user/);
  });
});
