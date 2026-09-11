/**
 * Project-graph assembly: the full edge set for the report, plus the strongly-connected components
 * and a topological order of the SCC condensation that the scheduler uses for grouping.
 *
 * Two edge sets are kept deliberately apart:
 * - `edges` / `adjacency` / `reverse` / `describeUnresolved` cover **every** edge kind, because the
 *   report must be able to state everything the analysis found, unresolved references included.
 * - `sccOf` / `condensationOrder` are computed from `SCHEDULING_EDGE_KINDS` only: an edge kind that
 *   does not schedule work must not collapse two units into one component through this path.
 *   `cycles.ts#findGroups` applies the wider cycle rule from plan step 28 on top of the raw edges.
 */

import { invariant } from "../util/result.ts";
import type { AnalysisUnit } from "../indexing/units.ts";
import { SCHEDULING_EDGE_KINDS, type DependencyEdge, type DependencyReport } from "./edges.ts";

export interface AnalysisGraph {
  /** Every unit id, plus any id an edge names, sorted. */
  readonly nodes: readonly string[];
  /** Every edge of every kind, sorted by edge id. */
  readonly edges: readonly DependencyEdge[];
  /** Unit id → the ids it points at (all kinds), sorted and deduplicated. */
  readonly adjacency: Readonly<Record<string, readonly string[]>>;
  /** Unit id → the ids pointing at it (all kinds), sorted and deduplicated. */
  readonly reverse: Readonly<Record<string, readonly string[]>>;
  /** Topological order of the SCC condensation; each component lists its unit ids, sorted. */
  readonly condensationOrder: readonly (readonly string[])[];
  /** Unit id → component id (the lexicographically smallest member of its component). */
  readonly sccOf: Readonly<Record<string, string>>;
  /** Units with no edge at all — the explicit `dependencies.none` coverage fact. */
  readonly noneEdgeUnits: readonly string[];
}

/**
 * Neighbour lists for one direction. Every listed node gets a key, so a missing key means "not a
 * node in this graph" rather than "no neighbours".
 */
function adjacencyOf(
  nodes: readonly string[],
  edges: readonly DependencyEdge[],
  direction: "forward" | "reverse",
): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node, []);
  for (const edge of edges) {
    const from = direction === "forward" ? edge.from : edge.to;
    const to = direction === "forward" ? edge.to : edge.from;
    const targets = adjacency.get(from);
    if (targets === undefined) continue;
    if (!targets.includes(to)) targets.push(to);
  }
  for (const targets of adjacency.values()) targets.sort();
  return adjacency;
}

/**
 * Tarjan's strongly-connected components, iterative so a deep project graph cannot overflow the
 * stack. Components are emitted in reverse topological order of the condensation (Tarjan's property)
 * and each component's members are sorted. A self-loop yields a single-member component.
 */
export function stronglyConnectedComponents(
  nodes: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): readonly (readonly string[])[] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  const lowOf = (node: string): number => low.get(node) ?? 0;

  const visit = (node: string): void => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
  };

  for (const root of nodes) {
    if (index.has(root)) continue;
    visit(root);
    const work: { node: string; neighbors: readonly string[]; next: number }[] = [
      { node: root, neighbors: adjacency.get(root) ?? [], next: 0 },
    ];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame === undefined) break; // unreachable: `work.length > 0`
      if (frame.next < frame.neighbors.length) {
        const next = frame.neighbors[frame.next];
        frame.next += 1;
        if (next === undefined) continue; // unreachable: `frame.next < neighbors.length`
        if (!index.has(next)) {
          visit(next);
          work.push({ node: next, neighbors: adjacency.get(next) ?? [], next: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(lowOf(frame.node), index.get(next) ?? 0));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) {
        low.set(parent.node, Math.min(lowOf(parent.node), lowOf(frame.node)));
      }
      if (lowOf(frame.node) === index.get(frame.node)) {
        const members: string[] = [];
        for (;;) {
          const member = stack.pop();
          if (member === undefined) break; // unreachable: the component root is on the stack
          onStack.delete(member);
          members.push(member);
          if (member === frame.node) break;
        }
        components.push(members.sort());
      }
    }
  }
  return components;
}

/** Topological order of a condensation DAG, ties broken lexicographically by component id. */
function topologicalOrder(
  componentIds: readonly string[],
  edgesByComponent: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  const indegree = new Map<string, number>();
  for (const id of componentIds) indegree.set(id, 0);
  for (const targets of edgesByComponent.values()) {
    for (const target of targets) indegree.set(target, (indegree.get(target) ?? 0) + 1);
  }

  const insertSorted = (list: string[], value: string): void => {
    let low = 0;
    let high = list.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((list[mid] ?? "") < value) low = mid + 1;
      else high = mid;
    }
    list.splice(low, 0, value);
  };

  const ready = componentIds.filter((id) => indegree.get(id) === 0).slice().sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined) break; // unreachable: `ready.length > 0`
    order.push(id);
    for (const target of [...new Set(edgesByComponent.get(id) ?? [])].sort()) {
      const remaining = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, remaining);
      if (remaining === 0) insertSorted(ready, target);
    }
  }
  invariant(
    order.length === componentIds.length,
    "GM2DEEP-GRAPH-CONDENSATION",
    "condensation of the strongly-connected components is not acyclic",
  );
  return order;
}

export function buildGraph(units: readonly AnalysisUnit[], report: DependencyReport): AnalysisGraph {
  const edges = [...report.edges].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const nodeSet = new Set<string>();
  for (const unit of units) nodeSet.add(unit.id);
  for (const edge of edges) {
    nodeSet.add(edge.from);
    nodeSet.add(edge.to);
  }
  const nodes = [...nodeSet].sort();

  const forward = adjacencyOf(nodes, edges, "forward");
  const backward = adjacencyOf(nodes, edges, "reverse");

  const schedulingKinds = new Set<string>(SCHEDULING_EDGE_KINDS);
  const schedulingEdges = edges.filter((edge) => schedulingKinds.has(edge.kind));
  const scheduling = adjacencyOf(nodes, schedulingEdges, "forward");

  const components = stronglyConnectedComponents(nodes, scheduling);
  const componentOf = new Map<string, string>();
  const membersById = new Map<string, readonly string[]>();
  for (const members of components) {
    const id = members[0];
    if (id === undefined) continue; // unreachable: Tarjan never emits an empty component
    componentOf.set(id, id);
    membersById.set(id, members);
    for (const member of members) componentOf.set(member, id);
  }

  const edgesByComponent = new Map<string, string[]>();
  for (const id of membersById.keys()) edgesByComponent.set(id, []);
  for (const edge of schedulingEdges) {
    const from = componentOf.get(edge.from);
    const to = componentOf.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    const targets = edgesByComponent.get(from);
    if (targets !== undefined && !targets.includes(to)) targets.push(to);
  }

  const condensationOrder = topologicalOrder(
    [...membersById.keys()].sort(),
    edgesByComponent,
  ).flatMap((id) => {
    const members = membersById.get(id);
    return members === undefined ? [] : [members];
  });

  const touched = new Set<string>();
  for (const edge of edges) {
    touched.add(edge.from);
    touched.add(edge.to);
  }
  const noneEdgeUnits = [...new Set(units.map((unit) => unit.id))]
    .sort()
    .filter((id) => !touched.has(id));

  const sccOf: Record<string, string> = {};
  const adjacency: Record<string, readonly string[]> = {};
  const reverse: Record<string, readonly string[]> = {};
  for (const node of nodes) {
    const component = componentOf.get(node);
    if (component !== undefined) sccOf[node] = component;
    adjacency[node] = forward.get(node) ?? [];
    reverse[node] = backward.get(node) ?? [];
  }

  return {
    nodes,
    edges,
    adjacency,
    reverse,
    condensationOrder,
    sccOf,
    noneEdgeUnits,
  };
}

/**
 * Edges the static analysis refused to resolve, for the report. A `room_creation` self-loop is a
 * confirmed fact (a room runs its own creation code), so it never appears here.
 */
export function describeUnresolved(graph: AnalysisGraph): readonly DependencyEdge[] {
  return graph.edges.filter((edge) => edge.confidence === "unresolved");
}
