import { beforeEach, describe, expect, it } from 'vitest';
import {
  createWorld,
  jobsOf,
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

describe('PR検出とレビュー項目', () => {
  it('新しい直接レビュー依頼でレビュー項目と実行待ちジョブを1件作る（AC-01）', async () => {
    // Act
    const res = await syncPr(world.worker);

    // Assert
    expect(res.task_created).toBe(true);
    expect(res.job_created).toBe(true);
    const jobs = await jobsOf(res.task_id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('queued');
    expect(jobs[0].head_sha).toBe(sha('a'));
    const task = await overview(world.owner, res.task_id);
    expect(task.display_state).toBe('preparing');
    expect(task.pr_url).toBe('https://github.com/example-org/app/pull/12');
  });

  it('Reviewer割当がなければ項目もジョブも作らない（AC-36）', async () => {
    // Act
    const res = await syncPr(world.worker, {}, { requested: false, request_event: null });

    // Assert
    expect(res.task_id).toBeNull();
    const { rows } = await sql.query('select count(*)::int as n from public.review_jobs');
    expect(rows[0].n).toBe(0);
  });

  it('同じPRを繰り返し検出しても項目・ジョブを重複作成しない（AC-02・AC-22）', async () => {
    // Arrange
    const first = await syncPr(world.worker);

    // Act
    const second = await syncPr(world.worker);
    const third = await syncPr(world.worker);

    // Assert
    expect(second.task_id).toBe(first.task_id);
    expect(third.task_created).toBe(false);
    expect(third.job_created).toBe(false);
    expect(await jobsOf(first.task_id)).toHaveLength(1);
  });

  it('成功済みの同じSHAを再同期しても新しいジョブを作らない（AC-02）', async () => {
    // Arrange
    const res = await syncPr(world.worker);
    await runReview(world);

    // Act
    const again = await syncPr(world.worker);

    // Assert
    expect(again.job_created).toBe(false);
    const jobs = await jobsOf(res.task_id);
    expect(jobs.map((j) => j.status)).toEqual(['succeeded']);
    const task = await overview(world.owner, res.task_id);
    expect(task.display_state).toBe('awaiting_ack');
  });

  it('新しいheadでは同じ項目に新しいジョブを1件作る（AC-04・AC-23）', async () => {
    // Arrange
    const res = await syncPr(world.worker);
    await runReview(world);

    // Act
    const moved = await syncPr(world.worker, { head_sha: sha('c') });

    // Assert
    expect(moved.task_id).toBe(res.task_id);
    expect(moved.head_changed).toBe(true);
    const jobs = await jobsOf(res.task_id);
    expect(jobs.map((j) => [j.head_sha, j.status])).toEqual([
      [sha('a'), 'succeeded'],
      [sha('c'), 'queued'],
    ]);
    const task = await overview(world.owner, res.task_id);
    // 旧headの結果しかないので最新結果待ち
    expect(task.display_state).toBe('preparing');
    expect(task.result_is_current).toBe(false);
  });

  it('待機中に複数回pushされると最終headのジョブだけが残る（AC-05）', async () => {
    // Arrange
    await sql.query('update public.app_settings set debounce_seconds = 120');
    const res = await syncPr(world.worker);

    // Act
    await syncPr(world.worker, { head_sha: sha('c') });
    await syncPr(world.worker, { head_sha: sha('d') });

    // Assert
    const jobs = await jobsOf(res.task_id);
    expect(jobs.map((j) => [j.head_sha, j.status])).toEqual([
      [sha('a'), 'superseded'],
      [sha('c'), 'superseded'],
      [sha('d'), 'queued'],
    ]);
    const last = jobs[2];
    expect(new Date(last.not_before).getTime()).toBeGreaterThan(Date.now() + 60_000);
  });

  it('同じSHAで新しいレビュー依頼が来ると項目を再開し、AIは再実行しない（AC-16）', async () => {
    // Arrange
    const res = await syncPr(world.worker);
    await runReview(world);
    // 本人がGitHubでレビューを提出して依頼が外れる
    await syncPr(
      world.worker,
      {},
      {
        requested: false,
        request_event: null,
        review: { id: '777', submitted_at: '2026-09-29T01:00:00Z', state: 'COMMENTED' },
      },
    );
    expect((await overview(world.owner, res.task_id)).display_state).toBe('done');

    // Act: 再依頼
    const again = await syncPr(
      world.worker,
      {},
      { request_event: { id: '9002', created_at: '2026-09-29T02:00:00Z' } },
    );

    // Assert
    expect(again.generation_changed).toBe(true);
    expect(again.request_generation).toBe(2);
    expect(again.job_created).toBe(false);
    const task = await overview(world.owner, res.task_id);
    expect(task.display_state).toBe('awaiting_ack');
    expect(await jobsOf(res.task_id)).toHaveLength(1);
  });

  it('GitHubでレビューを提出して依頼が外れると対応終了になる（12.3）', async () => {
    // Arrange
    const res = await syncPr(world.worker);

    // Act
    const after = await syncPr(
      world.worker,
      {},
      {
        requested: false,
        request_event: null,
        review: { id: '777', submitted_at: '2026-09-29T01:00:00Z', state: 'APPROVED' },
      },
    );

    // Assert
    expect(after.human_state_changed).toBe(true);
    const task = await overview(world.owner, res.task_id);
    expect(task.display_state).toBe('done');
    expect(task.done_source).toBe('github_review');
    expect((await jobsOf(res.task_id))[0].status).toBe('cancelled');
  });

  it('依頼解除・PRのclose/mergeでは未開始ジョブを止めて対応不要にする（AC-17）', async () => {
    // Arrange
    const res = await syncPr(world.worker);

    // Act
    await syncPr(world.worker, {}, { requested: false, request_event: null });

    // Assert
    let task = await overview(world.owner, res.task_id);
    expect(task.display_state).toBe('inactive');
    expect((await jobsOf(res.task_id))[0].status).toBe('cancelled');

    // Arrange: 別PRをmergeする
    const other = await syncPr(world.worker, {
      pr_number: 13,
      url: 'https://github.com/example-org/app/pull/13',
    });
    // Act
    await syncPr(world.worker, {
      pr_number: 13,
      url: 'https://github.com/example-org/app/pull/13',
      state: 'merged',
    });
    // Assert
    task = await overview(world.owner, other.task_id);
    expect(task.display_state).toBe('inactive');
    expect(task.pr_state).toBe('merged');
    expect((await jobsOf(other.task_id))[0].status).toBe('cancelled');
  });

  it('取得失敗は状態不明として保留し、完了・対象外にしない（AC-18）', async () => {
    // Arrange
    const res = await syncPr(world.worker);

    // Act
    await syncPr(world.worker, {}, { requested: null, request_event: null });

    // Assert
    const task = await overview(world.owner, res.task_id);
    expect(task.display_state).toBe('waiting');
    expect(task.request_state).toBe('unknown');
    expect(task.human_state).toBe('open');
  });

  it('PRの取得失敗を記録しても対応状態は変えない', async () => {
    // Arrange
    const res = await syncPr(world.worker);

    // Act
    const { error } = await world.worker.rpc('worker_mark_pull_request_sync_failed', {
      p_worker_id: 'review-worker-1',
      p_pull_request_id: res.pull_request_id,
      p_status: 'forbidden',
      p_error: 'HTTP 403',
    });

    // Assert
    expect(error).toBeNull();
    const task = await overview(world.owner, res.task_id);
    expect(task.display_state).toBe('waiting');
    expect(task.waiting_reason).toBe('github_forbidden');
    expect(task.human_state).toBe('open');
  });

  it('baseや説明文だけの変化では自動レビューを増やさず前提変更を表示する（AC-29）', async () => {
    // Arrange
    const res = await syncPr(world.worker);
    await runReview(world);

    // Act
    const again = await syncPr(world.worker, { base_sha: sha('e'), body_hash: 'body-2' });

    // Assert
    expect(again.job_created).toBe(false);
    const task = await overview(world.owner, res.task_id);
    expect(task.premise_changed).toBe(true);
    expect(task.display_state).toBe('awaiting_ack');
  });

  it('本人が対応終了にした依頼は、同じ割当の再検出では再開しない（12.3）', async () => {
    // Arrange
    const res = await syncPr(world.worker);
    const task = await overview(world.owner, res.task_id);
    const { error } = await world.owner.rpc('complete_review_task', {
      p_task_id: res.task_id,
      p_request_generation: 1,
      p_reason: '対応完了',
      p_expected_revision: task.revision ?? 0,
      p_operation_id: 'op-complete-1',
    });
    expect(error).toBeNull();

    // Act
    const again = await syncPr(world.worker);

    // Assert
    expect(again.generation_changed).toBe(false);
    expect((await overview(world.owner, res.task_id)).display_state).toBe('done');
  });

  it('draftになったPRは自動レビューを止め、非draftに戻ると再開する', async () => {
    // Arrange
    const res = await syncPr(world.worker);

    // Act
    await syncPr(world.worker, { draft: true });
    const draftJobs = await jobsOf(res.task_id);
    await syncPr(world.worker, { draft: false });

    // Assert
    expect(draftJobs[0].status).toBe('cancelled');
    const jobs = await jobsOf(res.task_id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('queued');
  });
});
