import assert from "node:assert/strict";
import { test } from "node:test";
import { DeepError } from "../../src/util/result.ts";
import type { AgentRuntime } from "../../src/agents/runtime.ts";
import { PatchRecordPayloadSchema } from "../../src/evidence/schemas.ts";
import { assertAllowed, isAllowedWrite, isProtected, PATCH_ERRORS, PROTECTED_PATHS } from "../../src/integration/allowlist.ts";
import { integrateTask } from "../../src/integration/integrator.ts";
import { validateProposedPatch } from "../../src/agents/toolSpecs.ts";
import type { TaskRecord } from "../../src/storage/types.ts";
import { createTestWorkspace, hashBytes, insertTask } from "../helpers/harness.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, reported: false } as const;
const producedBy = { runtime: "mock", simulated: true, promptVersion: "1", schemaVersion: 1, usage } as const;

function assertCode(fn: () => unknown, code: string): DeepError {
  let captured: DeepError | null = null;
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof DeepError, `expected a DeepError, got ${String(error)}`);
    assert.equal(error.code, code);
    captured = error;
    return true;
  });
  assert.ok(captured !== null);
  return captured;
}

function patchPayload(task: TaskRecord, path: string, overrides: Record<string, unknown> = {}) {
  const content = "extends Node\n";
  return PatchRecordPayloadSchema.parse({
    schemaVersion: 1,
    taskId: task.id,
    attempt: 1,
    basePortRevision: 0,
    inputHash: task.inputHash,
    contractVersions: { ...task.contractVersions },
    files: [
      {
        path,
        action: "update",
        preimageSha256: hashBytes("previous"),
        contentSha256: hashBytes(content),
        content,
      },
    ],
    summary: "test patch",
    producedBy,
    ...overrides,
  });
}

test("every PROTECTED_PATHS root is rejected before the task allowlist is consulted", () => {
  const ws = createTestWorkspace("allowlist-protected");
  try {
    // The write allowlist deliberately includes the protected roots, so a rejection can only come
    // from PROTECTED_PATHS being evaluated first.
    const task = insertTask(ws.repo, { id: "task-protected", write: [...PROTECTED_PATHS] });
    const samples: Record<string, string> = {
      "tests/**": "tests/integration/allowlist.test.ts",
      "fixtures/**": "fixtures/gm-projects/counter/Counter.yyp",
      "evidence/**": "evidence/inventory/inventory.json",
      "source/**": "source/scripts/scr_state/scr_state.gml",
      "baseline/**": "baseline/gm2godot/conversion_manifest.json",
      "deep-convert.config.json": "deep-convert.config.json",
      "bin/**": "bin/deep-convert.mjs",
      "src/**": "src/integration/allowlist.ts",
    };
    for (const path of Object.values(samples)) {
      assert.equal(isProtected(path), true, `${path} should be protected`);
      const direct = assertCode(() => assertAllowed(task, path, "update"), PATCH_ERRORS.protectedPath);
      assert.equal(direct.detail["path"], path);
      assertCode(() => assertAllowed(task, path, "delete"), PATCH_ERRORS.protectedPath);
    }
    assert.equal(isProtected("gm2godot/managers/gml_runtime.gd"), false);
    assert.equal(isProtected("testsX/not-protected.gd"), false);
  } finally {
    ws.cleanup();
  }
});

test("a proposed patch that touches a protected path throws GM2DEEP-PATCH-PROTECTED-PATH", () => {
  const ws = createTestWorkspace("allowlist-proposed");
  try {
    const task = insertTask(ws.repo, { id: "task-proposed", write: ["tests/**", "gm2godot/**"] });
    const error = assertCode(
      () =>
        validateProposedPatch(task, {
          schemaVersion: 1,
          files: [
            {
              path: "tests/e2e/offline-workflow.test.ts",
              action: "update",
              preimageSha256: hashBytes("old"),
              contentSha256: hashBytes("weakened"),
              content: "weakened",
            },
          ],
          summary: "weaken the acceptance test",
        }),
      PATCH_ERRORS.protectedPath,
    );
    assert.equal(error.detail["path"], "tests/e2e/offline-workflow.test.ts");

    const outside = assertCode(
      () =>
        validateProposedPatch(task, {
          schemaVersion: 1,
          files: [
            {
              path: "addons/other/not-allowed.gd",
              action: "create",
              preimageSha256: null,
              contentSha256: hashBytes("x"),
              content: "x",
            },
          ],
          summary: "outside the write allowlist",
        }),
      PATCH_ERRORS.outsideAllowlist,
    );
    assert.deepEqual(outside.detail["writeAllowlist"], ["tests/**", "gm2godot/**"]);
  } finally {
    ws.cleanup();
  }
});

test("allowlist containment respects path segments and the delete code is distinct", () => {
  const ws = createTestWorkspace("allowlist-segments");
  try {
    const task = insertTask(ws.repo, { id: "task-segments", write: ["gm2godot/managers/**"] });
    assert.equal(isAllowedWrite(task, "gm2godot/managers/gml_runtime.gd"), true);
    assert.equal(isAllowedWrite(task, "gm2godot/managersX/escape.gd"), false);
    assert.equal(isAllowedWrite(task, "gm2godot"), false);

    assertCode(() => assertAllowed(task, "gm2godot/sounds/boom.wav", "create"), PATCH_ERRORS.outsideAllowlist);
    assertCode(() => assertAllowed(task, "gm2godot/sounds/boom.wav", "delete"), PATCH_ERRORS.deleteOutsideAllowlist);
    assert.doesNotThrow(() => assertAllowed(task, "gm2godot/managers/gml_runtime.gd", "update"));
  } finally {
    ws.cleanup();
  }
});

test("integrateTask rejects a drifted input hash and drifted contract versions as GM2DEEP-PATCH-STALE-INPUT", async () => {
  const ws = createTestWorkspace("allowlist-stale");
  try {
    const task = insertTask(ws.repo, {
      id: "task-stale",
      state: "PLANNED",
      write: ["gm2godot/**"],
      inputHash: "sha256:" + "a".repeat(64),
      contractVersions: { global_state: 1 },
    });
    const runtime: AgentRuntime = {
      id: "mock",
      simulated: true,
      run: () => Promise.reject(new Error("a stale patch must be rejected before the runtime is ever asked to review")),
    };
    const base = {
      workspace: ws.workspace,
      repo: ws.repo,
      task,
      runtime,
      workspaceRoots: {
        source: ws.workspace.paths.source,
        baseline: ws.workspace.paths.baseline,
        port: ws.workspace.paths.port,
        task: ws.workspace.paths.tasks,
        evidence: ws.workspace.paths.evidence,
      },
      credentials: {},
      signal: new AbortController().signal,
      runChecks: async () => [],
    };

    const driftedHash = await integrateTask({
      ...base,
      payload: patchPayload(task, "gm2godot/scripts/scr_state.gd", { inputHash: "sha256:" + "b".repeat(64) }),
      currentContractVersions: { global_state: 1 },
      currentPortRevision: 0,
      expectedInputHash: "sha256:" + "a".repeat(64),
      baselineId: "sha256:" + "c".repeat(64),
      currentBaselineId: "sha256:" + "c".repeat(64),
    });
    assert.equal(driftedHash.state, "rejected");
    assert.equal(driftedHash.reasons.length, 1);
    assert.match(driftedHash.reasons[0] ?? "", /^GM2DEEP-PATCH-STALE-INPUT: unit input hash drifted/);

    const driftedContracts = await integrateTask({
      ...base,
      payload: patchPayload(task, "gm2godot/scripts/scr_state.gd", { contractVersions: { global_state: 2 } }),
      currentContractVersions: { global_state: 1 },
      currentPortRevision: 0,
      expectedInputHash: "sha256:" + "a".repeat(64),
      baselineId: "sha256:" + "c".repeat(64),
      currentBaselineId: "sha256:" + "c".repeat(64),
    });
    assert.equal(driftedContracts.state, "rejected");
    assert.equal(driftedContracts.reasons.length, 1);
    assert.match(driftedContracts.reasons[0] ?? "", /^GM2DEEP-PATCH-STALE-INPUT: contract versions drifted/);

    const driftedBaseline = await integrateTask({
      ...base,
      payload: patchPayload(task, "gm2godot/scripts/scr_state.gd"),
      currentContractVersions: { global_state: 1 },
      currentPortRevision: 0,
      expectedInputHash: "sha256:" + "a".repeat(64),
      baselineId: "sha256:" + "c".repeat(64),
      currentBaselineId: "sha256:" + "d".repeat(64),
    });
    assert.equal(driftedBaseline.state, "rejected");
    assert.match(driftedBaseline.reasons[0] ?? "", /^GM2DEEP-PATCH-STALE-INPUT: baseline drifted/);
  } finally {
    ws.cleanup();
  }
});
