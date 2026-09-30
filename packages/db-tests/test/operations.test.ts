import {
  acknowledgeResult,
  completeReviewTask,
  requestManualReview,
  requestReviewRetry,
  setTaskSnooze,
} from '@kakari/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AcquiredJob,
  acquire,
  complete,
  createWorld,
  jobsOf,
  launch,
  overview,
  runReview,
  sha,
  sql,
  syncPr,
  type World,
} from './helpers.ts';

let world: World;

beforeEach(async () => {
  world = await createWorld();
});

async function reviewedTask() {
  const res = await syncPr(world.worker);
  const { done } = await runReview(world, 'first');
  const task = await overview(world.owner, res.task_id);
  return { taskId: res.task_id as string, resultId: done.result_id as string, task };
}

describe('確認済み（ack）', () => {
  it('最新結果をackすると確認済みになりCLIからも同じ状態が見える（AC-13・AC-43）', async () => {
    // Arrange
    const { taskId, resultId, task } = await reviewedTask();

    // Act
    const res = await acknowledgeResult(world.owner, {
      taskId,
      resultId,
      requestGeneration: 1,
      expectedRevision: task.revision ?? 0,
      operationId: 'op-ack-00001',
    });

    // Assert
    expect(res.status).toBe('applied');
    const after = await overview(world.owner, taskId);
    expect(after.display_state).toBe('in_review');
    expect(after.revision).toBe((task.revision ?? 0) + 1);
  });

  it('古い結果のackは履歴だけに残り、新しい結果は未確認のまま（AC-14・AC-48）', async () => {
    // Arrange
    const { taskId, resultId: oldResult } = await reviewedTask();
    await syncPr(world.worker, { head_sha: sha('c') });
    await runReview(world, 'second');
    const task = await overview(world.owner, taskId);

    // Act: 画面に表示していた古い結果を送る
    const res = await acknowledgeResult(world.owner, {
      taskId,
      resultId: oldResult,
      requestGeneration: 1,
      expectedRevision: task.revision ?? 0,
      operationId: 'op-ack-old-1',
    });

    // Assert
    expect(res.status).toBe('recorded_only');
    const after = await overview(world.owner, taskId);
    expect(after.display_state).toBe('awaiting_ack');
    const { rows } = await sql.query(
      'select outcome from public.task_operations where operation_id = $1',
      ['op-ack-old-1'],
    );
    expect(rows[0].outcome).toBe('recorded_only');
  });

  it('確認済みの後に新しいheadの結果ができると未確認に戻る（AC-15）', async () => {
    // Arrange
    const { taskId, resultId, task } = await reviewedTask();
    await acknowledgeResult(world.owner, {
      taskId,
      resultId,
      requestGeneration: 1,
      expectedRevision: task.revision ?? 0,
      operationId: 'op-ack-00002',
    });

    // Act
    await syncPr(world.worker, { head_sha: sha('c') });
    await runReview(world, 'second');

    // Assert
    expect((await overview(world.owner, taskId)).display_state).toBe('awaiting_ack');
  });

  it('UIとCLIが同時に同じ項目を更新するとrevisionの競合を返す（AC-46）', async () => {
    // Arrange
    const { taskId, resultId, task } = await reviewedTask();
    const revision = task.revision ?? 0;

    // Act
    const [a, b] = await Promise.all([
      acknowledgeResult(world.owner, {
        taskId,
        resultId,
        requestGeneration: 1,
        expectedRevision: revision,
        operationId: 'op-ui-000001',
      }),
      setTaskSnooze(world.owner, {
        taskId,
        until: new Date(Date.now() + 3_600_000),
        expectedRevision: revision,
        operationId: 'op-cli-00001',
      }),
    ]);

    // Assert
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['applied', 'conflict']);
    expect((await overview(world.owner, taskId)).revision).toBe(revision + 1);
  });

  it('同じoperation IDの再送は二重適用せず記録済みの結果を返す（AC-47）', async () => {
    // Arrange
    const { taskId, resultId, task } = await reviewedTask();
    const input = {
      taskId,
      resultId,
      requestGeneration: 1,
      expectedRevision: task.revision ?? 0,
      operationId: 'op-resend-01',
    };
    const first = await acknowledgeResult(world.owner, input);

    // Act
    const again = await acknowledgeResult(world.owner, input);

    // Assert
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(again.status).toBe('applied');
    expect(again.revision).toBe(first.revision);
    const { rows } = await sql.query(
      "select count(*)::int as n from public.task_operations where operation_id = 'op-resend-01'",
    );
    expect(rows[0].n).toBe(1);
  });

  it('同じoperation IDで異なる内容が届いたら拒否する', async () => {
    // Arrange
    const { taskId, resultId, task } = await reviewedTask();
    await acknowledgeResult(world.owner, {
      taskId,
      resultId,
      requestGeneration: 1,
      expectedRevision: task.revision ?? 0,
      operationId: 'op-reused-01',
    });

    // Act / Assert
    await expect(
      setTaskSnooze(world.owner, {
        taskId,
        until: null,
        expectedRevision: (task.revision ?? 0) + 1,
        operationId: 'op-reused-01',
      }),
    ).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('別の項目の結果IDはackできない', async () => {
    // Arrange
    const { resultId } = await reviewedTask();
    const other = await syncPr(world.worker, {
      pr_number: 99,
      url: 'https://github.com/example-org/app/pull/99',
    });
    const otherTask = await overview(world.owner, other.task_id);

    // Act / Assert
    await expect(
      acknowledgeResult(world.owner, {
        taskId: other.task_id,
        resultId,
        requestGeneration: 1,
        expectedRevision: otherTask.revision ?? 0,
        operationId: 'op-cross-001',
      }),
    ).rejects.toMatchObject({ kind: 'invalid' });
  });
});

describe('スヌーズ・対応終了', () => {
  it('過去の期限ではスヌーズできない', async () => {
    // Arrange
    const { taskId, task } = await reviewedTask();

    // Act / Assert
    await expect(
      setTaskSnooze(world.owner, {
        taskId,
        until: new Date(Date.now() - 1000),
        expectedRevision: task.revision ?? 0,
        operationId: 'op-snooze-01',
      }),
    ).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('対応終了にすると未開始ジョブを止め、GitHubの状態は変えない（AC-24）', async () => {
    // Arrange
    const res = await syncPr(world.worker);
    const task = await overview(world.owner, res.task_id);

    // Act
    const done = await completeReviewTask(world.owner, {
      taskId: res.task_id,
      requestGeneration: 1,
      reason: '手動で対応済み',
      expectedRevision: task.revision ?? 0,
      operationId: 'op-done-0001',
    });

    // Assert
    expect(done.status).toBe('applied');
    const after = await overview(world.owner, res.task_id);
    expect(after.display_state).toBe('done');
    expect(after.pr_state).toBe('open');
    expect((await jobsOf(res.task_id))[0].status).toBe('cancelled');
    expect((await acquire(world.worker)).status).toBe('idle');
  });

  it('依頼世代が変わっていれば対応終了を競合として返す', async () => {
    // Arrange
    const res = await syncPr(world.worker);
    const task = await overview(world.owner, res.task_id);

    // Act
    const done = await completeReviewTask(world.owner, {
      taskId: res.task_id,
      requestGeneration: 2,
      reason: 'x',
      expectedRevision: task.revision ?? 0,
      operationId: 'op-done-gen2',
    });

    // Assert
    expect(done.status).toBe('conflict');
  });
});

describe('再試行・手動再レビュー', () => {
  it('起動済みの可能性がある失敗の再試行には追加消費の承認を求める', async () => {
    // Arrange
    const res = await syncPr(world.worker);
    const acquired = (await acquire(world.worker)) as AcquiredJob;
    await launch(world.worker, acquired);
    await complete(world.worker, acquired, {
      outcome: 'timeout',
      error_class: 'timeout',
      error_message: 'timed out',
    } as never);
    const task = await overview(world.owner, res.task_id);

    // Act
    const noConfirm = await requestReviewRetry(world.owner, {
      jobId: acquired.job.id,
      expectedRevision: task.revision ?? 0,
      acknowledgePossibleExtraUsage: false,
      operationId: 'op-retry-001',
    });
    const confirmed = await requestReviewRetry(world.owner, {
      jobId: acquired.job.id,
      expectedRevision: task.revision ?? 0,
      acknowledgePossibleExtraUsage: true,
      operationId: 'op-retry-002',
    });

    // Assert
    expect(noConfirm.status).toBe('confirmation_required');
    expect(confirmed.status).toBe('applied');
    expect((await jobsOf(res.task_id))[0].status).toBe('queued');
  });

  it('成功済みレビューの手動再実行は承認付きで別世代として履歴を残す（AC-35）', async () => {
    // Arrange
    const { taskId, task } = await reviewedTask();
    const [job] = await jobsOf(taskId);

    // Act
    const unconfirmed = await requestManualReview(world.owner, {
      jobId: job.id,
      reason: 'base変更の影響を再確認',
      expectedRevision: task.revision ?? 0,
      acknowledgeExtraUsage: false,
      operationId: 'op-rerun-001',
    });
    const confirmed = await requestManualReview(world.owner, {
      jobId: job.id,
      reason: 'base変更の影響を再確認',
      expectedRevision: task.revision ?? 0,
      acknowledgeExtraUsage: true,
      operationId: 'op-rerun-002',
    });

    // Assert
    expect(unconfirmed.status).toBe('confirmation_required');
    expect(confirmed.status).toBe('applied');
    expect(confirmed.manual_generation).toBe(1);
    const { done } = await runReview(world, 'manual');
    const after = await overview(world.owner, taskId);
    expect(after.current_result_id).toBe(done.result_id);
    expect(after.display_state).toBe('awaiting_ack');
    const jobs = await jobsOf(taskId);
    expect(jobs.map((j) => [j.manual_generation, j.status])).toEqual([
      [0, 'succeeded'],
      [1, 'succeeded'],
    ]);
  });
});
