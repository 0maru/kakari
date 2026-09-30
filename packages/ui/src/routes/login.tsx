import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { useApp } from '../lib/app.tsx';

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({
    redirect:
      typeof search.redirect === 'string' &&
      search.redirect.startsWith('/') &&
      !search.redirect.startsWith('//')
        ? search.redirect
        : undefined,
  }),
  component: LoginPage,
});

function LoginPage() {
  const { client } = useApp();
  const navigate = useNavigate();
  const { redirect } = Route.useSearch();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error: signInError } = await client.auth.signInWithPassword({ email, password });
    if (signInError || !data.user) {
      setBusy(false);
      setError('ログインできません。メールアドレスとパスワードを確認してください。');
      return;
    }
    // worker・通知クライアントのアカウントでは本人操作をさせない
    const { data: me } = await client
      .from('app_users')
      .select('user_id')
      .eq('user_id', data.user.id)
      .maybeSingle();
    if (!me) {
      await client.auth.signOut({ scope: 'local' });
      setBusy(false);
      setError('このアカウントは本人アカウントとして登録されていません。');
      return;
    }
    setBusy(false);
    if (redirect) window.location.assign(redirect);
    else void navigate({ to: '/tasks' });
  };

  return (
    <div className="mx-auto mt-16 max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <h1 className="mb-4 text-lg font-semibold">kakari にログイン</h1>
      <form className="space-y-3" onSubmit={submit}>
        <label className="block text-sm">
          メールアドレス
          <input
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 dark:border-slate-700 dark:bg-slate-800"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="block text-sm">
          パスワード
          <input
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 dark:border-slate-700 dark:bg-slate-800"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {busy ? 'ログイン中…' : 'ログイン'}
        </button>
      </form>
    </div>
  );
}
