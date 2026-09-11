import { randomUUID } from "node:crypto";

/** Short, sortable, collision-resistant id: `<prefix>_<base36 time>_<random>`. */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

/** ISO-8601 UTC, second precision. Used for every recorded timestamp. */
export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** `Promise.withResolvers`-style sleep that respects an abort signal. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  function onAbort(): void {
    clearTimeout(timer);
    reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
  }
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return promise;
}
