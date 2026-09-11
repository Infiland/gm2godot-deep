import { spawn } from "node:child_process";

export interface SpawnCaptureSpec {
  readonly argv: readonly string[];
  readonly cwd: string;
  /** Complete environment; nothing is inherited implicitly. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutSeconds: number;
  readonly maxOutputBytes?: number;
  readonly stdinData?: string;
}

export interface SpawnCaptureResult {
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/**
 * Run one child process to completion with a byte cap and a hard deadline. The whole process group is
 * killed on timeout, so a tool that forks children cannot outlive its deadline.
 */
export function spawnCapture(spec: SpawnCaptureSpec): Promise<SpawnCaptureResult> {
  const maxOutputBytes = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const [command, ...args] = spec.argv;
  const { promise, resolve, reject } = Promise.withResolvers<SpawnCaptureResult>();
  if (command === undefined) {
    reject(new Error("spawnCapture requires a non-empty argv"));
    return promise;
  }

  const startedAt = Date.now();
  const child = spawn(command, args, {
    cwd: spec.cwd,
    env: { ...spec.env },
    stdio: [spec.stdinData === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  let stdout = "";
  let stderr = "";
  let truncated = false;
  let timedOut = false;
  let settled = false;

  const collect = (chunk: Buffer, target: "stdout" | "stderr"): void => {
    const text = chunk.toString("utf8");
    const current = target === "stdout" ? stdout : stderr;
    const remaining = maxOutputBytes - (stdout.length + stderr.length);
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    const slice = text.length > remaining ? text.slice(0, remaining) : text;
    if (slice.length < text.length) truncated = true;
    if (target === "stdout") stdout = current + slice;
    else stderr = current + slice;
  };

  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child.pid);
  }, Math.max(1, spec.timeoutSeconds) * 1000);

  const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    child.stdout?.removeAllListeners();
    child.stderr?.removeAllListeners();
    resolve({
      argv: spec.argv,
      exitCode,
      signal,
      stdout,
      stderr,
      truncated,
      timedOut,
      durationMs: Date.now() - startedAt,
    });
  };

  child.stdout?.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
  child.stderr?.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
  child.on("error", (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(error);
  });
  child.on("close", (code, signal) => finish(code, signal));

  if (spec.stdinData !== undefined && child.stdin) {
    child.stdin.end(spec.stdinData);
  }
  return promise;
}

/** SIGTERM then SIGKILL the child's whole process group (POSIX) or the child itself (Windows). */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") process.kill(pid, "SIGKILL");
    else process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process already exited between the timer firing and the kill.
    }
  }
}
