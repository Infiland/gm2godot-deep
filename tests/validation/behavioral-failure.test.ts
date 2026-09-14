import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { generateBaseline } from "../../src/adapters/gm2godot/adapter.ts";
import type { AgentRuntime } from "../../src/agents/runtime.ts";
import { checkGdSyntax } from "../../src/agents/toolSpecs.ts";
import { ZERO_USAGE } from "../../src/agents/runtime.ts";
import { createLogger } from "../../src/util/log.ts";
import { checkBehavioral } from "../../src/validation/behavioral.ts";
import { executedEvidence } from "../../src/validation/levels.ts";
import { runRepairLoop } from "../../src/validation/repair.ts";
import { copyTree } from "../../src/workspaces/staging.ts";
import { thawTree } from "../../src/workspaces/snapshot.ts";
import {
  FIXTURE_EXPECTED_TRACE,
  FIXTURE_PROJECT,
  FIXTURE_SCENARIO,
  GODOT_BINARY,
  GM2GODOT_PYTHON,
  createTestWorkspace,
  readJson,
  type TestWorkspace,
} from "../helpers/harness.ts";

const OBJECT_SCRIPT = "objects/obj_counter/obj_counter.gd";

async function buildCandidate(
  ws: TestWorkspace,
): Promise<{ candidate: string; original: string }> {
  await generateBaseline({
    sourceDir: FIXTURE_PROJECT,
    baselineDir: ws.workspace.paths.baseline,
    stagingRoot: ws.workspace.paths.staging,
    evidenceInventoryDir: ws.workspace.paths.evidenceInventory,
    config: ws.workspace.config,
    python: GM2GODOT_PYTHON,
    toolchain: {
      gm2godotVersion: "0.7.74",
      gm2godotCommit: null,
      pythonVersion: null,
    },
  });
  const candidate = join(ws.workspace.paths.validation, "candidate");
  copyTree(ws.workspace.paths.baseline, candidate);
  thawTree(candidate);
  const original = readFileSync(join(candidate, OBJECT_SCRIPT), "utf8");
  assert.match(
    original,
    /\[counter_step, 1\]/,
    "the generated step handler must contain the increment",
  );
  return { candidate, original };
}

/** A structurally valid edit that keeps the project working but changes the stepped behaviour. */
function defective(original: string): string {
  const content = original.replace(/\[counter_step, 1\]/g, "[counter_step, 2]");
  assert.notEqual(
    content,
    original,
    "the defect must change the generated code",
  );
  checkGdSyntax(OBJECT_SCRIPT, content);
  return content;
}

function behavioralDeps(
  ws: TestWorkspace,
  candidate: string,
  workspaceValidationDir: string,
  checkId = "behavioral-trace",
) {
  return {
    candidateProjectDir: candidate,
    scenarioSourcePath: FIXTURE_SCENARIO,
    expectedTracePath: FIXTURE_EXPECTED_TRACE,
    workspaceValidationDir,
    godotBinary: GODOT_BINARY,
    timeoutSeconds: ws.workspace.config.godot.timeoutSeconds,
    inputRevision: "port@0",
    checkId,
    expectedGodot: {
      expectedVersion: ws.workspace.config.godot.expectedVersion,
      expectedVersionPrefix: ws.workspace.config.godot.expectedVersionPrefix,
    },
  };
}

const fakeRuntime: AgentRuntime = {
  id: "mock",
  simulated: true,
  run: (request) =>
    Promise.resolve({
      outcome: "completed",
      result: { taskId: request.taskId },
      transcriptPath: "",
      usage: ZERO_USAGE,
      events: [],
    }),
};

test(
  "a behaviourally wrong patch fails level D, the repair loop accepts the corrective patch, and a zero repair budget blocks",
  {
    skip:
      process.env["DEEP_INTEGRATION"] === "1" && GM2GODOT_PYTHON && GODOT_BINARY
        ? false
        : "requires explicit checkout, Python, Godot and DEEP_INTEGRATION=1",
  },
  async () => {
    const ws = createTestWorkspace("behavioral-failure");
    try {
      const { candidate, original } = await buildCandidate(ws);
      writeFileSync(
        join(candidate, OBJECT_SCRIPT),
        defective(original),
        "utf8",
      );

      // The differing behaviour is the only defect: the project boots, prints a trace, and differs.
      const failed = await checkBehavioral(
        behavioralDeps(
          ws,
          candidate,
          join(ws.workspace.paths.validation, "initial"),
        ),
      );
      assert.equal(failed.state, "failed", failed.reason ?? "");
      assert.equal(failed.level, "D");
      assert.match(failed.reason ?? "", /differs from the expectation/);
      assert.match(failed.reason ?? "", /provenance: synthetic/);
      assert.ok(
        executedEvidence(failed) !== null,
        "a failed level D check must still record what ran",
      );
      const diff = readJson<{ differences: unknown[] }>(
        join(
          ws.workspace.paths.validation,
          "initial",
          "behavioral-trace.diff.json",
        ),
      );
      assert.ok(
        diff.differences.length > 0,
        "the failing check must record the per-event differences",
      );

      const workspaceRoots = {
        source: ws.workspace.paths.source,
        baseline: ws.workspace.paths.baseline,
        port: candidate,
        task: ws.workspace.paths.tasks,
        evidence: ws.workspace.paths.evidence,
      };
      const applyAttempt = (attempt: number): void => {
        // Attempt 0 submits the wrong patch; the repair attempt restores the recorded behaviour.
        writeFileSync(
          join(candidate, OBJECT_SCRIPT),
          attempt === 0 ? defective(original) : original,
          "utf8",
        );
      };
      const loopDeps = (maxRepairAttempts: number) => ({
        maxRepairAttempts,
        candidateWorkspace: candidate,
        runtime: fakeRuntime,
        implementerRequest: (context: { attempt: number }) => ({
          role: "implementer" as const,
          taskId: "task-behavioral",
          systemPrompt: "test",
          userPrompt: `attempt ${String(context.attempt)}`,
          tools: [],
          workspaceRoots,
          allowlist: { read: [], write: [OBJECT_SCRIPT] },
          resultSchema: z.unknown(),
          maxTurns: 5,
          timeoutSeconds: 30,
          budgets: { tokens: null, costUsd: null },
          signal: new AbortController().signal,
          credentials: {},
          attempt: context.attempt + 1,
          logger: createLogger({ stderr: () => {} }),
          recordPolicyDenial: () => {},
        }),
        applyResult: async (context: { attempt: number }) => {
          applyAttempt(context.attempt);
        },
        validate: async (attempt: number) => [
          await checkBehavioral(
            behavioralDeps(
              ws,
              candidate,
              join(ws.workspace.paths.validation, `repair-${String(attempt)}`),
              "behavioral-trace",
            ),
          ),
        ],
      });

      const repaired = await runRepairLoop(loopDeps(2));
      assert.equal(repaired.state, "accepted", repaired.blockReason ?? "");
      assert.equal(
        repaired.repairAttempts,
        1,
        "one repair attempt corrected the behaviour",
      );
      assert.equal(repaired.evidence[0]?.state, "passed");
      assert.match(
        repaired.evidence[0]?.reason ?? "",
        /match the expectation exactly/,
      );
      assert.equal(
        repaired.evidence[0]?.artifacts.includes(FIXTURE_EXPECTED_TRACE),
        true,
      );

      // With no repair budget the run must stop at BLOCKED carrying the failing check, not rewrite again.
      writeFileSync(join(candidate, OBJECT_SCRIPT), original, "utf8");
      const blocked = await runRepairLoop(loopDeps(0));
      assert.equal(blocked.state, "blocked");
      assert.equal(blocked.repairAttempts, 0);
      assert.match(blocked.blockReason ?? "", /repair budget exhausted/);
      assert.equal(blocked.evidence.length, 1);
      assert.equal(blocked.evidence[0]?.checkId, "behavioral-trace");
      assert.equal(blocked.evidence[0]?.state, "failed");
      assert.match(
        blocked.evidence[0]?.reason ?? "",
        /differs from the expectation/,
      );
      assert.equal(
        blocked.diagnoses.length,
        0,
        "a zero budget must not record a repair diagnosis",
      );
    } finally {
      ws.cleanup();
    }
  },
);
