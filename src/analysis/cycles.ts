/**
 * Task grouping: which units must be handled together because they form a reference cycle, and which
 * must merely never run concurrently because their planned writes overlap.
 *
 * Cycle detection follows plan step 28: the cycle graph is every **confirmed** edge plus the
 * structural instance/room creation edges whatever their confidence. That is wider than
 * `buildGraph`'s condensation (which is `SCHEDULING_EDGE_KINDS` only, as the report artifact needs a
 * well-defined scheduling view) because a confirmed `shared_state` edge in both directions means two
 * units own the same global: they must be analyzed, planned and scheduled as one task, or the
 * schedule is unsound.
 */

import { DeepError } from "../util/result.ts";
import type { AnalysisUnit, UnitGeneratedOutput, UnitKind } from "../indexing/units.ts";
import { SCHEDULING_EDGE_KINDS, type DependencyEdge } from "./edges.ts";
import { stronglyConnectedComponents, type AnalysisGraph } from "./graph.ts";

export interface UnitGroup {
  readonly id: string;
  readonly kind: "cycle" | "shared_output";
  readonly reason: string;
  readonly unitIds: readonly string[];
  /** Edge ids (for `cycle`) or overlapping write roots (for `shared_output`) that justify the group. */
  readonly evidence?: readonly string[];
}

/**
 * Paths GM2Godot's generated runtime manages jointly: two tasks that touch the same one of these are
 * serialized by a single-writer mutex even when their write allowlists do not intersect. A root
 * *under* `gm2godot/managers` counts as touching `gm2godot/managers`.
 */
export const SHARED_OUTPUT_MUTEX_PATHS: readonly string[] = [
  "project.godot",
  "default_bus_layout.tres",
  "gm2godot/gml_runtime.gd",
  "gm2godot/managers",
  "gm2godot/gml_script_registry.gd",
  "gm2godot/gml_asset_registry.gd",
];

/** Workspace-relative roots as written by callers: drop `./`, collapse trailing slashes, keep `.`. */
function normalizeRoots(roots: readonly string[]): readonly string[] {
  const normalized: string[] = [];
  for (const raw of roots) {
    let root = raw.trim();
    while (root.startsWith("./")) root = root.slice(2);
    while (root.length > 1 && root.endsWith("/")) root = root.slice(0, -1);
    if (root.length === 0) continue;
    if (!normalized.includes(root)) normalized.push(root);
  }
  return normalized;
}

/** The mutex paths a set of write roots touches, in declaration order. */
export function mutexPathsFor(writeRoots: readonly string[]): readonly string[] {
  const roots = normalizeRoots(writeRoots);
  if (roots.includes(".")) return [...SHARED_OUTPUT_MUTEX_PATHS];
  return SHARED_OUTPUT_MUTEX_PATHS.filter((mutex) =>
    roots.some(
      (root) => root === mutex || root.startsWith(`${mutex}/`) || mutex.startsWith(`${root}/`),
    ),
  );
}

/**
 * Whether two sets of write roots overlap: an identical path, one path inside the other's directory,
 * or both touching a common jointly-managed path. The one predicate that decides concurrency, shared
 * with `findSharedOutputGroups` so `integration/conflicts.ts` cannot drift from it.
 */
export function writeRootsIntersect(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const a = normalizeRoots(left);
  const b = normalizeRoots(right);
  if (a.includes(".") && b.length > 0) return true;
  if (b.includes(".") && a.length > 0) return true;
  for (const x of a) {
    for (const y of b) {
      if (x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)) return true;
    }
  }
  const leftMutex = new Set(mutexPathsFor(a));
  return mutexPathsFor(b).some((mutex) => leftMutex.has(mutex));
}

/**
 * Cycle groups from the strongly-connected components of the cycle graph, plus single-member groups
 * for self-loops. A unit's own confirmed `room_creation` self-loop is the room running its creation
 * code — a fact, not a cycle — so it never forms a group.
 */
export function findGroups(graph: AnalysisGraph, units: readonly AnalysisUnit[]): readonly UnitGroup[] {
  const unitIds = new Set(units.map((unit) => unit.id));
  const schedulingKinds = new Set<string>(SCHEDULING_EDGE_KINDS);
  const cycleEdges = graph.edges.filter(
    (edge) =>
      unitIds.has(edge.from) &&
      unitIds.has(edge.to) &&
      (edge.confidence === "confirmed" ||
        edge.kind === "instance_creation" ||
        edge.kind === "room_creation"),
  );

  const nodes = [...unitIds].sort();
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node, []);
  for (const edge of cycleEdges) {
    const targets = adjacency.get(edge.from);
    if (targets === undefined) continue;
    if (!targets.includes(edge.to)) targets.push(edge.to);
  }

  const selfLoops = new Map<string, DependencyEdge[]>();
  for (const edge of cycleEdges) {
    if (edge.from !== edge.to) continue;
    if (!schedulingKinds.has(edge.kind)) continue;
    if (edge.kind === "room_creation" && edge.confidence === "confirmed") continue;
    const loops = selfLoops.get(edge.from);
    if (loops === undefined) selfLoops.set(edge.from, [edge]);
    else loops.push(edge);
  }

  const groups: UnitGroup[] = [];
  for (const members of stronglyConnectedComponents(nodes, adjacency)) {
    const only = members.length === 1 ? members[0] : undefined;
    if (members.length === 1 && (only === undefined || !selfLoops.has(only))) continue;
    const evidence = cycleEdges
      .filter((edge) => members.includes(edge.from) && members.includes(edge.to))
      .map((edge) => edge.id)
      .sort();
    groups.push({
      id: `cycle:${members.join("+")}`,
      kind: "cycle",
      reason:
        members.length === 1
          ? `unit references itself (${evidence.join(", ")}); scheduled as one task`
          : `strongly-connected component of ${members.length} units; scheduled as one task`,
      unitIds: members,
      evidence,
    });
  }
  return groups.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Units whose planned write roots overlap, one group per connected component of that intersection
 * graph. These groups never merge units — they serialize them.
 */
export function findSharedOutputGroups(
  units: readonly AnalysisUnit[],
  taskWriteRoots: Readonly<Record<string, readonly string[]>>,
): readonly UnitGroup[] {
  const rootsByUnit = new Map<string, readonly string[]>();
  for (const unit of units) {
    const roots = normalizeRoots(taskWriteRoots[unit.id] ?? []);
    if (roots.length > 0) rootsByUnit.set(unit.id, roots);
  }

  const parent = new Map<string, string>();
  for (const id of rootsByUnit.keys()) parent.set(id, id);
  const find = (id: string): string => {
    let root = id;
    for (;;) {
      const next = parent.get(root);
      if (next === undefined || next === root) break;
      root = next;
    }
    let cursor = id;
    while (cursor !== root) {
      const next = parent.get(cursor);
      parent.set(cursor, root);
      if (next === undefined) break;
      cursor = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;
    if (rootA < rootB) parent.set(rootB, rootA);
    else parent.set(rootA, rootB);
  };

  const unitsByRoot = new Map<string, string[]>();
  for (const [unitId, roots] of rootsByUnit) {
    for (const root of roots) {
      const owners = unitsByRoot.get(root);
      if (owners === undefined) unitsByRoot.set(root, [unitId]);
      else owners.push(unitId);
    }
  }
  for (const owners of unitsByRoot.values()) {
    const first = owners[0];
    if (first === undefined) continue;
    for (const owner of owners.slice(1)) union(first, owner);
  }
  // A root that is a directory containing another root's file (or vice versa) also overlaps.
  for (const [root, owners] of unitsByRoot) {
    const segments = root.split("/");
    for (let end = segments.length - 1; end >= 1; end -= 1) {
      const enclosing = unitsByRoot.get(segments.slice(0, end).join("/"));
      if (enclosing === undefined) continue;
      for (const owner of owners) for (const other of enclosing) union(owner, other);
    }
  }
  const unitsByMutex = new Map<string, string[]>();
  for (const [unitId, roots] of rootsByUnit) {
    for (const mutex of mutexPathsFor(roots)) {
      const owners = unitsByMutex.get(mutex);
      if (owners === undefined) unitsByMutex.set(mutex, [unitId]);
      else if (!owners.includes(unitId)) owners.push(unitId);
    }
  }
  for (const owners of unitsByMutex.values()) {
    const first = owners[0];
    if (first === undefined) continue;
    for (const owner of owners.slice(1)) union(first, owner);
  }

  const membersByRoot = new Map<string, string[]>();
  for (const id of rootsByUnit.keys()) {
    const root = find(id);
    const members = membersByRoot.get(root);
    if (members === undefined) membersByRoot.set(root, [id]);
    else members.push(id);
  }

  const groups: UnitGroup[] = [];
  for (const members of membersByRoot.values()) {
    if (members.length < 2) continue;
    const sorted = members.slice().sort();
    const overlaps = new Set<string>();
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const leftId = sorted[i];
        const rightId = sorted[j];
        if (leftId === undefined || rightId === undefined) continue;
        for (const left of rootsByUnit.get(leftId) ?? []) {
          for (const right of rootsByUnit.get(rightId) ?? []) {
            if (left === right) overlaps.add(left);
            else if (left.startsWith(`${right}/`)) overlaps.add(right);
            else if (right.startsWith(`${left}/`)) overlaps.add(left);
          }
        }
      }
    }
    for (const [mutex, owners] of unitsByMutex) {
      if (owners.filter((owner) => sorted.includes(owner)).length > 1) overlaps.add(mutex);
    }
    const evidence = [...overlaps].sort();
    groups.push({
      id: `shared_output:${sorted.join("+")}`,
      kind: "shared_output",
      reason:
        evidence.length === 0
          ? "planned write roots intersect; never dispatched concurrently"
          : `planned write roots overlap on ${evidence.join(", ")}; never dispatched concurrently`,
      unitIds: sorted,
      evidence,
    });
  }
  return groups.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Replace every cycle group's members with one unit. `shared_output` groups are ignored: they only
 * serialize, so their members stay separate units. Units outside any cycle group pass through
 * unchanged, keeping the input order with each merged unit at its first member's position.
 */
export function applyGroups(units: readonly AnalysisUnit[], groups: readonly UnitGroup[]): AnalysisUnit[] {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const mergedIdByMember = new Map<string, string>();
  const mergedById = new Map<string, AnalysisUnit>();

  for (const group of groups) {
    if (group.kind !== "cycle") continue;
    const members = group.unitIds.filter((id) => byId.has(id)).sort();
    const memberUnits: AnalysisUnit[] = [];
    for (const id of members) {
      const unit = byId.get(id);
      if (unit !== undefined) memberUnits.push(unit);
    }
    const first = memberUnits[0];
    if (first === undefined) continue;
    const kind: UnitKind = memberUnits.every((unit) => unit.kind === "script") ? "script_group" : first.kind;
    const names = memberUnits.map((unit) => unit.name).sort();
    const id = `${kind}:${names.join("+")}`;
    if (mergedById.has(id)) {
      throw new DeepError(
        "GM2DEEP-UNIT-GROUP-COLLISION",
        `two cycle groups produce the same merged unit id ${id}`,
        { groupId: group.id, unitId: id },
      );
    }
    const existing = byId.get(id);
    if (existing !== undefined && !members.includes(id)) {
      throw new DeepError(
        "GM2DEEP-UNIT-GROUP-COLLISION",
        `merged cycle group produces unit id ${id}, which already exists`,
        { groupId: group.id, unitId: id },
      );
    }

    const sourceHashes: Record<string, string> = {};
    for (const member of memberUnits) {
      for (const [path, hash] of Object.entries(member.sourceHashes)) {
        if (sourceHashes[path] === undefined) sourceHashes[path] = hash;
      }
    }
    const outputsByPath = new Map<string, UnitGeneratedOutput>();
    for (const member of memberUnits) {
      for (const output of member.generatedOutputs) {
        if (!outputsByPath.has(output.path)) outputsByPath.set(output.path, output);
      }
    }

    mergedById.set(id, {
      id,
      kind,
      name: names.join("+"),
      sourcePaths: [...new Set(memberUnits.flatMap((unit) => unit.sourcePaths))].sort(),
      sourceHashes,
      generatedOutputs: [...outputsByPath.values()].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      ),
      analysisRequired: true,
      memberUnitIds: members,
    });
    for (const member of members) mergedIdByMember.set(member, id);
  }

  const emitted = new Set<string>();
  const result: AnalysisUnit[] = [];
  for (const unit of units) {
    const mergedId = mergedIdByMember.get(unit.id);
    if (mergedId === undefined) {
      result.push(unit);
      continue;
    }
    if (emitted.has(mergedId)) continue;
    const merged = mergedById.get(mergedId);
    if (merged === undefined) continue; // unreachable: every mergedId came from mergedById
    emitted.add(mergedId);
    result.push(merged);
  }
  return result;
}
