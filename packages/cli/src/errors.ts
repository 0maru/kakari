import { KakariError } from '@kakari/shared';

// 16.3 終了コード
export const EXIT = {
  ok: 0,
  runtime: 1,
  usage: 2,
  auth: 3,
  conflict: 4,
  confirmation: 5,
} as const;

export type CliErrorKind = 'runtime' | 'usage' | 'config' | 'auth' | 'conflict' | 'confirmation';

export class CliError extends Error {
  readonly kind: CliErrorKind;

  constructor(kind: CliErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CliError';
    this.kind = kind;
  }
}

export function exitCodeFor(error: unknown): number {
  if (error instanceof CliError) {
    switch (error.kind) {
      case 'usage':
      case 'config':
        return EXIT.usage;
      case 'auth':
        return EXIT.auth;
      case 'conflict':
        return EXIT.conflict;
      case 'confirmation':
        return EXIT.confirmation;
      default:
        return EXIT.runtime;
    }
  }
  if (error instanceof KakariError) {
    switch (error.kind) {
      case 'unauthenticated':
      case 'forbidden':
        return EXIT.auth;
      case 'invalid':
      case 'not_found':
        return EXIT.usage;
      case 'conflict':
        return EXIT.conflict;
      case 'confirmation_required':
        return EXIT.confirmation;
      default:
        return EXIT.runtime;
    }
  }
  return EXIT.runtime;
}
