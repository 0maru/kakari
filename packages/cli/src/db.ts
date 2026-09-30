import type { Database, KakariClient } from '@kakari/shared';
import { createClient } from '@supabase/supabase-js';
import type { LoadedConfig } from './config/load.ts';
import { findWorker } from './config/load.ts';
import { CliError } from './errors.ts';
import type { SecretResolver } from './secrets.ts';
import type { SessionStore } from './session-store.ts';

export function createDbClient(url: string, publishableKey: string): KakariClient {
  return createClient<Database>(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false },
    global: { headers: { 'x-client-info': 'kakari-cli' } },
  });
}

export async function publishableKey(loaded: LoadedConfig, secrets: SecretResolver) {
  return secrets.resolveRef(loaded.config.storage.publishable_key_ref);
}

/**
 * workerの認証主体でDBへログインする（5.2）。
 * パスワードは local.yaml の db_logins から参照先を解決して取得する。
 */
export async function workerDbClient(
  loaded: LoadedConfig,
  secrets: SecretResolver,
  workerId: string,
): Promise<KakariClient> {
  const worker = findWorker(loaded.config, workerId);
  const login = loaded.local.db_logins[worker.db_session_ref];
  if (!login) {
    throw new CliError(
      'config',
      `worker ${workerId} のDBログイン ${worker.db_session_ref} が local.yaml の db_logins に定義されていません`,
    );
  }
  const client = createDbClient(
    loaded.config.storage.project_url,
    await publishableKey(loaded, secrets),
  );
  const password = await secrets.resolveSource(login.password_ref);
  const { error } = await client.auth.signInWithPassword({ email: login.email, password });
  if (error) {
    throw new CliError('auth', `worker ${workerId} としてDBにログインできません: ${error.message}`);
  }
  return client;
}

/** 本人のCLI用セッションを復元する。更新されたトークンは保存し直す。 */
export async function humanDbClient(
  loaded: LoadedConfig,
  secrets: SecretResolver,
  store: SessionStore,
): Promise<KakariClient> {
  const saved = await store.load();
  if (!saved) {
    throw new CliError('auth', '未ログインです。`kakari login` を実行してください');
  }
  const client = createDbClient(
    loaded.config.storage.project_url,
    await publishableKey(loaded, secrets),
  );
  const { data, error } = await client.auth.setSession({
    access_token: saved.access_token,
    refresh_token: saved.refresh_token,
  });
  if (error || !data.session) {
    throw new CliError(
      'auth',
      'セッションの有効期限が切れました。`kakari login` を実行してください',
    );
  }
  if (data.session.refresh_token !== saved.refresh_token) {
    await store.save({
      ...saved,
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    });
  }
  client.auth.onAuthStateChange((event, session) => {
    if (event === 'TOKEN_REFRESHED' && session) {
      void store.save({
        ...saved,
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      });
    }
  });
  return client;
}
