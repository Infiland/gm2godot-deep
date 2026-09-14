/**
 * Shared helpers for the Phase-16 test suite.
 *
 * Every test creates its own temp workspace under `<realpath(tmpdir())>` and removes it afterwards.
 * GM2Godot refuses a `--report-dir` under the `/tmp` symlink on macOS, so the real path of the temp
 * root is used, never `os.tmpdir()` directly.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ConfigSchema,
  type Config,
  type AgentRuntimeId,
} from "../../src/config/schema.ts";
import { openDatabase, type Database } from "../../src/storage/db.ts";
import { Repo } from "../../src/storage/repo.ts";
import {
  createWorkspace,
  type Workspace,
} from "../../src/workspaces/workspace.ts";
import { thawTree } from "../../src/workspaces/snapshot.ts";
import {
  InventoryRecordSchema,
  type InventoryRecord,
} from "../../src/indexing/inventory.ts";
import type {
  Allowlist,
  TaskBudgets,
  TaskRecord,
  TaskState,
  UnitStrategy,
} from "../../src/storage/types.ts";

/** Absolute repository root, derived from this file's location (`tests/helpers/harness.ts`). */
export function repoRoot(): string {
  return realpathSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", ".."),
  );
}

export const FIXTURE_PROJECT = join(
  repoRoot(),
  "fixtures",
  "gm-projects",
  "counter",
);
export const FIXTURE_SCENARIO = join(
  repoRoot(),
  "fixtures",
  "scenarios",
  "counter_trace.gd",
);
export const FIXTURE_EXPECTED_TRACE = join(
  repoRoot(),
  "fixtures",
  "traces",
  "counter_expected.json",
);
export const GM2GODOT_CHECKOUT = process.env["GM2GODOT_CHECKOUT"] ?? "";
export const GM2GODOT_PYTHON = process.env["GM2GODOT_PYTHON"] ?? "";
export const GODOT_BINARY = process.env["GODOT_BIN"] ?? "";

/** A fresh temp directory whose *real* path is returned (the parent `/tmp` is a symlink on macOS). */
export function makeTempDir(label: string): string {
  return mkdtempSync(join(realpathSync(tmpdir()), `gm2deep-${label}-`));
}

export function removeTree(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export interface TestWorkspace {
  readonly root: string;
  readonly workspace: Workspace;
  readonly repo: Repo;
  readonly db: Database;
  /** Closes the database and removes the whole temp root. Safe to call twice. */
  cleanup(): void;
}

export interface TestWorkspaceOptions {
  /** Directory to use as the immutable source project. Defaults to a tiny synthetic `.yyp` folder. */
  readonly sourceDir?: string;
  readonly runtime?: AgentRuntimeId;
  readonly godotBinary?: string | null;
  readonly repairAttempts?: number;
}

const FIXTURE_YYP = JSON.stringify(
  {
    resourceType: "GMProject",
    resourceVersion: "2.0",
    name: "Tiny",
    resources: [],
    RoomOrderNodes: [],
    MetaData: { IDEVersion: "2026.0.0.16" },
  },
  null,
  2,
);

/** Write a minimal but valid GameMaker project so config/workspace code has a real source path. */
export function writeTinyGmProject(directory: string): string {
  mkdirSync(join(directory, "scripts", "scr_tiny"), { recursive: true });
  writeFileSync(join(directory, "Tiny.yyp"), FIXTURE_YYP, "utf8");
  writeFileSync(
    join(directory, "scripts", "scr_tiny", "scr_tiny.gml"),
    "function scr_tiny() { return 1; }\n",
    "utf8",
  );
  return directory;
}

export function sampleConfig(input: {
  sourcePath: string;
  workspacePath: string;
  runtime?: AgentRuntimeId;
  godotBinary?: string | null;
  repairs?: number;
}): Config {
  return ConfigSchema.parse({
    version: 1,
    source: { path: input.sourcePath },
    workspace: { path: input.workspacePath },
    gm2godot: {
      checkout: GM2GODOT_CHECKOUT,
      python: GM2GODOT_PYTHON,
      expectedVersions: ["0.7.74"],
      platform: "macos",
      groups: ["assets", "project", "wip"],
      only: [],
      allowPartial: true,
      timeoutSeconds: 900,
    },
    godot: {
      binary: input.godotBinary ?? null,
      expectedVersion: "4.7.2.stable.official.ed1daf0bf",
      expectedVersionPrefix: "4.7.2",
      bootFrames: 0,
      timeoutSeconds: 120,
    },
    agent: { runtime: input.runtime ?? "mock" },
    concurrency: { analysis: 2, implementation: 2 },
    sandbox: { backend: "auto" },
    policy: { maxRepairAttempts: input.repairs ?? 2 },
    report: { includeSourceSnippets: false },
  });
}

/** Create a workspace (layout + `.sqlite`) and an open `Repo` on it. */
export function createTestWorkspace(
  label: string,
  options: TestWorkspaceOptions = {},
): TestWorkspace {
  const root = makeTempDir(label);
  const sourceDir =
    options.sourceDir ??
    writeTinyGmProject(join(root, "elsewhere", "source-project"));
  mkdirSync(sourceDir, { recursive: true });
  const config = sampleConfig({
    sourcePath: sourceDir,
    workspacePath: join(root, "workspace"),
    runtime: options.runtime ?? "mock",
    godotBinary: options.godotBinary ?? null,
    repairs: options.repairAttempts ?? 2,
  });
  const workspace = createWorkspace(join(root, "workspace"), config);
  const db = openDatabase(workspace.paths.database);
  const repo = new Repo(db);
  return {
    root,
    workspace,
    repo,
    db,
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      // `source/` and `baseline/` are frozen read-only and their copies live in `.staging/` and
      // `validation/`; a frozen parent cannot be removed, so the whole workspace is thawed first.
      try {
        const workspace = join(root, "workspace");
        if (existsSync(workspace)) thawTree(workspace);
      } catch {
        /* best effort: the tree may not exist or may already be writable */
      }
      removeTree(root);
    },
  };
}

const DEFAULT_BUDGETS: TaskBudgets = {
  maxAttempts: 3,
  maxModelTokens: null,
  maxCostUsd: null,
  timeoutSeconds: 600,
};

export interface InsertTaskInput {
  readonly id: string;
  readonly state?: TaskState;
  readonly write?: readonly string[];
  readonly read?: readonly string[];
  readonly strategy?: UnitStrategy;
  readonly unitIds?: readonly string[];
  readonly dependsOn?: readonly string[];
  readonly contractVersions?: Record<string, number>;
  readonly inputHash?: string;
  readonly acceptanceCheckIds?: readonly string[];
  readonly reviewRequired?: boolean;
  readonly blockReason?: string | null;
}

/** Insert a task row with a narrow allowlist and return the persisted record. */
export function insertTask(repo: Repo, input: InsertTaskInput): TaskRecord {
  const allowlist: Allowlist = {
    read: [...(input.read ?? [])],
    write: [...(input.write ?? [])],
  };
  repo.insertTask({
    id: input.id,
    unitIds: [...(input.unitIds ?? [`unit:${input.id}`])],
    role: "implementer",
    state: input.state ?? "READY",
    strategy: input.strategy ?? "repair_generated",
    maxAttempts: 3,
    allowlist,
    dependsOn: [...(input.dependsOn ?? [])],
    contractVersions: input.contractVersions ?? {},
    inputHash: input.inputHash ?? `input-${input.id}`,
    acceptanceCheckIds: [...(input.acceptanceCheckIds ?? [])],
    reviewRequired: input.reviewRequired ?? false,
    budgets: DEFAULT_BUDGETS,
    blockReason: input.blockReason ?? null,
  });
  const task = repo.getTask(input.id);
  if (task === null) throw new Error(`task ${input.id} was not persisted`);
  return task;
}

export function hashBytes(buffer: Buffer | string): string {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer, "utf8");
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Content hash of every file under `root`, keyed by POSIX relative path. Used for byte-identity checks. */
export function hashTree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (directory: string): void => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => (a.name < b.name ? -1 : 1),
    )) {
      const absolute = join(directory, entry.name);
      const rel = relative(root, absolute).split(sep).join("/");
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) result[rel] = hashBytes(readFileSync(absolute));
    }
  };
  walk(root);
  return result;
}

/** Tree snapshot including file modes, so read-only drift is visible as well as content drift. */
export function statTree(
  root: string,
): Record<string, { sha256: string; mode: number }> {
  const result: Record<string, { sha256: string; mode: number }> = {};
  const walk = (directory: string): void => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => (a.name < b.name ? -1 : 1),
    )) {
      const absolute = join(directory, entry.name);
      const rel = relative(root, absolute).split(sep).join("/");
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) {
        result[rel] = {
          sha256: hashBytes(readFileSync(absolute)),
          mode: statSync(absolute).mode & 0o777,
        };
      }
    }
  };
  walk(root);
  return result;
}

export function writeFileEnsured(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

/** An empty inventory: a valid record for code paths that only need the shape, not real file rows. */
export function minimalInventory(): InventoryRecord {
  return InventoryRecordSchema.parse({
    schemaVersion: 1,
    sourceSnapshotId: `sha256:${"0".repeat(64)}`,
    baselineId: null,
    createdAt: "1970-01-01T00:00:00Z",
    tool: {
      gm2godotDeepVersion: "0.1.0",
      node: process.version,
      python: null,
      gm2godot: { version: "0.7.74", commit: null },
    },
    files: [],
    resources: [],
    objects: [],
    rooms: [],
    units: [],
    counts: {
      total: 0,
      excluded: 0,
      byClassification: {},
      byUnitKind: {},
      unitsTotal: 0,
      unitsRequiringAnalysis: 0,
      unitsDeterministicOnly: 0,
    },
    gmlApi: { entryCount: 0, byStatus: {}, digest: `sha256:${"0".repeat(64)}` },
  });
}

export function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Await a condition with a bounded poll; throws with `label` when it never becomes true. */
export async function waitFor(
  condition: () => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const { promise, resolve } = Promise.withResolvers<void>();
  const poll = (): void => {
    if (condition()) resolve();
    else if (Date.now() >= deadline) resolve();
    else setTimeout(poll, 5);
  };
  poll();
  await promise;
  if (!condition()) throw new Error(`timed out waiting for ${label}`);
}
