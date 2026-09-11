import assert from "node:assert/strict";
import test from "node:test";

import { buildDependencies } from "../../src/analysis/dependencies.ts";
import type { DependencyEdge, DependencyReport } from "../../src/analysis/edges.ts";
import { loadFixture } from "../helpers/environment.ts";

function findEdge(report: DependencyReport, from: string, to: string, kind: string): DependencyEdge {
  const edge = report.edges.find((candidate) => candidate.from === from && candidate.to === to && candidate.kind === kind);
  assert.ok(edge !== undefined, `expected an edge ${from} -> ${to} (${kind})`);
  return edge;
}

/** Every resolved edge the fixture is documented to produce on the real sources. */
async function fixtureReport(): Promise<{ report: DependencyReport; cleanup: () => void }> {
  const env = await loadFixture();
  const report = buildDependencies({
    snapshotDir: env.snapshotDir,
    units: env.inventory.units,
    bridge: env.bridge,
    gmlApiEntries: env.gmlApi,
  });
  return { report, cleanup: env.cleanup };
}

test("the fixture's structural and shared-state edges are computed as confirmed, with evidence", async () => {
  const { report, cleanup } = await fixtureReport();
  try {
    const inherits = findEdge(report, "object:obj_counter_child", "object:obj_counter", "inherits");
    assert.equal(inherits.confidence, "confirmed");
    assert.ok(inherits.evidence.some((location) => location.path === "objects/obj_counter_child/obj_counter_child.yy"));

    const instance = findEdge(report, "room:rm_main", "object:obj_counter", "instance_creation");
    assert.equal(instance.confidence, "confirmed");
    assert.ok(instance.evidence.some((location) => location.path === "rooms/rm_main/rm_main.yy"));

    const roomCreation = findEdge(report, "room:rm_main", "room:rm_main", "room_creation");
    assert.equal(roomCreation.confidence, "confirmed");
    assert.ok(roomCreation.evidence.some((location) => location.path === "rooms/rm_main/rm_main.yy"));

    // global.counter is written by obj_counter's Step event and by the room's creation code, and read
    // (and written) by both scripts: every ordered pair of distinct units touching it is a
    // confirmed shared_state edge, which is what makes the two-unit cycle detectable.
    const bothWays: readonly (readonly [string, string])[] = [
      ["object:obj_counter", "room:rm_main"],
      ["script:scr_math", "script:scr_state"],
      ["script:scr_state", "script:scr_math"],
    ];
    for (const [from, to] of bothWays) {
      const edge = findEdge(report, from, to, "shared_state");
      assert.equal(edge.confidence, "confirmed");
      assert.ok(edge.evidence.length > 0, `${from} -> ${to} must cite the global it shares`);
      assert.ok(edge.basis?.includes("global.counter"), "the shared global must be named in the basis");
    }

    // A shared_state edge must never be invented between units that do not both touch the global.
    const scriptToObject = report.edges.find(
      (edge) => edge.from === "script:scr_state" && edge.to === "object:obj_counter_child",
    );
    assert.equal(scriptToObject, undefined, "obj_counter_child does not touch global.counter");
  } finally {
    cleanup();
  }
});

test("a call to a function defined in a script resource becomes a confirmed calls edge", async () => {
  const { report, cleanup } = await fixtureReport();
  try {
    // scr_state_advance calls scr_math_add, which scr_math.gml defines: the callee must resolve to the
    // script resource that owns it, with the call site as evidence.
    const fromState = findEdge(report, "script:scr_state", "script:scr_math", "calls");
    assert.equal(fromState.confidence, "confirmed");
    const callSite = fromState.evidence.find((location) => location.path === "scripts/scr_state/scr_state.gml");
    assert.ok(callSite !== undefined, "the call site must be cited");
    assert.ok(callSite.snippet.includes("scr_math_add"), callSite.snippet);

    for (const caller of ["object:obj_counter", "object:obj_counter_child"]) {
      const edge = findEdge(report, caller, "script:scr_math", "calls");
      assert.equal(edge.confidence, "confirmed");
      assert.ok(edge.evidence.length > 0, `${caller} must cite its call site`);
    }

    // A resolved call is not also reported as unresolved: the two lists must not disagree.
    for (const entry of report.unresolved) assert.notEqual(entry.symbol, "scr_math_add");
  } finally {
    cleanup();
  }
});

test("dynamic script and asset references are recorded as unresolved, never dropped", async () => {
  const { report, cleanup } = await fixtureReport();
  try {
    const scrState = report.unresolved.filter((entry) => entry.unitId === "script:scr_state");
    for (const symbol of ["script_execute", "asset_get_index"]) {
      const entries = scrState.filter((entry) => entry.symbol === symbol);
      assert.ok(entries.length > 0, `${symbol} must be reported as unresolved`);
      for (const entry of entries) {
        assert.ok(entry.reason.length > 0, `${symbol} must carry the reason it stayed unresolved`);
        assert.ok(entry.evidence.length > 0, `${symbol} must carry an evidence location`);
        for (const location of entry.evidence) {
          assert.equal(location.path, "scripts/scr_state/scr_state.gml");
          assert.ok(location.line > 0 && location.column > 0);
          assert.ok(location.snippet.length > 0);
        }
      }
    }

    // Every unresolved entry is attributable: known unit, non-empty reason, real location.
    const unitIds = new Set(report.unresolved.map((entry) => entry.unitId));
    for (const entry of report.unresolved) {
      assert.ok(unitIds.has(entry.unitId));
      assert.ok(entry.reason.length > 0);
      assert.ok(entry.evidence.length > 0);
    }
    assert.deepEqual(
      [...new Set(report.unresolved.map((entry) => entry.symbol))].sort(),
      ["asset_get_index", "script_execute"],
      "the fixture resolves every other call target, so only the two dynamic lookups stay unresolved",
    );
  } finally {
    cleanup();
  }
});

test("a call to a GML API entry produces api_usage with the upstream support status instead of an edge", async () => {
  const { report, cleanup } = await fixtureReport();
  try {
    const usage = report.apiUsage.find((record) => record.api === "instance_position");
    assert.ok(usage !== undefined, "Step_0.gml calls instance_position");
    assert.equal(usage.unitId, "object:obj_counter");
    assert.equal(usage.status, "partial");
    assert.equal(usage.issueNumber, 487);
    assert.ok(usage.evidence.some((location) => location.path === "objects/obj_counter/Step_0.gml" && location.line > 0));
  } finally {
    cleanup();
  }
});
