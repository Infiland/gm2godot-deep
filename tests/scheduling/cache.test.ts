import assert from "node:assert/strict";
import test from "node:test";

import { analysisCacheKey, type CacheKeyInput } from "../../src/scheduling/cache.ts";
import { sha256Text } from "../../src/util/sha256.ts";

const SOURCE_HASHES = {
  "scripts/scr_math/scr_math.gml": sha256Text("scr_math source"),
  "scripts/scr_math/scr_math.yy": sha256Text("scr_math metadata"),
};
const SCR_MATH_EDGE = {
  to: "script:scr_state",
  kind: "shared_state",
  contractVersions: { global_state: 1, callable_context: 1 },
} as const;
const SCR_STATE_EDGE = {
  to: "script:scr_math",
  kind: "calls",
  contractVersions: { callable_context: 1 },
} as const;

const BASE: CacheKeyInput = {
  unitId: "script:scr_math",
  sourceHashes: { ...SOURCE_HASHES },
  dependencyEdges: [
    { to: SCR_MATH_EDGE.to, kind: SCR_MATH_EDGE.kind, contractVersions: { ...SCR_MATH_EDGE.contractVersions } },
    { to: SCR_STATE_EDGE.to, kind: SCR_STATE_EDGE.kind, contractVersions: { ...SCR_STATE_EDGE.contractVersions } },
  ],
  baselineId: sha256Text("baseline"),
  gm2godotVersion: "0.7.74",
  godotVersion: "4.7.2.stable.official.ed1daf0bf",
  promptVersion: "1",
  model: "mock",
};

function keyOf(overrides: Partial<CacheKeyInput> = {}): string {
  return analysisCacheKey({ ...BASE, ...overrides });
}

test("the cache key is a sha256 digest and is stable for identical inputs", () => {
  const first = keyOf();
  assert.match(first, /^sha256:[0-9a-f]{64}$/);
  assert.equal(keyOf(), first);
});

test("input ordering does not change the cache key", () => {
  const reordered = analysisCacheKey({
    ...BASE,
    sourceHashes: {
      "scripts/scr_math/scr_math.yy": SOURCE_HASHES["scripts/scr_math/scr_math.yy"],
      "scripts/scr_math/scr_math.gml": SOURCE_HASHES["scripts/scr_math/scr_math.gml"],
    },
    dependencyEdges: [...BASE.dependencyEdges].reverse().map((edge) => ({
      to: edge.to,
      kind: edge.kind,
      contractVersions: Object.fromEntries(Object.entries(edge.contractVersions).reverse()),
    })),
  });
  assert.equal(reordered, keyOf());
});

test("every component of the key changes the digest when it changes", () => {
  const base = keyOf();
  const mutations: readonly (readonly [string, Partial<CacheKeyInput>])[] = [
    ["unitId", { unitId: "script:scr_state" }],
    [
      "a source hash",
      { sourceHashes: { ...SOURCE_HASHES, "scripts/scr_math/scr_math.gml": sha256Text("changed source") } },
    ],
    [
      "a dependency edge's contract version",
      {
        dependencyEdges: [
          {
            to: SCR_MATH_EDGE.to,
            kind: SCR_MATH_EDGE.kind,
            contractVersions: { global_state: 2, callable_context: 1 },
          },
          { to: SCR_STATE_EDGE.to, kind: SCR_STATE_EDGE.kind, contractVersions: { ...SCR_STATE_EDGE.contractVersions } },
        ],
      },
    ],
    [
      "a dependency edge's kind",
      {
        dependencyEdges: [
          { to: SCR_MATH_EDGE.to, kind: "resource_reference", contractVersions: { ...SCR_MATH_EDGE.contractVersions } },
          { to: SCR_STATE_EDGE.to, kind: SCR_STATE_EDGE.kind, contractVersions: { ...SCR_STATE_EDGE.contractVersions } },
        ],
      },
    ],
    [
      "a dependency edge's target",
      {
        dependencyEdges: [
          { to: "script:scr_other", kind: SCR_MATH_EDGE.kind, contractVersions: { ...SCR_MATH_EDGE.contractVersions } },
          { to: SCR_STATE_EDGE.to, kind: SCR_STATE_EDGE.kind, contractVersions: { ...SCR_STATE_EDGE.contractVersions } },
        ],
      },
    ],
    ["the baseline id", { baselineId: sha256Text("other baseline") }],
    ["the baseline being absent", { baselineId: null }],
    ["the gm2godot version", { gm2godotVersion: "0.7.75" }],
    ["the godot version", { godotVersion: "4.7.3.stable.official.deadbeef" }],
    ["the prompt version", { promptVersion: "2" }],
    ["the model", { model: "some-other-model" }],
    ["the model being unset", { model: null }],
  ];
  for (const [label, overrides] of mutations) {
    assert.notEqual(keyOf(overrides), base, `${label} must change the cache key`);
  }
});
