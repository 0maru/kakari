import type { KakariClient } from '@kakari/shared';
import type { Command } from 'commander';
import { type AppContext, createContext, sessionStore } from '../context.ts';
import { humanDbClient } from '../db.ts';
import { CliError } from '../errors.ts';
import { PendingOperations } from '../pending-ops.ts';

export interface GlobalOptions {
  config?: string;
  local?: string;
}

export function contextFor(cmd: Command): AppContext {
  const opts = cmd.optsWithGlobals<GlobalOptions>();
  return createContext({ config: opts.config, local: opts.local });
}

export async function humanClient(ctx: AppContext): Promise<KakariClient> {
  return humanDbClient(ctx.loaded, ctx.secrets, sessionStore(ctx));
}

export function pendingOps(ctx: AppContext): PendingOperations {
  return new PendingOperations(ctx.loaded.stateDir);
}

export function parseIntOption(name: string) {
  return (value: string): number => {
    if (!/^\d+$/.test(value)) throw new CliError('usage', `${name} には整数を指定してください`);
    return Number(value);
  };
}

export function requireUuid(value: string, label: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new CliError('usage', `${label} の形式が不正です: ${value}`);
  }
  return value.toLowerCase();
}
