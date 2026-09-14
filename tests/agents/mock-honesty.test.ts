import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { z } from "zod";
import { createMockRuntime } from "../../src/agents/mock/mockRuntime.ts";
import type { MockFacts } from "../../src/agents/mock/script.ts";
import {
  buildToolSpecs,
  ImplementerSubmissionSchema,
  type ToolBuildDeps,
} from "../../src/agents/toolSpecs.ts";
import { ROLE_CONFIGS } from "../../src/agents/roles.ts";
import type {
  AgentRoleName,
  AgentRunRequest,
  ToolContext,
} from "../../src/agents/runtime.ts";
import { writeAnalysis } from "../../src/evidence/store.ts";
import {
  AnalysisRecordSchema,
  PlanRecordSchema,
  ReviewRecordSchema,
  type AnalysisRecord,
  type ProducedBy,
} from "../../src/evidence/schemas.ts";
import {
  producedByFor,
  type PipelineOptions,
} from "../../src/scheduling/pipeline.ts";
import { writeReport, runtimeLine } from "../../src/evidence/report.ts";
import { createLogger } from "../../src/util/log.ts";
import type { AnalysisUnit } from "../../src/indexing/units.ts";
import {
  createTestWorkspace,
  hashBytes,
  insertTask,
  minimalInventory,
  readJson,
} from "../helpers/harness.ts";

const SOURCE_PATH = "scripts/scr_math/scr_math.gml";
const SOURCE_TEXT = "function scr_math_add(a, b) {\n    return a + b;\n}\n";

const UNIT: AnalysisUnit = {
  id: "script:scr_math",
  kind: "script",
  name: "scr_math",
  sourcePaths: [SOURCE_PATH],
  sourceHashes: { [SOURCE_PATH]: hashBytes(SOURCE_TEXT) },
  generatedOutputs: [],
  analysisRequired: true,
};

const FACTS: MockFacts = {
  unit: UNIT,
  baselineId: null,
  sourceSnapshotId: `sha256:${"0".repeat(64)}`,
  sourceFiles: [
    {
      path: SOURCE_PATH,
      sha256: hashBytes(SOURCE_TEXT),
      lines: SOURCE_TEXT.split("\n"),
    },
  ],
  generatedOutputs: [],
  converterDiagnostics: [],
  dependencies: { edges: [], apiUsage: [], unresolved: [] },
  hazards: [],
  apiUsage: [],
  unresolved: [],
  risk: { level: "low", reasons: [] },
  strategy: "retain_generated",
  contractVersions: { global_state: 1 },
  writeAllowlist: [],
  portFiles: {},
  attempt: 1,
};

test("the mock runtime labels every record simulated and the mock report claims no model or engine ran", async () => {
  const ws = createTestWorkspace("mock-honesty");
  try {
    const task = insertTask(ws.repo, {
      id: "task-mock",
      write: ["gm2godot/scripts/**"],
    });
    const context: ToolContext = {
      role: "analyst",
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
      recordPolicyDenial: () => {},
      signal: new AbortController().signal,
      attempt: 1,
    };
    const toolDeps: ToolBuildDeps = {
      context,
      task,
      unitId: UNIT.id,
      unitSourcePaths: UNIT.sourcePaths,
      unitGeneratedOutputs: [],
      converterDiagnostics: [],
      inventory: minimalInventory(),
    };
    const runtime = createMockRuntime({
      transcriptsDir: ws.workspace.paths.transcripts,
      factsFor: () => ({ toolDeps, facts: FACTS }),
      planInputFor: () => ({
        unitIds: [UNIT.id],
        strategies: { [UNIT.id]: "retain_generated" },
        contracts: [],
      }),
      logger: createLogger({ stderr: () => {} }),
    });
    assert.equal(runtime.id, "mock");
    assert.equal(runtime.simulated, true);

    const options: PipelineOptions = {
      workspace: ws.workspace,
      repo: ws.repo,
      logger: createLogger({ stderr: () => {} }),
      through: "analyze",
      execute: false,
      maxWorkers: null,
      taskFilter: [],
      allowStaleBaseline: false,
      signal: new AbortController().signal,
    };

    const schemas: Record<AgentRoleName, z.ZodTypeAny> = {
      analyst: AnalysisRecordSchema.omit({
        unitId: true,
        unitKind: true,
        sourceSnapshotId: true,
        baselineId: true,
        generatedOutputs: true,
        producedBy: true,
      }),
      risk_reviewer: ReviewRecordSchema.omit({
        unitId: true,
        producedBy: true,
      }),
      patch_reviewer: ReviewRecordSchema.omit({
        unitId: true,
        producedBy: true,
      }),
      reconciler: PlanRecordSchema.omit({
        version: true,
        createdAt: true,
        producedBy: true,
      }),
      implementer: ImplementerSubmissionSchema,
    };
    const roles: AgentRoleName[] = [
      "analyst",
      "risk_reviewer",
      "reconciler",
      "implementer",
    ];

    const producedByRuntimes = new Set<string>();
    for (const role of roles) {
      const request: AgentRunRequest = {
        role,
        taskId: task.id,
        systemPrompt: "mock",
        userPrompt: "mock",
        tools: buildToolSpecs(role, toolDeps),
        workspaceRoots: context.workspaceRoots,
        allowlist: task.allowlist,
        resultSchema: schemas[role],
        maxTurns: ROLE_CONFIGS[role].maxTurns,
        timeoutSeconds: 60,
        budgets: { tokens: null, costUsd: null },
        signal: new AbortController().signal,
        credentials: {},
        attempt: 1,
        logger: options.logger,
        recordPolicyDenial: () => {},
      };
      const result = await runtime.run(request);
      assert.equal(
        result.outcome,
        "completed",
        `${role}: ${result.reason ?? ""}`,
      );
      assert.equal(
        result.usage.reported,
        false,
        `${role} must not claim provider-reported usage`,
      );
      assert.equal(result.usage.costUsd, 0);

      const producedBy: ProducedBy = producedByFor(options, result.usage);
      assert.equal(
        producedBy.runtime,
        "mock",
        `${role} record must be labelled runtime mock`,
      );
      assert.equal(
        producedBy.simulated,
        true,
        `${role} record must be labelled simulated`,
      );
      assert.equal(producedBy.usage.reported, false);
      assert.equal(
        runtimeLine({ ...producedBy, provider: null, model: null }),
        "mock (deterministic, no model exercised)",
      );
      producedByRuntimes.add(producedBy.runtime);

      const transcript = readFileSync(result.transcriptPath, "utf8");
      assert.match(transcript, /"simulated":true/);
      assert.match(transcript, /"runtime":"mock"/);
      assert.doesNotMatch(transcript, /provider|apiKey|"model"/);
    }
    assert.deepEqual([...producedByRuntimes], ["mock"]);

    // A real analysis record stamped by the host, then rendered: the report must say the mock ran and
    // must carry no line that claims a model or an engine was exercised.
    const analystResult = await runtime.run({
      role: "analyst",
      taskId: task.id,
      systemPrompt: "mock",
      userPrompt: "mock",
      tools: [],
      workspaceRoots: context.workspaceRoots,
      allowlist: task.allowlist,
      resultSchema: schemas.analyst,
      maxTurns: 40,
      timeoutSeconds: 60,
      budgets: { tokens: null, costUsd: null },
      signal: new AbortController().signal,
      credentials: {},
      attempt: 1,
      logger: options.logger,
      recordPolicyDenial: () => {},
    });
    const record: AnalysisRecord = AnalysisRecordSchema.parse({
      ...(analystResult.result as Record<string, unknown>),
      unitId: UNIT.id,
      unitKind: UNIT.kind,
      sourceSnapshotId: FACTS.sourceSnapshotId,
      baselineId: FACTS.baselineId,
      generatedOutputs: [],
      producedBy: producedByFor(options, analystResult.usage),
    });
    writeAnalysis(ws.workspace.paths.evidenceAnalyses, record);

    const written = await writeReport({
      workspace: ws.workspace,
      repo: ws.repo,
      logger: options.logger,
    });
    const report = readJson<{
      adapters: { runtimeLines: string[] };
      versions: {
        agentArtifacts: {
          runtime: string;
          simulated: boolean;
          provider: string | null;
          model: string | null;
        }[];
      };
      usage: { artifacts: { reported: boolean } };
    }>(written.jsonPath);
    assert.deepEqual(report.adapters.runtimeLines, [
      "mock (deterministic, no model exercised)",
    ]);
    assert.equal(report.versions.agentArtifacts.length, 1);
    assert.equal(report.versions.agentArtifacts[0]?.runtime, "mock");
    assert.equal(report.versions.agentArtifacts[0]?.simulated, true);
    assert.equal(report.versions.agentArtifacts[0]?.provider, null);
    assert.equal(report.versions.agentArtifacts[0]?.model, null);
    assert.equal(report.usage.artifacts.reported, false);
    assert.match(
      written.markdown,
      /mock \(deterministic, no model exercised\)/,
    );
    assert.doesNotMatch(written.markdown, /provider=[A-Za-z]/);
    assert.doesNotMatch(written.markdown, /\(real, provider=/);
  } finally {
    ws.cleanup();
  }
});
