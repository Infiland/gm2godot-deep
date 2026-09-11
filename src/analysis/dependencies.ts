import { readFileSync } from "node:fs";
import { DeepError } from "../util/result.ts";
import { sha256Text } from "../util/sha256.ts";
import { join } from "node:path";
import { scanGml, type KnownNames } from "./gml/scanner.ts";
import type { SourceLocation } from "./gml/types.ts";
import { collectMacros } from "./gml/macros.ts";
import {
  apiUsageId,
  edgeId,
  type ApiUsageRecord,
  type DependencyEdge,
  type DependencyReport,
  type EvidenceLocation,
  type SymbolUnresolvedRecord,
} from "./edges.ts";
import type { AnalysisUnit } from "../indexing/units.ts";
import type { BridgeInventory, GmlApiEntry } from "../adapters/gm2godot/bridge.ts";

export interface DependencyBuildRequest {
  readonly snapshotDir: string;
  readonly units: readonly AnalysisUnit[];
  readonly bridge: BridgeInventory;
  readonly gmlApiEntries: readonly GmlApiEntry[];
  readonly readFile?: (absolutePath: string) => string;
}

function location(path: string, at: SourceLocation, sha256ByPath: ReadonlyMap<string, string>): EvidenceLocation {
  const sha256 = sha256ByPath.get(path);
  if (sha256 === undefined) {
    throw new DeepError("GM2DEEP-EVIDENCE-STALE", `no digest recorded for ${path}`, { path });
  }
  return { path, sha256, line: at.line, column: at.column, snippet: at.snippet };
}

const RESOURCE_SET_BY_DIRECTORY = [
  ["scripts", "scripts"],
  ["objects", "objects"],
  ["rooms", "rooms"],
  ["sprites", "sprites"],
  ["sounds", "sounds"],
  ["fonts", "fonts"],
  ["tilesets", "tilesets"],
  ["paths", "paths"],
  ["sequences", "sequences"],
  ["shaders", "shaders"],
] as const;

/**
 * Resource sets the scanner uses to tell a resource identifier from an unknown call target. Membership
 * is derived from both the bridge's `kind` field and the resource's path prefix, so a change in either
 * upstream field alone does not silently empty a set.
 */
export function knownNamesFromBridge(bridge: BridgeInventory, gmlApiEntries: readonly GmlApiEntry[]): KnownNames {
  const sets: Record<(typeof RESOURCE_SET_BY_DIRECTORY)[number][1], Set<string>> = {
    scripts: new Set<string>(),
    objects: new Set<string>(),
    rooms: new Set<string>(),
    sprites: new Set<string>(),
    sounds: new Set<string>(),
    fonts: new Set<string>(),
    tilesets: new Set<string>(),
    paths: new Set<string>(),
    sequences: new Set<string>(),
    shaders: new Set<string>(),
  };
  for (const resource of bridge.resources) {
    const path = resource.yypPath.split("\\").join("/");
    for (const [directory, key] of RESOURCE_SET_BY_DIRECTORY) {
      if (path.startsWith(`${directory}/`) || resource.kind === directory) sets[key].add(resource.name);
    }
  }
  return {
    scripts: sets.scripts,
    objects: sets.objects,
    rooms: sets.rooms,
    sprites: sets.sprites,
    sounds: sets.sounds,
    fonts: sets.fonts,
    tilesets: sets.tilesets,
    paths: sets.paths,
    sequences: sets.sequences,
    shaders: sets.shaders,
    extensionFunctions: new Set(bridge.extensions.flatMap((extension) => extension.functions.map((fn) => fn.name))),
    gmlApi: new Set(gmlApiEntries.map((entry) => entry.name)),
  };
}

interface GlobalTouch {
  readonly unitId: string;
  readonly path: string;
  readonly evidence: EvidenceLocation;
}

/**
 * Turn scan results into graph edges.
 *
 * Resolution order for a callee identifier: a script name becomes a `calls` edge; a GML API entry
 * produces no edge but an `api_usage` record carrying the upstream status; anything else is recorded as
 * unresolved — never guessed, never dropped. Structural edges (inheritance, room instances, room
 * creation code) come from the converter's resource model rather than from text.
 */
export function buildDependencies(request: DependencyBuildRequest): DependencyReport {
  const known = knownNamesFromBridge(request.bridge, request.gmlApiEntries);
  const apiByName = new Map(request.gmlApiEntries.map((entry) => [entry.name, entry]));
  const unitIds = new Set(request.units.map((unit) => unit.id));
  const edges = new Map<string, DependencyEdge>();
  const apiUsage = new Map<string, ApiUsageRecord>();
  const unresolved: SymbolUnresolvedRecord[] = [];
  const globalTouches = new Map<string, GlobalTouch[]>();

  // A GameMaker script resource holds functions; a call names the function, not the resource. Resolve
  // function names to their owning unit from the declarations the scanner recorded.
  const ownerByFunction = new Map<string, string>();
  const read = request.readFile ?? ((absolutePath: string) => readFileSync(absolutePath, "utf8"));
  const sources: { path: string; source: string }[] = [];
  const sha256ByPath = new Map<string, string>();
  for (const unit of request.units) {
    for (const path of unit.sourcePaths) {
      const source = read(join(request.snapshotDir, path));
      sha256ByPath.set(path, unit.sourceHashes[path] ?? sha256Text(source));
      if (path.endsWith(".gml")) sources.push({ path, source });
    }
  }
  const macros = collectMacros(sources);

  const addEdge = (edge: DependencyEdge): void => {
    if (!unitIds.has(edge.to) || !unitIds.has(edge.from)) return;
    const existing = edges.get(edge.id);
    if (existing === undefined) edges.set(edge.id, edge);
    else edges.set(edge.id, { ...existing, evidence: [...existing.evidence, ...edge.evidence] });
  };

  for (const unit of request.units) {
    if (!unit.analysisRequired) continue;
    for (const path of unit.sourcePaths) {
      if (!path.endsWith(".gml")) continue;
      const scan = scanGml(path, read(join(request.snapshotDir, path)), macros, known);
      for (const definition of scan.functionDefinitions) {
        if (!ownerByFunction.has(definition.name)) ownerByFunction.set(definition.name, unit.id);
      }
    }
  }

  for (const unit of request.units) {
    if (!unit.analysisRequired) continue;
    for (const path of unit.sourcePaths) {
      if (!path.endsWith(".gml")) continue;
      const scan = scanGml(path, read(join(request.snapshotDir, path)), macros, known);

      for (const call of scan.calls) {
        const scriptId = `script:${call.name}`;
        if (unitIds.has(scriptId)) {
          addEdge({
            id: edgeId(unit.id, scriptId, "calls"),
            from: unit.id,
            to: scriptId,
            kind: "calls",
            confidence: "confirmed",
            evidence: [location(path, call.location, sha256ByPath)],
          });
          continue;
        }
        const api = apiByName.get(call.name);
        if (api !== undefined) {
          const id = apiUsageId(unit.id, api.name);
          const previous = apiUsage.get(id);
          const evidence = [location(path, call.location, sha256ByPath)];
          apiUsage.set(id, {
            id,
            unitId: unit.id,
            api: api.name,
            status: api.status,
            issueNumber: api.issueNumber,
            ownerModule: api.ownerModule,
            evidence: previous === undefined ? evidence : [...previous.evidence, ...evidence],
          });
          continue;
        }
        if (known.extensionFunctions.has(call.name)) continue;
        const owner = ownerByFunction.get(call.name);
        if (owner !== undefined && owner !== unit.id) {
          addEdge({
            id: edgeId(unit.id, owner, "calls"),
            from: unit.id,
            to: owner,
            kind: "calls",
            confidence: "confirmed",
            evidence: [location(path, call.location, sha256ByPath)],
            basis: `${call.name} is declared in ${owner}`,
          });
          continue;
        }
        unresolved.push({
          unitId: unit.id,
          symbol: call.name,
          reason: `call target ${call.name} matches no script, object, extension function or GML API entry`,
          evidence: [location(path, call.location, sha256ByPath)],
        });
      }

      for (const creation of scan.instanceCreates) {
        if (creation.objectName === null) continue;
        const inferred = creation.confidence !== "confirmed";
        addEdge({
          id: edgeId(unit.id, `object:${creation.objectName}`, "instance_creation"),
          from: unit.id,
          to: `object:${creation.objectName}`,
          kind: "instance_creation",
          confidence: inferred ? "inferred" : "confirmed",
          evidence: [location(path, creation.location, sha256ByPath)],
          ...(inferred ? { basis: "object name came from a macro resolution rather than a literal" } : {}),
        });
      }

      for (const resource of scan.resourceRefs) {
        for (const kind of ["sprite", "sound", "font", "tileset", "path", "sequence", "shader"] as const) {
          const targetId = `${kind}:${resource.name}`;
          if (!unitIds.has(targetId)) continue;
          addEdge({
            id: edgeId(unit.id, targetId, "resource_reference"),
            from: unit.id,
            to: targetId,
            kind: "resource_reference",
            confidence: "confirmed",
            evidence: [location(path, resource.location, sha256ByPath)],
          });
        }
      }

      for (const reference of scan.unresolved) {
        unresolved.push({
          unitId: unit.id,
          symbol: reference.symbol,
          reason: reference.reason,
          evidence: [location(path, reference.location, sha256ByPath)],
        });
      }

      for (const access of [...scan.globalWrites, ...scan.globalReads]) {
        const touches = globalTouches.get(access.name);
        const touch: GlobalTouch = { unitId: unit.id, path, evidence: location(path, access.location, sha256ByPath) };
        if (touches === undefined) globalTouches.set(access.name, [touch]);
        else touches.push(touch);
      }
    }
  }

  // Shared state: every ordered pair of distinct units touching the same global. Recorded in both
  // directions once, with the touching evidence of the pair.
  for (const [name, touches] of globalTouches) {
    const distinct = new Map<string, GlobalTouch>();
    for (const touch of touches) if (!distinct.has(touch.unitId)) distinct.set(touch.unitId, touch);
    const members = [...distinct.values()].sort((a, b) => (a.unitId < b.unitId ? -1 : 1));
    if (members.length < 2) continue;
    for (const from of members) {
      for (const to of members) {
        if (from.unitId === to.unitId) continue;
        addEdge({
          id: edgeId(from.unitId, to.unitId, "shared_state"),
          from: from.unitId,
          to: to.unitId,
          kind: "shared_state",
          confidence: "confirmed",
          evidence: [from.evidence],
          basis: `both units touch global.${name}`,
        });
      }
    }
  }

  // Structural edges from the converter's own resource model, not from text.
  for (const object of request.bridge.objects) {
    if (object.parentObjectName === null) continue;
    const from = `object:${object.name}`;
    const to = `object:${object.parentObjectName}`;
    if (!unitIds.has(from) || !unitIds.has(to)) continue;
    edges.set(edgeId(from, to, "inherits"), {
      id: edgeId(from, to, "inherits"),
      from,
      to,
      kind: "inherits",
      confidence: "confirmed",
      evidence: [structuralEvidence(request, from, `parentObjectId references ${object.parentObjectName}`)],
    });
  }
  for (const room of request.bridge.rooms) {
    const roomId = `room:${room.name}`;
    for (const instance of room.instances) {
      if (instance.objectName === null) continue;
      const to = `object:${instance.objectName}`;
      if (!unitIds.has(roomId) || !unitIds.has(to)) continue;
      edges.set(edgeId(roomId, to, "instance_creation"), {
        id: edgeId(roomId, to, "instance_creation"),
        from: roomId,
        to,
        kind: "instance_creation",
        confidence: "confirmed",
        evidence: [structuralEvidence(request, roomId, `room instance references ${instance.objectName}`)],
      });
    }
    if (room.creationCodeFile === null || room.creationCodeFile.length === 0) continue;
    if (!unitIds.has(roomId)) continue;
    edges.set(edgeId(roomId, roomId, "room_creation"), {
      id: edgeId(roomId, roomId, "room_creation"),
      from: roomId,
      to: roomId,
      kind: "room_creation",
      confidence: "confirmed",
      evidence: [structuralEvidence(request, roomId, `creation code file ${room.creationCodeFile}`)],
    });
  }

  return {
    edges: [...edges.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
    apiUsage: [...apiUsage.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
    unresolved: unresolved.sort((a, b) =>
      a.unitId === b.unitId ? (a.symbol < b.symbol ? -1 : 1) : a.unitId < b.unitId ? -1 : 1,
    ),
  };
}

function structuralEvidence(request: DependencyBuildRequest, unitId: string, snippet: string): EvidenceLocation {
  const unit = request.units.find((candidate) => candidate.id === unitId);
  const path = unit?.sourcePaths.find((candidate) => candidate.endsWith(".yy")) ?? unit?.sourcePaths[0];
  if (path === undefined) {
    throw new DeepError("GM2DEEP-EVIDENCE-STALE", `unit ${unitId} has no source file to cite`, { unitId });
  }
  const sha256 = unit?.sourceHashes[path];
  if (sha256 === undefined) {
    throw new DeepError("GM2DEEP-EVIDENCE-STALE", `no digest recorded for ${path}`, { path });
  }
  return { path, sha256, line: 1, column: 1, snippet };
}
