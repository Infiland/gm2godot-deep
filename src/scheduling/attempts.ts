import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "../util/json.ts";

/** Persist research and reviewer attempts before dispatch, including attempts interrupted by a crash. */
export function nextAttempt(
  workspaceRoot: string,
  taskId: string,
  role: string,
): number {
  const path = join(workspaceRoot, "agent-attempts.json");
  const previous = existsSync(path)
    ? (readJsonFile(path) as Record<string, number>)
    : {};
  const key = `${role}:${taskId}`;
  const attempt = (previous[key] ?? 0) + 1;
  writeJsonAtomic(path, { ...previous, [key]: attempt });
  return attempt;
}
