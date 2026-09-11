import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { z } from "zod";
import { DeepError } from "../util/result.ts";
import { exclusionFor } from "../indexing/exclude.ts";
import { sha256File, sha256OfEntries } from "../util/sha256.ts";
import { writeJsonAtomic } from "../util/json.ts";
import { nowIso } from "../util/ids.ts";

export const SnapshotEntrySchema = z.strictObject({
  path: z.string().min(1),
  sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  bytes: z.number().int().nonnegative(),
  mode: z.number().int().nonnegative(),
});

export const SnapshotRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  originalSourcePath: z.string().min(1),
  snapshotId: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  createdAt: z.string().min(1),
  entries: z.array(SnapshotEntrySchema),
  excluded: z.array(z.strictObject({ path: z.string().min(1), reason: z.string().min(1) })),
});

export type SnapshotEntry = z.output<typeof SnapshotEntrySchema>;
export type SnapshotRecord = z.output<typeof SnapshotRecordSchema>;

export const SNAPSHOT_CHANGED = "GM2DEEP-SOURCE-SNAPSHOT-CHANGED";

/** POSIX-style relative path, so identities are stable across platforms. */
function toPosix(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join("/");
}

/** Walk a tree skipping excluded directories entirely, recording every skipped entry with a reason. */
function collectSourceFiles(sourcePath: string): {
  files: SourceFile[];
  excluded: { path: string; reason: string }[];
} {
  const files: SourceFile[] = [];
  const excluded: { path: string; reason: string }[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const absolute = join(directory, entry.name);
      const relativePath = toPosix(sourcePath, absolute);
      if (entry.isDirectory()) {
        const decision = exclusionFor(`${relativePath}/`, 0);
        if (decision.excluded) {
          excluded.push({ path: relativePath, reason: decision.reason });
          continue;
        }
        walk(absolute);
        continue;
      }
      if (entry.isSymbolicLink()) {
        excluded.push({ path: relativePath, reason: "symlinks are not copied into the source snapshot" });
        continue;
      }
      if (!entry.isFile()) {
        excluded.push({ path: relativePath, reason: `unsupported directory entry kind for ${entry.name}` });
        continue;
      }
      const stats = statSync(absolute);
      const decision = exclusionFor(relativePath, stats.size);
      if (decision.excluded) {
        excluded.push({ path: relativePath, reason: decision.reason });
        continue;
      }
      files.push({ absolute, path: relativePath, bytes: stats.size, mode: stats.mode & 0o777 });
    }
  };

  walk(sourcePath);
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  excluded.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { files, excluded };
}

interface SourceFile {
  readonly absolute: string;
  readonly path: string;
  readonly bytes: number;
  readonly mode: number;
}

async function describeEntries(files: readonly SourceFile[]): Promise<SnapshotEntry[]> {
  const entries: SnapshotEntry[] = [];
  for (const file of files) {
    entries.push({
      path: file.path,
      sha256: await sha256File(file.absolute),
      bytes: file.bytes,
      mode: file.mode,
    });
  }
  return entries;
}

async function hashByPath(files: readonly SourceFile[]): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const file of files) hashes.set(file.path, await sha256File(file.absolute));
  return hashes;
}

/** `chmod` a tree read-only, deepest first, so nothing in it can be edited in place. */
export function freezeTree(root: string, directories: readonly string[] = []): void {
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) chmodSync(absolute, 0o444);
    }
    chmodSync(directory, 0o555);
  };
  walk(root);
  for (const directory of directories) chmodSync(directory, 0o555);
}

export function thawTree(root: string): void {
  const walk = (directory: string): void => {
    chmodSync(directory, 0o755);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) chmodSync(absolute, 0o644);
    }
  };
  walk(root);
}

export interface SnapshotOptions {
  /** Freeze the copy read-only (default true). Tests may set false. */
  readonly freeze?: boolean;
  readonly now?: () => string;
}

/**
 * Copy the GameMaker project into `destDir`, excluding junk, hashing every kept file, and freezing
 * the result. The snapshot id is a pure function of the kept `(path, sha256)` set.
 */
export async function snapshotSource(
  sourcePath: string,
  destDir: string,
  options: SnapshotOptions = {},
): Promise<SnapshotRecord> {
  if (!existsSync(sourcePath) || !statSync(sourcePath).isDirectory()) {
    throw new DeepError("GM2DEEP-SOURCE-MISSING", `source project directory does not exist: ${sourcePath}`);
  }
  if (existsSync(destDir)) {
    throw new DeepError("GM2DEEP-SNAPSHOT-DEST-EXISTS", `snapshot destination already exists: ${destDir}`, { destDir });
  }
  const { files, excluded } = collectSourceFiles(sourcePath);
  if (files.length === 0) {
    throw new DeepError("GM2DEEP-SOURCE-EMPTY", `source project has no includable files: ${sourcePath}`);
  }

  for (const file of files) {
    const target = join(destDir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file.absolute, target);
  }

  const entries = await describeEntries(files);

  const record: SnapshotRecord = {
    schemaVersion: 1,
    originalSourcePath: sourcePath,
    snapshotId: sha256OfEntries(entries),
    createdAt: (options.now ?? nowIso)(),
    entries,
    excluded,
  };

  if (options.freeze !== false) freezeTree(destDir);
  return record;
}

export function writeSnapshotRecord(path: string, record: SnapshotRecord): void {
  writeJsonAtomic(path, record);
}

/**
 * Recompute the snapshot's identity and compare. Called before every integration and every baseline
 * generation: a source that changed mid-run must stop the pipeline rather than produce mixed evidence.
 */
export async function verifySnapshot(snapshotDir: string, expected: SnapshotRecord): Promise<void> {
  const { files } = collectSourceFiles(snapshotDir);
  const expectedByPath = new Map(expected.entries.map((entry) => [entry.path, entry.sha256]));
  const observedPaths = new Set<string>();
  const unexpected: string[] = [];
  const drifted: { path: string; expected: string; actual: string }[] = [];
  const hashes = await hashByPath(files);

  for (const [path, sha256] of hashes) {
    observedPaths.add(path);
    const wanted = expectedByPath.get(path);
    if (wanted === undefined) unexpected.push(path);
    else if (wanted !== sha256) drifted.push({ path, expected: wanted, actual: sha256 });
  }
  const missing = expected.entries.filter((entry) => !observedPaths.has(entry.path)).map((entry) => entry.path);

  const observedId = sha256OfEntries([...hashes].map(([path, sha256]) => ({ path, sha256 })));
  if (unexpected.length > 0 || missing.length > 0 || drifted.length > 0 || observedId !== expected.snapshotId) {
    throw new DeepError(SNAPSHOT_CHANGED, `the source snapshot at ${snapshotDir} no longer matches its record`, {
      expected: expected.snapshotId,
      observed: observedId,
      missing,
      unexpected,
      drifted,
    });
  }
}
