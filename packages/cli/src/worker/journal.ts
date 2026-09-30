import { appendFile, chmod, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CompletePayload } from './db-api.ts';

export type JournalEntry =
  | {
      type: 'reserved';
      at: string;
      execution_id: string;
      lease_token: string;
      job_id: string;
      task_id: string;
      profile_id: string;
      head_sha: string;
      worker_id: string;
    }
  | { type: 'launching'; at: string; input_hash: string; cli_version: string | null }
  | { type: 'launched'; at: string; pid: number | null }
  | { type: 'released'; at: string; disposition: string; reason: string }
  | { type: 'finished'; at: string; payload: CompletePayload }
  | { type: 'recorded'; at: string; status: string; result_id: string | null }
  | { type: 'resolved'; at: string; resolution: string }
  | { type: 'discarded'; at: string };

export interface JournalState {
  executionId: string;
  reserved: Extract<JournalEntry, { type: 'reserved' }> | null;
  launched: boolean;
  launching: boolean;
  finished: Extract<JournalEntry, { type: 'finished' }> | null;
  recorded: boolean;
  released: boolean;
  resolved: boolean;
  discarded: boolean;
  lastAt: string | null;
}

/**
 * 実行記録（9.4）。CLI起動前に実行ID・入力ハッシュ・起動予定を永続化し、
 * 起動後はセッションID・終了状態・結果を追記する。制御プロセスだけが読める権限で保存する。
 */
export class ExecutionJournal {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private file(executionId: string): string {
    if (!/^[0-9a-f-]{36}$/.test(executionId)) throw new Error('invalid execution id');
    return join(this.dir, `${executionId}.jsonl`);
  }

  async append(executionId: string, entry: JournalEntry): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700).catch(() => undefined);
    const path = this.file(executionId);
    await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  async read(executionId: string): Promise<JournalState | null> {
    const text = await readFile(this.file(executionId), 'utf8').catch(() => null);
    if (text === null) return null;
    const state: JournalState = {
      executionId,
      reserved: null,
      launched: false,
      launching: false,
      finished: null,
      recorded: false,
      released: false,
      resolved: false,
      discarded: false,
      lastAt: null,
    };
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let entry: JournalEntry;
      try {
        entry = JSON.parse(line) as JournalEntry;
      } catch {
        // 書き込み途中の行は無視する
        continue;
      }
      state.lastAt = entry.at;
      switch (entry.type) {
        case 'reserved':
          state.reserved = entry;
          break;
        case 'launching':
          state.launching = true;
          break;
        case 'launched':
          state.launched = true;
          break;
        case 'finished':
          state.finished = entry;
          break;
        case 'recorded':
          state.recorded = true;
          break;
        case 'released':
          state.released = true;
          break;
        case 'resolved':
          state.resolved = true;
          break;
        case 'discarded':
          state.discarded = true;
          break;
      }
    }
    return state;
  }

  async list(): Promise<JournalState[]> {
    const files = await readdir(this.dir).catch(() => [] as string[]);
    const states: JournalState[] = [];
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const s = await this.read(f.slice(0, -'.jsonl'.length)).catch(() => null);
      if (s) states.push(s);
    }
    return states;
  }

  /** DBへ未保存の結果（AI実行済み・保存未確認） */
  async pendingUploads(): Promise<JournalState[]> {
    return (await this.list()).filter((s) => s.finished && !s.recorded && !s.discarded);
  }

  async findByJob(jobId: string): Promise<JournalState[]> {
    return (await this.list()).filter((s) => s.reserved?.job_id === jobId);
  }

  /** 共有保存を確認した記録だけを期限で削除する（14.3） */
  async prune(maxAgeMs: number, now = Date.now()): Promise<number> {
    let removed = 0;
    for (const s of await this.list()) {
      const done = s.recorded || s.released || s.resolved || s.discarded;
      if (!done) continue;
      const info = await stat(this.file(s.executionId)).catch(() => null);
      if (info && now - info.mtimeMs > maxAgeMs) {
        await rm(this.file(s.executionId), { force: true });
        removed++;
      }
    }
    return removed;
  }
}
