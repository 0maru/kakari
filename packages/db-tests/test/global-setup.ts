import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';

export interface SupabaseTestEnv {
  apiUrl: string;
  dbUrl: string;
  publishableKey: string;
  secretKey: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    supabase: SupabaseTestEnv;
  }
}

// ローカルのSupabase（`pnpm db:start`）に接続する
export default function setup(project: TestProject) {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  let status: Record<string, string>;
  try {
    const out = execFileSync('pnpm', ['exec', 'supabase', 'status', '-o', 'json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    status = JSON.parse(out.slice(out.indexOf('{')));
  } catch (error) {
    throw new Error(
      `local Supabase is not running. Run \`pnpm db:start\` first. (${String(error)})`,
    );
  }
  project.provide('supabase', {
    apiUrl: status.API_URL ?? '',
    dbUrl: status.DB_URL ?? '',
    publishableKey: status.PUBLISHABLE_KEY ?? '',
    secretKey: status.SECRET_KEY ?? '',
  });
}
