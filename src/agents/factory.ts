import type { Config } from "../config/schema.ts";
import type { Logger } from "../util/log.ts";
import type { AgentRoleName } from "./runtime.ts";
import type { AgentRuntime } from "./runtime.ts";
import { createPiRuntime } from "./pi/piRuntime.ts";
import { createRelayRuntime } from "./external/relay.ts";
import { codexTransport } from "./external/codex.ts";
import { claudeTransport } from "./external/claude.ts";
import { OpenCodeClient } from "./external/opencode.ts";
export interface RuntimeFactoryOptions {
  config: Config;
  credentials: Readonly<Record<string, string>>;
  transcriptsDir: string;
  logger: Logger;
}
/** Role overrides select adapters without giving any adapter control over scheduling or nested agents. */
export function roleAgentConfig(
  config: Config,
  role: AgentRoleName,
): Config["agent"] {
  const publicRole = {
    analyst: "researcher",
    reconciler: "planner",
    implementer: "implementer",
    risk_reviewer: "reviewer",
    patch_reviewer: "reviewer",
  }[role];
  const override =
    config.agent.roleOverrides[publicRole] ?? config.agent.roleOverrides[role];
  return {
    ...config.agent,
    runtime: override?.runtime ?? config.agent.runtime,
    executable: override?.runtime && override.runtime !== config.agent.runtime
      ? null : config.agent.executable,
    provider: override?.provider ?? config.agent.provider,
    model: override?.model ?? config.agent.model,
  };
}
export function createRuntime(options: RuntimeFactoryOptions): AgentRuntime {
  return {
    id: options.config.agent.runtime,
    simulated: false,
    run: async (request) => {
      const config: Config = {
        ...options.config,
        agent: roleAgentConfig(options.config, request.role),
      };
      const runtime = config.agent.runtime;
      if (runtime === "mock")
        throw new Error(
          "Mock runtime must use the explicit simulated pipeline",
        );
      if (config.agent.freeOnly && config.agent.endpoint)
        throw new Error(
          "Free-only mode requires an isolated managed OpenCode server so helper models can be pinned without changing user configuration",
        );
      if (config.agent.freeOnly && runtime !== "opencode")
        throw new Error(
          "Free-only mode permits only verified OpenCode Zen models",
        );
      if (runtime === "pi") {
        const result = await createPiRuntime({ ...options, config }).run(
          request,
        );
        return {
          ...result,
          provenance: {
            runtime,
            provider: config.agent.provider,
            model: config.agent.model,
          },
        };
      }
      const executable =
        config.agent.executable ??
        { codex: "codex", claude: "claude", opencode: "opencode" }[runtime];
      return createRelayRuntime({
        id: runtime,
        provider: config.agent.provider,
        model: config.agent.model,
        freeOnly: config.agent.freeOnly,
        transcriptsDir: options.transcriptsDir,
        create: (cwd) =>
          runtime === "codex"
            ? codexTransport(config.agent.executable, cwd)
            : runtime === "claude"
              ? claudeTransport(executable, cwd)
              : new OpenCodeClient({
                  executable,
                  cwd,
                  endpoint: config.agent.endpoint,
                  provider: config.agent.provider,
                  freeOnly: config.agent.freeOnly,
                  ...(config.agent.provider &&
                  options.credentials[config.agent.provider]
                    ? { apiKey: options.credentials[config.agent.provider] }
                    : {}),
                  ...(options.credentials["opencode-server"]
                    ? { password: options.credentials["opencode-server"] }
                    : {}),
                }),
      }).run(request);
    },
  };
}
