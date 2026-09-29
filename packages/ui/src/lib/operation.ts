import { KakariError, newOperationId, type OperationResponse, toKakariError } from '@kakari/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';

export interface OperationState {
  busy: boolean;
  message: string | null;
  error: string | null;
  /** 応答を失った操作がある（再送すると同じ操作IDで送る） */
  resendable: boolean;
}

/**
 * UIからの状態変更（10.4）。
 * 成功を確認するまで完了と表示せず、応答を失った場合は同じ操作ID・同じ内容で再送する（AC-47）。
 */
export function useOperation(taskId: string) {
  const queryClient = useQueryClient();
  const pending = useRef<{ key: string; operationId: string; args: unknown } | null>(null);
  const [state, setState] = useState<OperationState>({
    busy: false,
    message: null,
    error: null,
    resendable: false,
  });

  async function run<A>(
    key: string,
    args: A,
    send: (args: A, operationId: string) => Promise<OperationResponse>,
    messages: Partial<Record<OperationResponse['status'], string>>,
  ): Promise<OperationResponse | null> {
    if (!pending.current || pending.current.key !== key) {
      pending.current = { key, operationId: newOperationId(), args };
    }
    const current = pending.current;
    setState({ busy: true, message: null, error: null, resendable: false });
    try {
      const res = await send(current.args as A, current.operationId);
      pending.current = null;
      await queryClient.invalidateQueries({ queryKey: ['task', taskId] });
      await queryClient.invalidateQueries({ queryKey: ['tasks'] });
      if (res.status === 'conflict') {
        setState({
          busy: false,
          message: null,
          error:
            '別の画面・端末で状態が変わりました。最新の状態を読み込んだので、内容を確認してからもう一度操作してください。',
          resendable: false,
        });
      } else if (res.status === 'rejected' || res.status === 'confirmation_required') {
        setState({
          busy: false,
          message: null,
          error: res.message ?? '操作を受け付けませんでした',
          resendable: false,
        });
      } else {
        setState({
          busy: false,
          message: messages[res.status] ?? '操作を適用しました',
          error: null,
          resendable: false,
        });
      }
      return res;
    } catch (error) {
      const e = error instanceof KakariError ? error : toKakariError(error as Error);
      const unknownOutcome = e.kind === 'network' || e.kind === 'unknown';
      if (!unknownOutcome) pending.current = null;
      setState({
        busy: false,
        message: null,
        error: unknownOutcome
          ? 'サーバーの応答を受け取れませんでした。操作が適用されたかは不明です。「再送」すると同じ操作として処理されます。'
          : e.message,
        resendable: unknownOutcome,
      });
      return null;
    }
  }

  return { state, run, pendingKey: () => pending.current?.key ?? null };
}
