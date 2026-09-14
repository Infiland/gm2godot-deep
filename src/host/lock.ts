import {
  closeSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DeepError } from "../util/result.ts";

export function acquireJobLock(root: string): () => void {
  const path = join(root, "host.lock");
  try {
    const pid = Number(readFileSync(path, "utf8"));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      alive = (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
    if (alive)
      throw new DeepError(
        "HOST_JOB_LOCKED",
        "Another extension process owns this job",
      );
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch {
    throw new DeepError(
      "HOST_JOB_LOCKED",
      "Another extension process acquired this job",
    );
  }
  writeFileSync(descriptor, String(process.pid));
  closeSync(descriptor);
  return () => {
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
}
