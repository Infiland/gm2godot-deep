import assert from "node:assert/strict";
import test from "node:test";

import { buildDependencies } from "../../src/analysis/dependencies.ts";
import { buildGraph } from "../../src/analysis/graph.ts";
import { applyGroups, findGroups } from "../../src/analysis/cycles.ts";
import { SCHEDULING_EDGE_KINDS } from "../../src/analysis/edges.ts";
import { loadFixture } from "../helpers/environment.ts";

test("scr_math and scr_state form one cycle group, scheduled as a single merged unit", async () => {
  const env = await loadFixture();
  try {
    const report = buildDependencies({
      snapshotDir: env.snapshotDir,
      units: env.inventory.units,
      bridge: env.bridge,
      gmlApiEntries: env.gmlApi,
    });
    const graph = buildGraph(env.inventory.units, report);
    const groups = findGroups(graph, env.inventory.units);

    assert.equal(groups.length, 1, `expected exactly one cycle group, got ${groups.map((group) => group.id).join(", ")}`);
    const group = groups[0];
    assert.ok(group !== undefined);
    assert.equal(group.kind, "cycle");
    assert.ok(group.unitIds.includes("script:scr_math"));
    assert.ok(group.unitIds.includes("script:scr_state"));
    assert.deepEqual(group.unitIds, ["object:obj_counter", "room:rm_main", "script:scr_math", "script:scr_state"]);

    // Every cited edge is a real confirmed edge, and both directions of the script cycle are named.
    const confirmed = new Set(report.edges.filter((edge) => edge.confidence === "confirmed").map((edge) => edge.id));
    for (const id of group.evidence ?? []) assert.ok(confirmed.has(id), `${id} must be a confirmed edge`);
    assert.ok(group.evidence?.includes("script:scr_state->script:scr_math:calls"));
    assert.ok(group.evidence?.includes("script:scr_math->script:scr_state:shared_state"));
    assert.ok(group.reason.includes("scheduled as one task"), group.reason);

    const merged = applyGroups(env.inventory.units, groups);
    const carriers = merged.filter((unit) => unit.memberUnitIds !== undefined);
    assert.equal(carriers.length, 1, "exactly one unit represents the cycle group");
    const mergedUnit = carriers[0];
    assert.ok(mergedUnit !== undefined);
    assert.deepEqual(mergedUnit.memberUnitIds, group.unitIds);
    assert.equal(mergedUnit.analysisRequired, true);
    assert.ok(mergedUnit.sourcePaths.includes("scripts/scr_math/scr_math.gml"));
    assert.ok(mergedUnit.sourcePaths.includes("scripts/scr_state/scr_state.gml"));
    assert.ok(!merged.some((unit) => unit.id === "script:scr_math"), "merged members are not scheduled twice");
    assert.ok(!merged.some((unit) => unit.id === "script:scr_state"), "merged members are not scheduled twice");

    // Units outside the cycle pass through unchanged.
    assert.ok(merged.some((unit) => unit.id === "object:obj_counter_child"));
    assert.ok(merged.some((unit) => unit.id === "sprite:spr_counter"));
  } finally {
    env.cleanup();
  }
});

test("the condensation order respects every scheduling edge", async () => {
  const env = await loadFixture();
  try {
    const report = buildDependencies({
      snapshotDir: env.snapshotDir,
      units: env.inventory.units,
      bridge: env.bridge,
      gmlApiEntries: env.gmlApi,
    });
    const graph = buildGraph(env.inventory.units, report);

    // The components partition the node set exactly once each, and a node's component id is one of its members.
    const position = new Map<string, number>();
    const seen = new Set<string>();
    for (const [index, members] of graph.condensationOrder.entries()) {
      assert.ok(members.length > 0, "a component is never empty");
      for (const member of members) {
        assert.ok(!seen.has(member), `${member} appears in two components`);
        seen.add(member);
        assert.equal(graph.sccOf[member], members[0]);
        position.set(member, index);
      }
    }
    assert.deepEqual([...seen].sort(), graph.nodes, "every node belongs to a component");

    const schedulingKinds = new Set<string>(SCHEDULING_EDGE_KINDS);
    for (const edge of graph.edges) {
      if (!schedulingKinds.has(edge.kind)) continue;
      if (graph.sccOf[edge.from] === graph.sccOf[edge.to]) continue;
      const from = position.get(edge.from);
      const to = position.get(edge.to);
      assert.ok(from !== undefined, `${edge.from} must be in a component`);
      assert.ok(to !== undefined, `${edge.to} must be in a component`);
      assert.ok(from < to, `${edge.id} must point forwards in the condensation order`);
    }

    // The condensation deliberately ignores shared_state: the script cycle is one task because the
    // cycle detector reads the wider edge set, not because the scheduling graph collapsed it.
    assert.equal(graph.sccOf["script:scr_math"], "script:scr_math");
    assert.equal(graph.sccOf["script:scr_state"], "script:scr_state");
    assert.ok(findGroups(graph, env.inventory.units).some((group) => group.unitIds.includes("script:scr_math")));

    // A room's confirmed room_creation self-loop is a fact, not a one-unit cycle.
    assert.ok(report.edges.some((edge) => edge.id === "room:rm_main->room:rm_main:room_creation"));
    assert.equal(
      findGroups(graph, env.inventory.units).filter((group) => group.unitIds.length === 1).length,
      0,
      "a self-loop must not become a one-unit group",
    );
  } finally {
    env.cleanup();
  }
});
