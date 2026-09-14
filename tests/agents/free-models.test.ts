import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isVerifiedFree,
  isAutomaticModel,
} from "../../src/models/freePolicy.ts";
import {
  parseZenPricing,
  verifyZenCatalog,
} from "../../src/models/zenCatalog.ts";
import {
  evaluateFreeModels,
  scoreAnswer,
} from "../../src/models/evaluation.ts";
import { BENCHMARKS } from "../../src/models/benchmarks.ts";
import type { OpenCodeModel } from "../../src/agents/external/opencode.ts";
const free: OpenCodeModel = {
  id: "test",
  name: "Test",
  provider: "opencode",
  toolcall: true,
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
};
test("free eligibility rejects absent, positive, negative, string and nested pricing, unsupported tools and other providers", () => {
  assert.equal(isVerifiedFree(free), true);
  for (const cost of [
    undefined,
    {},
    { input: 0, output: 0 },
    { input: 0, output: 0, cache: { read: 0 } },
    { input: 0, output: 1, cache: { read: 0, write: 0 } },
    { input: 0, output: 0, cache: { read: 0, write: -1 } },
    { input: "0", output: 0, cache: { read: 0, write: 0 } },
    {
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
      context_over_200k: { input: 1 },
    },
  ])
    assert.equal(isVerifiedFree({ ...free, cost }), false);
  assert.equal(isVerifiedFree({ ...free, provider: "paid-provider" }), false);
  assert.equal(isVerifiedFree({ ...free, toolcall: false }), false);
});
const pricing =
  '<h2 id="pricing">Pricing</h2><table><thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cached Read</th><th>Cached Write</th></tr></thead><tbody><tr><td>Test</td><td>Free</td><td>Free</td><td>Free</td><td>-</td></tr></tbody></table>';
test("authoritative table and live model metadata both required", async () => {
  assert.equal(parseZenPricing(pricing).length, 1);
  assert.equal(parseZenPricing("<p>Test is free</p>").length, 0);
  const verified = await verifyZenCatalog(
    [free, { ...free, id: "other", name: "Other Free" }],
    AbortSignal.timeout(1000),
    async () => new Response(pricing),
  );
  assert.deepEqual(
    verified.map((m) => m.id),
    ["test"],
  );
});
test("benchmarks require actual source tool action, correct semantics and citations", () => {
  const c = BENCHMARKS[0]!;
  const answer = {
    facts: c.expected,
    citations: [{ path: "obj_player/Create.gml", line: 1 }],
    uncertain: c.uncertain,
    gdscript:
      "func _physics_process(_delta: float) -> void:\n    position.x += 2",
  };
  assert.equal(scoreAnswer(c, answer, true), 100);
  assert.equal(scoreAnswer(c, answer, false), 0);
  assert.equal(scoreAnswer(c, { ...answer, facts: {} }, true), 30);
  assert.equal(
    scoreAnswer(
      c,
      { ...answer, citations: [{ path: "fabricated.gml", line: 1 }] },
      true,
    ),
    0,
  );
});
test("free evaluation is sequential, capped at five, cached, and invalidated by metadata", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deep-model-test-"));
  let calls = 0,
    active = 0;
  try {
    const models = Array.from({ length: 7 }, (_, i) => ({
      ...free,
      id: `m${i}`,
    }));
    const run = async (_m: OpenCodeModel, c: (typeof BENCHMARKS)[number]) => {
      active++;
      assert.equal(active, 1);
      calls++;
      await Promise.resolve();
      active--;
      return {
        answer: {
          facts: c.expected,
          citations: [{ path: /^\/\/ (.+)/.exec(c.source)![1]!, line: 1 }],
          uncertain: c.uncertain,
          gdscript:
            "func _physics_process(_delta: float) -> void:\n    position.x += 2",
        },
        toolUsed: true,
      };
    };
    const options = {
      models,
      cacheDir: dir,
      signal: AbortSignal.timeout(10000),
      run,
    };
    const results = await evaluateFreeModels(options);
    assert.equal(results.length, 5);
    assert.equal(calls, 20);
    assert.ok(results.every((r) => r.passed));
    await evaluateFreeModels(options);
    assert.equal(calls, 20);
    await evaluateFreeModels({
      ...options,
      models: [{ ...free, id: "changed" }],
    });
    assert.equal(calls, 24);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("automatic-free client model token selects automatic evaluation", () => {
  assert.equal(isAutomaticModel("automatic-free"), true);
  assert.equal(isAutomaticModel("selected-free-id"), false);
});

test("transient budget/provider failures are not cached as seven-day semantic failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deep-eval-retry-"));
  let calls = 0;
  try {
    const options = {
      models: [free],
      cacheDir: dir,
      signal: AbortSignal.timeout(5000),
      run: async () => {
        calls++;
        throw new Error("Insufficient token budget");
      },
    };
    await evaluateFreeModels(options);
    await evaluateFreeModels(options);
    assert.equal(calls, 8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
