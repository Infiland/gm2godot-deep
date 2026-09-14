import { runProcess } from "./process.ts";
import { TransportFailure } from "./transport.ts";
import type { AgentTransport } from "./transport.ts";
export function claudeTransport(
  executable: string,
  cwd: string,
): AgentTransport {
  return {
    close: async () => {},
    complete: async (request) => {
      const args = [
        "-p",
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(request.schema),
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--setting-sources",
        "",
        "--no-session-persistence",
        "--max-turns",
        "1",
        "--system-prompt",
        request.system,
      ];
      if (request.model) args.push("--model", request.model);
      const output = await runProcess(
        executable,
        args,
        cwd,
        request.prompt,
        request.signal,
        [0, 1],
      );
      const parsed = JSON.parse(output) as {
        is_error?: boolean;
        structured_output?: unknown;
        result?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
        total_cost_usd?: number;
      };
      const usage = {
        input: parsed.usage?.input_tokens ?? 0,
        output: parsed.usage?.output_tokens ?? 0,
        cacheRead: parsed.usage?.cache_read_input_tokens ?? 0,
        cacheWrite: parsed.usage?.cache_creation_input_tokens ?? 0,
        costUsd: parsed.total_cost_usd ?? 0,
        reported: parsed.usage !== undefined,
      };
      if (parsed.is_error)
        throw new TransportFailure(
          "Claude Code returned an unsuccessful result",
          usage,
        );
      try {
        return {
          value:
            parsed.structured_output ?? JSON.parse(parsed.result ?? "null"),
          usage,
        };
      } catch {
        throw new TransportFailure(
          "Claude Code returned malformed structured JSON",
          usage,
        );
      }
    },
  };
}
