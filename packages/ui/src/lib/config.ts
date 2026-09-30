export interface PublicConfig {
  supabaseUrl: string;
  publishableKey: string;
  refreshIntervalSeconds: number;
  pageSize: number;
  appName: string;
}

/**
 * 公開可能な接続設定だけを読む（11.5）。
 * kakari ui が /kakari-config.json で配信する。開発時は VITE_ の環境変数を使う。
 */
export async function loadPublicConfig(): Promise<PublicConfig> {
  try {
    const res = await fetch('/kakari-config.json', { cache: 'no-store' });
    if (res.ok) return (await res.json()) as PublicConfig;
  } catch {
    // 開発サーバーでは配信されない
  }
  const env = import.meta.env;
  if (env.VITE_SUPABASE_URL && env.VITE_SUPABASE_PUBLISHABLE_KEY) {
    return {
      supabaseUrl: env.VITE_SUPABASE_URL,
      publishableKey: env.VITE_SUPABASE_PUBLISHABLE_KEY,
      refreshIntervalSeconds: 30,
      pageSize: 50,
      appName: 'kakari',
    };
  }
  throw new Error('接続設定を取得できません。kakari ui で起動してください。');
}
