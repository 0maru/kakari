export type ProviderErrorClass =
  | 'blocked_auth'
  | 'auth'
  | 'usage_limit'
  | 'not_installed'
  | 'safety'
  | 'timeout'
  | 'cli_error'
  | 'aborted';

export interface PreflightResult {
  ok: boolean;
  cliVersion: string | null;
  authMethod: string | null;
  errorClass?: ProviderErrorClass;
  message?: string;
  warnings: string[];
}

export interface PinnedReviewInput {
  executionId: string;
  /** 読み取り専用の入力ディレクトリ。AI CLI の作業ディレクトリになる */
  dir: string;
  prompt: string;
  timeoutMs: number;
  model?: string | undefined;
}

export interface ReviewExecutionResult {
  outcome: 'succeeded' | 'failed' | 'timeout';
  /** CLIの標準出力（そのまま保存する） */
  rawOutput: string;
  /** 構造化出力。取得できなければ null */
  structured: unknown | null;
  sessionId: string | null;
  /** 取得できない利用量は null（ゼロとみなさない） */
  usage: Record<string, unknown> | null;
  errorClass?: ProviderErrorClass;
  errorMessage?: string;
  /** 利用上限の復帰時刻を信頼できる形で取得できた場合だけ設定する */
  retryAt?: Date | null;
}

export interface ReviewProvider {
  readonly name: 'claude' | 'codex';
  preflight(): Promise<PreflightResult>;
  run(input: PinnedReviewInput, signal: AbortSignal): Promise<ReviewExecutionResult>;
}
