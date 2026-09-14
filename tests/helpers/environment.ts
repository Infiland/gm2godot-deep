import { HostSnapshotSchema } from "../../src/host/protocol.ts";
import { readJsonFile } from "../../src/util/json.ts";
/**
 * Shared test environment helpers.
 *
 * Every test builds its own temp workspace under the *real* temp directory: on this machine `/tmp`
 * is a symlink and GM2Godot refuses a report directory under it, so `fs.mkdtempSync(os.tmpdir())`
 * is used only after `fs.realpathSync`. Frozen snapshots/baselines are thawed before removal,
 * because a `0555` directory cannot be emptied.
 */

import {
  cpSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

import {
  snapshotSource,
  type SnapshotRecord,
} from "../../src/workspaces/snapshot.ts";
import {
  bridgeGmlApi,
  bridgeInventory,
  probeGm2Godot,
  type BridgeInventory,
  type GmlApiEntry,
  type Gm2GodotProbe,
} from "../../src/adapters/gm2godot/bridge.ts";
import {
  buildInventory,
  type InventoryRecord,
} from "../../src/indexing/inventory.ts";
import { openDatabase, type Database } from "../../src/storage/db.ts";
import { Repo } from "../../src/storage/repo.ts";
import { sha256Text } from "../../src/util/sha256.ts";
import { ConfigSchema, type Config } from "../../src/config/schema.ts";

export const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** The synthetic GameMaker LTS 2026 project every indexing/analysis test runs against. */
export const FIXTURE_PROJECT = join(
  REPO_ROOT,
  "fixtures",
  "gm-projects",
  "counter",
);

export const GM2GODOT_CHECKOUT = process.env["GM2GODOT_CHECKOUT"] ?? "";
export const GM2GODOT_PYTHON = process.env["GM2GODOT_PYTHON"] ?? "";

export interface TempDir {
  readonly path: string;
  cleanup(): void;
}

/** Recursively restore write permission so a frozen tree can be deleted. */
function makeWritable(root: string): void {
  let stats: Stats;
  try {
    stats = statSync(root);
  } catch {
    return;
  }
  if (stats.isDirectory()) {
    try {
      chmodSync(root, 0o755);
    } catch {
      return;
    }
    for (const entry of readdirSync(root, { withFileTypes: true }))
      makeWritable(join(root, entry.name));
    return;
  }
  try {
    chmodSync(root, 0o644);
  } catch {
    // A missing or already-removed file needs no permission fix.
  }
}

/** A unique directory under the real temp root, removed (recursively) by `cleanup`. */
export function tempDir(prefix: string): TempDir {
  const path = mkdtempSync(join(realpathSync(os.tmpdir()), `${prefix}-`));
  return {
    path,
    cleanup(): void {
      makeWritable(path);
      rmSync(path, { recursive: true, force: true });
    },
  };
}

export interface TempRepo extends TempDir {
  readonly db: Database;
  readonly repo: Repo;
}

/** A temp directory holding an open workspace `state.sqlite` and its `Repo`. */
export function tempRepo(prefix = "gm2deep-repo"): TempRepo {
  const temp = tempDir(prefix);
  const db = openDatabase(join(temp.path, "state.sqlite"));
  return {
    path: temp.path,
    db,
    repo: new Repo(db),
    cleanup(): void {
      try {
        db.close();
      } catch {
        // The database may already be closed by the test.
      }
      temp.cleanup();
    },
  };
}

export interface FixtureEnvironment extends TempDir {
  /** A writable copy of the fixture, before the snapshot was taken. */
  readonly projectDir: string;
  /** The frozen source snapshot (`<root>/source-snapshot`). */
  readonly snapshotDir: string;
  /** `<root>/evidence` — where `buildInventory` writes its artifacts. */
  readonly evidenceDir: string;
  readonly snapshot: SnapshotRecord;
  readonly probe: Gm2GodotProbe;
  readonly bridge: BridgeInventory;
  readonly gmlApi: readonly GmlApiEntry[];
  readonly inventory: InventoryRecord;
}

/**
 * Copy the fixture into a temp project, optionally mutate the copy, snapshot it, and use a committed host inventory for offline tests. Explicit
 * DEEP_INTEGRATION plus checkout/interpreter variables enables a real bridge refresh. Returns the inventory the pipeline would build.
 */
export async function loadFixture(
  options: {
    readonly prefix?: string;
    readonly mutate?: (projectDir: string) => void;
  } = {},
): Promise<FixtureEnvironment> {
  const temp = tempDir(options.prefix ?? "gm2deep-fixture");
  try {
    const bridgeOptions = {
      checkout: GM2GODOT_CHECKOUT,
      python: GM2GODOT_PYTHON,
    };
    const projectDir = join(temp.path, "project");
    cpSync(FIXTURE_PROJECT, projectDir, { recursive: true });
    options.mutate?.(projectDir);

    const snapshotDir = join(temp.path, "source-snapshot");
    const snapshot = await snapshotSource(projectDir, snapshotDir);
    const evidenceDir = join(temp.path, "evidence");
    const fixture = HostSnapshotSchema.parse(
      readJsonFile(join(REPO_ROOT, "tests", "fixtures", "counter-host.json")),
    );
    const live =
      process.env["DEEP_INTEGRATION"] === "1" &&
      GM2GODOT_CHECKOUT &&
      GM2GODOT_PYTHON;
    const bridge = live
      ? await bridgeInventory(bridgeOptions, snapshotDir)
      : fixture.inventory;
    const gmlApi = live
      ? await bridgeGmlApi(bridgeOptions)
      : fixture.gmlApiEntries;
    const probe = live
      ? await probeGm2Godot(bridgeOptions)
      : {
          gm2godotVersion: fixture.gm2godotVersion,
          pythonVersion: "fixture",
          pythonExecutable: "fixture",
          checkout: "fixture",
          commit: null,
        };
    const inventory = await buildInventory({
      snapshot,
      snapshotDir,
      baselineDir: null,
      bridge,
      probe,
      gmlApiEntries: gmlApi,
      evidenceInventoryDir: evidenceDir,
    });

    return {
      ...temp,
      projectDir,
      snapshotDir,
      evidenceDir,
      snapshot,
      probe,
      bridge,
      gmlApi,
      inventory,
    };
  } catch (error) {
    temp.cleanup();
    throw error;
  }
}

// ------------------------------------------------------- synthetic baselines

/**
 * A stand-in for the pinned GM2Godot `convert` command. It writes the same two ledger files the real
 * converter writes into `--godot-project`, so `generateBaseline` can be exercised without a real
 * conversion of a real project.
 *
 * `partial`  → attempt `partial`, canonical manifest `updated`/`verified` with a matching digest, exit 0
 * `preserved`→ attempt `failed`, canonical manifest `preserved`/`unverified`, exit 1
 */
export type StubConversionMode = "partial" | "preserved";

export interface StubConverter {
  /** Executable the adapter spawns as `<python> <checkout>/main.py convert …`. */
  readonly python: string;
  readonly checkout: string;
  readonly mainPy: string;
}

function stubConverterSource(mode: StubConversionMode): string {
  return `#!/usr/bin/env node
const { createHash } = require("node:crypto");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const NL = String.fromCharCode(10);
const MODE = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
const at = args.indexOf("--godot-project");
if (at === -1) { process.stderr.write("stub: missing --godot-project"); process.exit(2); }
const godot = args[at + 1];
const dir = join(godot, "gm2godot");
mkdirSync(dir, { recursive: true });
const preserved = MODE === "preserved";
const converters = { requested: 15, executed: 15, completed: 15, skipped: 0, failed: 0 };
const resources = { requested: 16, executed: 16, completed: 15, skipped: 1, failed: 0 };
const manifest = {
  format_version: 2,
  conversion: { state: preserved ? "failed" : "partial", converters, resources, failed_step: null, failure_phase: null },
  target_platform: "macos",
  enabled_converters: [],
  source_project: { name: "Counter", yyp_path: "Counter.yyp", resource_type: "GMProject", resource_version: "2.0", ide_version: "2026.0.0.16" },
  resources: [],
  generation_inventory: {
    format_version: 1,
    entries: [{ path: "project.godot", kind: "generated", owner: { class: "ProjectConverter", name: "project" }, byte_count: 20, sha256: "sha256:" + "0".repeat(64), mode: 420 }],
  },
  generated_files: [],
  source_maps: [],
  architecture_policies: null,
  path_diagnostics: null,
};
const manifestBytes = JSON.stringify(manifest, null, 2) + NL;
writeFileSync(join(dir, "conversion_manifest.json"), manifestBytes);
const digest = "sha256:" + createHash("sha256").update(Buffer.from(manifestBytes, "utf8")).digest("hex");
const attempt = {
  format_version: 1,
  attempt: { state: preserved ? "failed" : "partial", converters, steps: [], resources, failed_step: null, failure_phase: null, cancelled: false },
  canonical_manifest: {
    path: "gm2godot/conversion_manifest.json",
    status: preserved ? "preserved" : "updated",
    updated: !preserved,
    current_output: preserved ? "unverified" : "verified",
    sha256: preserved ? "sha256:" + "1".repeat(64) : digest,
  },
};
writeFileSync(join(dir, "conversion_attempt.json"), JSON.stringify(attempt, null, 2) + NL);
writeFileSync(join(godot, "project.godot"), "[application]" + NL + 'config/name="Counter"' + NL);
const outcome = preserved ? "failed" : "partial";
process.stdout.write("GM2Godot conversion outcome: " + outcome + "; converters[requested=15, executed=15, completed=15, skipped=0, failed=0]; resources[requested=16, executed=16, completed=15, skipped=1, failed=0]" + NL);
if (preserved) { process.stderr.write("GM2Godot conversion failed: stub" + NL); process.exit(1); }
process.exit(0);
`;
}

/** Write the stub converter and a placeholder checkout `main.py`; returns the paths a config needs. */
export function writeStubConverter(
  root: string,
  mode: StubConversionMode,
): StubConverter {
  const python = process.execPath;
  const checkout = join(root, "stub-checkout");
  mkdirSync(checkout, { recursive: true });
  const mainPy = join(checkout, "main.py");
  writeFileSync(mainPy, stubConverterSource(mode), "utf8");
  return { python, checkout, mainPy };
}

/** A complete, valid config for a temp source/workspace pair pointed at the stub converter. */
export function testConfig(input: {
  readonly sourceDir: string;
  readonly workspaceDir: string;
  readonly checkout: string;
  readonly python: string;
}): Config {
  return ConfigSchema.parse({
    version: 1,
    source: { path: input.sourceDir },
    workspace: { path: input.workspaceDir },
    gm2godot: {
      checkout: input.checkout,
      python: input.python,
      expectedVersions: ["0.7.74"],
      platform: "macos",
      groups: ["assets", "project", "wip"],
      only: [],
      allowPartial: true,
      timeoutSeconds: 60,
    },
    godot: { binary: null },
    agent: { runtime: "mock" },
    concurrency: { analysis: 1, implementation: 1 },
    policy: { maxRepairAttempts: 1, maxTaskAttempts: 2 },
    report: { includeSourceSnippets: false },
  });
}

export interface BaselineSpec {
  readonly manifestFormatVersion?: number;
  readonly inventoryFormatVersion?: number;
  readonly attemptFormatVersion?: number;
  readonly attemptState?: string;
  readonly canonicalStatus?: string;
  readonly canonicalUpdated?: boolean;
  readonly currentOutput?: string;
  /** Digest recorded for the manifest; defaults to the digest of the manifest bytes actually written. */
  readonly digest?: string | null;
  readonly entryCount?: number;
  readonly includeAttempt?: boolean;
}

export interface SyntheticBaseline {
  readonly manifestPath: string;
  readonly attemptPath: string;
  readonly manifestSha256: string;
  readonly directory: string;
}

/** Write a `gm2godot/conversion_manifest.json` + `conversion_attempt.json` pair to `dir`. */
export function writeSyntheticBaseline(
  dir: string,
  spec: BaselineSpec = {},
): SyntheticBaseline {
  const manifest = {
    format_version: spec.manifestFormatVersion ?? 2,
    conversion: {
      state: spec.attemptState ?? "success",
      converters: {
        requested: 15,
        executed: 15,
        completed: 15,
        skipped: 0,
        failed: 0,
      },
      resources: {
        requested: 16,
        executed: 16,
        completed: 15,
        skipped: 1,
        failed: 0,
      },
      failed_step: null,
      failure_phase: null,
    },
    target_platform: "macos",
    enabled_converters: [],
    source_project: {
      name: "Counter",
      yyp_path: "Counter.yyp",
      resource_type: "GMProject",
      resource_version: "2.0",
      ide_version: "2026.0.0.16",
    },
    resources: [],
    generation_inventory: {
      format_version: spec.inventoryFormatVersion ?? 1,
      entries: Array.from({ length: spec.entryCount ?? 1 }, (_, index) => ({
        path: `generated-${index}.gd`,
        kind: "generated",
        owner: { class: "ProjectConverter", name: "project" },
        byte_count: 1,
        sha256: sha256Text(`generated-${index}`),
        mode: 420,
      })),
    },
    generated_files: [],
    source_maps: [],
    architecture_policies: null,
    path_diagnostics: null,
  };
  const gm2godotDir = join(dir, "gm2godot");
  mkdirSync(gm2godotDir, { recursive: true });
  const manifestPath = join(gm2godotDir, "conversion_manifest.json");
  const manifestText = JSON.stringify(manifest, null, 2) + "\n";
  writeFileSync(manifestPath, manifestText, "utf8");
  const manifestSha256 = sha256Text(manifestText);
  const attemptPath = join(gm2godotDir, "conversion_attempt.json");
  if (spec.includeAttempt !== false) {
    const attempt = {
      format_version: spec.attemptFormatVersion ?? 1,
      attempt: {
        state: spec.attemptState ?? "success",
        converters: manifest.conversion.converters,
        steps: [],
        resources: manifest.conversion.resources,
        failed_step: null,
        failure_phase: null,
        cancelled: spec.attemptState === "cancelled",
      },
      canonical_manifest: {
        path: "gm2godot/conversion_manifest.json",
        status: spec.canonicalStatus ?? "updated",
        updated: spec.canonicalUpdated ?? true,
        current_output: spec.currentOutput ?? "verified",
        sha256: spec.digest === undefined ? manifestSha256 : spec.digest,
      },
    };
    writeFileSync(attemptPath, JSON.stringify(attempt, null, 2) + "\n", "utf8");
  }
  return { manifestPath, attemptPath, manifestSha256, directory: dir };
}
