import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeId } from "../../evidence/ids.ts";
import { DeepError } from "../../util/result.ts";
import { nowIso } from "../../util/ids.ts";
import { createLogger, type Logger } from "../../util/log.ts";
import { buildToolSpecs, type ToolBuildDeps } from "../toolSpecs.ts";
import { roleConfig } from "../roles.ts";
import {
  ZERO_USAGE,
  type AgentEventRecord,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRuntime,
  type ToolOutcome,
} from "../runtime.ts";
import {
  MOCK_USAGE,
  mockAnalysis,
  mockPatch,
  mockPlan,
  mockReview,
  type MockFacts,
  type MockPlanInput,
} from "./script.ts";
import type { AgentRoleName } from "../../storage/types.ts";

export interface MockRuntimeDeps {
  readonly transcriptsDir: string;
  /** Everything the deterministic producer needs for one request. */
  readonly factsFor: (request: AgentRunRequest) => {
    toolDeps: ToolBuildDeps;
    facts: MockFacts;
  };
  readonly planInputFor?: (request: AgentRunRequest) => MockPlanInput;
  readonly logger?: Logger;
}

function transcriptPath(
  transcriptsDir: string,
  taskId: string,
  attempt: number,
): string {
  return join(transcriptsDir, `${encodeId(taskId)}.${attempt}.jsonl`);
}

function payloadFor(
  role: AgentRoleName,
  facts: MockFacts,
  deps: MockRuntimeDeps,
  request: AgentRunRequest,
): unknown {
  switch (role) {
    case "analyst":
      return mockAnalysis(facts);
    case "risk_reviewer":
    case "patch_reviewer":
      return mockReview(facts);
    case "reconciler": {
      if (deps.planInputFor === undefined) {
        throw new DeepError(
          "GM2DEEP-MOCK-INCOMPLETE",
          "the mock reconciler needs planInputFor",
        );
      }
      return mockPlan(deps.planInputFor(request));
    }
    case "implementer":
      return mockPatch(facts);
  }
}

/**
 * Deterministic runtime: it drives the real host tool handlers over the real artifacts, then produces its
 * payload from `script.ts`. No model is exercised and no network is touched; every result is labelled
 * `simulated: true` with `usage.reported: false`.
 */
export function createMockRuntime(deps: MockRuntimeDeps): AgentRuntime {
  const logger = (deps.logger ?? createLogger()).asSimulated();

  return {
    id: "mock",
    simulated: true,
    async run(request: AgentRunRequest): Promise<AgentRunResult> {
      if (request.signal.aborted) {
        const events: AgentEventRecord[] = [
          {
            seq: 1,
            at: nowIso(),
            type: "agent_start",
            detail: {
              runtime: "mock",
              role: request.role,
              taskId: request.taskId,
            },
          },
          {
            seq: 2,
            at: nowIso(),
            type: "agent_end",
            detail: { aborted: true },
          },
        ];
        return {
          outcome: "aborted",
          transcriptPath: writeTranscript(
            deps.transcriptsDir,
            request,
            events,
            null,
          ),
          usage: MOCK_USAGE,
          events,
          reason: "run aborted before the first turn",
        };
      }
      const { toolDeps, facts } = deps.factsFor(request);
      const specs = buildToolSpecs(request.role, toolDeps);
      const byName = new Map(specs.map((spec) => [spec.name, spec]));
      const events: AgentEventRecord[] = [];
      const record = (
        type: string,
        detail?: unknown,
        toolName?: string,
      ): void => {
        events.push({
          seq: events.length + 1,
          at: nowIso(),
          type,
          ...(toolName === undefined ? {} : { toolName }),
          ...(detail === undefined ? {} : { detail }),
        });
      };

      record("agent_start", {
        runtime: "mock",
        role: request.role,
        taskId: request.taskId,
      });
      logger.info(
        `mock run: role=${request.role} task=${request.taskId} (deterministic, no model exercised)`,
      );

      // Exercise the real host handlers so a mock run still proves the tool surface works.
      for (const name of [
        "list_unit_files",
        "get_converter_diagnostics",
      ] as const) {
        const spec = byName.get(name);
        if (spec === undefined) continue;
        const outcome: ToolOutcome = await spec.execute({}, toolDeps.context);
        record(
          "tool_execution_end",
          { text: outcome.text.slice(0, 400) },
          name,
        );
      }

      const payload = payloadFor(request.role, facts, deps, request);
      if (request.signal.aborted) {
        record("agent_end", { aborted: true });
        return {
          outcome: "aborted",
          transcriptPath: writeTranscript(
            deps.transcriptsDir,
            request,
            events,
            null,
          ),
          usage: MOCK_USAGE,
          events,
          reason: "run aborted before the result tool was called",
        };
      }
      const parsed = request.resultSchema.safeParse(payload);
      if (!parsed.success) {
        const reason = `mock payload for role ${request.role} failed schema validation: ${parsed.error.issues
          .slice(0, 5)
          .map(
            (issue) => `${issue.path.map(String).join(".")}: ${issue.message}`,
          )
          .join("; ")}`;
        record("agent_end", { error: reason });
        return {
          outcome: "failed",
          transcriptPath: writeTranscript(
            deps.transcriptsDir,
            request,
            events,
            null,
          ),
          usage: MOCK_USAGE,
          events,
          reason,
        };
      }

      const resultTool = roleConfig(request.role).resultTool;
      record("tool_execution_end", { accepted: true }, resultTool);
      record("agent_end", { simulated: true });
      const transcript = writeTranscript(
        deps.transcriptsDir,
        request,
        events,
        parsed.data,
      );
      return {
        outcome: "completed",
        result: parsed.data,
        transcriptPath: transcript,
        usage: { ...ZERO_USAGE, ...MOCK_USAGE },
        events,
      };
    },
  };
}

function writeTranscript(
  transcriptsDir: string,
  request: AgentRunRequest,
  events: readonly AgentEventRecord[],
  result: unknown,
): string {
  const path = transcriptPath(transcriptsDir, request.taskId, request.attempt);
  mkdirSync(transcriptsDir, { recursive: true });
  const lines = [
    JSON.stringify({
      schemaVersion: 1,
      runtime: "mock",
      simulated: true,
      role: request.role,
      taskId: request.taskId,
      attempt: request.attempt,
      promptVersion: "1",
      note: "deterministic mock runtime: no model was exercised",
    }),
    ...events.map((event) => JSON.stringify(event)),
    JSON.stringify({ type: "result", simulated: true, result }),
  ];
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}
