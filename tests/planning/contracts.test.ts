import assert from "node:assert/strict";
import test from "node:test";

import { analysisCacheKey } from "../../src/scheduling/cache.ts";
import { invalidateForContractChange } from "../../src/scheduling/cache.ts";
import { sha256Text } from "../../src/util/sha256.ts";
import { tempRepo } from "../helpers/environment.ts";
import type { Repo } from "../../src/storage/repo.ts";

const GLOBAL_STATE = "global_state";
const TIMING_RANDOM = "timing_random";

/** Source hashes that never change across the bump: a contract change alone must re-key the unit. */
const HASHES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "script:scr_math": { "scripts/scr_math/scr_math.gml": sha256Text("scr_math") },
  "object:obj_counter": { "objects/obj_counter/Step_0.gml": sha256Text("Step_0") },
  "script:scr_state": { "scripts/scr_state/scr_state.gml": sha256Text("scr_state") },
  "sprite:spr_counter": { "sprites/spr_counter/spr_counter.yy": sha256Text("spr_counter") },
};

function insertUnits(repo: Repo): void {
  for (const [id, sourceHashes] of Object.entries(HASHES)) {
    const [kind = "script", name = id] = id.split(":");
    repo.upsertUnit({
      id,
      kind,
      name,
      analysisRequired: true,
      deterministic: false,
      state: "ANALYZED",
      sourceHashes: { ...sourceHashes },
    });
  }
}

function cacheKeyFor(unitId: string, contractVersions: Record<string, number>): string {
  return analysisCacheKey({
    unitId,
    sourceHashes: { ...(HASHES[unitId] ?? {}) },
    dependencyEdges:
      unitId === "sprite:spr_counter"
        ? []
        : [{ to: unitId === "script:scr_math" ? "script:scr_state" : "script:scr_math", kind: "shared_state", contractVersions }],
    baselineId: sha256Text("baseline"),
    gm2godotVersion: "0.7.74",
    godotVersion: "4.7.2.stable.official.ed1daf0bf",
    promptVersion: "1",
    model: "mock",
  });
}

test("bumping a concern's version re-keys exactly the units bound to it, even when their sources are unchanged", () => {
  const { repo, cleanup } = tempRepo("gm2deep-contracts");
  try {
    insertUnits(repo);
    repo.upsertContract({
      concern: GLOBAL_STATE,
      version: 1,
      path: "evidence/contracts/global_state.v1.json",
      sha256: sha256Text("global_state v1"),
      policy: { needsReview: false, rationale: "seeded from the baseline" },
    });
    repo.bindContractRule(GLOBAL_STATE, 1, "script:scr_math", "global_state.r1");
    repo.bindContractRule(GLOBAL_STATE, 1, "object:obj_counter", "global_state.r1");
    repo.bindContractRule(TIMING_RANDOM, 1, "script:scr_state", "timing_random.r1");
    // A v2 binding must not be affected by a v1 -> v2 bump of the same concern.
    repo.bindContractRule(GLOBAL_STATE, 2, "script:scr_state", "global_state.r1");

    const beforeKeys = {
      math: cacheKeyFor("script:scr_math", { [GLOBAL_STATE]: 1 }),
      counter: cacheKeyFor("object:obj_counter", { [GLOBAL_STATE]: 1 }),
      state: cacheKeyFor("script:scr_state", { [TIMING_RANDOM]: 1 }),
      sprite: cacheKeyFor("sprite:spr_counter", {}),
    };
    const before: Readonly<Record<string, string>> = {
      "script:scr_math": beforeKeys.math,
      "object:obj_counter": beforeKeys.counter,
      "script:scr_state": beforeKeys.state,
      "sprite:spr_counter": beforeKeys.sprite,
    };
    for (const [unitId, key] of Object.entries(before)) repo.putCacheEntry(key, unitId, "analysis", { unitId });

    // After the bump each bound unit's edges carry the new version; unbound units are untouched.
    const mathAfter = cacheKeyFor("script:scr_math", { [GLOBAL_STATE]: 2 });
    const counterAfter = cacheKeyFor("object:obj_counter", { [GLOBAL_STATE]: 2 });
    assert.notEqual(mathAfter, beforeKeys.math, "a re-keyed unit must get a new cache key");
    assert.notEqual(counterAfter, beforeKeys.counter, "a re-keyed unit must get a new cache key");

    const outcome = invalidateForContractChange(repo, GLOBAL_STATE, 1, 2);
    assert.equal(outcome.concern, GLOBAL_STATE);
    assert.equal(outcome.fromVersion, 1);
    assert.equal(outcome.toVersion, 2);
    assert.deepEqual(outcome.affectedUnitIds, ["object:obj_counter", "script:scr_math"]);

    const invalidations = repo.listInvalidations();
    assert.equal(invalidations.length, 2, "one invalidation row per affected unit");
    assert.deepEqual(
      invalidations.map((row) => row.unitId).sort(),
      ["object:obj_counter", "script:scr_math"],
    );
    for (const row of invalidations) {
      assert.equal(row.kind, "contract_change");
      assert.equal(row.concern, GLOBAL_STATE);
      assert.equal(row.fromVersion, 1);
      assert.equal(row.toVersion, 2);
      assert.ok(JSON.stringify(row.detail).includes("global_state.r1"));
    }

    // The affected units' cached analyses are dropped; unrelated entries survive with the same key.
    assert.equal(repo.getCacheEntry(beforeKeys.math), null);
    assert.equal(repo.getCacheEntry(beforeKeys.counter), null);
    assert.equal(repo.getCacheEntry(beforeKeys.state)?.unitId, "script:scr_state");
    assert.equal(repo.getCacheEntry(beforeKeys.sprite)?.unitId, "sprite:spr_counter");
    assert.deepEqual(
      repo.listCacheEntries().map((entry) => entry.unitId).sort(),
      ["script:scr_state", "sprite:spr_counter"],
    );
  } finally {
    cleanup();
  }
});
