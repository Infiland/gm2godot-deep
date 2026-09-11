import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { createModels, type MutableModels, type Provider } from "@earendil-works/pi-ai";
import { createPiRuntime } from "../../src/agents/pi/piRuntime.ts";
import { ConfigSchema, type Config } from "../../src/config/schema.ts";
import { createLogger } from "../../src/util/log.ts";
import type { AgentRunRequest, AgentRunResult, ToolSpec } from "../../src/agents/runtime.ts";
import { createTestWorkspace } from "../helpers/harness.ts";

const INTEGRATION = process.env["DEEP_INTEGRATION"] === "1";

interface Credential {
  readonly provider: string;
  readonly apiKey: string;
}

/** Providers cheaper to exercise first; anything else in the store follows in declaration order. */
const PROVIDER_ORDER = ["deepseek", "google", "openrouter", "opencode"];

/**
 * Read the host-owned credential store. The values never leave this function except as the API key.
 * `PI_CODING_AGENT_DIR` is honoured when it holds a store, and the documented default is used otherwise.
 */
function resolveCredentials(): readonly Credential[] | string {
  const override = process.env["PI_CODING_AGENT_DIR"];
  const candidates = [...(override === undefined ? [] : [override]), join(homedir(), ".pi", "agent")];
  const paths = candidates.map((directory) => join(directory, "auth.json"));
  const file = paths.find((path) => existsSync(path));
  if (file === undefined) return `no credential store at ${paths.join(" or ")}`;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, { key?: unknown }>;
  const preferred = process.env["DEEP_PI_PROVIDER"];
  const withKeys = Object.keys(parsed).filter((provider) => typeof parsed[provider]?.key === "string");
  const order = [
    ...(preferred === undefined ? [] : [preferred]),
    ...PROVIDER_ORDER.filter((provider) => withKeys.includes(provider)),
    ...withKeys.filter((provider) => !PROVIDER_ORDER.includes(provider)),
  ];
  const credentials = [...new Set(order)]
    .map((provider) => ({ provider, apiKey: parsed[provider]?.key }))
    .filter((entry): entry is Credential => typeof entry.apiKey === "string" && entry.apiKey.length > 0);
  return credentials.length === 0 ? `no provider credential with an API key resolved in ${file}` : credentials;
}

const CREDENTIALS = INTEGRATION ? resolveCredentials() : "DEEP_INTEGRATION is not set";
const SKIP = typeof CREDENTIALS === "string" ? CREDENTIALS : false;

/** Register the runtime-selected provider module and pick a small, cheap model from it. */
async function pickModel(providerId: string, models: MutableModels): Promise<string> {
  const module = (await import(`@earendil-works/pi-ai/providers/${providerId}`)) as Record<string, unknown>;
  for (const [name, value] of Object.entries(module)) {
    if (typeof value !== "function" || !name.endsWith("Provider")) continue;
    const created = value() as unknown;
    const candidate = (created as { provider?: unknown }).provider ?? created;
    if (candidate !== null && typeof candidate === "object" && "getModels" in candidate) {
      models.setProvider(candidate as Provider);
    }
  }
  const ids = models.getModels(providerId).map((model) => model.id);
  assert.ok(ids.length > 0, `provider ${providerId} exposed no models`);
  const cheap = ids.find((id) => /flash|haiku|mini|chat/i.test(id) && !/reasoning|thinking/i.test(id));
  return process.env["DEEP_PI_MODEL"] ?? cheap ?? (ids[0] as string);
}

const readSchema = z.strictObject({ unitId: z.string().min(1) });
const submitSchema = z.strictObject({ note: z.string().min(1) });

const READ_TOOL: ToolSpec = {
  name: "list_unit_files",
  description: "List the source files of a unit. Call this before submitting.",
  schema: readSchema,
  execute: (args) => {
    const { unitId } = readSchema.parse(args);
    return Promise.resolve({
      text: `${unitId} is composed of scripts/scr_math/scr_math.gml and scripts/scr_math/scr_math.yy`,
      details: { unitId, fileCount: 2 },
    });
  },
};
const SUBMIT_TOOL: ToolSpec = {
  name: "submit_analysis",
  description: "Submit the one-sentence note and end the conversation.",
  schema: submitSchema,
  execute: (args) => Promise.resolve({ text: "accepted", details: args, terminate: true }),
};

function requestFor(workspace: { source: string; baseline: string; port: string; task: string; evidence: string }, credential: Credential): AgentRunRequest {
  return {
    role: "analyst",
    taskId: "pi-real",
    systemPrompt:
      'You are testing the host tool surface. First call list_unit_files with unitId "script:scr_math". Then call submit_analysis with a one-sentence note about the unit. Do not answer in prose; the tools are the only output channel.',
    userPrompt: "Analyse unit script:scr_math. Use the tools and then submit.",
    tools: [READ_TOOL, SUBMIT_TOOL],
    workspaceRoots: workspace,
    allowlist: { read: [], write: [] },
    resultSchema: submitSchema,
    maxTurns: 8,
    timeoutSeconds: 300,
    budgets: { tokens: null, costUsd: null },
    signal: new AbortController().signal,
    credentials: { [credential.provider]: credential.apiKey },
    attempt: 1,
    logger: createLogger({ stderr: () => {} }),
    recordPolicyDenial: () => {},
  };
}

test(
  "a real Pi conversation performs a tool round-trip and reports usage",
  { skip: SKIP },
  async () => {
    if (typeof CREDENTIALS === "string") throw new Error(CREDENTIALS);
    const ws = createTestWorkspace("pi-real", { runtime: "pi" });
    try {
      const failures: string[] = [];
      for (const credential of CREDENTIALS) {
        const models = createModels();
        const model = await pickModel(credential.provider, models);
        const config: Config = ConfigSchema.parse({
          ...ws.workspace.config,
          agent: {
            runtime: "pi",
            provider: credential.provider,
            model,
            thinkingLevel: "off",
            maxTurnsPerTask: 8,
            taskTimeoutSeconds: 300,
            budgets: { perTaskTokens: null, perTaskCostUsd: null, perRunTokens: null, perRunCostUsd: null },
          },
        });
        const runtime = createPiRuntime({
          config,
          credentials: { [credential.provider]: credential.apiKey },
          transcriptsDir: ws.workspace.paths.transcripts,
          logger: createLogger({ stderr: () => {} }),
          models,
        });
        assert.equal(runtime.id, "pi");
        assert.equal(runtime.simulated, false);

        const result: AgentRunResult = await runtime.run(
          requestFor(
            {
              source: ws.workspace.paths.source,
              baseline: ws.workspace.paths.baseline,
              port: ws.workspace.paths.port,
              task: ws.workspace.paths.tasks,
              evidence: ws.workspace.paths.evidence,
            },
            credential,
          ),
        );
        if (result.outcome !== "completed") {
          // An unusable provider (quota, auth) is not the run we are asserting on; try the next one.
          failures.push(`${credential.provider}/${model}: ${result.outcome} — ${result.reason ?? "no reason"}`);
          continue;
        }

        const payload = submitSchema.parse(result.result);
        assert.ok(payload.note.length > 0, "the assistant returned an empty result");
        const roundTrips = result.events.filter((event) => event.type === "tool_execution_end" && event.isError !== true);
        assert.ok(
          roundTrips.some((event) => event.toolName === "list_unit_files"),
          `no list_unit_files round-trip: ${JSON.stringify(result.events.map((event) => [event.type, event.toolName]))}`,
        );
        assert.ok(roundTrips.some((event) => event.toolName === "submit_analysis"));
        assert.ok(result.usage.reported, "the provider did not report usage for a real conversation");
        assert.ok(result.usage.input + result.usage.output > 0, "a real conversation must report non-zero token usage");

        assert.equal(existsSync(result.transcriptPath), true);
        assert.equal(result.transcriptPath.startsWith(ws.workspace.paths.transcripts), true);
        const transcript = readFileSync(result.transcriptPath, "utf8");
        assert.match(transcript, /"runtime":"pi"/);
        assert.match(transcript, /"simulated":false/);
        assert.equal(transcript.includes(credential.apiKey), false, "the transcript must not carry the API key");
        assert.equal(/authorization/i.test(transcript), false, "the transcript must not carry an auth header");
        return; // one real conversation is all this test asserts
      }
      assert.fail(`no configured provider completed a real conversation: ${failures.join(" | ")}`);
    } finally {
      ws.cleanup();
    }
  },
);
