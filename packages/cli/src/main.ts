import { APP_NAME, KakariError } from '@kakari/shared';
import { Command, CommanderError } from 'commander';
import { registerAdminCommands } from './commands/admin.ts';
import { registerAuthCommands } from './commands/auth.ts';
import { contextFor } from './commands/common.ts';
import { registerDoctorCommand } from './commands/doctor.ts';
import { registerOpsCommands } from './commands/ops.ts';
import { registerRunCommands } from './commands/run.ts';
import { registerStatusCommand } from './commands/status.ts';
import { openUrl, registerViewCommands } from './commands/view.ts';
import { CliError, EXIT, exitCodeFor } from './errors.ts';
import { info } from './output.ts';
import { startUiServer } from './ui-server.ts';

export function buildProgram(): Command {
  const program = new Command(APP_NAME)
    .description('GitHubで自分に依頼されたPRレビューを自動で準備する')
    .option('--config <path>', 'config.yaml のパス（既定: ~/.config/kakari/config.yaml）')
    .option('--local <path>', 'local.yaml のパス（既定: config.yaml と同じディレクトリ）')
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({ writeErr: (s) => process.stderr.write(s) });

  registerAuthCommands(program);

  program
    .command('ui')
    .description('ローカルのレビューUIを配信する')
    .option('--open', 'ブラウザで開く')
    .action(async (opts, cmd: Command) => {
      const ctx = contextFor(cmd);
      const server = await startUiServer(ctx);
      info(`${APP_NAME} UI: ${server.url}（Ctrl+C で停止）`);
      if (opts.open) await openUrl(`${server.url}/tasks`, [new URL(server.url).host]);
      await new Promise<void>((resolve) => {
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
      });
      await server.close();
    });

  registerViewCommands(program);
  registerOpsCommands(program);
  registerDoctorCommand(program);
  registerRunCommands(program);
  registerStatusCommand(program);
  registerAdminCommands(program);
  return program;
}

export async function main(argv: string[]): Promise<number> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
    return EXIT.ok;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (
        error.code === 'commander.helpDisplayed' ||
        error.code === 'commander.version' ||
        error.exitCode === 0
      ) {
        return EXIT.ok;
      }
      return EXIT.usage;
    }
    if (error instanceof CliError || error instanceof KakariError) {
      process.stderr.write(`${APP_NAME}: ${error.message}\n`);
    } else {
      process.stderr.write(
        `${APP_NAME}: 予期しないエラー: ${(error as Error)?.stack ?? String(error)}\n`,
      );
    }
    return exitCodeFor(error);
  }
}
