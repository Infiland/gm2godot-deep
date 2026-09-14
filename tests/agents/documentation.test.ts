import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DocumentationService,
  documentationRoot,
} from "../../src/documentation/service.ts";
test("documentation versions and URL guards preserve official version boundaries", async () => {
  assert.deepEqual(documentationRoot("godot", "4.7.2.stable"), {
    url: "https://docs.godotengine.org/en/4.7/",
    version: "4.7",
    fallback: false,
  });
  assert.equal(documentationRoot("gamemaker", "2024.11").fallback, true);
  const service = new DocumentationService(
    "/tmp/unused",
    { gamemaker: "monthly", godot: "4.7" },
    async () => {
      throw new Error("Unexpected fetch");
    },
  );
  for (const url of [
    "https://evil.example/page",
    "https://docs.godotengine.org/en/4.6/page.html",
    "https://docs.godotengine.org@evil.example/en/4.7/page.html",
    "https://docs.godotengine.org/en/4.7/../4.6/page.html",
  ])
    await assert.rejects(service.read("godot", url));
});
test("documentation stores verified citations, strips scripts, reads cache offline, and searches official index", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deep-doc-test-"));
  let requests = 0;
  const fetcher: typeof fetch = async (input) => {
    requests++;
    return new Response(
      String(input).endsWith("searchindex.js")
        ? 'Search.setIndex({"docnames":["classes/class_node","classes/class_refcounted"]});'
        : "<title>Node</title><script>malicious()</script><p>Node documentation.</p>",
    );
  };
  try {
    const service = new DocumentationService(
      dir,
      { gamemaker: "monthly", godot: "4.7" },
      fetcher,
    );
    const page = await service.read(
      "godot",
      "https://docs.godotengine.org/en/4.7/classes/class_node.html",
    );
    assert.equal(page.title, "Node");
    assert.ok(!page.text.includes("malicious"));
    assert.equal(page.contentHash.length, 64);
    assert.equal(page.fallback, false);
    const offline = new DocumentationService(
      dir,
      { gamemaker: "monthly", godot: "4.7" },
      async () => {
        throw new Error("offline");
      },
    );
    assert.equal((await offline.read("godot", page.url)).cached, true);
    assert.equal(requests, 1);
    const results = await service.search("godot", "node");
    assert.equal(results[0]?.url, page.url);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
