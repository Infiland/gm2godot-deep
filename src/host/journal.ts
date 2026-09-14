import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "../util/json.ts";
import type { HostEvent } from "./protocol.ts";

export interface JobRecord {
  schemaVersion: 1;
  jobId: string;
  jobRoot: string;
  state: string;
  operation: "research" | "convert";
  seq: number;
  artifacts: Record<string, string>;
  extensionVersion: string;
  ownerPid?: number;
  elapsedSeconds?: number;
}
export function loadJob(root: string): JobRecord {
  const record = readJsonFile(join(root, "host-job.json")) as JobRecord;
  const journal = join(root, "host-events.jsonl");
  if (existsSync(journal))
    for (const line of readFileSync(journal, "utf8").split("\n")) {
      try {
        const event = JSON.parse(line) as HostEvent;
        record.seq = Math.max(record.seq, event.seq ?? 0);
      } catch {
        /* interrupted append */
      }
    }
  if (record.state === "running" || record.state === "pausing")
    record.state = "paused";
  return record;
}
export function saveJob(record: JobRecord): void {
  writeJsonAtomic(join(record.jobRoot, "host-job.json"), record);
}
export function journalEvent(
  record: JobRecord,
  type: string,
  result: unknown,
): HostEvent {
  const event: HostEvent = {
    protocolVersion: 1,
    jobId: record.jobId,
    seq: ++record.seq,
    type,
    result,
  };
  appendFileSync(
    join(record.jobRoot, "host-events.jsonl"),
    JSON.stringify(event) + "\n",
  );
  saveJob(record);
  return event;
}
