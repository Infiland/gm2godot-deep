import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Replays durable public events only; provider transcripts and credentials are never exposed here. */
export function readMonitoring(
  jobRoot: string,
  running: boolean,
): { tasks: Record<string, unknown>[]; agents: Record<string, unknown>[] } {
  const tasks = new Map<string, Record<string, unknown>>(),
    agents = new Map<string, Record<string, unknown>>();
  const path = join(jobRoot, "host-events.jsonl");
  if (!existsSync(path)) return { tasks: [], agents: [] };
  const merge = (
    map: Map<string, Record<string, unknown>>,
    key: string,
    row: Record<string, unknown>,
  ): void => {
    map.set(key, { ...map.get(key), ...row });
  };
  for (const line of readFileSync(path, "utf8").split("\n")) {
    try {
      const event = JSON.parse(line) as {
        type: string;
        result?: Record<string, unknown>;
      };
      if (event.type !== "progress" || !event.result) continue;
      const row = event.result;
      if (row.phase === "tasks" && Array.isArray(row.tasks))
        for (const task of row.tasks as Record<string, unknown>[])
          merge(tasks, `${task.phase}:${task.taskId}`, task);
      else if (
        (row.phase === "research" || row.phase === "implementation") &&
        typeof row.taskId === "string"
      )
        merge(tasks, `${row.phase}:${row.taskId}`, row);
      else if (row.phase === "agent" && typeof row.agentId === "string")
        merge(agents, row.agentId, row);
    } catch {
      /* incomplete trailing write */
    }
  }
  if (!running)
    for (const row of [...tasks.values(), ...agents.values()])
      if (
        ["running", "validating", "implementing", "retrying"].includes(
          String(row.state),
        )
      )
        row.state = "paused";
  return { tasks: [...tasks.values()], agents: [...agents.values()] };
}
