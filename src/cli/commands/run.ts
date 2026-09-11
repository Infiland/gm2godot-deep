import type { CommandContext, CommandRunner } from "../main.ts";
import { DeepError } from "../../util/result.ts";
import { openWorkspaceRepo, PHASE_ORDER, runPipeline, type Phase, type PipelineOutcome } from "../../scheduling/pipeline.ts";
import type { Repo } from "../../storage/repo.ts";
import { recordedFailureReason } from "../../evidence/report.ts";
import { EXIT } from "../exit.ts";
import { flagBoolean, flagList, flagNumber, flagString, renderTable  } from "../output.ts";

function isPhase(value: string): value is Phase {
  return (PHASE_ORDER as readonly string[]).includes(value);
}

function requireWorkspaceFlag(context: CommandContext, command: string): string {
  const root = flagString(context.flags, "workspace");
  if (root === null) throw new DeepError("GM2DEEP-CLI-USAGE", `${command} requires --workspace`);
  return root;
}

/**
 * Print what the plan decided: which tasks exist, which units were retained without a task, and what
 * is blocked. This is the point where a human can see the run's intent before implementation starts.
 */
export function printPlanSummary(stdout: (line: string) => void, repo: Repo): void {
  const tasks = repo.listTasks();
  const units = repo.listUnits();
  const tasked = new Set(tasks.flatMap((task) => [...task.unitIds]));
  const retained = units.filter((unit) => unit.strategy === "retain_generated" && !tasked.has(unit.id));
  stdout(`plan: ${String(tasks.length)} task(s); ${String(retained.length)} unit(s) retained without a task`);
  stdout("");
  stdout(
    renderTable(
      ["task", "role", "state", "strategy", "writes", "depends on", "block reason"],
      tasks.map((task) => [
        task.id,
        task.role,
        task.state,
        task.strategy,
        String(task.allowlist.write.length),
        task.dependsOn.join(", "),
        task.blockReason ?? "",
      ]),
    ),
  );
  const blockages = tasks.filter((task) => task.state === "BLOCKED" || task.state === "FAILED");
  stdout("");
  if (blockages.length === 0) {
    stdout("blockages: none");
    return;
  }
  stdout(`blockages: ${String(blockages.length)}`);
  for (const task of blockages) {
    const reason = task.blockReason ?? recordedFailureReason(repo.listEvents(task.id)) ?? "no reason recorded";
    stdout(`  ${task.id} [${task.state}]: ${reason}`);
  }
}

export function printOutcome(stdout: (line: string) => void, outcome: PipelineOutcome): void {
  stdout(`run: reached ${outcome.reached}`);
  stdout(`blocked: ${String(outcome.blocked.length)}${outcome.blocked.length > 0 ? ` (${outcome.blocked.join(", ")})` : ""}`);
  stdout(`failed: ${String(outcome.failed.length)}${outcome.failed.length > 0 ? ` (${outcome.failed.join(", ")})` : ""}`);
  stdout(`skipped: ${String(outcome.skipped.length)}${outcome.skipped.length > 0 ? ` (${outcome.skipped.slice(0, 10).join(" | ")})` : ""}`);
}

export const run: CommandRunner = async (context) => {
  const root = requireWorkspaceFlag(context, "run");
  const { workspace, repo, db } = openWorkspaceRepo(root);
  const execute = flagBoolean(context.flags, "execute");
  const throughFlag = flagString(context.flags, "through");
  if (throughFlag !== null && !isPhase(throughFlag)) {
    throw new DeepError("GM2DEEP-CLI-USAGE", `unknown phase ${throughFlag}`, { known: PHASE_ORDER });
  }
  // Without `--execute` the pipeline stops after planning: implementation never starts implicitly.
  const through: Phase = throughFlag ?? (execute ? "report" : "plan");

  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  try {
    const outcome = await runPipeline({
      workspace,
      repo,
      logger: context.logger,
      through,
      execute,
      maxWorkers: flagNumber(context.flags, "max-workers"),
      taskFilter: flagList(context.flags, "task"),
      allowStaleBaseline: flagBoolean(context.flags, "allow-stale-baseline"),
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
