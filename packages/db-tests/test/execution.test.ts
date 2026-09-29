import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AcquiredJob,
  acquire,
  complete,
  createWorld,
  jobsOf,
  launch,
  overview,
  rpc,
  runReview,
  sha,
  sql,
  successPayload,
  syncPr,
  WORKER,
  type World,
} from './helpers.ts';

let world: World;

beforeEach(async () => {
  world = await createWorld();
});

describe('実行権の取得', () => {
  it('2つのプロセスが同じジョブを同時取得しても実行権を取れるのは1つだけ（AC-06）', async () => {
    // Arrange
    await syncPr(world.worker);

    // Act
    const results = await Promise.all([
      acquire(world.worker),
      acquire(world.worker2),
      acquire(world.worker),
      acquire(world.worker2),
    ]);

    // Assert
    const acquired = results.filter((r) => r.status === 'acquired');
    expect(acquired).toHaveLength(1);
  });

  it('異なるジョブを同時取得しても全体・usage poolの並列数上限を超えない（AC-07）', async () => {
    // Arrange
    await sql.query('update public.app_settings set max_concurrent_reviews = 5');
    for (const n of [1, 2, 3]) {
      await syncPr(world.worker, {
        pr_number: n,
        url: `https://github.com/example-org/app/pull/${n}`,
      });
    }

    // Act
    const results = await Promise.all([
      acquire(world.worker),
      acquire(world.worker2),
      acquire(world.worker),
    ]);

    // Assert: usage pool の max_concurrent = 1
    expect(results.filter((r) => r.status === 'acquired')).toHaveLength(1);

    // Arrange: poolの枠を広げ、全体の枠を2にする
    await sql.query("update public.usage_pools set max_concurrent = 5 where id = 'pool-a'");
    await sql.query('update public.app_settings set max_concurrent_reviews = 2');

    // Act
    const more = await Promise.all([acquire(world.worker), acquire(world.worker2)]);

    // Assert
    expect(more.filter((r) => r.status === 'acquired')).toHaveLength(1);
    const { rows } = await sql.query(
      'select count(*)::int as n from public.review_jobs where slot_held',
    );
    expect(rows[0].n).toBe(2);
  });

  it('日次開始件数の上限を超えて開始しない', async () => {
    // Arrange
    await sql.query('update public.app_settings set max_auto_starts_per_day = 1');
    await syncPr(world.worker);
    await syncPr(world.worker, { pr_number: 2, url: 'https://github.com/example-org/app/pull/2' });
    await runReview(world);

    // Act
    const second = await acquire(world.worker);

    // Assert
    expect(second.status).toBe('daily_limit');
  });

  it('待機時間を過ぎるまでは実行しない', async () => {
    // Arrange
    await sql.query('update public.app_settings set debounce_seconds = 120');
    await syncPr(world.worker);

    // Act
    const res = await acquire(world.worker);

    // Assert
    expect(res.status).toBe('idle');
  });

  it('プロファイル停止中・利用枠の保留中は開始しない', async () => {
    // Arrange
    await syncPr(world.worker);
    await sql.query("update public.profiles set paused = true where id = 'default'");

    // Act / Assert
    expect((await acquire(world.worker)).status).toBe('idle');

    // Arrange
    await sql.query("update public.profiles set paused = false where id = 'default'");
    await sql.query("update public.usage_pools set blocked_manual = true where id = 'pool-a'");

    // Act / Assert
    expect((await acquire(world.worker)).status).toBe('pool_blocked');
  });
});

describe('結果確定', () => {
  it('結果を保存するとジョブ確定・枠解放・現在結果の更新を同時に行う（10.2）', async () => {
    // Arrange
    const res = await syncPr(world.worker);

    // Act
    const { done } = await runReview(world, 'first');

    // Assert
    expect(done.status).toBe('recorded');
    expect(done.adopted).toBe(true);
    const task = await overview(world.owner, res.task_id);
    expect(task.current_result_id).toBe(done.result_id);
    expect(task.display_state).toBe('awaiting_ack');
    const jobs = await jobsOf(res.task_id);
    expect(jobs[0].slot_held).toBe(false);
  });

  it('DB保存の再試行は同じ結果を返し、重複保存しない（AC-09）', async () => {
    // Arrange
    await syncPr(world.worker);
    const acquired = (await acquire(world.worker)) as AcquiredJob;
    await launch(world.worker, acquired);
    const first = await complete(world.worker, acquired);

    // Act
    const retry = await complete(world.worker, acquired);

    // Assert
    expect(retry.status).toBe('already_recorded');
    expect(retry.result_id).toBe(first.result_id);
    const { rows } = await sql.query('select count(*)::int as n from public.review_results');
    expect(rows[0].n).toBe(1);
  });

  it('実行権が失効したら結果不明として保留し、自動で再割り当てしない（AC-10）', async () => {
    // Arrange
    const res = await syncPr(world.worker);
    const acquired = (await acquire(world.worker)) as AcquiredJob;
    await launch(world.worker, acquired);
    await sql.query(
      "update public.review_jobs set lease_expires_at = now() - interval '1 second' where id = $1",
      [acquired.job.id],
    );

    // Act
    const next = await acquire(world.worker2);

    // Assert
    expect(next.status).toBe('no_capacity');
    const jobs = await jobsOf(res.task_id);
    expect(jobs[0].status).toBe('unknown');
    expect(jobs[0].slot_held).toBe(true);
    const task = await overview(world.owner, res.task_id);
    expect(task.display_state).toBe('waiting');
  });

  it('結果不明のジョブに元の試行の結果が届けば照合して採用する（9.3）', async () => {
    // Arrange
    const res = await syncPr(world.worker);
    const acquired = (await acquire(world.worker)) as AcquiredJob;
    await launch(world.worker, acquired);
    await sql.query(
      "update public.review_jobs set lease_expires_at = now() - interval '1 second' where id = $1",
      [acquired.job.id],
    );
    await acquire(world.worker2);

    // Act
    const late = await complete(world.worker, acquired);

    // Assert
    expect(late.status).toBe('recorded');
    expect(late.late).toBe(true);
    const task = await overview(world.owner, res.task_id);
    expect(task.display_state).toBe('awaiting_ack');
  });

  it('古いtokenで最新状態を上書きできない（AC-11）', async () => {
    // Arrange: 最初の試行が失効 → 本人が再試行 → 新しい試行が実行中
    const res = await syncPr(world.worker);
    const first = (await acquire(world.worker)) as AcquiredJob;
    await launch(world.worker, first);
    await sql.query(
      "update public.review_jobs set lease_expires_at = now() - interval '1 second' where id = $1",
      [first.job.id],
    );
    await acquire(world.worker2);
    const task = await overview(world.owner, res.task_id);
    const retry = await rpc(world.owner, 'request_review_retry', {
      p_job_id: first.job.id,
      p_expected_revision: task.revision,
      p_confirm: { acknowledge_possible_extra_usage: true },
      p_operation_id: 'op-retry-11',
    });
    expect(retry.status).toBe('applied');
    const second = (await acquire(world.worker2)) as AcquiredJob;
    expect(second.status).toBe('acquired');

    // Act: 古いworkerが復帰して結果を送る
    const stale = await complete(world.worker, first, successPayload('stale'));

    // Assert
    expect(stale.status).toBe('rejected');
    const { rows } = await sql.query('select count(*)::int as n from public.review_results');
    expect(rows[0].n).toBe(0);
    const jobs = await jobsOf(res.task_id);
    expect(jobs[0].status).toBe('running');
  });

  it('レビュー中に新しいheadが来ても旧結果を最新headの完了として扱わない（AC-12）', async () => {
    // Arrange
    const res = await syncPr(world.worker);
    const acquired = (await acquire(world.worker)) as AcquiredJob;
    await launch(world.worker, acquired);
    await syncPr(world.worker, { head_sha: sha('c') });

    // Act
    const done = await complete(world.worker, acquired, successPayload('old-head'));

    // Assert
    expect(done.status).toBe('recorded');
    const task = await overview(world.owner, res.task_id);
    expect(task.result_head_sha).toBe(sha('a'));
    expect(task.result_is_current).toBe(false);
    expect(task.display_state).toBe('preparing');
    const jobs = await jobsOf(res.task_id);
    expect(jobs.map((j) => [j.head_sha, j.status])).toEqual([
      [sha('a'), 'succeeded'],
      [sha('c'), 'queued'],
    ]);
  });

  it('新しいheadの結果が出た後に旧headの結果が届いても最新結果を置き換えない', async () => {
    // Arrange
    await sql.query('update public.app_settings set max_concurrent_reviews = 2');
    await sql.query("update public.usage_pools set max_concurrent = 2 where id = 'pool-a'");
    const res = await syncPr(world.worker);
    const oldJob = (await acquire(world.worker)) as AcquiredJob;
    await launch(world.worker, oldJob);
    await syncPr(world.worker, { head_sha: sha('c') });
    const { done: newDone } = await runReview(world, 'new-head');

    // Act
    const oldDone = await complete(world.worker, oldJob, successPayload('old-head'));

    // Assert
    expect(oldDone.adopted).toBe(false);
    const task = await overview(world.owner, res.task_id);
    expect(task.current_result_id).toBe(newDone.result_id);
    expect(task.result_is_current).toBe(true);
  });

  it('利用上限の失敗ではジョブを保留し、利用枠を止める（AC-19）', async () => {
    // Arrange
    const res = await syncPr(world.worker);
    const acquired = (await acquire(world.worker)) as AcquiredJob;
    await launch(world.worker, acquired);

    // Act
    const done = await complete(world.worker, acquired, {
      outcome: 'failed',
      error_class: 'usage_limit',
      error_message: 'limit reached',
      pool_block: { until: null, reason: 'usage limit' },
    } as never);

    // Assert
    expect(done.job_status).toBe('blocked');
    const { rows } = await sql.query("select * from public.usage_pools where id = 'pool-a'");
    expect(rows[0].blocked_manual).toBe(true);
    const task = await overview(world.owner, res.task_id);
    expect(task.display_state).toBe('waiting');
  });

  it('CLI起動前の一時障害は回数制限付きで実行待ちへ戻す', async () => {
    // Arrange
    await sql.query('update public.app_settings set max_auto_retries = 1');
    const res = await syncPr(world.worker);
    const acquired = (await acquire(world.worker)) as AcquiredJob;

    // Act
    const released = await rpc(world.worker, 'worker_release_job', {
      p_worker_id: WORKER,
      p_execution_id: acquired.execution_id,
      p_lease_token: acquired.lease_token,
      p_disposition: 'requeue',
      p_error_class: 'input_error',
      p_error_message: 'git fetch failed',
      p_retry_after_seconds: 0,
    });

    // Assert
    expect(released.status).toBe('queued');
    const jobs = await jobsOf(res.task_id);
    expect(jobs[0].slot_held).toBe(false);
    // 起動しなかった試行は日次件数に数えない
    const { rows } = await sql.query(
      "select count(*)::int as n from public.review_attempts where launch_state <> 'not_launched'",
    );
    expect(rows[0].n).toBe(0);
  });
});
