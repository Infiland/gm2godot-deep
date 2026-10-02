import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProcess, stopProcess } from "../../src/agents/external/process.ts";

test("external process shutdown works when PATH excludes system utilities", { timeout: 5000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "deep-process-test-"));
  const previousPath = process.env["PATH"];
  const child = startProcess(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"], directory);
  const closed = once(child, "close");
  void closed.catch(() => {});
  try {
    await once(child.stdout, "data");
    process.env["PATH"] = directory;
    await stopProcess(child);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    await closed;
  } finally {
    if (previousPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previousPath;
    child.kill();
    await stopProcess(child);
    rmSync(directory, { recursive: true, force: true });
  }
});
