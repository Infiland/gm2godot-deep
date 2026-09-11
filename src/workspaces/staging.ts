import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DeepError } from "../util/result.ts";
import { exclusionFor } from "../indexing/exclude.ts";

/** Allocate `<root>/<prefix>-<n>` with the lowest unused `n`, so runs never collide. */
export function allocateStagingDir(root: string, prefix: string): string {
  mkdirSync(root, { recursive: true });
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  let highest = 0;
  for (const entry of readdirSync(root)) {
    const match = pattern.exec(entry);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  const next = join(root, `${prefix}-${highest + 1}`);
  mkdirSync(next, { recursive: true });
  return next;
}

/** Copy a tree with the snapshot exclusion rules; the copy stays writable. */
export function copyTree(source: string, destination: string): void {
  cpSync(source, destination, {
    recursive: true,
    dereference: false,
    filter: (src) => {
      const relative = src.slice(source.length).replace(/^[/\\]/, "");
      if (relative.length === 0) return true;
      return !exclusionFor(relative, 0).excluded;
    },
  });
}

/**
 * Replace `destination` with `staged` in one rename. Used to promote a verified conversion into
 * `baseline/` without ever letting a tool write into the frozen destination.
 */
export function promoteDirectory(staged: string, destination: string): void {
  if (!existsSync(staged)) {
    throw new DeepError("GM2DEEP-STAGING-MISSING", `staged directory does not exist: ${staged}`);
  }
  rmSync(destination, { recursive: true, force: true });
  try {
    renameSync(staged, destination);
  } catch (error) {
    throw new DeepError("GM2DEEP-STAGING-PROMOTE-FAILED", `cannot move ${staged} to ${destination}`, {
      staged,
      destination,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}
