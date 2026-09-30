import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KakariError } from '@kakari/shared';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../../cli/src/config/load.ts';
import type { KakariConfig } from '../../cli/src/config/schema.ts';
import { ConditionalCache, GitHubClient, RateLimiter } from '../../cli/src/github/client.ts';
import type { GhRequest, GhResponse, GhTransport } from '../../cli/src/github/transport.ts';
import { prepareSnapshot } from '../../cli/src/input/snapshot.ts';
import { silentLogger } from '../../cli/src/log.ts';
import type {
  PinnedReviewInput,
  ReviewExecutionResult,
  ReviewProvider,
} from '../../cli/src/providers/types.ts';
import { WorkerDb } from '../../cli/src/worker/db-api.ts';
import { Detector } from '../../cli/src/worker/detector.ts';
import { ExecutionJournal } from '../../cli/src/worker/journal.ts';
import { ReviewRunner } from '../../cli/src/worker/runner.ts';
import { dbSink, dbSource } from '../../cli/src/worker/service.ts';
import { createWorld, jobsOf, overview, sql, WORKER, type World } from './helpers.ts';

const gitPath = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
let remote: string;
let baseSha: string;
let headSha: string;

function git(cwd: string, ...args: string[]) {
  return execFileSync(gitPath, args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  }).trim();
}

beforeAll(async () => {
  const work = await mkdtemp(join(tmpdir(), 'kakari-pipeline-'));
  const src = join(work, 'src');
  await mkdir(src);
  git(work, 'init', '-q', '-b', 'main', src);
  await writeFile(join(src, 'a.ts'), 'export const a = 1;\n');
  git(src, 'add', '.');
  git(src, 'commit', '-q', '-m', 'base');
  baseSha = git(src, 'rev-parse', 'HEAD');
  await writeFile(join(src, 'a.ts'), 'export const a = 2;\n');
  git(src, 'commit', '-q', '-am', 'head');
  headSha = git(src, 'rev-parse', 'HEAD');
  remote = join(work, 'remote.git');
  git(work, 'clone', '-q', '--bare', src, remote);
});

interface GhState {
  head: string;
  requested: boolean;
}

class FakeGitHub implements GhTransport {
  readonly state: GhState = { head: '', requested: true };
  async request(_host: string, _token: string, req: GhRequest): Promise<GhResponse> {
    const pr = {
      id: 1,
      number: 7,
      html_url: 'https://github.com/example-org/app/pull/7',
      title: '他の開発者のPR',
      body: 'body',
      state: 'open',
      draft: false,
      merged: false,
      merged_at: null,
      user: { login: 'someone-else' },
      labels: [],
      head: {
        sha: this.state.head,
        ref: 'feature',
        repo: { full_name: 'example-org/app', id: 500 },
      },
      base: {
        sha: baseSha,
        ref: 'main',
        repo: { full_name: 'example-org/app', id: 500, owner: { login: 'example-org' } },
      },
    };
    const routes: Record<string, unknown> = {
      'users/alice': { id: 1001, login: 'alice', type: 'User' },
      'users/example-org': { id: 9, login: 'example-org', type: 'Organization' },
      'search/issues': {
        total_count: this.state.requested ? 1 : 0,
        incomplete_results: false,
        items: this.state.requested
          ? [
              {
                number: 7,
                repository_url: 'https://api.github.com/repos/example-org/app',
                pull_request: {},
              },
            ]
          : [],
      },
      'repos/example-org/app/pulls/7': pr,
      'repos/example-org/app/pulls/7/requested_reviewers': {
        users: this.state.requested ? [{ id: 1001, login: 'alice' }] : [],
        teams: [],
      },
      'repos/example-org/app/issues/7/events': [
        {
          id: 1,
          event: 'review_requested',
          created_at: '2026-09-29T00:00:00Z',
          requested_reviewer: { id: 1001, login: 'alice' },
        },
      ],
      'repos/example-org/app/pulls/7/reviews': [],
    };
    const body = routes[req.path];
    return body === undefined
      ? { status: 404, headers: {}, body: '{"message":"Not Found"}' }
      : { status: 200, headers: { 'x-ratelimit-remaining': '4999' }, body: JSON.stringify(body) };
  }
}

class FakeProvider implements ReviewProvider {
  readonly name = 'claude' as const;
  runs: PinnedReviewInput[] = [];
  preflightResult: Awaited<ReturnType<ReviewProvider['preflight']>> = {
    ok: true,
    cliVersion: '9.9.9',
    authMethod: 'claude.ai',
    warnings: [],
  };
  output: ReviewExecutionResult = {
    outcome: 'succeeded',
    rawOutput: '{"type":"result"}',
    structured: {
      schema_version: 1,
      summary: '問題が1件あります',
      findings: [
        {
          severity: 'high',
          title: '値の変更',
          path: 'a.ts',
          start_line: 1,
          end_line: 1,
          reason: '理由',
          suggestion: null,
          confidence: 'medium',
        },
      ],
      questions: [],
      limitations: [],
      quality_status: 'complete',
    },
    sessionId: 'sess',
    usage: null,
  };
  async preflight() {
    return this.preflightResult;
  }
  async run(input: PinnedReviewInput): Promise<ReviewExecutionResult> {
    this.runs.push(input);
    return this.output;
  }
}

const rawConfig = {
  schema_version: 1,
  owner: { email: 'owner@example.com' },
  storage: { backend: 'supabase', project_url: 'http://127.0.0.1:54321', publishable_key_ref: 'k' },
  workers: [
    {
      id: WORKER,
      roles: ['detector', 'reviewer', 'notification_planner'],
      db_session_ref: 'w',
      allowed_profiles: ['default'],
    },
    {
      id: 'notification-client-1',
      roles: ['notifier'],
      db_session_ref: 'n',
      allowed_profiles: ['default'],
    },
  ],
  usage_pools: [{ id: 'pool-a', provider: 'claude' }],
  profiles: [
    {
      id: 'default',
      name: 'Default',
      enabled: true,
      github: {
        reviewer_login: 'alice',
        auth: { mode: 'gh_user', credential_ref: 'gh' },
        owners: ['example-org'],
      },
      review: {
        provider: 'claude',
        usage_pool_id: 'pool-a',
        config_version: 'review-v1',
        allowed_workers: [WORKER],
        send_to_provider_approved: true,
      },
      notifications: {
        destination_worker_id: 'notification-client-1',
        timezone: 'UTC',
        weekdays: ['mon'],
        times: ['09:00'],
      },
    },
  ],
};

let world: World;
let config: KakariConfig;
let gh: FakeGitHub;
let provider: FakeProvider;
let journalDir: string;

function build(db = new WorkerDb(world.worker, WORKER)) {
  const client = new GitHubClient({
    transport: gh,
    host: 'github.com',
    principal: 'gh:alice',
    token: async () => 'token',
    cacheScope: 'default',
    limiter: new RateLimiter(),
    cache: new ConditionalCache(),
  });
  const profile = config.profiles[0];
  if (!profile) throw new Error('profile');
  const detector = new Detector(client, profile, dbSource(db), dbSink(db), silentLogger);
  const runner = new ReviewRunner({
    db,
    journal: new ExecutionJournal(journalDir),
    config,
    github: () => client,
    provider: async () => provider,
    prompt: async () => 'prompt',
    snapshot: (_p, req) =>
      prepareSnapshot({
        ...req,
        gitPath,
        cacheDir: join(journalDir, 'cache'),
        remoteUrl: `file://${remote}`,
      }),
    runsDir: join(journalDir, 'runs'),
    log: silentLogger,
    heartbeatMs: 60_000,
    saveRetryDelaysMs: [],
  });
  return { detector, runner, db };
}

beforeEach(async () => {
  world = await createWorld();
  config = parseConfig(rawConfig);
  gh = new FakeGitHub();
  gh.state.head = headSha;
  provider = new FakeProvider();
  journalDir = await mkdtemp(join(tmpdir(), 'kakari-journal-'));
});

describe('workerの処理全体', () => {
  it('検出したレビュー依頼を1回だけAIレビューし、元PRに紐づいた結果を保存する（AC-01・AC-02・AC-21）', async () => {
    // Arrange
    const { detector, runner } = build();

    // Act
    const report = await detector.run();
    const first = await runner.runOnce();
    await detector.run();
    const second = await runner.runOnce();

    // Assert
    expect(report.outcomes[0]?.action).toBe('synced');
    expect(first.status).toBe('completed');
    expect(second.status).toBe('idle');
    expect(provider.runs).toHaveLength(1);
    const taskId = report.outcomes[0]?.result?.task_id ?? '';
    const task = await overview(world.owner, taskId);
    expect(task.display_state).toBe('awaiting_ack');
    expect(task.pr_url).toBe('https://github.com/example-org/app/pull/7');
    expect(task.pr_author_login).toBe('someone-else');
    expect(task.result_findings_count).toBe(1);
    expect(task.result_head_sha).toBe(headSha);
  });

  it('構造化できない出力は元の出力を保存し「要確認」にする（AC-31）', async () => {
    // Arrange
    provider.output = { ...provider.output, rawOutput: 'not json', structured: null };
    const { detector, runner } = build();
    const report = await detector.run();

    // Act
    await runner.runOnce();

    // Assert
    const { rows } = await sql.query(
      'select structured, quality_status, raw_output, findings_count from public.review_results',
    );
    expect(rows[0]).toMatchObject({
      structured: false,
      quality_status: 'unstructured',
      raw_output: 'not json',
      findings_count: null,
    });
    const task = await overview(world.owner, report.outcomes[0]?.result?.task_id ?? '');
    expect(task.display_state).toBe('awaiting_ack');
    expect(task.result_quality_status).toBe('unstructured');
  });

  it('AI完了後にDB保存だけ失敗したら退避結果の保存を再試行し、AIは呼び直さない（AC-09）', async () => {
    // Arrange
    const realDb = new WorkerDb(world.worker, WORKER);
    let failures = 1;
    const flakyDb = Object.create(realDb) as WorkerDb;
    flakyDb.completeAttempt = async (...args) => {
      if (failures-- > 0) throw new KakariError('network', 'fetch failed');
      return realDb.completeAttempt(...args);
    };
    const { detector, runner } = build(flakyDb);
    await detector.run();

    // Act
    const first = await runner.runOnce();
    const flushed = await runner.flushPending();

    // Assert
    expect(first.status).toBe('save_pending');
    expect(flushed).toBe(1);
    expect(provider.runs).toHaveLength(1);
    const { rows } = await sql.query('select count(*)::int as n from public.review_results');
    expect(rows[0].n).toBe(1);
  });

  it('サブスク認証を確認できなければ起動せず、利用枠を保留する（AC-20）', async () => {
    // Arrange
    provider.preflightResult = {
      ok: false,
      cliVersion: '9.9.9',
      authMethod: 'api_key',
      errorClass: 'blocked_auth',
      message: '認証方式 api_key は許可されていません',
      warnings: [],
    };
    const { detector, runner } = build();
    const report = await detector.run();

    // Act
    const res = await runner.runOnce();

    // Assert
    expect(res.status).toBe('released');
    expect(provider.runs).toHaveLength(0);
    const jobs = await jobsOf(report.outcomes[0]?.result?.task_id ?? '');
    expect(jobs[0]).toMatchObject({ status: 'blocked', error_class: 'blocked_auth' });
    const { rows } = await sql.query(
      "select blocked_manual from public.usage_pools where id = 'pool-a'",
    );
    expect(rows[0].blocked_manual).toBe(true);
    // 起動しなかった試行は日次件数に数えない
    const attempts = await sql.query('select launch_state from public.review_attempts');
    expect(attempts.rows[0].launch_state).toBe('not_launched');
  });

  it('起動前にGitHubでheadが変わっていたら古いheadのAIは起動しない（7.1）', async () => {
    // Arrange
    const { detector, runner } = build();
    const report = await detector.run();
    gh.state.head = 'f'.repeat(40);

    // Act
    const res = await runner.runOnce();

    // Assert
    expect(res).toMatchObject({ status: 'released', disposition: 'superseded' });
    expect(provider.runs).toHaveLength(0);
    const jobs = await jobsOf(report.outcomes[0]?.result?.task_id ?? '');
    expect(jobs[0].status).toBe('superseded');
  });

  it('検索から消えただけでは完了にせず、追跡中PRとして再確認する（6.3）', async () => {
    // Arrange
    const { detector } = build();
    const report = await detector.run();
    const taskId = report.outcomes[0]?.result?.task_id ?? '';
    gh.state.requested = false;

    // Act
    const again = await detector.run();

    // Assert
    expect(again.outcomes).toHaveLength(1);
    expect(again.outcomes[0]?.action).toBe('synced');
    const task = await overview(world.owner, taskId);
    // 依頼解除（レビュー提出なし）を確認したので対応不要。完了扱いにはしない
    expect(task.display_state).toBe('inactive');
    expect(task.human_state).toBe('open');
  });
});
