import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { DeepError } from "../../util/result.ts";
import { writeTextAtomic } from "../../util/json.ts";
import { encodeId } from "../../evidence/ids.ts";
import { redact } from "../events.ts";
import {
  ZERO_USAGE,
  type AgentRuntime,
  type AgentRunRequest,
  type AgentRunResult,
  type Usage,
  type ToolContext,
  type AgentEventRecord,
} from "../runtime.ts";
import { budgetExceeded } from "../result.ts";
import { TransportFailure } from "./transport.ts";
import type { AgentTransport } from "./transport.ts";
import { OpenCodeClient } from "./opencode.ts";
import { modelCacheDirectory } from "../../models/cache.ts";
import { verifyZenCatalog } from "../../models/zenCatalog.ts";
import { isVerifiedFree, isAutomaticModel } from "../../models/freePolicy.ts";
import {
  evaluateFreeModels,
  rankForRole,
  EvaluationAnswerSchema,
} from "../../models/evaluation.ts";
const ActionSchema = z.strictObject({
  tool: z.string().min(1),
  argsJson: z.string(),
});
export const ACTION_JSON_SCHEMA = z.toJSONSchema(ActionSchema) as Record<
  string,
  unknown
>;
function merge(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    costUsd: a.costUsd + b.costUsd,
    reported: a.reported || b.reported,
  };
}
export interface RelayOptions {
  id: "codex" | "claude" | "opencode";
  provider: string | null;
  model: string | null;
  freeOnly: boolean;
  transcriptsDir: string;
  create: (cwd: string) => AgentTransport;
}
export function createRelayRuntime(options: RelayOptions): AgentRuntime {
  return {
    id: options.id,
    simulated: false,
    run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
      const cwd = mkdtempSync(join(tmpdir(), "gm2deep-agent-"));
      const transport = options.create(cwd);
      const signal = AbortSignal.any([
        request.signal,
        AbortSignal.timeout(request.timeoutSeconds * 1000),
      ]);
      let usage = ZERO_USAGE;
      let usageUncertain = false;
      let result: unknown;
      let outcome: AgentRunResult["outcome"] = "no_result";
      let reason: string | undefined;
      const events: AgentEventRecord[] = [];
      const record = (type: string, detail?: unknown): void => {
        events.push({
          seq: events.length + 1,
          at: new Date().toISOString(),
          type,
          ...(detail === undefined ? {} : { detail: redact(detail) }),
        });
      };
      const context: ToolContext = { ...request, signal };
      let model = options.model;
      let provider = options.provider;
      let candidates: string[] = [];
      try {
        if (options.freeOnly) {
          if (!(transport instanceof OpenCodeClient))
            throw new Error(
              "Free-only selection requires OpenCode Zen; no paid fallback is permitted",
            );
          const catalog = await verifyZenCatalog(
            await transport.catalog(signal),
            signal,
          );
          const evaluated = await evaluateFreeModels({
            models: catalog,
            cacheDir: modelCacheDirectory(),
            ...(options.model ? { preferredModel: options.model } : {}),
            signal,
            run: async (candidate, test, caseSignal) => {
              const admit = (): void => {
                caseSignal.throwIfAborted();
                if (
                  budgetExceeded(usage, request.budgets) ||
                  (request.budgets.tokens !== null &&
                    request.budgets.tokens - usage.input - usage.output < 2048)
                )
                  throw new Error(
                    "Insufficient token budget for a bounded model evaluation case",
                  );
              };
              admit();
              const firstCatalog = await verifyZenCatalog(
                await transport.catalog(caseSignal),
                caseSignal,
              );
              if (
                !firstCatalog.some(
                  (m) => m.id === candidate.id && isVerifiedFree(m),
                )
              )
                throw new Error("Free eligibility changed before evaluation");
              // Prove a source-tool request before scoring the answer. No project content is sent.
              const first = await transport
                .complete({
                  system:
                    "Return one JSON host tool action. First call read_source with argsJson {} to inspect the fixture. Native tools are unavailable.",
                  prompt: test.question,
                  model: candidate.id,
                  provider: candidate.provider,
                  schema: ACTION_JSON_SCHEMA,
                  signal: caseSignal,
                  maxTokens: 512,
                })
                .catch((error) => {
                  if (error instanceof TransportFailure)
                    usage = merge(usage, error.usage);
                  if (
                    !(error instanceof TransportFailure) ||
                    !error.usage.reported
                  )
                    usageUncertain = true;
                  throw error;
                });
              usage = merge(usage, first.usage);
              if (!first.usage.reported) usageUncertain = true;
              admit();
              const action = ActionSchema.parse(first.value);
              if (
                action.argsJson !== "{}" &&
                Object.keys(JSON.parse(action.argsJson)).length > 0
              )
                return { answer: null, toolUsed: false };
              if (action.tool !== "read_source")
                return { answer: null, toolUsed: false };
              const latest = (
                await verifyZenCatalog(
                  await transport.catalog(caseSignal),
                  caseSignal,
                )
              ).find(
                (m) =>
                  m.id === candidate.id && m.provider === candidate.provider,
              );
              if (!latest || !isVerifiedFree(latest))
                throw new Error(
                  "Free model eligibility changed during evaluation",
                );
              const answer = await transport
                .complete({
                  system:
                    "Use only this synthetic source. Return the requested facts, citations {path,line} to source paths, and uncertain boolean.",
                  prompt: `${test.question}\nread_source returned:\n${test.source}`,
                  model: candidate.id,
                  provider: candidate.provider,
                  schema: z.toJSONSchema(EvaluationAnswerSchema) as Record<
                    string,
                    unknown
                  >,
                  signal: caseSignal,
                  maxTokens: 1024,
                })
                .catch((error) => {
                  if (error instanceof TransportFailure)
                    usage = merge(usage, error.usage);
                  if (
                    !(error instanceof TransportFailure) ||
                    !error.usage.reported
                  )
                    usageUncertain = true;
                  throw error;
                });
              usage = merge(usage, answer.usage);
              if (!answer.usage.reported) usageUncertain = true;
              admit();
              return { answer: answer.value, toolUsed: true };
            },
          });
          candidates = rankForRole(evaluated, request.role).map((r) => r.model);
          record("model_evaluation", evaluated);
          if (!candidates.length)
            throw new Error(
              "No verified free model passed evaluation. Research is paused; select another provider or retry later.",
            );
          const automatic = isAutomaticModel(options.model);
          if (!automatic && !candidates.includes(options.model!))
            throw new Error(
              "The selected model is not an eligible passing free model",
            );
          model = automatic ? (candidates[0] ?? null) : options.model;
          if (!automatic)
            candidates = [
              model!,
              ...candidates.filter((candidate) => candidate !== model),
            ];
          provider = "opencode";
        }
        if (!model) throw new Error("Select a model before starting an agent");
        const toolDefinitions = request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: z.toJSONSchema(t.schema),
        }));
        const system = `${request.systemPrompt}\n\nYou communicate using a host tool relay. Return exactly {\"tool\":\"name\",\"argsJson\":\"JSON object encoded as a string\"} for one available tool per response. The host executes tools and sends results. Native tools are disabled. Only the final result tool ends the task. Available host tools:\n${JSON.stringify(toolDefinitions)}`;
        let history = request.userPrompt;
        for (let turn = 0; turn < request.maxTurns; turn++) {
          signal.throwIfAborted();
          if (budgetExceeded(usage, request.budgets)) {
            outcome = "budget_exceeded";
            reason = "Task usage budget exceeded";
            break;
          }
          if (options.freeOnly && transport instanceof OpenCodeClient) {
            const latest = await verifyZenCatalog(
              await transport.catalog(signal),
              signal,
            );
            const eligible = candidates.filter((id) =>
              latest.some((m) => m.id === id && isVerifiedFree(m)),
            );
            if (!model || !eligible.includes(model))
              model = eligible[0] ?? null;
            if (!model)
              throw new Error(
                "No eligible free candidate remains; job must pause",
              );
          }
          const remaining =
            request.budgets.tokens === null
              ? 8192
              : Math.max(
                  1,
                  request.budgets.tokens - usage.input - usage.output,
                );
          const estimatedInput = Math.ceil(
            (system.length + history.length) / 3,
          );
          if (
            request.budgets.tokens !== null &&
            estimatedInput + 512 > remaining
          ) {
            outcome = "budget_exceeded";
            reason =
              "Estimated next input exceeds the remaining task token budget";
            break;
          }
          const outputAllowance = Math.min(
            8192,
            Math.max(1, remaining - estimatedInput),
          );
          const completion = await transport
            .complete({
              system,
              prompt: history,
              model,
              provider,
              schema: ACTION_JSON_SCHEMA,
              signal,
              maxTokens: outputAllowance,
            })
            .catch(async (error) => {
              if (
                !(error instanceof TransportFailure) ||
                !error.usage.reported ||
                signal.aborted
              )
                usageUncertain = true;
              if (error instanceof TransportFailure) {
                usage = merge(usage, error.usage);
                if (budgetExceeded(usage, request.budgets))
                  throw new Error(
                    "Task budget exhausted by failed model response",
                  );
              }
              if (!options.freeOnly || !(transport instanceof OpenCodeClient))
                throw new Error(
                  "Agent completion failed after reported usage was recorded",
                );
              candidates = candidates.filter((id) => id !== model);
              const live = await verifyZenCatalog(
                await transport.catalog(signal),
                signal,
              );
              model =
                candidates.find((id) =>
                  live.some((m) => m.id === id && isVerifiedFree(m)),
                ) ?? null;
              if (!model)
                throw new Error(
                  "Free models exhausted; no paid fallback permitted",
                );
              return transport.complete({
                system,
                prompt: history,
                model,
                provider,
                schema: ACTION_JSON_SCHEMA,
                signal,
                maxTokens: outputAllowance,
              });
            });
          usage = merge(usage, completion.usage);
          if (!completion.usage.reported) usageUncertain = true;
          record("model_response", {
            provider,
            model,
            usage: completion.usage,
          });
          if (budgetExceeded(usage, request.budgets)) {
            outcome = "budget_exceeded";
            reason = "Task usage budget exceeded";
            break;
          }
          const action = ActionSchema.parse(completion.value);
          const tool = request.tools.find((t) => t.name === action.tool);
          if (!tool) {
            request.recordPolicyDenial({
              tool: action.tool,
              reason: "Tool is outside the host allowlist",
            });
            throw new Error("Agent requested an unavailable tool");
          }
          try {
            const args = tool.schema.parse(JSON.parse(action.argsJson));
            const reply = await tool.execute(args, context);
            record("tool_result", { tool: tool.name, details: reply.details });
            if (reply.terminate) {
              result = request.resultSchema.parse(reply.details);
              outcome = "completed";
              break;
            }
            history += `\nAssistant action: ${JSON.stringify(action)}\nHost tool result:\n${reply.text}\nMetadata: ${JSON.stringify(reply.details ?? null)}`;
          } catch (error) {
            record("tool_error", { tool: tool.name });
            const detail =
              error instanceof DeepError
                ? error.message.slice(0, 2000)
                : "Tool argument validation or execution failed";
            history += `\nTool ${tool.name} failed: ${detail}. Correct the arguments or record uncertainty.`;
          }
          if (history.length > 2_000_000)
            throw new Error(
              "Host conversation context exceeded the bounded size; split the research unit",
            );
        }
      } catch (error) {
        if (error instanceof TransportFailure) {
          usage = merge(usage, error.usage);
          if (!error.usage.reported || signal.aborted) usageUncertain = true;
        }
        outcome = signal.aborted
          ? request.signal.aborted
            ? "aborted"
            : "timeout"
          : "failed";
        reason = signal.aborted
          ? "Agent stopped by cancellation or task timeout"
          : error instanceof Error
            ? error.message
            : "Agent runtime failed";
      } finally {
        await transport.close();
        rmSync(cwd, { recursive: true, force: true });
      }
      const transcriptPath = join(
        options.transcriptsDir,
        `${encodeId(request.taskId)}.${request.attempt}.jsonl`,
      );
      // Do not serialize provider stdout, errors, prompts, environment or credentials.
      writeTextAtomic(
        transcriptPath,
        [
          {
            schemaVersion: 1,
            runtime: options.id,
            simulated: false,
            taskId: request.taskId,
            role: request.role,
            provider,
            model,
          },
          ...events,
          { type: "result", outcome, usage },
        ]
          .map((v) => JSON.stringify(redact(v)))
          .join("\n") + "\n",
      );
      return {
        outcome,
        transcriptPath,
        provenance: { runtime: options.id, provider, model },
        usage,
        usageUncertain,
        events,
        ...(result === undefined ? {} : { result }),
        ...(reason === undefined ? {} : { reason }),
      };
    },
  };
}
