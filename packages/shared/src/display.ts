// 11.4 表示状態
export const DISPLAY_STATES = [
  'preparing',
  'awaiting_ack',
  'in_review',
  'waiting',
  'done',
  'inactive',
] as const;

export type DisplayState = (typeof DISPLAY_STATES)[number];

export const DISPLAY_STATE_LABELS: Record<DisplayState, string> = {
  preparing: '準備中',
  awaiting_ack: '確認待ち',
  in_review: 'レビュー中',
  waiting: '保留',
  done: '対応終了',
  inactive: '対応不要',
};

export function isDisplayState(value: unknown): value is DisplayState {
  return typeof value === 'string' && (DISPLAY_STATES as readonly string[]).includes(value);
}

const WAITING_REASON_LABELS: Record<string, string> = {
  github_unknown: 'GitHubの状態を確認できません',
  github_rate_limited: 'GitHubのレート制限で同期を保留中',
  github_forbidden: 'GitHubへのアクセス権がありません',
  github_not_found: 'GitHubでPRを取得できません',
  github_auth_error: 'GitHub認証を確認してください',
  github_request_unknown: 'レビュー依頼の状態を確認できません',
  pr_draft: 'PRがdraftです',
  profile_paused: 'プロファイルの自動レビューを停止中',
  profile_disabled: 'プロファイルが無効です',
};

const JOB_ERROR_LABELS: Record<string, string> = {
  auth: 'AI CLIの認証を確認してください',
  blocked_auth: 'サブスク認証を確認できないため停止中',
  usage_limit: '利用上限に到達したため保留中',
  lease_expired: '実行結果が不明です（照合が必要）',
  timeout: '実行時間の上限を超えました',
  input_error: 'レビュー入力を取得できませんでした',
  safety: '安全性チェックで停止中',
};

/** 保留理由を表示用の文に変換する。 */
export function describeWaitingReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  if (WAITING_REASON_LABELS[reason]) return WAITING_REASON_LABELS[reason];
  const job = /^job_(blocked|unknown|failed)(?::(.+))?$/.exec(reason);
  if (job) {
    const [, status, errorClass] = job;
    if (errorClass && JOB_ERROR_LABELS[errorClass]) return JOB_ERROR_LABELS[errorClass];
    if (status === 'unknown') return '実行結果が不明です（照合が必要）';
    if (status === 'failed')
      return `AIレビューに失敗しました${errorClass ? `（${errorClass}）` : ''}`;
    return `AIレビューを保留中${errorClass ? `（${errorClass}）` : ''}`;
  }
  return reason;
}

export const SEVERITY_LABELS: Record<string, string> = {
  critical: '重大',
  high: '高',
  medium: '中',
  low: '低',
  info: '情報',
};

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '-';
}
