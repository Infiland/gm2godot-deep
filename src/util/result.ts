import type { Logger } from "./log.ts";

/** A coded, user-facing failure. `code` is a stable `GM2DEEP-…` identifier. */
export class DeepError extends Error {
  readonly code: string;
  readonly detail: Record<string, unknown>;

  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "DeepError";
    this.code = code;
    this.detail = detail;
  }

  toJSON(): { code: string; message: string; detail: Record<string, unknown> } {
    return { code: this.code, message: this.message, detail: this.detail };
  }
}

export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/**
 * Run `fn`, converting a thrown `DeepError` into a `Result` and re-throwing anything else.
 * Used at CLI boundaries so unexpected exceptions stay loud.
 */
export async function capture<T>(fn: () => Promise<T> | T): Promise<Result<T, DeepError>> {
  try {
    return ok(await fn());
  } catch (error) {
    if (error instanceof DeepError) return err(error);
    throw error;
  }
}

export function deepErrorFrom(error: unknown, logger?: Logger): DeepError {
  if (error instanceof DeepError) return error;
  const message = error instanceof Error ? error.message : String(error);
  logger?.error(`unexpected error: ${message}`);
  return new DeepError("GM2DEEP-UNEXPECTED", message, {
    cause: error instanceof Error ? error.stack ?? error.message : String(error),
  });
}

/** Assertion helper: throws a coded `DeepError` rather than a bare `Error`. */
export function invariant(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new DeepError(code, message);
}
