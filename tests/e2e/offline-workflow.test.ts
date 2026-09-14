import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { thawTree } from "../../src/workspaces/snapshot.ts";
import { test } from "node:test";
import { main } from "../../src/cli/main.ts";
import { openDatabase } from "../../src/storage/db.ts";
import { Repo } from "../../src/storage/repo.ts";
import {
  FIXTURE_PROJECT,
  GM2GODOT_CHECKOUT,
  GM2GODOT_PYTHON,
  GODOT_BINARY,
  makeTempDir,
  readJson,
  removeTree,
} from "../helpers/harness.ts";

async function runChain(workspaceRoot: string): Promise<void> {
  const lines: string[] = [];
  const io = {
    stdout: (line: string) => lines.push(line),
    stderr: (line: string) => lines.push(line),
  };
  const attempt = async (argv: string[]): Promise<void> => {
    const code = await main(argv, io);
    assert.equal(
      code,
      0,
      `${argv.join(" ")} exited ${String(code)}:\n${lines.join("\n")}`,
    );
  };
  await attempt([
    "init",
    "--source",
    FIXTURE_PROJECT,
    "--workspace",
    workspaceRoot,
    "--gm2godot-checkout",
    GM2GODOT_CHECKOUT,
    "--gm2godot-python",
    GM2GODOT_PYTHON,
    "--godot-bin",
    GODOT_BINARY,
    "--runtime",
    "mock",
  ]);
  await attempt(["run", "--workspace", workspaceRoot, "--through", "plan"]);
  await attempt([
    "run",
    "--workspace",
    workspaceRoot,
    "--execute",
    "--max-workers",
    "2",
  ]);
  await attempt(["report", "--workspace", workspaceRoot, "--format", "md"]);
}

interface WorkspaceDirs {
  readonly workspace: string;
  readonly evidence: string;
  readonly port: string;
  readonly baseline: string;
}

function workspacePaths(root: string): WorkspaceDirs {
  const workspace = join(root, "workspace");
  return {
    workspace,
    evidence: join(workspace, "evidence"),
    port: join(workspace, "port"),
    baseline: join(workspace, "baseline"),
  };
}

function listFiles(
  root: string,
  filter: (relativePath: string) => boolean,
): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const rel = relative(root, absolute).split(sep).join("/");
      if (entry.isDirectory()) {
        if (rel === ".godot") continue;
        walk(absolute);
        continue;
      }
      if (filter(rel)) found.push(rel);
    }
  };
  walk(root);
  return found.sort();
}

/**
 * The only permitted differences between two runs of the chain.
 *
 * - Timestamps (`createdAt`, `generatedAt`, `at`, …) and wall-clock durations are run metadata.
 * - Run-scoped identifiers (`newId`, e.g. `int_…`) are random by construction and appear in the
 *   report's accepted-change rows.
 * - `baselineId` (and its `manifestSha256`/`attemptSha256` twins) is a per-generation identity, not a
 *   reproducible one: `conversion_manifest.json` lists every generated file with its sha256, and
 *   `<generated>.gmlmap.json` embeds the **absolute** conversion-source path (`entries[].source_path`,
 *   e.g. `<workspace>/.staging/baseline-1/source/objects/obj_counter/Create_0.gml`). A different
 *   staging path therefore changes those digests, the manifest bytes, and hence `baselineId`. That is
 *   upstream GM2Godot behaviour (it embeds absolute paths in source maps), not a port artifact, so the
 *   generation identity is normalised while everything it identifies is still compared byte-for-byte.
 */
const NORMALISED_KEYS = new Set([
  "createdAt",
  "generatedAt",
  "updatedAt",
  "startedAt",
  "finishedAt",
  "at",
  "latestRunId",
  "workspaceRoot",
  "baselineId",
  "manifestSha256",
  "attemptSha256",
]);

/** Timestamps and workspace-specific paths are the only permitted differences between two runs. */
function normalize(value: unknown, roots: readonly string[]): unknown {
  if (Array.isArray(value))
    return value.map((entry) => normalize(entry, roots));
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (NORMALISED_KEYS.has(key) || /duration/i.test(key)) continue;
      result[key] = normalize((value as Record<string, unknown>)[key], roots);
    }
    return result;
  }
  if (typeof value === "string") {
    // `newId(prefix)` identifiers (`int_<base36 time>_<8 hex>`) are run-scoped, like timestamps.
    if (/^[a-z]+_[0-9a-z]+_[0-9a-f]{8}$/.test(value)) return "<RUN-ID>";
    let text = value;
    for (const root of roots) text = text.split(root).join("<WS>");
    return text.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<TS>");
  }
  return value;
}

/** JSON path of the first difference between two normalized values, or `null` when they are equal. */
function firstDifference(
  left: unknown,
  right: unknown,
  path: string,
): string | null {
  if (left === right) return null;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length)
      return `${path}.length (${String(left.length)} vs ${String(right.length)})`;
    for (let index = 0; index < left.length; index += 1) {
      const difference = firstDifference(
        left[index],
        right[index],
        `${path}[${String(index)}]`,
      );
      if (difference !== null) return difference;
    }
    return null;
  }
  if (
    left !== null &&
    right !== null &&
    typeof left === "object" &&
    typeof right === "object"
  ) {
    const keys = [
      ...new Set([
        ...Object.keys(left as object),
        ...Object.keys(right as object),
      ]),
    ].sort();
    for (const key of keys) {
      const difference = firstDifference(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
        `${path}.${key}`,
      );
      if (difference !== null) return difference;
    }
    return null;
  }
  return `${path} (${JSON.stringify(left)} vs ${JSON.stringify(right)})`;
}

function normalizedArtifacts(
  root: string,
  paths: WorkspaceDirs,
): Record<string, unknown> {
  const artifacts: Record<string, unknown> = {};
  for (const rel of listFiles(paths.evidence, (path) =>
    path.endsWith(".json"),
  )) {
    const value = JSON.parse(
      readFileSync(join(paths.evidence, rel), "utf8"),
    ) as unknown;
    artifacts[`evidence/${rel}`] = normalize(value, [root]);
  }
  // GM2Godot's own managed-output bookkeeping carries a per-run random generation id and a lock file;
  // it is upstream converter state, not an artifact this pipeline produces.
  for (const rel of listFiles(
    paths.port,
    (path) =>
      !path.endsWith(".png") && !path.startsWith(".gm2godot-managed-output"),
  )) {
    const value = readFileSync(join(paths.port, rel), "utf8");
    artifacts[`port/${rel}`] = normalize(value, [root]);
  }
  return artifacts;
}

test(
  "init → run --execute → report produces every artifact with the mock runtime, deterministically",
  {
    skip:
      process.env["DEEP_INTEGRATION"] === "1" &&
      GM2GODOT_CHECKOUT &&
      GM2GODOT_PYTHON &&
      GODOT_BINARY
        ? false
        : "requires explicit checkout, Python, Godot and DEEP_INTEGRATION=1",
  },
  async () => {
    // Both runs use the *same* workspace path: GM2Godot embeds the absolute source path in the files it
    // generates, so its manifest digest (our baseline id) is path-dependent by upstream design. Running
    // the identical chain twice at the identical path is what makes byte-level determinism assertable.
    const first = makeTempDir("e2e");
    try {
      mkdirSync(first, { recursive: true });
      await runChain(join(first, "workspace"));

      const paths = workspacePaths(first);
      const inventory = readJson<{
        counts: {
          total: number;
          excluded: number;
          unitsTotal: number;
          unitsRequiringAnalysis: number;
        };
        files: {
          path: string;
          classification: string;
          excludeReason?: string;
        }[];
      }>(join(paths.evidence, "inventory", "inventory.json"));
      assert.equal(inventory.counts.excluded, 0);
      assert.ok(
        inventory.counts.total >= 17,
        `expected the fixture's files, got ${String(inventory.counts.total)}`,
      );
      for (const file of inventory.files) {
        assert.ok(
          file.classification.length > 0,
          `${file.path} has no classification`,
        );
        if (file.classification === "excluded")
          assert.ok((file.excludeReason ?? "").length > 0);
      }

      const sourceSnapshot = readJson<{
        snapshotId: string;
        entries: unknown[];
      }>(join(paths.evidence, "inventory", "source-snapshot.json"));
      assert.match(sourceSnapshot.snapshotId, /^sha256:[0-9a-f]{64}$/);
      assert.equal(sourceSnapshot.entries.length, inventory.counts.total);

      const baseline = readJson<{
        baselineId: string | null;
        exitCode: number | null;
        outcome: string;
        gm2godot: { version: string | null };
      }>(join(paths.evidence, "inventory", "baseline.json"));
      assert.equal(baseline.exitCode, 0);
      assert.match(baseline.baselineId ?? "", /^sha256:[0-9a-f]{64}$/);
      assert.equal(baseline.gm2godot.version, "0.7.74");
      const manifest = readJson<{ format_version: number }>(
        join(paths.baseline, "gm2godot", "conversion_manifest.json"),
      );
      assert.equal(manifest.format_version, 2);

      const analyses = listFiles(
        join(paths.evidence, "analyses"),
        (path) => path.endsWith(".json") && !path.endsWith(".review.json"),
      );
      assert.equal(analyses.length, inventory.counts.unitsRequiringAnalysis);
      const scrState = readJson<{
        dependencies: { unresolved: { symbol: string }[] };
      }>(join(paths.evidence, "analyses", "script%3Ascr_state.json"));
      assert.deepEqual(
        scrState.dependencies.unresolved.map((entry) => entry.symbol).sort(),
        ["asset_get_index", "script_execute"],
      );

      const contracts = listFiles(join(paths.evidence, "contracts"), (path) =>
        path.endsWith(".json"),
      );
      assert.equal(
        contracts.length,
        10,
        `expected the ten concerns, got ${contracts.join(", ")}`,
      );

      const plan = readJson<{
        version: number;
        contracts: unknown[];
        unitStrategies: { unitId: string }[];
      }>(join(paths.evidence, "plans", "plan.v1.json"));
      assert.equal(plan.version, 1);
      assert.equal(plan.contracts.length, 10);

      const validation = listFiles(join(paths.evidence, "validation"), (path) =>
        path.endsWith(".json"),
      );
      const validationRows = validation.map((rel) =>
        readJson<{ checkId: string; level: string; state: string }>(
          join(paths.evidence, "validation", rel),
        ),
      );
      for (const level of ["A", "B", "C", "D", "E"]) {
        assert.ok(
          validationRows.some((row) => row.level === level),
          `level ${level} recorded no check`,
        );
      }
      assert.equal(
        validationRows.find((row) => row.checkId === "coverage")?.state,
        "passed",
      );
      assert.equal(
        validationRows.find((row) => row.checkId === "runtime-boot")?.state,
        "passed",
      );

      const report = readJson<{
        adapters: { runtimeLines: string[] };
        summary: {
          fileCoverage: {
            label: string;
            numerator: number;
            denominator: number;
          };
          testCoverage: { label: string };
          behavioralVerification: { label: string };
        };
        counts: { portRevision: number };
      }>(join(paths.evidence, "reports", "report.json"));
      assert.deepEqual(report.adapters.runtimeLines, [
        "mock (deterministic, no model exercised)",
      ]);
      assert.equal(report.summary.fileCoverage.label, "file coverage");
      assert.equal(
        report.summary.fileCoverage.numerator,
        report.summary.fileCoverage.denominator,
      );
      assert.equal(report.summary.testCoverage.label, "test coverage");
      assert.equal(
        report.summary.behavioralVerification.label,
        "behavioral verification",
      );
      assert.ok(
        report.counts.portRevision > 0,
        "at least one patch must have been published",
      );

      const markdown = readFileSync(
        join(paths.evidence, "reports", "report.md"),
        "utf8",
      );
      assert.match(markdown, /mock \(deterministic, no model exercised\)/);
      assert.match(markdown, /file coverage:/);

      // Running the same chain again at the same path must produce the same artifacts.
      const firstArtifacts = normalizedArtifacts(first, paths);
      thawTree(join(first, "workspace"));
      removeTree(join(first, "workspace"));
      await runChain(join(first, "workspace"));
      const secondArtifacts = normalizedArtifacts(first, workspacePaths(first));
      assert.deepEqual(
        Object.keys(secondArtifacts).sort(),
        Object.keys(firstArtifacts).sort(),
        "the two runs produced different artifact sets",
      );
      for (const key of Object.keys(firstArtifacts)) {
        const difference = firstDifference(
          firstArtifacts[key],
          secondArtifacts[key],
          key,
        );
        if (difference !== null)
          assert.fail(`two runs differ at ${difference}`);
      }
    } finally {
      // `source/` and `baseline/` are frozen and copied into `.staging/`; thaw before removing.
      try {
        const workspace = join(first, "workspace");
        if (existsSync(workspace)) thawTree(workspace);
      } catch {
        /* best effort */
      }
      removeTree(first);
    }
  },
);
