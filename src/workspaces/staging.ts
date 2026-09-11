import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
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

/** Add owner-write to every entry in a tree, preserving the other permission bits. */
export function makeTreeWritable(root: string): void {
  const walk = (directory: string): void => {
    const directoryMode = statSync(directory).mode & 0o7777;
    chmodSync(directory, directoryMode | 0o700);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) chmodSync(absolute, (statSync(absolute).mode & 0o7777) | 0o600);
    }
  };
  walk(root);
}

/**
 * Copy a tree with the snapshot exclusion rules, then make the copy writable.
 *
 * The source of every copy here (`source/`, `baseline/`, `port/`) is frozen read-only, so a verbatim copy
 * would inherit `0o444` files inside `0o555` directories, which breaks the staging source GM2Godot converts
 * and the candidate workspace a patch is applied to. Unlike `thawTree`, this preserves the other mode bits.
 */
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
  makeTreeWritable(destination);
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
