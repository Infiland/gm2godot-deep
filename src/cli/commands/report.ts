import { resolve } from "node:path";
import type { CommandContext, CommandRunner } from "../main.ts";
import { DeepError } from "../../util/result.ts";
import { openWorkspace } from "../../workspaces/workspace.ts";
import { openDatabase } from "../../storage/db.ts";
import { Repo } from "../../storage/repo.ts";
import { writeReport } from "../../evidence/report.ts";
import { writeTextAtomic } from "../../util/json.ts";
import { EXIT } from "../exit.ts";
import { flagString, renderJson  } from "../output.ts";

/**
 * `report` rebuilds the evidence report from the stored artifacts and prints it. `--out` writes the
 * rendered form to a caller-chosen path; the canonical copies always live in `evidence/reports/`.
 */
export const run: CommandRunner = async (context: CommandContext) => {
  const root = flagString(context.flags, "workspace");
  if (root === null) throw new DeepError("GM2DEEP-CLI-USAGE", "report requires --workspace");
  const format = flagString(context.flags, "format") ?? "md";
  const out = flagString(context.flags, "out");
  const workspace = openWorkspace(root);
  const db = openDatabase(workspace.paths.database);
  const repo = new Repo(db);
  try {
    const written = await writeReport({ workspace, repo, logger: context.logger });
    const body = format === "json" ? renderJson(written.json) : written.markdown;
    if (out === null) {
      context.stdout(body.endsWith("\n") ? body.slice(0, -1) : body);
    } else {
      const target = resolve(context.cwd, out);
      writeTextAtomic(target, body.endsWith("\n") ? body : `${body}\n`);
      context.stdout(`report: wrote ${target}`);
    }
    // Artifact locations go to the log, not stdout: `--format json` must stay parseable on its own.
    context.logger.debug(`report: artifacts ${written.jsonPath} , ${written.markdownPath}`);
    return EXIT.ok;
  } finally {
    db.close();
  }
};
