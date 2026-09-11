import type { CommandContext, CommandRunner } from "../main.ts";
import { DeepError } from "../../util/result.ts";
import { openWorkspaceRepo, runPipeline } from "../../scheduling/pipeline.ts";
import { reclaimExpired, retryStuckTasks } from "../../scheduling/leases.ts";
import { EXIT } from "../exit.ts";
import { flagBoolean, flagNumber, flagString  } from "../output.ts";
import { printOutcome, printPlanSummary } from "./run.ts";

/**
 * `resume` continues a workspace: expired leases are reclaimed (the crash-recovery path), the caller's
 * explicit retries are recorded, and the pipeline is then driven to completion.
 *
 * Undo of a published patch is not part of resume — publication is idempotent, so re-running cannot
 * apply a patch twice.
 */
export const run: CommandRunner = async (context: CommandContext) => {
  const root = flagString(context.flags, "workspace");
  if (root === null) throw new DeepError("GM2DEEP-CLI-USAGE", "resume requires --workspace");
  const { workspace, repo, db } = openWorkspaceRepo(root);

  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  try {
    const reclaimed = reclaimExpired(repo);
    if (reclaimed.reclaimed.length === 0) {
      context.stdout("resume: no expired leases to reclaim");
    } else {
      context.stdout(`resume: reclaimed ${String(reclaimed.reclaimed.length)} expired lease(s)`);
      for (const entry of reclaimed.reclaimed) {
        context.stdout(`  ${entry.taskId} (previous owner ${entry.previousOwner ?? "unknown"}) → READY`);
      }
    }

    const retryStates: ("BLOCKED" | "FAILED")[] = [];
    if (flagBoolean(context.flags, "retry-blocked")) retryStates.push("BLOCKED");
    if (flagBoolean(context.flags, "retry-failed")) retryStates.push("FAILED");
    if (retryStates.length > 0) {
      const moved = retryStuckTasks(repo, retryStates, "retry");
      context.stdout(`resume: returned ${String(moved.length)} ${retryStates.join("/")} task(s) to READY`);
      for (const taskId of moved) context.stdout(`  ${taskId}`);
    }

    const outcome = await runPipeline({
      workspace,
      repo,
      logger: context.logger,
      through: "report",
      execute: true,
      maxWorkers: flagNumber(context.flags, "max-workers"),
      taskFilter: [],
      allowStaleBaseline: false,
      signal: controller.signal,
    });
    printPlanSummary(context.stdout, repo);
    printOutcome(context.stdout, outcome);
    return outcome.blocked.length > 0 || outcome.failed.length > 0 ? EXIT.incomplete : EXIT.ok;
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
    db.close();
  }
};
