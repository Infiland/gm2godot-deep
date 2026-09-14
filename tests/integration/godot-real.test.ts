import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { probeGodot, runGodot } from "../../src/adapters/godot/adapter.ts";
import {
  GODOT_BINARY,
  makeTempDir,
  removeTree,
  writeFileEnsured,
} from "../helpers/harness.ts";

const SKIP =
  process.env["DEEP_INTEGRATION"] === "1" && GODOT_BINARY
    ? false
    : "DEEP_INTEGRATION is not set";
const EXPECTED = {
  expectedVersion: "4.7.2.stable.official.ed1daf0bf",
  expectedVersionPrefix: "4.7.2",
};

function writeProbeProject(directory: string): void {
  writeFileEnsured(
    `${directory}/project.godot`,
    [
      "; Engine configuration file.",
      "config_version=5",
      "",
      "[application]",
      'config/name="deep-probe"',
      "",
    ].join("\n"),
  );
  writeFileEnsured(
    `${directory}/tools/probe.gd`,
    [
      "extends SceneTree",
      "",
      "func _initialize() -> void:",
      '\tprint("DEEP_PROBE ok")',
      "\tquit(0)",
      "",
    ].join("\n"),
  );
}

test(
  "probeGodot reports the installed engine build and its absence without pretending",
  { skip: SKIP },
  async () => {
    const probe = await probeGodot(GODOT_BINARY, EXPECTED);
    assert.equal(probe.path, GODOT_BINARY);
    assert.equal(probe.version, EXPECTED.expectedVersion);
    assert.equal(probe.matchesExpected, true, probe.reason);

    const missing = await probeGodot(null, EXPECTED);
    assert.equal(missing.path, null);
    assert.equal(missing.version, null);
    assert.equal(missing.matchesExpected, false);
    assert.match(missing.reason, /godot binary not configured or not found/);

    const missingDir = makeTempDir("godot-missing");
    try {
      const bogus = await probeGodot(
        join(missingDir, "no-such-godot"),
        EXPECTED,
      );
      assert.equal(bogus.version, null);
      assert.equal(bogus.matchesExpected, false);
      assert.match(bogus.reason, /not an executable file/);
    } finally {
      removeTree(missingDir);
    }
  },
);

test(
  "runGodot executes a real headless SceneTree script and reports its engine build",
  { skip: SKIP },
  async () => {
    const project = makeTempDir("godot-real");
    try {
      writeProbeProject(project);
      const result = await runGodot({
        binary: GODOT_BINARY,
        projectPath: project,
        extraArgs: ["--script", "res://tools/probe.gd"],
        timeoutSeconds: 120,
      });
      assert.equal(
        result.exitCode,
        0,
        `stderr: ${result.stderr.slice(0, 500)}`,
      );
      assert.equal(result.timedOut, false);
      assert.equal(result.engineVersion, EXPECTED.expectedVersion);
      assert.match(result.stdout, /DEEP_PROBE ok/);
      assert.deepEqual(result.argv.slice(0, 2), [GODOT_BINARY, "--headless"]);
      assert.ok(result.argv.includes(project));
      assert.equal(result.truncated, false);
      assert.ok(result.durationMs >= 0);
    } finally {
      removeTree(project);
    }
  },
);
