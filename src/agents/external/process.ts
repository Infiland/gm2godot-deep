import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export function startProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  // Never run inside a project: installed agents must not discover source hooks, plugins or instructions.
  return spawn(executable, [...args], {
    cwd,
    env: env ?? process.env,
    stdio: "pipe",
    detached: process.platform !== "win32",
    windowsHide: true,
  });
}
export async function stopProcess(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn(
        "taskkill",
        ["/pid", String(child.pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true },
      );
      killer.once("error", () => resolve());
      killer.once("close", () => resolve());
    });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill();
    }
  }
  await Promise.race([
    new Promise<void>((resolve) => child.once("close", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 500)),
  ]);
  if (child.exitCode === null && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
}
export async function runProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  input: string,
  signal: AbortSignal,
  acceptedExitCodes: readonly number[] = [0],
): Promise<string> {
  signal.throwIfAborted();
  const child = startProcess(executable, args, cwd);
  let output = "";
  const abort = (): void => {
    void stopProcess(child);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await new Promise<string>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.on("data", (data: Buffer) => {
        output += data.toString();
        if (output.length > 8_000_000) {
          void stopProcess(child);
          reject(new Error("Agent output exceeded size limit"));
        }
      });
      child.stderr.resume(); // Provider stderr may contain secrets: never record it.
      child.once("close", (code) =>
        signal.aborted
          ? reject(signal.reason)
          : code !== null && acceptedExitCodes.includes(code)
            ? resolve(output)
            : reject(new Error(`Agent process exited with code ${code}`)),
      );
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
  } finally {
    signal.removeEventListener("abort", abort);
    await stopProcess(child);
  }
}
