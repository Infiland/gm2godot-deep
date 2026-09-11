/** Human-readable rendering helpers for `status`, `report` and `doctor`. */

import type { ParsedArgs } from "./args.ts";

/**
 * Typed accessors over `CommandContext["flags"]`. `parseArgs` already validated every flag name and
 * kind (a typo is rejected, never ignored), so these narrow the union once per read instead of at
 * every use site.
 */
export function flagString(flags: ParsedArgs["flags"], name: string): string | null {
  const value = flags[name];
  return typeof value === "string" ? value : null;
}

export function flagNumber(flags: ParsedArgs["flags"], name: string): number | null {
  const value = flags[name];
  return typeof value === "number" ? value : null;
}

export function flagBoolean(flags: ParsedArgs["flags"], name: string): boolean {
  const value = flags[name];
  return value === true;
}

export function flagList(flags: ParsedArgs["flags"], name: string): readonly string[] {
  const value = flags[name];
  return Array.isArray(value) ? value : [];
}

export function renderKeyValues(pairs: readonly (readonly [string, string])[]): string {
  const width = pairs.reduce((max, [key]) => Math.max(max, key.length), 0);
  return pairs.map(([key, value]) => `${key.padEnd(width)}  ${value}`).join("\n");
}

export function renderTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = header.map((cell, index) =>
    rows.reduce((max, row) => Math.max(max, (row[index] ?? "").length), cell.length),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ").trimEnd();
  return [line(header), widths.map((width) => "-".repeat(width)).join("  "), ...rows.map(line)].join("\n");
}

export function renderCounts(counts: Readonly<Record<string, number>>): string {
  const entries = Object.entries(counts).filter(([, value]) => value !== 0);
  if (entries.length === 0) return "—";
  return entries.map(([key, value]) => `${key}=${value}`).join(" ");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** `--json` output: the raw artifact, verbatim. */
export function renderJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
