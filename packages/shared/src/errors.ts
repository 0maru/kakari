export type KakariErrorKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'invalid'
  | 'not_found'
  | 'conflict'
  | 'confirmation_required'
  | 'network'
  | 'unknown';

export class KakariError extends Error {
  readonly kind: KakariErrorKind;
  readonly detail: unknown;

  constructor(kind: KakariErrorKind, message: string, detail?: unknown) {
    super(message);
    this.name = 'KakariError';
    this.kind = kind;
    this.detail = detail;
  }
}

interface PostgrestLikeError {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
  status?: number;
}

/** PostgREST / supabase-js のエラーを分類する。 */
export function toKakariError(error: PostgrestLikeError | Error | null | undefined): KakariError {
  if (!error) return new KakariError('unknown', 'unknown error');
  if (error instanceof KakariError) return error;
  const e = error as PostgrestLikeError & { name?: string };
  // DB関数のメッセージに付く接頭辞を外す
  const message = (e.message ?? 'unknown error').replace(/^kakari:\s*/, '');
  if (e.code === '42501') return new KakariError('forbidden', message, e);
  if (e.code === '22023' || e.code === '23514' || e.code === '22P02')
    return new KakariError('invalid', message, e);
  if (e.code === 'PGRST301' || e.code === 'PGRST302' || e.status === 401)
    return new KakariError('unauthenticated', message, e);
  if (e.code === 'PGRST116') return new KakariError('not_found', message, e);
  if (
    e.name === 'TypeError' ||
    e.name === 'AbortError' ||
    /fetch failed|network|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(message)
  ) {
    return new KakariError('network', message, e);
  }
  return new KakariError('unknown', message, e);
}
