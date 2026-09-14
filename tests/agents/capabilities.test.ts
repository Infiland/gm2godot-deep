import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgent } from "../../src/agents/capabilities.ts";
import { ZEN_PRICING_URL } from "../../src/models/zenCatalog.ts";

test("OpenCode discovery exposes names, verified pricing and provider auth metadata without credentials", async () => {
  const directory = mkdtempSync(join(tmpdir(), "deep-capabilities-test-"));
  const previous = process.env["XDG_DATA_HOME"];
  process.env["XDG_DATA_HOME"] = directory;
  mkdirSync(join(directory, "opencode"));
  writeFileSync(join(directory, "opencode", "auth.json"), JSON.stringify({
    "opencode-go": { type: "api", key: "secret-not-returned" },
    "empty": { type: "api", key: "" },
  }));
  const server = createServer((request, response) => {
    assert.equal(request.url, "/provider");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({
      all: [
        { id: "opencode-go", name: "OpenCode Go", models: {
          "deepseek-v4.1-flash": { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", capabilities: { toolcall: true }, cost: { input: 1, output: 1 } },
        } },
        { id: "opencode", name: "OpenCode Zen", models: {
          "free": { id: "free", name: "Free", capabilities: { toolcall: true }, cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } },
          "unknown": { id: "unknown", name: "Unknown free", capabilities: { toolcall: true }, cost: { input: 0, output: 0 } },
          "retired": { id: "retired", name: "Retired", capabilities: { toolcall: true }, status: "deprecated" },
        } },
      ], connected: [],
    }));
  });
  const originalFetch = globalThis.fetch;
  const fetchMock = mock.method(globalThis, "fetch", (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (url === ZEN_PRICING_URL) return Promise.resolve(new Response('<h2 id="pricing">Pricing</h2><table><tr><th>Model</th><th>Input</th><th>Output</th><th>Cached Read</th><th>Cached Write</th></tr><tr><td>Free</td><td>Free</td><td>Free</td><td>Free</td><td>Free</td></tr></table>'));
    return originalFetch(url, init);
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const capability = await discoverAgent({ runtime: "opencode", endpoint: `http://127.0.0.1:${address.port}`, password: "local-test", signal: AbortSignal.timeout(5000) });
    assert.equal(capability.installed, true);
    const go = capability.models.find((model) => model.provider === "opencode-go");
    assert.equal(go?.providerName, "OpenCode Go");
    assert.equal(go?.authenticated, true);
    assert.equal(go?.freeEligible, false);
    assert.equal(capability.models.find((model) => model.id === "free")?.freeEligible, true);
    assert.equal(capability.models.find((model) => model.id === "unknown")?.freeEligible, false);
    assert.equal(capability.models.find((model) => model.id === "unknown")?.authenticated, null);
    assert.equal(capability.models.find((model) => model.id === "retired")?.available, false);
    assert.ok(!JSON.stringify(capability).includes("secret-not-returned"));
  } finally {
    fetchMock.mock.restore();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previous === undefined) delete process.env["XDG_DATA_HOME"];
    else process.env["XDG_DATA_HOME"] = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
