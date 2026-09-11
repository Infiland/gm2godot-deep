import type { CommandContext, CommandRunner } from "../main.ts";
import { DeepError } from "../../util/result.ts";
import { openWorkspace } from "../../workspaces/workspace.ts";
import { openDatabase } from "../../storage/db.ts";
import { Repo } from "../../storage/repo.ts";
import { latestPlanVersion, listAnalyses } from "../../evidence/store.ts";
import type { Workspace } from "../../workspaces/workspace.ts";
import { EXIT } from "../exit.ts";
import { flagBoolean, flagString, renderJson, renderKeyValues, renderTable  } from "../output.ts";

/** Everything `status` prints, in one object so `--json` is the same data without the tables. */
export interface StatusAggregate {
  readonly workspace: string;
  readonly source: string;
  readonly runtime: string;
  readonly sandbox: string;
  readonly latestRun: {
    readonly id: string;
    readonly phase: string;
    readonly through: string;
    readonly status: string;
    readonly execute: boolean;
    readonly startedAt: string;
    readonly updatedAt: string;
    readonly finishedAt: string | null;
  } | null;
  readonly unitsByState: Readonly<Record<string, number>>;
  readonly tasksByState: Readonly<Record<string, number>>;
  readonly taskCount: number;
  readonly unitCount: number;
  readonly analysisCount: number;
  readonly contractCount: number;
  readonly planVersion: number | null;
  readonly patchCount: number;
  readonly integrationCount: number;
  readonly validationByState: Readonly<Record<string, number>>;
  readonly portRevision: number;
  readonly portRevisionCount: number;
  readonly recentEvents: readonly {
    readonly taskId: string;
    readonly at: string;
    readonly kind: string;
    readonly fromState: string | null;
    readonly toState: string | null;
  }[];
}

function aggregate(workspace: Workspace, repo: Repo): StatusAggregate {
  const run = repo.latestRun();
  const validationByState: Record<string, number> = {};
  for (const row of repo.listValidation()) validationByState[row.state] = (validationByState[row.state] ?? 0) + 1;
  return {
    workspace: workspace.paths.root,
    source: workspace.config.source.path,
    runtime: workspace.config.agent.runtime,
    sandbox: workspace.config.sandbox.backend,
    latestRun:
      run === null
        ? null
        : {
            id: run.id,
            phase: run.phase,
            through: run.throughPhase,
            status: run.status,
            execute: run.execute,
            startedAt: run.startedAt,
            updatedAt: run.updatedAt,
            finishedAt: run.finishedAt,
          },
    unitsByState: repo.countUnitsByState(),
    tasksByState: repo.countTasksByState(),
    taskCount: repo.listTasks().length,
    unitCount: repo.listUnits().length,
    analysisCount: listAnalyses(workspace.paths.evidenceAnalyses).length,
    contractCount: repo.listContracts().length,
    planVersion: latestPlanVersion(workspace.paths.evidencePlans),
    patchCount: repo.listPatches().length,
    integrationCount: repo.listIntegrations().length,
    validationByState,
    portRevision: repo.currentPortRevision(),
    portRevisionCount: repo.listPortRevisions().length,
    recentEvents: repo.listRecentEvents(20),
  };
}

function countsTable(counts: Readonly<Record<string, number>>): string {
  const rows = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  if (rows.length === 0) return "_none_";
  return renderTable(["state", "count"], rows.map(([state, count]) => [state, String(count)]));
}

function printHuman(stdout: (line: string) => void, status: StatusAggregate): void {
  stdout(
    renderKeyValues([
      ["workspace", status.workspace],
      ["source", status.source],
      ["runtime", status.runtime],
      ["sandbox", status.sandbox],
      [
        "latest run",
        status.latestRun === null
          ? "none"
          : `${status.latestRun.id} phase=${status.latestRun.phase} status=${status.latestRun.status} execute=${String(status.latestRun.execute)} started=${status.latestRun.startedAt}`,
      ],
      ["port revision", `${String(status.portRevision)} (${String(status.portRevisionCount)} record(s))`],
      ["plan version", status.planVersion === null ? "none" : `v${String(status.planVersion)}`],
      ["analyses", String(status.analysisCount)],
      ["contracts", String(status.contractCount)],
      ["patches", String(status.patchCount)],
      ["integrations", String(status.integrationCount)],
    ]),
  );
  stdout("");
  stdout(`units (${String(status.unitCount)}) by state:`);
  stdout(countsTable(status.unitsByState));
  stdout("");
  stdout(`tasks (${String(status.taskCount)}) by state:`);
  stdout(countsTable(status.tasksByState));
  stdout("");
  stdout("validation by state:");
  stdout(countsTable(status.validationByState));
  stdout("");
  stdout("recent events (newest first):");
  stdout(
    renderTable(
      ["at", "task", "kind", "from", "to"],
      status.recentEvents.map((event) => [
        event.at,
        event.taskId,
        event.kind,
        event.fromState ?? "",
        event.toState ?? "",
      ]),
    ),
  );
}

export const run: CommandRunner = async (context: CommandContext) => {
  const root = flagString(context.flags, "workspace");
  if (root === null) throw new DeepError("GM2DEEP-CLI-USAGE", "status requires --workspace");
  const workspace = openWorkspace(root);
  const db = openDatabase(workspace.paths.database);
  const repo = new Repo(db);
  try {
    const status = aggregate(workspace, repo);
    if (flagBoolean(context.flags, "json")) context.stdout(renderJson(status));
    else printHuman(context.stdout, status);
    return EXIT.ok;
  } finally {
    db.close();
  }
};
