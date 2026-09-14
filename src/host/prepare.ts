import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ConfigSchema } from "../config/schema.ts";
import { canonicalJson, readJsonFile, writeJsonAtomic } from "../util/json.ts";
import { DeepError } from "../util/result.ts";
import { sha256Text } from "../util/sha256.ts";
import {
  SnapshotRecordSchema,
  snapshotSource,
  thawTree,
  verifySnapshot,
  writeSnapshotRecord,
} from "../workspaces/snapshot.ts";
import {
  assertDisjoint,
  createWorkspace,
  openWorkspace,
  type Workspace,
} from "../workspaces/workspace.ts";
import { HostSnapshotSchema, type ResearchParams } from "./protocol.ts";
import { configuredBudgets } from "./settings.ts";

export async function prepareHostJob(
  params: ResearchParams,
): Promise<Workspace> {
  const root = resolve(params.jobRoot);
  assertDisjoint(params.sourcePath, root);
  assertDisjoint(params.baselinePath, root);
  const input = HostSnapshotSchema.parse(readJsonFile(params.hostSnapshotPath));
  if (!existsSync(join(params.baselinePath, "project.godot")))
    throw new DeepError(
      "HOST_BASELINE_MISSING",
      "The host baseline has no project.godot",
    );
  if (existsSync(join(root, "host-inputs.json"))) {
    const workspace = openWorkspace(root);
    const saved = readJsonFile(join(root, "host-inputs.json")) as {
      sourcePath: string;
      baselinePath: string;
      hostSnapshotSha256: string;
    };
    if (
      resolve(params.sourcePath) !== saved.sourcePath ||
      resolve(params.baselinePath) !== saved.baselinePath ||
      sha256Text(canonicalJson(input)) !== saved.hostSnapshotSha256
    ) {
      throw new DeepError(
        "HOST_INPUTS_CHANGED",
        "Project inputs changed; start research in a new job to preserve the reviewed evidence",
      );
    }
    await verifyHostInputs(workspace);
    return workspace;
  }
  const staged = `${root}.preparing-${process.pid}`;
  const clientFiles = existsSync(root) ? readdirSync(root) : [];
  if (
    clientFiles.some(
      (name) => !["client.json", "host-snapshot.json"].includes(name),
    )
  )
    throw new DeepError(
      "HOST_JOB_EXISTS",
      "Choose a fresh job path; existing workspace files are never reset",
    );
  const backup = `${root}.client-setup-${process.pid}`;
  mkdirSync(dirname(root), { recursive: true });
  rmSync(staged, { recursive: true, force: true });
  const s = params.settings;
  const config = ConfigSchema.parse({
    version: 1,
    source: { path: resolve(params.sourcePath) },
    workspace: { path: root },
    gm2godot: { checkout: "", expectedVersions: [input.gm2godotVersion] },
    host: {
      snapshotPath: join(root, "host-snapshot.json"),
      baselinePath: resolve(params.baselinePath),
      maxSeconds: s.budgets?.maxSeconds ?? null,
    },
    godot: { binary: s.godotBinary },
    agent: {
      runtime: s.runtime,
      provider: s.provider?.trim() || null,
      model: s.model?.trim() || null,
      executable: s.executable?.trim() || null,
      endpoint: s.endpoint?.trim() || null,
      freeOnly: s.freeOnly,
      roleOverrides: s.roleOverrides ?? {},
      budgets: configuredBudgets(s),
    },
    concurrency: {
      analysis: s.freeOnly
        ? Math.min(s.analysisWorkers ?? 4, s.freeProviderConcurrency)
        : (s.analysisWorkers ?? 4),
    },
    policy: { allowRemoteSourceUpload: s.allowRemoteSourceUpload },
  });
  try {
    const workspace = createWorkspace(staged, config);
    for (const name of clientFiles)
      copyFileSync(join(root, name), join(staged, name));
    const source = await snapshotSource(
      resolve(params.sourcePath),
      workspace.paths.source,
    );
    writeSnapshotRecord(
      join(workspace.paths.evidenceInventory, "source-snapshot.json"),
      source,
    );
    const baseline = await snapshotSource(
      resolve(params.baselinePath),
      workspace.paths.baseline,
    );
    writeSnapshotRecord(join(staged, "host-baseline.json"), baseline);
    writeJsonAtomic(join(workspace.paths.evidenceInventory, "baseline.json"), {
      schemaVersion: 1,
      baselineId: baseline.snapshotId,
      generatedAt: baseline.createdAt,
      gm2godot: {
        version: input.gm2godotVersion,
        commit: null,
        checkout: "host-managed",
        python: "host-managed",
        pythonVersion: null,
        platform: config.gm2godot.platform,
        groups: config.gm2godot.groups,
        only: config.gm2godot.only,
      },
      exitCode: null,
      state: "host_supplied",
      outcome: "host_supplied",
      summaryLine:
        "Existing converter output supplied by GM2Godot; no conversion was rerun by Deep",
      manifestSha256: null,
      attemptSha256: null,
      generationInventoryFormatVersion: null,
      entryCount: baseline.entries.length,
      preservedGeneration: null,
      reasons: [],
      godotProjectDir: join(root, "baseline"),
      reportsDir: join(root, "baseline", "gm2godot"),
    });
    writeJsonAtomic(join(staged, "host-snapshot.json"), input);
    writeJsonAtomic(join(staged, "host-inputs.json"), {
      sourcePath: resolve(params.sourcePath),
      baselinePath: resolve(params.baselinePath),
      hostSnapshotSha256: sha256Text(canonicalJson(input)),
    });
    if (existsSync(root)) renameSync(root, backup);
    try {
      renameSync(staged, root);
    } catch (error) {
      if (existsSync(backup)) renameSync(backup, root);
      throw error;
    }
    rmSync(backup, { recursive: true, force: true });
    return openWorkspace(root);
  } catch (error) {
    if (existsSync(staged)) thawTree(staged);
    rmSync(staged, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyHostInputs(workspace: Workspace): Promise<void> {
  const baseline = SnapshotRecordSchema.parse(
    readJsonFile(join(workspace.root, "host-baseline.json")),
  );
  const source = SnapshotRecordSchema.parse(
    readJsonFile(
      join(workspace.paths.evidenceInventory, "source-snapshot.json"),
    ),
  );
  await verifySnapshot(workspace.config.source.path, source);
  await verifySnapshot(workspace.paths.source, source);
  await verifySnapshot(baseline.originalSourcePath, baseline);
  await verifySnapshot(workspace.paths.baseline, baseline);
}
