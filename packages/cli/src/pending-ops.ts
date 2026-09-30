import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { KakariError, newOperationId, type OperationResponse } from '@kakari/shared';
import { info } from './output.ts';

interface PendingOp {
  operation_id: string;
  request: Record<string, unknown>;
  created_at: string;
}

/**
 * 操作IDのローカル記録（16.1）。
 * 送信前に操作IDと送信内容を保存し、応答を失った場合は同じ内容をそのまま再送する（AC-47）。
 * DBから応答を受け取ったら記録を消す。
 */
export class PendingOperations {
  private readonly path: string;

  constructor(stateDir: string) {
    this.path = join(stateDir, 'pending-operations.json');
  }

  private async load(): Promise<Record<string, PendingOp>> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as Record<string, PendingOp>;
    } catch {
      return {};
    }
  }

  private async save(data: Record<string, PendingOp>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await rename(tmp, this.path);
  }

  /**
   * @param fingerprint 操作の種類と対象（revision を含めない）
   * @param build 新しく送る場合の送信内容を作る
   * @param send 送信する
   */
  async run<T extends Record<string, unknown>>(
    fingerprint: string,
    explicitOperationId: string | undefined,
    build: () => Promise<T>,
    send: (request: T, operationId: string) => Promise<OperationResponse>,
  ): Promise<OperationResponse> {
    const data = await this.load();
    const now = Date.now();
    for (const [k, v] of Object.entries(data)) {
      if (now - new Date(v.created_at).getTime() > 24 * 3600_000) delete data[k];
    }
    let entry = data[fingerprint];
    if (entry && (!explicitOperationId || explicitOperationId === entry.operation_id)) {
      info(`前回応答を受け取れなかった操作 ${entry.operation_id} を同じ内容で再送します`);
    } else {
      entry = {
        operation_id: explicitOperationId ?? newOperationId(),
        request: await build(),
        created_at: new Date().toISOString(),
      };
      data[fingerprint] = entry;
    }
    await this.save(data);
    try {
      const res = await send(entry.request as T, entry.operation_id);
      await this.finish(fingerprint);
      return res;
    } catch (error) {
      // 通信失敗など結果が不明な場合だけ記録を残す
      if (!(error instanceof KakariError) || error.kind === 'network' || error.kind === 'unknown') {
        info(
          `応答を受け取れませんでした。同じコマンドを再実行すると操作 ${entry.operation_id} を再送します`,
        );
      } else {
        await this.finish(fingerprint);
      }
      throw error;
    }
  }

  async finish(fingerprint: string): Promise<void> {
    const data = await this.load();
    if (data[fingerprint]) {
      delete data[fingerprint];
      await this.save(data);
    }
  }
}
