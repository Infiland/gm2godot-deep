import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Deterministic JSON: object keys sorted recursively. Two structurally equal values always produce
 * identical bytes, which is what every cache key and snapshot identity relies on.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const entry = source[key];
    if (entry !== undefined) sorted[key] = sortValue(entry);
  }
  return sorted;
}

export function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeJsonAtomic(path: string, value: unknown, indent = 2): void {
  writeTextAtomic(path, JSON.stringify(value, null, indent) + "\n");
}

/** Write text via temp file → fsync → rename so a crash never leaves a half-written artifact. */
export function writeTextAtomic(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const handle = openSync(temp, "w");
  try {
    writeSync(handle, body);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temp, path);
}

/** Structural deep equality over JSON values. */
export function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}
