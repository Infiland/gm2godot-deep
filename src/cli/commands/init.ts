import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CommandRunner } from "../main.ts";
import { DeepError } from "../../util/result.ts";
import { ConfigSchema, type Config } from "../../config/schema.ts";
import { resolveGodotBinary, resolvePython } from "../../config/resolve.ts";
import { createWorkspace, removeTree, type Workspace } from "../../workspaces/workspace.ts";
import { assertNotInside } from "../../workspaces/guards.ts";
import { workspacePaths } from "../../workspaces/paths.ts";
import { snapshotSource, thawTree, writeSnapshotRecord } from "../../workspaces/snapshot.ts";
import { SNAPSHOT_FILENAME } from "../../indexing/inventory.ts";
import { openDatabase } from "../../storage/db.ts";
import { Repo } from "../../storage/repo.ts";
import { runDoctor, type DoctorReport } from "../../scheduling/pipeline.ts";
import { EXIT } from "../exit.ts";
import { flagBoolean, flagString, renderKeyValues  } from "../output.ts";

function requireFlag(value: string | null, name: string): string {
  if (value === null) throw new DeepError("GM2DEEP-CLI-USAGE", `init requires --${name}`);
  return value;
}

/** The lines `init` echoes after its probes, so the operator sees the same facts `doctor` prints. */
function summaryLines(report: DoctorReport): readonly string[] {
  const commit = report.gm2godot.commit === null ? "unknown" : `${report.gm2godot.commit.slice(0, 7)}…`;
  const gm2godot =
    report.gm2godot.version === null
      ? `GM2Godot unavailable (${report.gm2godot.error ?? "no version reported"})`
      : `GM2Godot ${report.gm2godot.version} (commit ${commit})`;
  const godot =
    report.godot.version === null
      ? `Godot not found (${report.godot.reason})`
      : report.godot.matchesExpected
        ? `Godot ${report.godot.version} (matches expected)`
        : `Godot ${report.godot.version} (mismatch: expected ${report.godot.reason})`;
  const sandbox = report.sandbox.available
    ? `sandbox: ${report.sandbox.backend} (available)`
    : `sandbox: none — isolation-requiring operations will fail closed (${report.sandbox.detail})`;
  return [
    gm2godot,
    `python ${report.gm2godot.python} (${report.gm2godot.pythonVersion ?? "version not reported"})`,
    godot,
    sandbox,
  ];
}

/**
 * Create the workspace: probe first, refuse on a version mismatch unless `--force`, then snapshot the
 * source, open the state database and only then write the configuration.
 *
 * Nothing here converts or analyses; `init` establishes an immutable snapshot and the pinned toolchain
 * every later phase re-verifies.
 */
export const run: CommandRunner = async (context) => {
  const sourceFlag = requireFlag(flagString(context.flags, "source"), "source");
  const workspaceFlag = requireFlag(flagString(context.flags, "workspace"), "workspace");
  const checkoutFlag = requireFlag(flagString(context.flags, "gm2godot-checkout"), "gm2godot-checkout");
  const pythonFlag = flagString(context.flags, "gm2godot-python");
  const godotFlag = flagString(context.flags, "godot-bin");
  const runtime = flagString(context.flags, "runtime") ?? "mock";
  const force = flagBoolean(context.flags, "force");

  const sourcePath = resolve(context.cwd, sourceFlag);
  const workspaceRoot = resolve(context.cwd, workspaceFlag);
  if (!existsSync(sourcePath)) {
    throw new DeepError("GM2DEEP-SOURCE-MISSING", `source project directory does not exist: ${sourcePath}`);
  }
  // The workspace module skips its own disjointness check while the workspace directory does not exist
  // yet, which is exactly the fresh-init case; assert it here with the same guard so a recursive
  // snapshot is impossible (GM2DEEP-PATH-NESTED-WORKSPACE). The reverse check is only meaningful once
  // the workspace exists — nothing can be inside a directory that is not there.
  assertNotInside(workspaceRoot, sourcePath);
  if (existsSync(workspaceRoot)) assertNotInside(sourcePath, workspaceRoot);

  // A config is built in memory first: the probes must run before anything is written to disk, and the
  // workspace directory itself is created by `createWorkspace` only after they agree with the pins.
  const config = ConfigSchema.parse({
    version: 1,
    source: { path: sourcePath },
    workspace: { path: workspaceRoot },
    gm2godot: {
      checkout: resolve(context.cwd, checkoutFlag),
      ...(pythonFlag === null ? {} : { python: resolve(context.cwd, pythonFlag) }),
    },
    godot: godotFlag === null ? {} : { binary: resolve(context.cwd, godotFlag) },
    agent: { runtime },
  });

  const pending: Workspace = { root: workspaceRoot, paths: workspacePaths(workspaceRoot), config };
  const report = await runDoctor({ workspace: pending, logger: context.logger });
  if ((!report.gm2godot.matchesExpected || (report.godot.version !== null && !report.godot.matchesExpected)) && !force) {
    throw new DeepError(
      "GM2DEEP-UPSTREAM-VERSION-MISMATCH",
      "pinned upstream versions do not match the probes; re-run with --force to record them anyway",
      {
        expectedGm2godot: report.gm2godot.expected,
        observedGm2godot: report.gm2godot.version,
        expectedGodot: config.godot.expectedVersion,
        observedGodot: report.godot.version,
      },
    );
  }

  // Resolve the interpreter and engine now, so the recorded config names concrete paths rather than
  // leaving every later phase to re-probe.
  const python = resolvePython(config).path;
  const godotBinary = resolveGodotBinary(config)?.path ?? null;
  const resolved: Config = {
    ...config,
    gm2godot: { ...config.gm2godot, python },
    godot: { ...config.godot, binary: godotBinary },
  };

  const workspace = createWorkspace(workspaceRoot, resolved, { force });
  if (existsSync(workspace.paths.source) && force) {
    thawTree(workspace.paths.source);
    removeTree(workspace.paths.source);
  }
  const snapshot = await snapshotSource(resolved.source.path, workspace.paths.source);
  writeSnapshotRecord(join(workspace.paths.evidenceInventory, SNAPSHOT_FILENAME), snapshot);

  const database = openDatabase(workspace.paths.database);
  const repo = new Repo(database);
  context.logger.debug(`state database ready at ${workspace.paths.database} (${String(repo.listUnits().length)} unit row(s))`);
  database.close();

  for (const line of summaryLines(report)) context.stdout(line);
  context.stdout("");
  context.stdout(
    renderKeyValues([
      ["workspace", workspace.root],
      ["source", resolved.source.path],
      ["checkout", resolved.gm2godot.checkout],
      ["python", python],
      ["godot", godotBinary ?? "not configured or not found"],
      ["runtime", resolved.agent.runtime],
      ["snapshot", snapshot.snapshotId],
      ["snapshot files", String(snapshot.entries.length)],
      ["snapshot excluded", String(snapshot.excluded.length)],
    ]),
  );
  return EXIT.ok;
};
