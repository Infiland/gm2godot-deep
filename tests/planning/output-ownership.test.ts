import assert from "node:assert/strict";
import test from "node:test";
import { planTasks, type TaskPlanningInput } from "../../src/planning/tasks.ts";
import type { AnalysisRecord, PlanRecord } from "../../src/evidence/schemas.ts";
import type { AnalysisUnit } from "../../src/indexing/units.ts";

function input(paths: string[]): TaskPlanningInput {
  const units: AnalysisUnit[] = paths.map((_, i) => ({
    id: `script:s${i}`,
    kind: "script",
    name: `s${i}`,
    sourcePaths: [`scripts/s${i}.gml`],
    sourceHashes: { [`scripts/s${i}.gml`]: "source-hash" },
    generatedOutputs: [],
    analysisRequired: true,
  }));
  return {
    units,
    groups: [],
    analyses: new Map(
      units.map((unit, i) => [
        unit.id,
        {
          strategy: "replace_component",
          plannedOutputs: [
            {
              path: paths[i]!,
              reason: "Converter has no output for this script",
            },
          ],
          acceptanceScenarios: [],
          uncertainties: [],
          blockers: [],
        } as unknown as AnalysisRecord,
      ]),
    ),
    reviews: new Map(),
    dependencies: { edges: [], apiUsage: [], unresolved: [] },
    contracts: [],
    plan: {
      unitStrategies: units.map((unit) => ({
        unitId: unit.id,
        strategy: "replace_component",
        rationale: "Source implementation is absent from the baseline",
      })),
    } as PlanRecord,
    risks: new Map(),
    policy: {
      requireReviewFor: [],
      maxTaskAttempts: 3,
      taskTimeoutSeconds: 60,
      perTaskTokens: 1000,
      perTaskCostUsd: 1,
    },
  };
}

test("a reviewed missing script gets a narrow create allowlist and current candidate read access", () => {
  const planned = planTasks(input(["scripts/new_state.gd"]));
  assert.equal(planned.tasks.length, 1);
  assert.deepEqual(planned.tasks[0]?.allowlist.write, ["scripts/new_state.gd"]);
  assert.ok(
    planned.tasks[0]?.allowlist.read.includes("port:scripts/new_state.gd"),
  );
});
test("conflicting planned outputs and protected paths remain blocked", () => {
  const conflict = planTasks(input(["scripts/shared.gd", "scripts/shared.gd"]));
  assert.equal(conflict.tasks.length, 2);
  assert.ok(
    conflict.tasks.every((task) =>
      task.blockReason?.includes("ownership conflicts"),
    ),
  );
  const escape = planTasks(input(["../escape.gd"]));
  assert.equal(escape.tasks.length, 0);
  assert.equal(escape.blocked.length, 1);
});
