import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCodexExecutable } from "../../src/agents/external/codexExecutable.ts";
import type { CodexExecutableOptions } from "../../src/agents/external/codexExecutable.ts";

function fixture(platform: NodeJS.Platform, files: string[], options: CodexExecutableOptions = {}): CodexExecutableOptions {
  const knownFiles = new Set(files);
  return {
    platform,
    env: {},
    home: platform === "win32" ? "C:\\Users\\tester" : "/home/tester",
    cwd: platform === "win32" ? "C:\\project" : "/project",
    execPath: platform === "win32" ? "C:\\node\\node.exe" : "/usr/bin/node",
    isFile: (path) => knownFiles.has(path),
    isExecutable: (path) => knownFiles.has(path),
    ...options,
  };
}

test("PATH wins over known installations and desktop bundles", () => {
  const executable = "/custom/bin/codex";
  const result = resolveCodexExecutable(undefined, fixture("darwin", [
    executable, "/opt/homebrew/bin/codex", "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
  ], { env: { PATH: "/custom/bin:/opt/homebrew/bin" } }));
  assert.deepEqual(result, { executable, command: executable, args: [], installationSource: "path" });
});

test("GUI environments discover Homebrew, npm, local and Linux installations", () => {
  for (const [platform, executable] of [
    ["darwin", "/opt/homebrew/bin/codex"],
    ["darwin", "/usr/local/bin/codex"],
    ["linux", "/home/tester/.local/bin/codex"],
    ["linux", "/home/tester/.npm-global/bin/codex"],
    ["linux", "/home/tester/.npm/bin/codex"],
    ["linux", "/home/tester/.volta/bin/codex"],
    ["linux", "/usr/bin/codex"],
  ] as const) {
    const result = resolveCodexExecutable(undefined, fixture(platform, [executable], { env: { PATH: "/minimal/gui/path" } }));
    assert.equal(result?.executable, executable);
    assert.equal(result?.installationSource, "known-location");
  }
});

test("desktop-only macOS installs include current and legacy app locations", () => {
  for (const executable of [
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    "/home/tester/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex",
  ]) {
    const result = resolveCodexExecutable(undefined, fixture("darwin", [executable]));
    assert.equal(result?.executable, executable);
    assert.equal(result?.installationSource, "desktop");
  }
});

test("automatic discovery ignores empty and relative PATH entries", () => {
  const options = fixture("linux", ["/project/codex", "/project/bin/codex"], {
    env: { PATH: ":.:bin:./bin:/missing:" },
  });
  assert.equal(resolveCodexExecutable(undefined, options), null);
  assert.throws(() => resolveCodexExecutable("codex", options), /selected Codex executable/);
});

test("explicit names search only PATH and an invalid selection never falls back", () => {
  const options = fixture("darwin", ["/opt/homebrew/bin/codex", "/custom/bin/renamed-codex"], { env: { PATH: "/custom/bin" } });
  assert.equal(resolveCodexExecutable("renamed-codex", options)?.installationSource, "explicit");
  for (const explicit of ["codex", "/missing/codex", "", "private-token\0codex"]) {
    assert.throws(() => resolveCodexExecutable(explicit, options), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Select an installed Codex binary/);
      assert.ok(!error.message.includes("private-token"));
      return true;
    });
  }
});

test("explicit paths preserve spaces and support relative and home paths", () => {
  const absolute = "/home/tester/Codex tools/codex";
  const options = fixture("linux", [absolute, "/project/tools/codex"]);
  assert.deepEqual(resolveCodexExecutable(absolute, options), {
    executable: absolute, command: absolute, args: [], installationSource: "explicit",
  });
  assert.equal(resolveCodexExecutable("~/Codex tools/codex", options)?.executable, absolute);
  assert.equal(resolveCodexExecutable("./tools/codex", options)?.executable, "/project/tools/codex");
});

test("native filesystem checks reject directories and non-executable files and accept symlinks", { skip: process.platform === "win32" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-resolver-"));
  try {
    const executable = join(directory, "Codex tools", "codex");
    mkdirSync(join(directory, "Codex tools"));
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
    const options: CodexExecutableOptions = { platform: "linux", env: {}, home: directory };
    assert.throws(() => resolveCodexExecutable(executable, options), /selected Codex executable/);
    assert.throws(() => resolveCodexExecutable(directory, options), /selected Codex executable/);
    chmodSync(executable, 0o700);
    const alias = join(directory, "codex-alias");
    symlinkSync(executable, alias);
    assert.equal(resolveCodexExecutable(alias, options)?.command, alias);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("configured absolute npm and Volta prefixes are supported without relative fallback", () => {
  assert.equal(resolveCodexExecutable(undefined, fixture("linux", ["/external/npm/bin/codex"], {
    env: { NPM_CONFIG_PREFIX: "/external/npm" },
  }))?.executable, "/external/npm/bin/codex");
  assert.equal(resolveCodexExecutable(undefined, fixture("linux", ["/external/npm/bin/codex"], {
    env: { npm_config_prefix: "/external/npm" },
  }))?.executable, "/external/npm/bin/codex");
  assert.equal(resolveCodexExecutable(undefined, fixture("linux", ["/external/volta/bin/codex"], {
    env: { VOLTA_HOME: "/external/volta" },
  }))?.executable, "/external/volta/bin/codex");
  assert.equal(resolveCodexExecutable(undefined, fixture("linux", ["npm/bin/codex", "volta/bin/codex"], {
    env: { NPM_CONFIG_PREFIX: "npm", VOLTA_HOME: "volta" },
  })), null);
});

test("Windows discovery finds native executables and handles case-insensitive PATH", () => {
  const executable = "C:\\Codex tools\\codex.exe";
  assert.deepEqual(resolveCodexExecutable(undefined, fixture("win32", [executable], {
    env: { Path: "C:\\Codex tools;C:\\missing" },
  })), { executable, command: executable, args: [], installationSource: "path" });
  assert.equal(resolveCodexExecutable(undefined, fixture("win32", ["C:\\Users\\tester\\.local\\bin\\codex.exe"]))?.installationSource, "known-location");
  assert.equal(resolveCodexExecutable(undefined, fixture("win32", ["C:\\Users\\tester\\AppData\\Local\\Microsoft\\WinGet\\Links\\codex.exe"], {
    env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
  }))?.installationSource, "known-location");
});

test("Windows npm shims use the known Codex entry point and Node without a shell", () => {
  const executable = "C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd";
  const entryPoint = "C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";
  const options = fixture("win32", [executable, entryPoint, "C:\\node\\node.exe"], {
    env: { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" },
  });
  assert.deepEqual(resolveCodexExecutable(undefined, options), {
    executable, command: "C:\\node\\node.exe", args: [entryPoint], installationSource: "known-location",
  });
  assert.equal(resolveCodexExecutable(executable, options)?.installationSource, "explicit");
  assert.equal(resolveCodexExecutable("codex", { ...options, env: { PATH: "C:\\Users\\tester\\AppData\\Roaming\\npm" } })?.executable, executable);
  assert.throws(() => resolveCodexExecutable(executable, { ...options, execPath: "C:\\missing\\node.exe" }), /cannot be launched safely/);
});

test("unsupported Windows shims and scripts fail closed without reading their contents", () => {
  const candidates = ["C:\\custom\\codex.cmd", "C:\\custom\\codex.bat", "C:\\custom\\codex.js", "C:\\custom\\other.cmd"];
  const options = fixture("win32", [...candidates, "C:\\node\\node.exe"], { env: { PATH: "C:\\custom" } });
  assert.equal(resolveCodexExecutable(undefined, options), null);
  for (const selected of candidates) assert.throws(() => resolveCodexExecutable(selected, options), /cannot be launched safely/);
});

test("Windows lookup ignores relative and drive-relative directories", () => {
  const options = fixture("win32", ["C:\\project\\codex.exe", "C:\\project\\tools\\codex.exe"], {
    env: { PATH: ";.;tools;C:tools;\\tools;" },
  });
  assert.equal(resolveCodexExecutable(undefined, options), null);
  assert.throws(() => resolveCodexExecutable("C:tools\\codex.exe", options), /selected Codex executable/);
});
