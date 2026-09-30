import type { Command } from 'commander';
import { sessionStore } from '../context.ts';
import { createDbClient, publishableKey } from '../db.ts';
import { CliError } from '../errors.ts';
import { info } from '../output.ts';
import { ask, askSecret } from '../prompt.ts';
import { contextFor, humanClient } from './common.ts';

export function registerAuthCommands(program: Command): void {
  program
    .command('login')
    .description('本人として共有DBへログインする（AI CLIの認証とは別に管理する）')
    .option('--email <email>', 'メールアドレス')
    .action(async (opts, cmd: Command) => {
      const ctx = contextFor(cmd);
      const email = (opts.email ?? (await ask('メールアドレス: '))).trim();
      const password = await askSecret('パスワード: ');
      if (!email || !password)
        throw new CliError('usage', 'メールアドレスとパスワードを入力してください');
      const client = createDbClient(
        ctx.loaded.config.storage.project_url,
        await publishableKey(ctx.loaded, ctx.secrets),
      );
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error || !data.session)
        throw new CliError('auth', `ログインできません: ${error?.message ?? 'no session'}`);
      // worker・通知クライアントのアカウントでは本人操作をさせない（11.5）
      const { data: me } = await client
        .from('app_users')
        .select('user_id')
        .eq('user_id', data.user.id)
        .maybeSingle();
      if (!me) {
        await client.auth.signOut({ scope: 'local' });
        throw new CliError('auth', 'このアカウントは本人アカウントとして登録されていません');
      }
      const store = sessionStore(ctx);
      await store.save({
        project_url: ctx.loaded.config.storage.project_url,
        email,
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
      });
      info(
        `${email} としてログインしました（セッションの保存先: ${store.backend === 'keychain' ? 'キーチェーン' : 'ファイル'}）`,
      );
    });

  program
    .command('logout')
    .description('本人のCLI用DBセッションを削除する')
    .action(async (_opts, cmd: Command) => {
      const ctx = contextFor(cmd);
      const store = sessionStore(ctx);
      try {
        const client = await humanClient(ctx);
        await client.auth.signOut({ scope: 'local' });
      } catch {
        // セッションが無効でもローカルの記録は削除する
      }
      await store.clear();
      info('ログアウトしました。');
    });
}
