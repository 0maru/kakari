import type { Database, KakariClient } from '@kakari/shared';
import { createClient, type Session } from '@supabase/supabase-js';
import { QueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { loadPublicConfig, type PublicConfig } from './config.ts';

export interface AppState {
  config: PublicConfig;
  client: KakariClient;
  queryClient: QueryClient;
}

const AppContext = createContext<AppState | null>(null);
const SessionContext = createContext<{ session: Session | null; ready: boolean }>({
  session: null,
  ready: false,
});

let appPromise: Promise<AppState> | null = null;

export function getApp(): Promise<AppState> {
  appPromise ??= loadPublicConfig().then((config) => ({
    config,
    client: createClient<Database>(config.supabaseUrl, config.publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'kakari-auth' },
    }),
    queryClient: new QueryClient({
      defaultOptions: {
        queries: {
          // 表示中は一定間隔で再取得し、画面への復帰時にも再取得する（2.2・11.2）
          refetchInterval: config.refreshIntervalSeconds * 1000,
          refetchIntervalInBackground: false,
          refetchOnWindowFocus: true,
          retry: 1,
        },
      },
    }),
  }));
  return appPromise;
}

export function AppProvider({ app, children }: { app: AppState; children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void app.client.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = app.client.auth.onAuthStateChange((event, next) => {
      setSession(next);
      if (event === 'SIGNED_OUT') {
        // ログアウト・セッション失効時は結果表示を消す（11.5・14.3）
        app.queryClient.clear();
      }
    });
    return () => data.subscription.unsubscribe();
  }, [app]);
  return (
    <AppContext.Provider value={app}>
      <SessionContext.Provider value={{ session, ready }}>{children}</SessionContext.Provider>
    </AppContext.Provider>
  );
}

export function useApp(): AppState {
  const app = useContext(AppContext);
  if (!app) throw new Error('AppProvider がありません');
  return app;
}

export function useSession() {
  return useContext(SessionContext);
}
