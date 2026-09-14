import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedOpenCodeEnvironment } from "../../src/agents/external/opencodeEnvironment.ts";
test("managed OpenCode cannot inherit global config, plugins, MCPs, model overrides or unrelated authentication", () => {
  const root = mkdtempSync(join(tmpdir(), "deep-opencode-isolation-"));
  try {
    const source = join(root, "original", "opencode");
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, "auth.json"),
      JSON.stringify({
        chosen: { type: "api", key: "chosen-test-key" },
        other: { type: "api", key: "not-for-this-task" },
      }),
    );
    const inherited = {
      PATH: "/bin",
      OPENCODE_CONFIG: "/unsafe/user.json",
      OPENCODE_CONFIG_CONTENT:
        '{"plugin":["unsafe"],"small_model":"paid/model"}',
      OPENCODE_CONFIG_DIR: "/unsafe/config",
      OPENAI_API_KEY: "ambient-secret",
      XDG_DATA_HOME: join(root, "original"),
      XDG_CONFIG_HOME: "/unsafe/global",
    };
    const cwd = join(root, "private");
    const env = isolatedOpenCodeEnvironment(
      {
        cwd,
        password: "test",
        config: { plugin: [], mcp: {} },
        provider: "chosen",
        freeOnly: false,
      },
      inherited,
    );
    assert.equal(env["OPENCODE_CONFIG"], undefined);
    assert.equal(env["OPENAI_API_KEY"], undefined);
    assert.equal(env["XDG_CONFIG_HOME"], join(cwd, "config"));
    assert.equal(env["OPENCODE_CONFIG_DIR"], join(cwd, "config", "opencode"));
    assert.equal(env["OPENCODE_CONFIG_CONTENT"], '{"plugin":[],"mcp":{}}');
    assert.deepEqual(
      Object.keys(
        JSON.parse(
          readFileSync(join(cwd, "data", "opencode", "auth.json"), "utf8"),
        ),
      ),
      ["chosen"],
    );
    const free = join(root, "free");
    isolatedOpenCodeEnvironment(
      {
        cwd: free,
        password: "test",
        config: {},
        provider: "chosen",
        freeOnly: true,
      },
      inherited,
    );
    assert.equal(
      existsSync(join(free, "data", "opencode", "auth.json")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
