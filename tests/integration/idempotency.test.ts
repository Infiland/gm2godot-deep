import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentRuntime } from "../../src/agents/runtime.ts";
import {
  PatchRecordPayloadSchema,
  type PatchRecordPayload,
} from "../../src/evidence/schemas.ts";
import { integrateTask } from "../../src/integration/integrator.ts";
import { passedInProcessResult } from "../../src/validation/levels.ts";
import type { Repo } from "../../src/storage/repo.ts";
import type { TaskRecord } from "../../src/storage/types.ts";
import {
  createTestWorkspace,
  hashBytes,
  insertTask,
  writeFileEnsured,
} from "../helpers/harness.ts";

const PORT_SCRIPT = "gm2godot/scripts/scr_state.gd";
const BEFORE = "extends Node\n\nfunc tick() -> void:\n\tpass\n";
const AFTER = "extends Node\n\nfunc tick() -> void:\n\tglobal.counter += 1\n";

const unusedRuntime: AgentRuntime = {
  id: "mock",
  simulated: true,
  run: () =>
    Promise.reject(
      new Error("a duplicate integration must be a no-op, not a review"),
    ),
};

function payloadFor(task: TaskRecord, content: string): PatchRecordPayload {
  return PatchRecordPayloadSchema.parse({
    schemaVersion: 1,
    taskId: task.id,
    attempt: 1,
    basePortRevision: 0,
    inputHash: task.inputHash,
    contractVersions: { ...task.contractVersions },
    files: [
      {
        path: PORT_SCRIPT,
        action: "update",
        preimageSha256: hashBytes(BEFORE),
        contentSha256: hashBytes(content),
        content,
      },
    ],
    summary: "tick the counter",
    producedBy: {
      runtime: "mock",
      simulated: true,
      promptVersion: "1",
      schemaVersion: 1,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        costUsd: 0,
        reported: false,
      },
    },
  });
}

function integratingRepo(repo: Repo): {
  integrations: number;
  revision: number;
} {
  // `port_revisions` is seeded with revision 0 as the empty-port baseline, so the *current* revision is
  // the honest count of publications.
  return {
    integrations: repo.listIntegrations().length,
    revision: repo.currentPortRevision(),
  };
}

test("integrating a 907-character task id uses a bounded candidate path", async () => {
  const ws = createTestWorkspace("long-task-id");
  try {
    writeFileEnsured(join(ws.workspace.paths.port, PORT_SCRIPT), BEFORE);
    const task = insertTask(ws.repo, {
      id: `cycle:${"x".repeat(901)}`,
      state: "PLANNED",
      write: ["gm2godot/scripts/**"],
    });
    const payload = payloadFor(task, AFTER);
    let candidateDir = "";
    const deps = {
      workspace: ws.workspace,
      repo: ws.repo,
      task,
      payload,
      currentContractVersions: {},
      currentPortRevision: 0,
      expectedInputHash: task.inputHash,
      baselineId: "sha256:" + "b".repeat(64),
      currentBaselineId: "sha256:" + "b".repeat(64),
      runtime: unusedRuntime,
      workspaceRoots: {
        source: ws.workspace.paths.source,
        baseline: ws.workspace.paths.baseline,
        port: ws.workspace.paths.port,
        task: ws.workspace.paths.tasks,
        evidence: ws.workspace.paths.evidence,
      },
      credentials: {},
      signal: new AbortController().signal,
      runChecks: async (path: string) => {
        candidateDir = path;
        return [
          passedInProcessResult({
            level: "B",
            checkId: "structural-static",
            name: "structural static",
            inputRevision: "r0",
            command: "in-process: on purpose",
            exitStatus: 0,
          }),
        ];
      },
    };
    const result = await integrateTask(deps);
    assert.equal(result.state, "accepted", JSON.stringify(result.reasons));
    assert.ok(candidateDir.length < 1_024);
    assert.ok(candidateDir.includes("~"));
    assert.equal(
      readFileSync(join(ws.workspace.paths.port, PORT_SCRIPT), "utf8"),
      AFTER,
    );
  } finally {
    ws.cleanup();
  }
});

test("integrating the same patch twice publishes once, returns the original row and bumps the revision once", async () => {
  const ws = createTestWorkspace("idempotency");
  try {
    writeFileEnsured(join(ws.workspace.paths.port, PORT_SCRIPT), BEFORE);
    const task = insertTask(ws.repo, {
      id: "task-idem",
      state: "PLANNED",
      write: ["gm2godot/scripts/**"],
    });
    const payload = payloadFor(task, AFTER);
    const checks = () => [
      passedInProcessResult({
        level: "B",
        checkId: "structural-static",
        name: "structural static",
        inputRevision: "r0",
        command: "in-process: on purpose",
        exitStatus: 0,
      }),
    ];
    const deps = {
      workspace: ws.workspace,
      repo: ws.repo,
      task,
      payload,
      currentContractVersions: {},
      currentPortRevision: 0,
      expectedInputHash: task.inputHash,
      baselineId: "sha256:" + "b".repeat(64),
      currentBaselineId: "sha256:" + "b".repeat(64),
      runtime: unusedRuntime,
      workspaceRoots: {
        source: ws.workspace.paths.source,
        baseline: ws.workspace.paths.baseline,
        port: ws.workspace.paths.port,
        task: ws.workspace.paths.tasks,
        evidence: ws.workspace.paths.evidence,
      },
      credentials: {},
      signal: new AbortController().signal,
      runChecks: async () => checks(),
    };

    const first = await integrateTask(deps);
    assert.equal(first.state, "accepted", JSON.stringify(first.reasons));
    assert.equal(first.revision, 1);
    assert.ok(first.integrationId !== null);
    assert.equal(
      readFileSync(join(ws.workspace.paths.port, PORT_SCRIPT), "utf8"),
      AFTER,
    );
    assert.deepEqual(integratingRepo(ws.repo), {
      integrations: 1,
      revision: 1,
    });

    // The port now holds the patch. A second integration of the identical payload must not rebuild a
    // candidate (the pre-image no longer matches) and must not bump the revision again.
    const second = await integrateTask(deps);
    assert.equal(second.state, "accepted");
    assert.equal(second.integrationId, first.integrationId);
    assert.equal(second.revision, first.revision);
    assert.match(second.reasons.join("\n"), /GM2DEEP-PATCH-ALREADY-PUBLISHED/);
    assert.deepEqual(integratingRepo(ws.repo), {
      integrations: 1,
      revision: 1,
    });
    assert.equal(
      readFileSync(join(ws.workspace.paths.port, PORT_SCRIPT), "utf8"),
      AFTER,
    );

    const rows = ws.repo.listIntegrations();
    assert.deepEqual(rows[0]?.files, [PORT_SCRIPT]);
    assert.deepEqual(
      ws.repo.listPortRevisions().map((row) => row.revision),
      [0, 1],
    );
  } finally {
    ws.cleanup();
  }
});
