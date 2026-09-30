import { createHash } from 'node:crypto';
import type { ProfileConfig } from '../config/schema.ts';
import { type GitHubClient, GitHubError, type PullRequest } from '../github/client.ts';
import type { Logger } from '../log.ts';
import type { SyncPrPayload, SyncRequestPayload, SyncResult } from './db-api.ts';

export interface DetectorSink {
  setReviewerIdentity(profileId: string, githubId: string): Promise<void>;
  recordDiscovery(
    profileId: string,
    status: string,
    error: string | null,
    incomplete: unknown[],
  ): Promise<void>;
  syncPullRequest(
    profileId: string,
    pr: SyncPrPayload,
    request: SyncRequestPayload,
  ): Promise<SyncResult | null>;
  markPullRequestSyncFailed(pullRequestId: string, status: string, error: string): Promise<void>;
}

export interface TrackedPullRequest {
  id: string;
  repository_full_name: string;
  pr_number: number;
}

export interface DetectorSource {
  reviewerGithubId(profileId: string): Promise<string | null>;
  trackedPullRequests(profileId: string): Promise<TrackedPullRequest[]>;
}

export interface CandidateOutcome {
  repository: string;
  number: number;
  action: 'synced' | 'skipped' | 'failed';
  reason?: string;
  result?: SyncResult | null;
  requested?: boolean | null;
  headSha?: string;
}

export interface DetectionReport {
  profileId: string;
  reviewerGithubId: string | null;
  searchComplete: boolean;
  incompleteScopes: { scope: string; reason: string }[];
  outcomes: CandidateOutcome[];
  rateLimitedUntil: Date | null;
  error: string | null;
}

const PR_KEY = (repo: string, n: number) => `${repo.toLowerCase()}#${n}`;

export function bodyHash(body: string | null): string {
  return createHash('sha256')
    .update(body ?? '', 'utf8')
    .digest('hex');
}

function isExcluded(profile: ProfileConfig, pr: PullRequest): string | null {
  const repo = pr.base.repo.full_name.toLowerCase();
  const owner = pr.base.repo.owner.login.toLowerCase();
  // 対象判定は base repository の owner を基準にする（5.1）
  if (!profile.github.owners.some((o) => o.toLowerCase() === owner)) return 'owner_not_allowed';
  if (
    profile.github.include_repositories.length > 0 &&
    !profile.github.include_repositories.some((r) => r.toLowerCase() === repo)
  ) {
    return 'repository_not_included';
  }
  if (profile.github.exclude_repositories.some((r) => r.toLowerCase() === repo)) {
    return 'repository_excluded';
  }
  const excludedLabel = pr.labels.find((l) =>
    profile.github.exclude_labels.some((x) => x.toLowerCase() === l.name.toLowerCase()),
  );
  if (excludedLabel) return `label_excluded:${excludedLabel.name}`;
  return null;
}

/**
 * レビュー依頼の検出と追跡中PRの再確認（6章）。
 * 検索は新規候補の発見にだけ使い、追跡中PRは検索に出なくても個別に確認する。
 */
export class Detector {
  private readonly ownerTypes = new Map<string, string>();

  private readonly gh: GitHubClient;
  private readonly profile: ProfileConfig;
  private readonly source: DetectorSource;
  private readonly sink: DetectorSink;
  private readonly log: Logger;

  constructor(
    gh: GitHubClient,
    profile: ProfileConfig,
    source: DetectorSource,
    sink: DetectorSink,
    log: Logger,
  ) {
    this.gh = gh;
    this.profile = profile;
    this.source = source;
    this.sink = sink;
    this.log = log;
  }

  async run(): Promise<DetectionReport> {
    const report: DetectionReport = {
      profileId: this.profile.id,
      reviewerGithubId: null,
      searchComplete: true,
      incompleteScopes: [],
      outcomes: [],
      rateLimitedUntil: null,
      error: null,
    };
    try {
      report.reviewerGithubId = await this.resolveReviewer();
      const candidates = new Map<string, { repo: string; number: number; trackedId?: string }>();

      // 新規検出
      for (const scope of await this.searchScopes()) {
        try {
          const q = `is:pr is:open draft:false user-review-requested:${this.profile.github.reviewer_login} ${scope}`;
          const res = await this.gh.searchPullRequests(q);
          if (!res.complete) {
            report.searchComplete = false;
            report.incompleteScopes.push({
              scope,
              reason: `incomplete (${res.items.length}/${res.total})`,
            });
          }
          for (const item of res.items) {
            const repo = item.repository_url.replace(/^.*\/repos\//, '');
            candidates.set(PR_KEY(repo, item.number), { repo, number: item.number });
          }
        } catch (error) {
          if (error instanceof GitHubError && error.kind.includes('rate_limited')) throw error;
          if (
            error instanceof GitHubError &&
            (error.kind === 'forbidden' ||
              error.kind === 'not_found' ||
              error.kind === 'validation')
          ) {
            // アクセスできない範囲は依頼0件ではなく取得不能として報告する（5.5）
            report.searchComplete = false;
            report.incompleteScopes.push({ scope, reason: `${error.kind}: ${error.message}` });
            continue;
          }
          throw error;
        }
      }

      // 追跡中PRの再確認
      for (const t of await this.source.trackedPullRequests(this.profile.id)) {
        candidates.set(PR_KEY(t.repository_full_name, t.pr_number), {
          repo: t.repository_full_name,
          number: t.pr_number,
          trackedId: t.id,
        });
      }

      for (const c of candidates.values()) {
        report.outcomes.push(await this.syncOne(report.reviewerGithubId, c));
      }
      await this.sink.recordDiscovery(
        this.profile.id,
        report.searchComplete ? 'ok' : 'incomplete',
        null,
        report.incompleteScopes,
      );
    } catch (error) {
      const message = (error as Error).message;
      report.error = message;
      if (error instanceof GitHubError && error.retryAt) report.rateLimitedUntil = error.retryAt;
      const status =
        error instanceof GitHubError
          ? error.kind.includes('rate_limited')
            ? 'rate_limited'
            : error.kind
          : 'error';
      this.log.warn('discovery failed', { profile: this.profile.id, status, error: message });
      await this.sink
        .recordDiscovery(this.profile.id, status, message.slice(0, 500), report.incompleteScopes)
        .catch(() => undefined);
    }
    return report;
  }

  /** 指定したPRだけを再同期する（通知前の鮮度確認など） */
  async resync(prs: TrackedPullRequest[]): Promise<CandidateOutcome[]> {
    const reviewerId = await this.resolveReviewer();
    const out: CandidateOutcome[] = [];
    for (const t of prs) {
      out.push(
        await this.syncOne(reviewerId, {
          repo: t.repository_full_name,
          number: t.pr_number,
          trackedId: t.id,
        }),
      );
    }
    return out;
  }

  private async resolveReviewer(): Promise<string> {
    const known = await this.source.reviewerGithubId(this.profile.id);
    const user = await this.gh.getUser(this.profile.github.reviewer_login);
    const id = String(user.id);
    if (known && known !== id) {
      throw new Error(
        `reviewer_login ${this.profile.github.reviewer_login} のGitHubユーザーIDが変わっています (${known} -> ${id})`,
      );
    }
    if (!known) await this.sink.setReviewerIdentity(this.profile.id, id);
    return id;
  }

  private async searchScopes(): Promise<string[]> {
    if (this.profile.github.include_repositories.length > 0) {
      return this.profile.github.include_repositories.map((r) => `repo:${r}`);
    }
    const scopes: string[] = [];
    for (const owner of this.profile.github.owners) {
      let type = this.ownerTypes.get(owner);
      if (!type) {
        type = (await this.gh.getUser(owner)).type;
        this.ownerTypes.set(owner, type);
      }
      scopes.push(type === 'Organization' ? `org:${owner}` : `user:${owner}`);
    }
    return scopes;
  }

  private async syncOne(
    reviewerId: string,
    c: { repo: string; number: number; trackedId?: string },
  ): Promise<CandidateOutcome> {
    const [owner, repo] = c.repo.split('/');
    const base: CandidateOutcome = { repository: c.repo, number: c.number, action: 'skipped' };
    if (!owner || !repo) return { ...base, reason: 'invalid_repository' };
    try {
      const pr = await this.gh.getPull(owner, repo, c.number);
      const excluded = isExcluded(this.profile, pr);
      if (excluded) return { ...base, reason: excluded, headSha: pr.head.sha };

      const reviewers = await this.gh.getRequestedReviewers(owner, repo, c.number);
      const requested = reviewers.users.some((u) => String(u.id) === reviewerId);

      const events = await this.gh.listIssueEvents(owner, repo, c.number);
      const lastRequest = events.items
        .filter(
          (e) => e.event === 'review_requested' && String(e.requested_reviewer?.id) === reviewerId,
        )
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .at(-1);

      let review: SyncRequestPayload['review'] = null;
      if (!requested) {
        const reviews = await this.gh.listReviews(owner, repo, c.number);
        const mine = reviews.items
          .filter(
            (r) =>
              String(r.user?.id) === reviewerId &&
              r.state !== 'PENDING' &&
              r.submitted_at !== null &&
              (!lastRequest || (r.submitted_at ?? '') >= lastRequest.created_at),
          )
          .sort((a, b) => (a.submitted_at ?? '').localeCompare(b.submitted_at ?? ''))
          .at(-1);
        if (mine) {
          review = {
            id: String(mine.id),
            submitted_at: mine.submitted_at,
            state: mine.state,
            commit_id: mine.commit_id,
          };
        }
      }

      // 追跡していない PR で依頼がなければ、DBへ書かずに終える（AC-36）
      if (!c.trackedId && !requested) {
        return { ...base, reason: 'not_requested', requested, headSha: pr.head.sha };
      }

      const result = await this.sink.syncPullRequest(
        this.profile.id,
        {
          github_host: this.profile.github.host,
          repository_id: String(pr.base.repo.id),
          repository_full_name: pr.base.repo.full_name,
          pr_number: pr.number,
          url: pr.html_url,
          title: pr.title,
          author_login: pr.user?.login ?? null,
          head_sha: pr.head.sha,
          head_ref: pr.head.ref,
          base_sha: pr.base.sha,
          base_ref: pr.base.ref,
          body_hash: bodyHash(pr.body),
          state: pr.merged || pr.merged_at ? 'merged' : pr.state,
          draft: pr.draft,
        },
        {
          reviewer_github_id: reviewerId,
          reviewer_login: this.profile.github.reviewer_login,
          requested,
          request_event: lastRequest
            ? { id: String(lastRequest.id), created_at: lastRequest.created_at }
            : null,
          review,
        },
      );
      return { ...base, action: 'synced', result, requested, headSha: pr.head.sha };
    } catch (error) {
      if (error instanceof GitHubError && error.kind.includes('rate_limited')) throw error;
      const message = (error as Error).message;
      if (c.trackedId) {
        const status = error instanceof GitHubError ? error.syncStatus : 'unknown';
        await this.sink.markPullRequestSyncFailed(c.trackedId, status, message.slice(0, 500));
      }
      this.log.warn('pull request sync failed', {
        repository: c.repo,
        number: c.number,
        error: message,
      });
      return { ...base, action: 'failed', reason: message };
    }
  }
}
