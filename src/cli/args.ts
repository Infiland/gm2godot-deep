import { DeepError } from "../util/result.ts";

export type FlagKind = "string" | "number" | "boolean" | "repeat";

export interface FlagSpec {
  readonly name: string;
  readonly kind: FlagKind;
  readonly required?: boolean;
  readonly choices?: readonly string[];
  readonly description: string;
}

export interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  readonly flags: readonly FlagSpec[];
  readonly positionals?: readonly string[];
}

export interface ParsedArgs {
  readonly command: string;
  readonly flags: Record<string, string | number | boolean | string[]>;
  readonly positionals: string[];
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "init",
    summary: "Create a workspace, probe upstream tools and snapshot the source project.",
    flags: [
      { name: "source", kind: "string", required: true, description: "GameMaker project directory" },
      { name: "workspace", kind: "string", required: true, description: "Workspace directory" },
      { name: "gm2godot-checkout", kind: "string", description: "Pinned GM2Godot checkout" },
      { name: "gm2godot-python", kind: "string", description: "Python interpreter for GM2Godot" },
      { name: "godot-bin", kind: "string", description: "Godot binary" },
      { name: "runtime", kind: "string", choices: ["mock", "pi"], description: "Agent runtime" },
      { name: "force", kind: "boolean", description: "Write config even when version probes mismatch" },
    ],
  },
  {
    name: "run",
    summary: "Advance the pipeline. Without --execute, implementation never starts implicitly.",
    flags: [
      { name: "workspace", kind: "string", required: true, description: "Workspace directory" },
      {
        name: "through",
        kind: "string",
        choices: ["inventory", "baseline", "analyze", "plan", "implement", "validate", "report"],
        description: "Stop after this phase",
      },
      { name: "execute", kind: "boolean", description: "Permit implementation and validation to run" },
      { name: "max-workers", kind: "number", description: "Override worker count" },
      { name: "task", kind: "repeat", description: "Restrict implementation to these task ids" },
      { name: "allow-stale-baseline", kind: "boolean", description: "Accept a non-fresh conversion manifest" },
    ],
  },
  {
    name: "status",
    summary: "Show run, unit and task state.",
    flags: [
      { name: "workspace", kind: "string", required: true, description: "Workspace directory" },
      { name: "json", kind: "boolean", description: "Print the raw artifact" },
    ],
  },
  {
    name: "resume",
    summary: "Reclaim expired leases and continue a workspace.",
    flags: [
      { name: "workspace", kind: "string", required: true, description: "Workspace directory" },
      { name: "execute", kind: "boolean", description: "Permit implementation and validation to run" },
      { name: "max-workers", kind: "number", description: "Override worker count" },
      { name: "retry-blocked", kind: "boolean", description: "Move BLOCKED tasks back to READY" },
      { name: "retry-failed", kind: "boolean", description: "Move FAILED tasks back to READY" },
    ],
  },
  {
    name: "report",
    summary: "Render the evidence report.",
    flags: [
      { name: "workspace", kind: "string", required: true, description: "Workspace directory" },
      { name: "format", kind: "string", choices: ["json", "md"], description: "Output format" },
      { name: "out", kind: "string", description: "Write to this path instead of stdout" },
    ],
  },
  {
    name: "doctor",
    summary: "Probe GM2Godot, Godot and sandbox availability for a workspace.",
    flags: [{ name: "workspace", kind: "string", required: true, description: "Workspace directory" }],
  },
  {
    name: "cache",
    summary: "Inspect or clear the analysis cache.",
    flags: [
      { name: "workspace", kind: "string", required: true, description: "Workspace directory" },
      { name: "clear", kind: "boolean", description: "Delete every cache entry" },
      { name: "invalidate-contract", kind: "string", description: "Invalidate entries bound to this concern" },
    ],
  },
];

function specFor(name: string): CommandSpec | undefined {
  return COMMANDS.find((command) => command.name === name);
}

function parseNumber(flag: FlagSpec, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new DeepError("GM2DEEP-CLI-USAGE", `--${flag.name} expects an integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function checkChoice(flag: FlagSpec, raw: string): string {
  if (flag.choices && !flag.choices.includes(raw)) {
    throw new DeepError(
      "GM2DEEP-CLI-USAGE",
      `--${flag.name} must be one of ${flag.choices.join(", ")}, got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

/**
 * Parse argv for a known command. Unknown flags are rejected rather than ignored, so a typo
 * never silently changes behaviour.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (command === undefined) {
    throw new DeepError("GM2DEEP-CLI-USAGE", "missing command; run with --help");
  }
  const spec = specFor(command);
  if (spec === undefined) {
    throw new DeepError("GM2DEEP-CLI-USAGE", `unknown command ${JSON.stringify(command)}`, {
      known: COMMANDS.map((candidate) => candidate.name),
    });
  }

  const flags: Record<string, string | number | boolean | string[]> = {};
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] as string;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
    const flag = spec.flags.find((candidate) => candidate.name === name);
    if (flag === undefined) {
      throw new DeepError("GM2DEEP-CLI-USAGE", `unknown flag --${name} for command ${command}`);
    }
    if (flag.kind === "boolean") {
      if (equals !== -1) {
        throw new DeepError("GM2DEEP-CLI-USAGE", `--${name} is a boolean flag and takes no value`);
      }
      flags[name] = true;
      continue;
    }
    const inline = equals === -1 ? undefined : token.slice(equals + 1);
    const value = inline ?? rest[++index];
    if (value === undefined) {
      throw new DeepError("GM2DEEP-CLI-USAGE", `--${name} requires a value`);
    }
    if (flag.kind === "number") flags[name] = parseNumber(flag, value);
    else if (flag.kind === "repeat") flags[name] = [...((flags[name] as string[] | undefined) ?? []), value];
    else flags[name] = checkChoice(flag, value);
  }

  for (const flag of spec.flags) {
    if (flag.required && !(flag.name in flags)) {
      throw new DeepError("GM2DEEP-CLI-USAGE", `command ${command} requires --${flag.name}`);
    }
  }

  return { command, flags, positionals };
}

export function usage(): string {
  const lines = ["usage: deep-convert <command> [flags]", ""];
  for (const command of COMMANDS) {
    lines.push(`  ${command.name} — ${command.summary}`);
    for (const flag of command.flags) {
      const value = flag.kind === "boolean" ? "" : ` <${flag.kind === "repeat" ? "value…" : "value"}>`;
      const suffix = flag.required ? " (required)" : "";
      lines.push(`      --${flag.name}${value}${suffix} — ${flag.description}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
