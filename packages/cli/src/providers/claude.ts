import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { reviewResultJsonSchema } from '@kakari/shared';
import { baseEnv, runProcess, SpawnError } from '../process.ts';
import type {
  PinnedReviewInput,
  PreflightResult,
  ProviderErrorClass,
  ReviewExecutionResult,
  ReviewProvider,
} from './types.ts';

/** 別の認証経路（API課金・クラウドprovider）に使われる環境変数（5.4） */
export const PAID_PATH_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_BEARER_TOKEN_BEDROCK',
  'GOOGLE_APPLICATION_CREDENTIALS',
];

const SETTINGS_RISK_KEYS = [
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'otelHeadersHelper',
];

/** managed settings の場所。--restricted でも適用されるため点検する */
export function managedSettingsPaths(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'darwin') {
    return ['/Library/Application Support/ClaudeCode/managed-settings.json'];
  }
  return ['/etc/claude-code/managed-settings.json'];
}

/** 設定ファイルの中から別の認証経路を探す */
export function findPaidPathInSettings(settings: unknown): string[] {
  const found: string[] = [];
  if (!settings || typeof settings !== 'object') return found;
  const s = settings as Record<string, unknown>;
  for (const key of SETTINGS_RISK_KEYS) {
    if (key in s && s[key]) found.push(key);
  }
  const env = s.env;
  if (env && typeof env === 'object') {
    for (const key of Object.keys(env as Record<string, unknown>)) {
      if (PAID_PATH_ENV.includes(key)) found.push(`env.${key}`);
    }
  }
  return found;
}

/** 利用上限のメッセージから復帰時刻を読む。形式が確かなときだけ返す */
export function parseUsageLimitReset(text: string, now = Date.now()): Date | null {
  const m = /usage limit reached\|(\d{10})\b/i.exec(text);
  if (!m?.[1]) return null;
  const t = Number(m[1]) * 1000;
  // 1分〜8日の範囲だけ信頼する
  return t > now + 60_000 && t < now + 8 * 24 * 3600_000 ? new Date(t) : null;
}

export function classifyError(text: string, apiStatus: number | null): ProviderErrorClass {
  if (
    apiStatus === 429 ||
    /usage limit|limit reached|rate limit|quota|too many requests/i.test(text)
  ) {
    return 'usage_limit';
  }
  if (
    apiStatus === 401 ||
    apiStatus === 403 ||
    /not logged in|please run \/login|authenticat|invalid api key|oauth token|credential/i.test(
      text,
    )
  ) {
    return 'auth';
  }
  return 'cli_error';
}

function extractJson(text: string): unknown | null {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  for (const candidate of [trimmed, fenced?.[1]?.trim()]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // 次の候補
    }
  }
  return null;
}

export interface ClaudeProviderOptions {
  claudePath: string;
  allowedAuthMethods: readonly string[];
  /** review.credential_ref で明示したサブスク用トークン（claude setup-token） */
  oauthToken?: string | undefined;
  parentEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  readFileImpl?: (path: string) => Promise<string>;
}

/**
 * Claude Code の非対話実行（claude -p）アダプタ（8.2）。
 * - サブスク認証を使うため --bare は使わない
 * - --restricted でユーザー・プロジェクト設定と実行系ツールを無効にし、ファイル操作を作業ディレクトリへ閉じ込める
 * - 読み取り系ツール（Read/Grep/Glob）だけを許可し、MCPを読み込まない
 */
export class ClaudeProvider implements ReviewProvider {
  readonly name = 'claude' as const;
  private readonly parentEnv: NodeJS.ProcessEnv;
  private readonly readFileImpl: (path: string) => Promise<string>;

  private readonly options: ClaudeProviderOptions;

  constructor(options: ClaudeProviderOptions) {
    this.options = options;
    this.parentEnv = options.parentEnv ?? process.env;
    this.readFileImpl = options.readFileImpl ?? ((p) => readFile(p, 'utf8'));
  }

  /** AI子プロセスの環境。別の認証経路の値は継承しない（5.4） */
  childEnv(): Record<string, string> {
    const env = baseEnv(this.parentEnv);
    if (this.parentEnv.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = this.parentEnv.CLAUDE_CONFIG_DIR;
    if (this.options.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = this.options.oauthToken;
    env.DISABLE_AUTOUPDATER = '1';
    env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE = '1';
    return env;
  }

  args(model?: string): string[] {
    const args = [
      '-p',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(reviewResultJsonSchema),
      '--restricted',
      '--tools',
      'Read,Grep,Glob',
      '--permission-mode',
      'dontAsk',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--no-session-persistence',
      '--disable-slash-commands',
    ];
    if (model) args.push('--model', model);
    return args;
  }

  async preflight(): Promise<PreflightResult> {
    const warnings: string[] = [];
    const env = this.childEnv();
    let cliVersion: string | null = null;
    try {
      const v = await runProcess(this.options.claudePath, ['--version'], {
        env,
        timeoutMs: 30_000,
      });
      cliVersion = v.stdout.toString('utf8').trim().split(/\s+/)[0] ?? null;
    } catch (error) {
      return {
        ok: false,
        cliVersion: null,
        authMethod: null,
        errorClass: 'not_installed',
        message: error instanceof SpawnError ? error.message : String(error),
        warnings,
      };
    }

    const inherited = PAID_PATH_ENV.filter((k) => this.parentEnv[k]);
    if (inherited.length > 0) {
      warnings.push(
        `親プロセスに ${inherited.join(', ')} が設定されています。AI子プロセスには渡しません`,
      );
    }

    for (const path of managedSettingsPaths(this.options.platform)) {
      const text = await this.readFileImpl(path).catch(() => null);
      if (text === null) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return {
          ok: false,
          cliVersion,
          authMethod: null,
          errorClass: 'blocked_auth',
          message: `${path} を解析できないため認証経路を確認できません`,
          warnings,
        };
      }
      const risky = findPaidPathInSettings(parsed);
      if (risky.length > 0) {
        return {
          ok: false,
          cliVersion,
          authMethod: null,
          errorClass: 'blocked_auth',
          message: `${path} に別の認証経路の設定があります: ${risky.join(', ')}`,
          warnings,
        };
      }
    }
    const configDir = this.parentEnv.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
    const userSettings = await this.readFileImpl(join(configDir, 'settings.json')).catch(
      () => null,
    );
    if (userSettings) {
      try {
        const risky = findPaidPathInSettings(JSON.parse(userSettings));
        if (risky.length > 0) {
          warnings.push(
            `~/.claude/settings.json に ${risky.join(', ')} があります（--restricted のため実行時には読み込みません）`,
          );
        }
      } catch {
        // ユーザー設定は --restricted で読み込まないため、解析できなくても続行する
      }
    }

    const status = await runProcess(this.options.claudePath, ['auth', 'status', '--json'], {
      env,
      timeoutMs: 30_000,
    }).catch(() => null);
    if (status?.code !== 0) {
      return {
        ok: false,
        cliVersion,
        authMethod: null,
        errorClass: 'blocked_auth',
        message: '`claude auth status` で認証状態を確認できません',
        warnings,
      };
    }
    let auth: { loggedIn?: boolean; authMethod?: string; apiProvider?: string };
    try {
      auth = JSON.parse(status.stdout.toString('utf8'));
    } catch {
      return {
        ok: false,
        cliVersion,
        authMethod: null,
        errorClass: 'blocked_auth',
        message: '`claude auth status --json` の出力を解析できません',
        warnings,
      };
    }
    const method = auth.authMethod ?? null;
    if (!auth.loggedIn) {
      return {
        ok: false,
        cliVersion,
        authMethod: method,
        errorClass: 'auth',
        message: 'Claude Code にログインしていません。`claude` を起動して /login してください',
        warnings,
      };
    }
    if (auth.apiProvider && auth.apiProvider !== 'firstParty') {
      return {
        ok: false,
        cliVersion,
        authMethod: method,
        errorClass: 'blocked_auth',
        message: `apiProvider が ${auth.apiProvider} です。サブスク認証だけを使用します`,
        warnings,
      };
    }
    if (!method || !this.options.allowedAuthMethods.includes(method)) {
      return {
        ok: false,
        cliVersion,
        authMethod: method,
        errorClass: 'blocked_auth',
        message: `認証方式 ${method ?? '(不明)'} は許可されていません（許可: ${this.options.allowedAuthMethods.join(', ')}）`,
        warnings,
      };
    }
    return { ok: true, cliVersion, authMethod: method, warnings };
  }

  async run(input: PinnedReviewInput, signal: AbortSignal): Promise<ReviewExecutionResult> {
    let res: Awaited<ReturnType<typeof runProcess>>;
    try {
      res = await runProcess(this.options.claudePath, this.args(input.model), {
        cwd: input.dir,
        env: this.childEnv(),
        input: input.prompt,
        timeoutMs: input.timeoutMs,
        signal,
        maxOutputBytes: 16 * 1024 * 1024,
      });
    } catch (error) {
      return {
        outcome: 'failed',
        rawOutput: '',
        structured: null,
        sessionId: null,
        usage: null,
        errorClass: 'not_installed',
        errorMessage: (error as Error).message,
      };
    }
    const rawOutput = res.stdout.toString('utf8');
    if (res.timedOut) {
      return {
        outcome: 'timeout',
        rawOutput,
        structured: null,
        sessionId: null,
        usage: null,
        errorClass: 'timeout',
        errorMessage: `実行時間の上限（${Math.round(input.timeoutMs / 1000)}秒）を超えました`,
      };
    }
    if (res.aborted) {
      return {
        outcome: 'failed',
        rawOutput,
        structured: null,
        sessionId: null,
        usage: null,
        errorClass: 'aborted',
        errorMessage: '実行を中断しました',
      };
    }

    let envelope: Record<string, unknown> | null = null;
    try {
      envelope = JSON.parse(rawOutput) as Record<string, unknown>;
    } catch {
      envelope = null;
    }
    if (envelope?.type !== 'result') {
      const text = `${rawOutput}\n${res.stderr}`.slice(0, 2000);
      return {
        outcome: 'failed',
        rawOutput,
        structured: null,
        sessionId: null,
        usage: null,
        errorClass: classifyError(text, null),
        errorMessage: `claude の出力を解析できません (exit ${res.code}): ${res.stderr.trim().slice(0, 300)}`,
        retryAt: parseUsageLimitReset(text),
      };
    }

    const sessionId = typeof envelope.session_id === 'string' ? envelope.session_id : null;
    const usage: Record<string, unknown> = {};
    for (const key of ['total_cost_usd', 'usage', 'modelUsage', 'duration_ms', 'num_turns']) {
      if (key in envelope) usage[key] = envelope[key];
    }
    const resultText = typeof envelope.result === 'string' ? envelope.result : '';
    if (
      envelope.is_error === true ||
      (typeof envelope.subtype === 'string' && envelope.subtype !== 'success')
    ) {
      const apiStatus =
        typeof envelope.api_error_status === 'number' ? envelope.api_error_status : null;
      const text = `${resultText}\n${res.stderr}`;
      return {
        outcome: 'failed',
        rawOutput,
        structured: null,
        sessionId,
        usage: Object.keys(usage).length > 0 ? usage : null,
        errorClass: classifyError(text, apiStatus),
        errorMessage: (resultText || String(envelope.subtype)).slice(0, 1000),
        retryAt: parseUsageLimitReset(text),
      };
    }
    const structured = envelope.structured_output ?? extractJson(resultText);
    return {
      outcome: 'succeeded',
      rawOutput,
      structured: structured ?? null,
      sessionId,
      usage: Object.keys(usage).length > 0 ? usage : null,
    };
  }
}
