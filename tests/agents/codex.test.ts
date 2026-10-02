import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { discoverAgent } from "../../src/agents/capabilities.ts";
import { CodexConnection, codexTransport } from "../../src/agents/external/codex.ts";
import type { CompletionRequest } from "../../src/agents/external/transport.ts";
import { TransportFailure } from "../../src/agents/external/transport.ts";
import { fakeCodex, waitForCodexRecord } from "../helpers/fakeCodex.ts";
import { sampleConfig } from "../helpers/harness.ts";
import { verifySelection } from "../../src/host/selection.ts";

function request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    system: "Return synthetic structured JSON through the host relay.",
    prompt: "Synthetic prompt only", model: "synthetic-model", provider: "codex",
    schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
    signal: AbortSignal.timeout(5000), maxTokens: 100, ...overrides,
  };
}

function assertStartupIsolation(argv: string[]): void {
  for (const feature of ["hooks", "plugins", "shell_tool", "unified_exec", "apps", "multi_agent"])
    assert.ok(argv.some((argument, index) => argument === "--disable" && argv[index + 1] === feature));
  assert.ok(argv.includes('web_search="disabled"'));
  assert.ok(argv.includes("mcp_servers={}"));
  assert.ok(argv.includes("project_doc_max_bytes=0"));
}

test("Codex discovery reuses sign-in safely, pages models and never starts inference", async () => {
  const fixture = fakeCodex({ pages: [
    { data: [{ id: "picker-id", model: "synthetic-model", displayName: "Synthetic model" }], nextCursor: "next" },
    { data: [{ id: "synthetic-model" }, { id: "another-model" }], nextCursor: null },
  ] });
  try {
    const capability = await discoverAgent({ runtime: "codex", executable: fixture.executable, provider: "codex", signal: AbortSignal.timeout(5000) });
    assert.equal(capability.installed, true);
    assert.equal(capability.executable, fixture.executable);
    assert.equal(capability.installationSource, "explicit");
    assert.equal(capability.authenticated, true);
    assert.equal(capability.authMode, "chatgpt");
    assert.equal(capability.discoveryStatus, "ready");
    assert.deepEqual(capability.models.map((model) => [model.id, model.provider, model.providerName]), [
      ["synthetic-model", "codex", "Codex configured provider"],
      ["another-model", "codex", "Codex configured provider"],
    ]);
    assert.ok(!JSON.stringify(capability).includes("secret"));
    const records = fixture.records();
    assert.deepEqual(records.filter((record) => record.method).map((record) => record.method), ["initialize", "initialized", "account/read", "model/list", "model/list"]);
    assert.deepEqual(records.find((record) => record.method === "account/read")?.params, { refreshToken: false });
    assert.deepEqual(records.filter((record) => record.method === "model/list")[1]?.params, { limit: 100, cursor: "next" });
    const startup = records[0]!;
    assertStartupIsolation(startup.argv!);
    assert.ok(!startup.argv!.some((argument) => argument.startsWith("model_provider=")));
    assert.ok(startup.cwd?.includes("gm2deep-discover-"));
    assert.equal(existsSync(startup.cwd!), false);
  } finally { fixture.cleanup(); }
});

test("Codex discovery distinguishes login-required, API account and auth-free configured providers", async () => {
  for (const [account, authenticated, authMode, status] of [
    [{ account: null, requiresOpenaiAuth: true }, false, null, "login-required"],
    [{ account: null, requiresOpenaiAuth: false }, null, null, "ready"],
    [{ account: null }, null, null, "unavailable"],
    [{ account: { type: "apiKey", apiKey: "secret-key" }, requiresOpenaiAuth: true }, true, "apiKey", "ready"],
    [{ account: { type: "amazonBedrock" }, requiresOpenaiAuth: false }, true, "other", "ready"],
  ] as const) {
    const fixture = fakeCodex({ account });
    try {
      const capability = await discoverAgent({ runtime: "codex", executable: fixture.executable, signal: AbortSignal.timeout(5000) });
      assert.equal(capability.installed, true);
      assert.equal(capability.authenticated, authenticated);
      assert.equal(capability.authMode, authMode);
      assert.equal(capability.discoveryStatus, status);
      assert.equal(capability.models[0]?.authenticated, authenticated);
      assert.ok(!JSON.stringify(capability).includes("secret"));
      if (status === "login-required") assert.match(capability.reason!, /codex login/);
      if ("requiresOpenaiAuth" in account && account.requiresOpenaiAuth === false && authenticated === null) assert.doesNotMatch(capability.reason!, /sign-in is required/);
    } finally { fixture.cleanup(); }
  }
});

test("installed Codex with protocol errors stays distinguishable from an invalid executable", async () => {
  for (const scenario of ["initialize-error", "bad-wire", "bad-account", "model-error", "repeated-cursor"] as const) {
    const fixture = fakeCodex({ scenario });
    try {
      const capability = await discoverAgent({ runtime: "codex", executable: fixture.executable, signal: AbortSignal.timeout(5000) });
      assert.equal(capability.installed, true);
      assert.equal(capability.discoveryStatus, "unavailable");
      assert.deepEqual(capability.models, []);
      assert.match(capability.reason!, /update Codex/);
      assert.ok(!JSON.stringify(capability).includes("secret"));
    } finally { fixture.cleanup(); }
  }
  const missing = await discoverAgent({ runtime: "codex", executable: "/missing/synthetic-codex", signal: AbortSignal.timeout(5000) });
  assert.equal(missing.installed, false);
  assert.equal(missing.discoveryStatus, "unavailable");
  assert.match(missing.reason!, /clear it to detect/);
});

test("Codex discovery and conversion preserve custom providers without shell interpolation", async () => {
  const fixture = fakeCodex();
  const provider = 'custom "provider"; literal';
  try {
    const capability = await discoverAgent({ runtime: "codex", executable: fixture.executable, provider, signal: AbortSignal.timeout(5000) });
    assert.equal(capability.models[0]?.provider, provider);
    const transport = codexTransport(fixture.executable, fixture.directory);
    try { assert.deepEqual((await transport.complete(request({ provider }))).value, { ok: true }); }
    finally { await transport.close(); }
    const records = fixture.records();
    for (const startup of records.filter((record) => record.event === "started"))
      assert.ok(startup.argv!.includes(`model_provider=${JSON.stringify(provider)}`));
    assert.equal(records.find((record) => record.method === "thread/start")?.params?.["modelProvider"], provider);
  } finally { fixture.cleanup(); }
});

test("Codex conversion returns structured output and usage while denying native tools and approvals", async () => {
  const fixture = fakeCodex();
  const transport = codexTransport(fixture.executable, fixture.directory);
  try {
    const completion = await transport.complete(request());
    assert.deepEqual(completion.value, { ok: true });
    assert.deepEqual(completion.usage, { input: 10, output: 3, cacheRead: 2, cacheWrite: 0, costUsd: 0, reported: true });
    const records = fixture.records();
    assertStartupIsolation(records[0]!.argv!);
    const start = records.find((record) => record.method === "thread/start")!.params!;
    assert.equal(start["modelProvider"], null);
    assert.equal(start["allowProviderModelFallback"], false);
    assert.equal(start["sandbox"], "read-only");
    assert.equal(start["approvalPolicy"], "never");
    assert.equal(start["ephemeral"], true);
    assert.deepEqual(start["selectedCapabilityRoots"], []);
    assert.deepEqual(start["dynamicTools"], []);
    const config = start["config"] as Record<string, unknown>;
    assert.equal(config["features.hooks"], false);
    assert.equal(config["features.plugins"], false);
    assert.deepEqual(config["mcp_servers"], {});
    const turn = records.find((record) => record.method === "turn/start")!.params!;
    assert.deepEqual(turn["outputSchema"], request().schema);
    for (const identifier of ["native-tool", "native-approval"])
      assert.equal(records.find((record) => record.id === identifier)?.error?.["code"], -32601);
  } finally { await transport.close(); fixture.cleanup(); }
});

test("Codex conversion failures retain reported usage and hide provider diagnostics", async () => {
  for (const scenario of ["bad-json", "failed-turn", "disconnect", "turn-error"] as const) {
    const fixture = fakeCodex({ scenario });
    const transport = codexTransport(fixture.executable, fixture.directory);
    try {
      await assert.rejects(transport.complete(request()), (error: unknown) => {
        assert.ok(error instanceof TransportFailure);
        assert.equal(error.usage.input, 10);
        assert.equal(error.usage.output, 3);
        assert.equal(error.usage.reported, true);
        assert.ok(!error.message.includes("secret"));
        return true;
      });
    } finally { await transport.close(); fixture.cleanup(); }
  }
});

test("Codex cancellation terminates an in-flight process and a pre-aborted call never launches", async () => {
  const fixture = fakeCodex({ scenario: "stall" });
  const transport = codexTransport(fixture.executable, fixture.directory);
  const controller = new AbortController();
  try {
    const completion = transport.complete(request({ signal: controller.signal }));
    void completion.catch(() => {});
    await waitForCodexRecord(fixture, (record) => record.method === "turn/start");
    controller.abort();
    await assert.rejects(completion, TransportFailure);
    const starts = fixture.records().filter((record) => record.event === "started").length;
    await assert.rejects(transport.complete(request({ signal: controller.signal })), TransportFailure);
    assert.equal(fixture.records().filter((record) => record.event === "started").length, starts);
    await transport.close();
  } finally { await transport.close(); fixture.cleanup(); }
});

test("Codex discovery cancellation preserves installed metadata and cleans its temporary directory", async () => {
  const fixture = fakeCodex({ scenario: "discovery-stall" });
  const controller = new AbortController();
  const discovery = discoverAgent({ runtime: "codex", executable: fixture.executable, signal: controller.signal });
  void discovery.catch(() => {});
  try {
    await waitForCodexRecord(fixture, (record) => record.method === "model/list");
    controller.abort();
    const capability = await discovery;
    assert.equal(capability.installed, true);
    assert.equal(capability.authenticated, true);
    assert.equal(capability.discoveryStatus, "unavailable");
    assert.match(capability.reason!, /interrupted/);
    assert.equal(existsSync(fixture.records()[0]!.cwd!), false);
    const starts = fixture.records().filter((record) => record.event === "started").length;
    await assert.rejects(discoverAgent({ runtime: "codex", executable: fixture.executable, signal: controller.signal }));
    assert.equal(fixture.records().filter((record) => record.event === "started").length, starts);
  } finally { controller.abort(); await discovery.catch(() => {}); fixture.cleanup(); }
});

test("Codex connection rejects calls after disconnection without hanging", async () => {
  const fixture = fakeCodex({ scenario: "bad-wire" });
  const connection = new CodexConnection(fixture.executable, fixture.directory);
  try {
    await assert.rejects(connection.call("initialize", {}), /disconnected/);
    await assert.rejects(connection.call("account/read", {}), /disconnected/);
    await Promise.all([connection.close(), connection.close()]);
  } finally { await connection.close(); fixture.cleanup(); }
});

test("discovery and conversion share automatic PATH detection", async () => {
  const fixture = fakeCodex();
  const previous = process.env["PATH"];
  process.env["PATH"] = dirname(fixture.executable);
  const transport = codexTransport(null, fixture.directory);
  try {
    const capability = await discoverAgent({ runtime: "codex", signal: AbortSignal.timeout(5000) });
    assert.equal(capability.executable, fixture.executable);
    assert.equal(capability.installationSource, "path");
    assert.deepEqual((await transport.complete(request())).value, { ok: true });
    assert.equal(fixture.records().filter((record) => record.event === "started").length, 2);
  } finally {
    if (previous === undefined) delete process.env["PATH"]; else process.env["PATH"] = previous;
    await transport.close(); fixture.cleanup();
  }
});

test("selection preflight detects a differing role runtime without the base Codex executable", { skip: process.platform === "win32" }, async () => {
  const fixture = fakeCodex();
  const claude = join(dirname(fixture.executable), "claude");
  copyFileSync(fixture.executable, claude);
  const previous = process.env["PATH"];
  process.env["PATH"] = dirname(fixture.executable);
  try {
    const config = sampleConfig({ sourcePath: "/tmp/source", workspacePath: "/tmp/work" });
    config.agent.runtime = "codex";
    config.agent.provider = "codex";
    config.agent.model = null;
    config.agent.executable = fixture.executable;
    config.agent.roleOverrides = { reviewer: { runtime: "claude" } };
    await verifySelection(config.agent);
    const starts = fixture.records().filter((record) => record.event === "started");
    assert.equal(starts.length, 2);
    assert.equal(starts[0]?.executable, fixture.executable);
    assert.equal(starts[1]?.executable, claude);
    assert.deepEqual(starts[1]?.argv, ["auth", "status", "--json"]);
  } finally {
    if (previous === undefined) delete process.env["PATH"]; else process.env["PATH"] = previous;
    fixture.cleanup();
  }
});
