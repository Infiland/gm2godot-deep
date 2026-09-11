import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { buildToolSpecs, type ToolBuildDeps } from "../../src/agents/toolSpecs.ts";
import { RESULT_TOOL_NAMES } from "../../src/agents/roles.ts";
import { TaskMachine } from "../../src/scheduling/machine.ts";
import { createLogger } from "../../src/util/log.ts";
import { DeepError } from "../../src/util/result.ts";
import { PATCH_ERRORS } from "../../src/integration/allowlist.ts";
import type { ToolContext, ToolSpec } from "../../src/agents/runtime.ts";
import { createTestWorkspace, hashBytes, hashTree, insertTask, minimalInventory, writeFileEnsured } from "../helpers/harness.ts";

const BEFORE = "extends Node\n\nfunc tick() -> void:\n\tpass\n";
const PORT_FILE = "gm2godot/scripts/scr_state.gd";

function proposal(path: string) {
  const content = "extends Node\n\n# tampered\n";
  return {
    schemaVersion: 1,
    files: [
      {
        path,
        action: "update" as const,
        preimageSha256: hashBytes(BEFORE),
        contentSha256: hashBytes(content),
        content,
      },
    ],
    summary: `rewrite ${path}`,
  };
}

test("an implementer cannot modify its own acceptance check or the expected trace; the denial is recorded and the port is untouched", async () => {
  const ws = createTestWorkspace("protected-tests");
  try {
    writeFileEnsured(join(ws.workspace.paths.port, PORT_FILE), BEFORE);
    // The write allowlist deliberately includes the protected roots: the rejection can only come from
    // PROTECTED_PATHS being evaluated first.
    const task = insertTask(ws.repo, {
      id: "task-implementer",
      state: "PLANNED",
      write: ["tests/**", "fixtures/**", "gm2godot/**"],
      acceptanceCheckIds: ["behavioral"],
    });
    const machine = new TaskMachine(ws.repo);
    const context: ToolContext = {
      role: "implementer",
      taskId: task.id,
      workspaceRoots: {
        source: ws.workspace.paths.source,
        baseline: ws.workspace.paths.baseline,
        port: ws.workspace.paths.port,
        task: ws.workspace.paths.tasks,
        evidence: ws.workspace.paths.evidence,
      },
      allowlist: task.allowlist,
      logger: createLogger({ stderr: () => {} }),
      recordPolicyDenial: (detail) => machine.record(task.id, "policy_denied", detail),
      signal: new AbortController().signal,
      attempt: 1,
    };
    const deps: ToolBuildDeps = {
      context,
      task,
      unitId: "script:scr_state",
      unitSourcePaths: ["scripts/scr_state/scr_state.gml"],
      unitGeneratedOutputs: [PORT_FILE],
      converterDiagnostics: [],
      inventory: minimalInventory(),
    };
    const tools = buildToolSpecs("implementer", deps);
    const proposePatch = tools.find((tool): tool is ToolSpec => tool.name === RESULT_TOOL_NAMES.propose_patch);
    assert.ok(proposePatch !== undefined, "the implementer must have a propose_patch tool");

    const portBefore = hashTree(ws.workspace.paths.port);

    const targets = ["tests/e2e/offline-workflow.test.ts", "fixtures/traces/counter_expected.json"];
    for (const target of targets) {
      await assert.rejects(
        () => proposePatch.execute(proposal(target), context),
        (error: unknown) => {
          assert.ok(error instanceof DeepError, `expected a DeepError for ${target}`);
          assert.equal(error.code, PATCH_ERRORS.protectedPath);
          assert.equal(error.detail["path"], target);
          return true;
        },
      );
    }

    const denials = ws.repo.listEvents(task.id).filter((event) => event.kind === "policy_denied");
    assert.equal(denials.length, targets.length, "every denied attempt must be recorded as a policy_denied event");
    const reasons = denials.map((event) => JSON.stringify(event.detail));
    assert.equal(reasons.filter((reason) => reason.includes("offline-workflow.test.ts")).length, 1);
    assert.equal(reasons.filter((reason) => reason.includes("counter_expected.json")).length, 1);
    assert.equal(reasons.filter((reason) => reason.includes(RESULT_TOOL_NAMES.propose_patch)).length, 2);

    // Nothing was written: propose_patch only validates and returns a payload, and both attempts were
    // rejected before any file could be touched.
    assert.deepEqual(hashTree(ws.workspace.paths.port), portBefore);

    const allowed = await proposePatch.execute(proposal(PORT_FILE), context);
    assert.equal(allowed.terminate, true);
    assert.deepEqual(hashTree(ws.workspace.paths.port), portBefore, "even an accepted proposal does not write the port");
  } finally {
    ws.cleanup();
  }
});
