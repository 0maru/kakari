/// <reference types="vite/client" />
import { QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  Scripts,
  useLocation,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router';
import { type ReactNode, useEffect, useState } from 'react';
import { AppProvider, type AppState, getApp, useApp, useSession } from '../lib/app.tsx';
import appCss from '../styles.css?url';

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { name: 'referrer', content: 'no-referrer' },
      { title: 'kakari' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
    ],
  }),
  shellComponent: RootDocument,
  component: RootComponent,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const [app, setApp] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getApp().then(setApp, (e: Error) => setError(e.message));
  }, []);
  if (error) return <Centered>{error}</Centered>;
  if (!app) return <Centered>読み込み中…</Centered>;
  return (
    <AppProvider app={app}>
      <QueryClientProvider client={app.queryClient}>
        <Layout />
      </QueryClientProvider>
    </AppProvider>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6 text-sm text-slate-500">
      {children}
    </div>
  );
}

function Layout() {
  const { client } = useApp();
  const { session, ready } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const onLogin = location.pathname === '/login';
  // 遷移中は直前のルートが描画され続けるため、実際に一致しているルートで判定する
  const showingLogin = useRouterState({
    select: (s) => s.matches.some((m) => m.routeId === '/login'),
  });

  useEffect(() => {
    if (ready && !session && !onLogin) {
      void navigate({ to: '/login', search: { redirect: location.href } });
    }
  }, [ready, session, onLogin, navigate, location.href]);

  if (!ready) return <Centered>読み込み中…</Centered>;
  // 未認証の間は結果を表示しない（11.5・11.6）
  if (!session && !showingLogin) return <Centered>ログインが必要です</Centered>;

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <Link to="/tasks" className="flex items-center gap-2 font-semibold">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-indigo-600 text-white">
              か
            </span>
            kakari
          </Link>
          {session && (
            <div className="flex items-center gap-3 text-sm">
              <span className="text-slate-500">{session.user.email}</span>
              <button
                type="button"
                className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
                onClick={() => {
                  void client.auth
                    .signOut({ scope: 'local' })
                    .then(() => navigate({ to: '/login', search: {} }));
                }}
              >
                ログアウト
              </button>
            </div>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
