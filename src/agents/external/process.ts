import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { win32 } from "node:path";

async function waitForExit(child: ChildProcessWithoutNullStreams, timeout: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      child.removeListener("close", done);
      resolve();
    };
    const timer = setTimeout(done, timeout);
    child.once("close", done);
  });
}

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
    // Desktop launches can have a minimal PATH. Resolve this system utility
    // explicitly so shutdown neither misses it nor executes a PATH replacement.
    const systemRoot = process.env["SystemRoot"] ?? process.env["WINDIR"];
    const absoluteRoot = systemRoot && win32.isAbsolute(systemRoot)
      && win32.parse(systemRoot).root.length > 1;
    const killed = absoluteRoot && await new Promise<boolean>((resolve) => {
      const killer = spawn(
        win32.join(systemRoot, "System32", "taskkill.exe"),
        ["/pid", String(child.pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true },
      );
      let settled = false;
      const done = (success: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(success);
      };
      const timer = setTimeout(() => {
        killer.kill();
        done(false);
      }, 1000);
      killer.once("error", () => done(false));
      killer.once("close", (code) => done(code === 0));
    });
    if (!killed) child.kill();
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill();
    }
  }
  await waitForExit(child, 500);
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === "win32") child.kill();
    else {
      try { process.kill(-child.pid, "SIGKILL"); }
      catch { child.kill("SIGKILL"); }
    }
    await waitForExit(child, 500);
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
