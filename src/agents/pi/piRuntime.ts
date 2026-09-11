import { Agent } from "@earendil-works/pi-agent-core";
import { createModels, type Api, type Model, type MutableModels, type Provider } from "@earendil-works/pi-ai";
import { join } from "node:path";
import type { Config } from "../../config/schema.ts";
import { writeTextAtomic } from "../../util/json.ts";
import type { Logger } from "../../util/log.ts";
import { DeepError } from "../../util/result.ts";
import { redact } from "../events.ts";
import { PROMPT_VERSION } from "../prompts.ts";
import { outcomeFrom, budgetExceeded, type RunLimits } from "../result.ts";
import type { AgentEventRecord, AgentRunRequest, AgentRunResult, AgentRuntime, Usage } from "../runtime.ts";
import { EventRecorder } from "./events.ts";
import { buildAgentTools } from "./tools.ts";

export interface PiRuntimeDeps {
  readonly config: Config;
  /** Host-owned provider credentials, keyed by provider id. Never serialized or logged. */
  readonly credentials: Readonly<Record<string, string>>;
  /** Directory for redacted per-run JSONL transcripts. */
  readonly transcriptsDir: string;
  readonly logger: Logger;
  /** Test seam: a pre-populated `Models` collection (e.g. `fauxProvider`). Defaults to `createModels()`. */
  readonly models?: MutableModels;
}

/** Provider ids become part of a module specifier, so they must not contain path syntax. */
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/i;

function isProvider(value: unknown): value is Provider {
  if (typeof value !== "object" || value === null) return false;
  if (!("id" in value) || typeof value.id !== "string") return false;
  if (!("getModels" in value) || typeof value.getModels !== "function") return false;
  return "stream" in value && typeof value.stream === "function";
}

/**
 * Extract the provider factory's result. Provider modules export one `*Provider()` factory returning a
 * `Provider`; `fauxProvider()` returns a handle whose `.provider` is the `Provider`.
 */
function providerFrom(created: unknown): Provider | undefined {
  if (isProvider(created)) return created;
  if (typeof created === "object" && created !== null && "provider" in created && isProvider(created.provider)) {
    return created.provider;
  }
  return undefined;
}

function providerFactoryIn(module: Record<string, unknown>, providerId: string): () => Provider {
  for (const [name, value] of Object.entries(module)) {
    if (typeof value !== "function" || !name.endsWith("Provider")) continue;
    return () => {
      const provider = providerFrom(value());
      if (provider === undefined) {
        throw new DeepError("GM2DEEP-PI-MODEL-UNRESOLVED", `provider factory "${name}" did not return a Provider`, {
          provider: providerId,
        });
      }
      return provider;
    };
  }
  throw new DeepError("GM2DEEP-PI-MODEL-UNRESOLVED", `no provider factory found in the "${providerId}" module`, {
    provider: providerId,
  });
}

/**
 * Resolve the configured model, registering the provider module lazily on first use. An unknown provider,
 * an unimportable subpath or an unknown model id all raise `GM2DEEP-PI-MODEL-UNRESOLVED` listing what was
 * tried — there is no silent fallback to a default model.
 */
async function resolveModel(config: Config, models: MutableModels, logger: Logger): Promise<Model<Api>> {
  const providerId = config.agent.provider;
  const modelId = config.agent.model;
  const tried: string[] = [];
  if (providerId === null || modelId === null) {
    throw new DeepError("GM2DEEP-PI-MODEL-UNRESOLVED", "agent.provider and agent.model must both be configured", {
      provider: providerId,
      model: modelId,
      tried,
    });
  }
  tried.push(`${providerId}/${modelId}`);
  if (!PROVIDER_ID.test(providerId)) {
    throw new DeepError("GM2DEEP-PI-MODEL-UNRESOLVED", `provider id "${providerId}" is not a valid module name`, {
      provider: providerId,
      model: modelId,
      tried,
    });
  }
  if (models.getProvider(providerId) === undefined) {
    let module: Record<string, unknown>;
    try {
      // The provider subpath is selected by config at runtime, and every provider module registers itself
      // through its own factory; a static import would pull all ~40 provider SDKs into every process.
      module = await import(`@earendil-works/pi-ai/providers/${providerId}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new DeepError("GM2DEEP-PI-MODEL-UNRESOLVED", `provider "${providerId}" is not a built-in provider module`, {
        provider: providerId,
        model: modelId,
        tried,
        cause: detail,
      });
    }
    models.setProvider(providerFactoryIn(module, providerId)());
    logger.info(`pi: registered provider ${providerId}`);
  }
  const model = models.getModel(providerId, modelId);
  if (model === undefined) {
    const available = models.getModels(providerId).map((entry) => entry.id);
    throw new DeepError("GM2DEEP-PI-MODEL-UNRESOLVED", `unknown model "${modelId}" for provider "${providerId}"`, {
      provider: providerId,
      model: modelId,
      tried,
      available: available.slice(0, 200),
    });
  }
  return model;
}

function transcriptPathFor(transcriptsDir: string, taskId: string, attempt: number): string {
  const safe = taskId.replace(/:/g, "%3A").replace(/\//g, "%2F");
  return join(transcriptsDir, `${safe}.${attempt}.jsonl`);
}

interface TranscriptTail {
  readonly outcome: AgentRunResult["outcome"];
  readonly usage: Usage;
  readonly result?: unknown;
  readonly reason?: string;
}

function writeTranscript(
  transcriptsDir: string,
  request: AgentRunRequest,
  config: Config,
  events: readonly AgentEventRecord[],
  tail: TranscriptTail,
): string {
  const path = transcriptPathFor(transcriptsDir, request.taskId, request.attempt);
  const header = redact({
    schemaVersion: 1,
    runtime: "pi",
    simulated: false,
    role: request.role,
    taskId: request.taskId,
    attempt: request.attempt,
    provider: config.agent.provider,
    model: config.agent.model,
    promptVersion: PROMPT_VERSION,
    systemPrompt: request.systemPrompt,
    userPrompt: request.userPrompt,
  });
  const lines = [
    JSON.stringify(header),
    ...events.map((event) => JSON.stringify(event)),
    JSON.stringify(redact({ type: "result", ...tail })),
  ];
  writeTextAtomic(path, lines.join("\n") + "\n");
  return path;
}

/**
 * The real Pi runtime. One `Agent` per run: the SDK has no `close()`, so disposal is
 * `abort()` → `waitForIdle()` → unsubscribe → drop the reference, which the `finally` below performs on
 * every path (success, abort, timeout, provider failure).
 */
export function createPiRuntime(deps: PiRuntimeDeps): AgentRuntime {
  const models = deps.models ?? createModels();
  let modelPromise: Promise<Model<Api>> | null = null;

  return {
    id: "pi",
    simulated: false,
    async run(request: AgentRunRequest): Promise<AgentRunResult> {
      const context = {
        role: request.role,
        taskId: request.taskId,
        workspaceRoots: request.workspaceRoots,
        allowlist: request.allowlist,
        logger: request.logger,
        recordPolicyDenial: request.recordPolicyDenial,
        signal: request.signal,
        attempt: request.attempt,
      };
      const { tools, resultToolName } = buildAgentTools(request.tools, context);
      modelPromise ??= resolveModel(deps.config, models, deps.logger);
      const model = await modelPromise;

      let aborted = false;
      let timedOut = false;
      let overBudget = false;
      let maxTurnsReached = false;
      let failure: string | undefined;
      let recorder: EventRecorder | null = null;

      const agent = new Agent({
        initialState: {
          systemPrompt: request.systemPrompt,
          model,
          tools,
          thinkingLevel: deps.config.agent.thinkingLevel,
        },
        streamFn: models.streamSimple.bind(models),
        getApiKey: (providerId: string) => deps.credentials[providerId],
        toolExecution: "sequential",
        shouldStopAfterTurn: () => {
          if (aborted || timedOut || overBudget) return true;
          if (recorder !== null && recorder.turnCount() >= request.maxTurns) {
            maxTurnsReached = true;
            return true;
          }
          if (recorder !== null && budgetExceeded(recorder.usage(), request.budgets)) {
            overBudget = true;
            return true;
          }
          return false;
        },
      });

      recorder = new EventRecorder(agent, {
        resultToolName,
        onUsage: (usage) => {
          if (budgetExceeded(usage, request.budgets)) {
            overBudget = true;
            agent.abort();
          }
        },
      });
      const recording: EventRecorder = recorder;

      const onAbort = (): void => {
        aborted = true;
        agent.abort();
      };
      const timer = setTimeout(
        () => {
          timedOut = true;
          agent.abort();
        },
        Math.max(1, request.timeoutSeconds) * 1000,
      );

      deps.logger.info(
        `pi run: role=${request.role} task=${request.taskId} attempt=${request.attempt} model=${model.provider}/${model.id}`,
      );
      try {
        if (request.signal.aborted) {
          aborted = true;
        } else {
          request.signal.addEventListener("abort", onAbort, { once: true });
          await agent.prompt(request.userPrompt);
        }
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", onAbort);
        await agent.waitForIdle();
        recording.unsubscribe();
      }

      const usage = recording.usage();
      const captured = recording.hasCaptured() ? recording.captured() : undefined;
      const limits: RunLimits = {
        aborted,
        timedOut,
        tokens: request.budgets.tokens,
        costUsd: request.budgets.costUsd,
      };
      let outcome = outcomeFrom(captured, usage, limits);
      let reason: string | undefined;
      let result: unknown;

      if (failure !== undefined) {
        outcome = "failed";
        reason = `the agent loop threw: ${failure}`;
      } else if (outcome === "timeout") {
        reason = `wall clock exceeded ${request.timeoutSeconds}s`;
      } else if (outcome === "aborted") {
        reason = "run aborted by the caller";
      } else if (outcome === "budget_exceeded") {
        reason = "token or cost ceiling exceeded";
      } else if (outcome === "no_result") {
        const assistantError = recording.assistantError();
        if (assistantError !== undefined) {
          outcome = "failed";
          reason = `the provider reported an error: ${assistantError}`;
        } else if (maxTurnsReached) {
          reason = `max_turns_exceeded (${request.maxTurns})`;
        } else {
          reason = "the model produced no result-tool call";
        }
      }

      if (outcome === "completed") {
        const parsed = request.resultSchema.safeParse(captured);
        if (!parsed.success) {
          outcome = "failed";
          reason = `result failed schema validation: ${parsed.error.issues
            .slice(0, 20)
            .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
            .join("; ")}`;
        } else {
          result = parsed.data;
        }
      }

      const events = recording.events();
      const tail: TranscriptTail = {
        outcome,
        usage,
        ...(result === undefined ? {} : { result }),
        ...(reason === undefined ? {} : { reason }),
      };
      const transcriptPath = writeTranscript(deps.transcriptsDir, request, deps.config, events, tail);
      deps.logger.debug(
        `pi run finished: task=${request.taskId} outcome=${outcome} tokens=${usage.input + usage.output} reported=${usage.reported}`,
      );
      return {
        outcome,
        ...(result === undefined ? {} : { result }),
        transcriptPath,
        usage,
        events,
        ...(reason === undefined ? {} : { reason }),
      };
    },
  };
}
