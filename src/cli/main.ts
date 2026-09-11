import { parseArgs, usage, type ParsedArgs } from "./args.ts";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Logger } from "../util/log.ts";
import { createLogger } from "../util/log.ts";
import { DeepError, deepErrorFrom } from "../util/result.ts";
import { packageVersion } from "../util/package.ts";

export interface CommandContext {
  readonly command: string;
  readonly flags: ParsedArgs["flags"];
  readonly positionals: readonly string[];
  readonly cwd: string;
  readonly logger: Logger;
  readonly stdout: (line: string) => void;
}

export type CommandRunner = (context: CommandContext) => Promise<number>;

/** Exit codes. 4 is "the run finished but reported blocked or failed tasks". */
export const EXIT = { ok: 0, failure: 1, usage: 2, incomplete: 4 } as const;

const RUNNERS: Record<string, () => Promise<{ run: CommandRunner }>> = {
  init: () => import("./commands/init.ts"),
  run: () => import("./commands/run.ts"),
  status: () => import("./commands/status.ts"),
  resume: () => import("./commands/resume.ts"),
  report: () => import("./commands/report.ts"),
  doctor: () => import("./commands/doctor.ts"),
  cache: () => import("./commands/cache.ts"),
};

export async function main(argv: readonly string[], io?: { stdout?: (line: string) => void; stderr?: (line: string) => void }): Promise<number> {
  const stdout = io?.stdout ?? ((line: string) => process.stdout.write(line + "\n"));
  const stderr = io?.stderr ?? ((line: string) => process.stderr.write(line + "\n"));
  const logger = createLogger({ stderr: (line) => stderr(line) });

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    stdout(usage());
    return argv.length === 0 ? EXIT.usage : EXIT.ok;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    stdout(packageVersion());
    return EXIT.ok;
  }

  try {
    const parsed = parseArgs(argv);
    const runner = RUNNERS[parsed.command];
    if (runner === undefined) throw new DeepError("GM2DEEP-CLI-USAGE", `unknown command ${parsed.command}`);
    const module = await runner();
    return await module.run({
      command: parsed.command,
      flags: parsed.flags,
      positionals: parsed.positionals,
      cwd: process.cwd(),
      logger,
      stdout,
    });
  } catch (error) {
    const failure = deepErrorFrom(error, logger);
    stderr(`${failure.code}: ${failure.message}`);
    if (Object.keys(failure.detail).length > 0) stderr(JSON.stringify(failure.detail, null, 2));
    return failure.code === "GM2DEEP-CLI-USAGE" ? EXIT.usage : EXIT.failure;
  }
}

/** True when this module is the script Node was asked to run (`node src/cli/main.ts`). */
function isEntryModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryModule()) process.exitCode = await main(process.argv.slice(2));
