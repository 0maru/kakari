import { platform } from 'node:process';
import {
  DISPLAY_STATES,
  type DisplayState,
  getResult,
  getTaskDetail,
  isDisplayState,
  listTasks,
} from '@kakari/shared';
import type { Command } from 'commander';
import { uiBaseUrl } from '../config/load.ts';
import { CliError } from '../errors.ts';
import { taskUrl } from '../notify/format.ts';
import { info, printJson, printText } from '../output.ts';
import { baseEnv, runProcess } from '../process.ts';
import { renderTaskDetail, renderTaskList } from '../render.ts';
import { contextFor, humanClient, parseIntOption, requireUuid } from './common.ts';

function parseStates(value: string | undefined): DisplayState[] | undefined {
  if (!value) return undefined;
  const states = value.split(',').map((s) => s.trim());
  for (const s of states) {
    if (!isDisplayState(s)) {
      throw new CliError('usage', `--status には ${DISPLAY_STATES.join(', ')} を指定してください`);
    }
  }
  return states as DisplayState[];
}

/** URLのhost・形式を検証して外部のブラウザで開く（16.1） */
export async function openUrl(url: string, allowedHosts: string[]): Promise<void> {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || !allowedHosts.includes(parsed.host)) {
    throw new CliError('runtime', `開けないURLです: ${url}`);
  }
  const opener = platform === 'darwin' ? '/usr/bin/open' : 'xdg-open';
  const res = await runProcess(opener, [parsed.toString()], {
    env: baseEnv(),
    timeoutMs: 15_000,
  }).catch(() => null);
  if (res?.code !== 0) {
    info(`ブラウザを起動できませんでした。次のURLを開いてください: ${parsed.toString()}`);
  }
}

async function uiRunning(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export function registerViewCommands(program: Command): void {
  program
    .command('list')
    .description('レビュー項目を一覧表示する（未確認の最新結果が先頭）')
    .option('--profile <id>', 'プロファイルで絞り込む')
    .option('--repo <owner/repo>', 'リポジトリで絞り込む')
    .option('--status <states>', `表示状態（カンマ区切り: ${DISPLAY_STATES.join(',')}）`)
    .option('--unacked', '未確認の最新結果があるものだけ')
    .option('--page <n>', 'ページ番号', parseIntOption('--page'), 1)
    .option('--page-size <n>', '1ページの件数', parseIntOption('--page-size'))
    .option('--json', 'JSONで出力する')
    .action(async (opts, cmd: Command) => {
      const ctx = contextFor(cmd);
      const client = await humanClient(ctx);
      const pageSize = opts.pageSize ?? ctx.loaded.config.ui.page_size;
      const res = await listTasks(client, {
        profileId: opts.profile,
        repository: opts.repo,
        displayStates: parseStates(opts.status),
        unackedOnly: opts.unacked,
        page: opts.page,
        pageSize,
      });
      if (opts.json) {
        printJson({ page: res.page, page_size: res.pageSize, total: res.total, tasks: res.rows });
      } else {
        printText(renderTaskList(res.rows, res.total, res.page, res.pageSize));
      }
    });

  program
    .command('show <task-id>')
    .description('結果・対象SHA・元PR・依頼世代を表示する（確認済みにはしない）')
    .option('--result <result-id>', '履歴の結果を表示する')
    .option('--format <format>', 'text | markdown | json', 'text')
    .action(async (taskId: string, opts, cmd: Command) => {
      if (!['text', 'markdown', 'json'].includes(opts.format)) {
        throw new CliError('usage', '--format には text / markdown / json を指定してください');
      }
      const ctx = contextFor(cmd);
      const client = await humanClient(ctx);
      const detail = await getTaskDetail(client, requireUuid(taskId, 'task ID'));
      const resultId = opts.result
        ? requireUuid(opts.result, 'result ID')
        : detail.task.current_result_id;
      const result = resultId ? await getResult(client, resultId) : null;
      if (result && result.review_task_id !== detail.task.task_id) {
        throw new CliError('usage', 'この結果は指定したレビュー項目のものではありません');
      }
      if (opts.format === 'json') {
        printJson({
          task: detail.task,
          result,
          results: detail.results,
          jobs: detail.jobs,
          operations: detail.operations,
          signals: detail.signals,
        });
      } else {
        printText(renderTaskDetail(detail, result, opts.format));
      }
    });

  program
    .command('open <task-id>')
    .description('レビュー詳細画面、またはGitHubのPRを開く')
    .option('--pr', 'GitHubのPRを開く')
    .action(async (taskId: string, opts, cmd: Command) => {
      const ctx = contextFor(cmd);
      const client = await humanClient(ctx);
      const detail = await getTaskDetail(client, requireUuid(taskId, 'task ID'));
      if (opts.pr) {
        const url = detail.task.pr_url ?? '';
        const host = detail.task.github_host ?? 'github.com';
        const expected = new RegExp(
          `^https://${host.replace(/\./g, '\\.')}/[^/]+/[^/]+/pull/\\d+$`,
        );
        if (!expected.test(url)) throw new CliError('runtime', `PRのURLが想定外の形式です: ${url}`);
        await openUrl(url, [host]);
        return;
      }
      const base = uiBaseUrl(ctx.loaded);
      if (!(await uiRunning(base))) {
        info(`ローカルUI（${base}）が起動していません。\`kakari ui\` で起動してください。`);
        info(`保存済みの結果は \`kakari show ${detail.task.task_id}\` で表示できます。`);
        return;
      }
      await openUrl(taskUrl(base, detail.task.task_id ?? taskId), [new URL(base).host]);
    });
}
