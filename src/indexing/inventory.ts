import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { z } from "zod";
import { canonicalJson, readJsonFile, writeJsonAtomic } from "../util/json.ts";
import { sha256Text } from "../util/sha256.ts";
import { nowIso } from "../util/ids.ts";
import { DeepError } from "../util/result.ts";
import { exclusionFor } from "./exclude.ts";
import { classifyPath, type FileClassification } from "./classify.ts";
import { hashFileEntry } from "./hash.ts";
import { buildUnits, UNIT_KINDS, type AnalysisUnit, type GeneratedFileLink, type IndexedFile } from "./units.ts";
import { listManagedOutputs } from "../adapters/gm2godot/manifest.ts";
import { BridgeInventorySchema, GmlApiEntrySchema, type BridgeInventory, type GmlApiEntry, type Gm2GodotProbe } from "../adapters/gm2godot/bridge.ts";
import { SnapshotRecordSchema, type SnapshotRecord } from "../workspaces/snapshot.ts";
import { packageVersion } from "../util/package.ts";

export const INVENTORY_SCHEMA_VERSION = 1;
export const GML_API_FILENAME = "gml-api.json";
export const INVENTORY_FILENAME = "inventory.json";
export const BRIDGE_FILENAME = "bridge.json";
export const SNAPSHOT_FILENAME = "source-snapshot.json";

export const IndexedFileSchema = z.strictObject({
  path: z.string().min(1),
  sha256: z.string(),
  bytes: z.number().int().nonnegative(),
  classification: z.enum(["code", "resource_metadata", "binary_asset", "configuration", "included_data", "excluded"]),
  classificationReason: z.string().min(1),
  resourceType: z.string().min(1).nullable(),
  resourceName: z.string().min(1).nullable(),
});

export const AnalysisUnitSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(UNIT_KINDS),
  name: z.string().min(1),
  sourcePaths: z.array(z.string().min(1)),
  sourceHashes: z.record(z.string(), z.string()),
  generatedOutputs: z.array(
    z.strictObject({ path: z.string().min(1), sha256: z.string(), sourceMapPath: z.string().min(1).nullable() }),
  ),
  analysisRequired: z.boolean(),
  memberUnitIds: z.array(z.string().min(1)).optional(),
});

export const InventoryRecordSchema = z.strictObject({
  schemaVersion: z.literal(INVENTORY_SCHEMA_VERSION),
  sourceSnapshotId: z.string().min(1),
  baselineId: z.string().min(1).nullable(),
  createdAt: z.string().min(1),
  tool: z.strictObject({
    gm2godotDeepVersion: z.string().min(1),
    node: z.string().min(1),
    python: z.string().min(1).nullable(),
    gm2godot: z.strictObject({ version: z.string().min(1), commit: z.string().nullable() }),
  }),
  files: z.array(IndexedFileSchema),
  resources: z.array(z.unknown()),
  objects: z.array(z.unknown()),
  rooms: z.array(z.unknown()),
  units: z.array(AnalysisUnitSchema),
  counts: z.strictObject({
    total: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(),
    byClassification: z.record(z.string(), z.number().int().nonnegative()),
    byUnitKind: z.record(z.string(), z.number().int().nonnegative()),
    unitsTotal: z.number().int().nonnegative(),
    unitsRequiringAnalysis: z.number().int().nonnegative(),
    unitsDeterministicOnly: z.number().int().nonnegative(),
  }),
  gmlApi: z.strictObject({
    entryCount: z.number().int().nonnegative(),
    byStatus: z.record(z.string(), z.number().int().nonnegative()),
    digest: z.string().min(1),
  }),
});

export type InventoryRecord = z.output<typeof InventoryRecordSchema>;
export type InventoryCounts = InventoryRecord["counts"];

function walkSnapshot(root: string): { absolute: string; relative: string }[] {
  const found: { absolute: string; relative: string }[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const absolute = join(directory, entry.name);
      const posix = relative(root, absolute).split(sep).join("/");
      if (entry.isDirectory()) {
        if (exclusionFor(`${posix}/`, 0).excluded) continue;
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (exclusionFor(posix, statSync(absolute).size).excluded) continue;
      found.push({ absolute, relative: posix });
    }
  };
  walk(root);
  return found;
}

/**
 * Bind each generated file to its source through the converter's per-file `.gmlmap.json`.
 *
 * The map's top-level `source_path` is unreliable: GM2Godot 0.7.74 writes `null` for object scripts (which
 * compile several event files into one `.gd`) and an absolute path for scripts. Both the top-level value and
 * `entries[].source_path` are therefore normalized by matching their suffix against the project's real source
 * files, which is the only form that survives conversion from a staging copy.
 */
function generatedFileLinks(baselineDir: string, knownSourcePaths: readonly string[]): GeneratedFileLink[] {
  const managed = listManagedOutputs(baselineDir);
  const mapPaths = new Set(managed.filter((entry) => entry.path.endsWith(".gmlmap.json")).map((entry) => entry.path));
  const known = [...knownSourcePaths].sort((a, b) => b.length - a.length);

  const normalize = (candidate: unknown): string | null => {
    if (typeof candidate !== "string" || candidate.length === 0) return null;
    const posix = candidate.split("\\").join("/");
    for (const path of known) {
      if (posix === path || posix.endsWith(`/${path}`)) return path;
    }
    return null;
  };

  const links: GeneratedFileLink[] = [];
  for (const entry of managed) {
    if (entry.path.endsWith(".gmlmap.json")) continue;
    const sourceMapPath = `${entry.path}.gmlmap.json`;
    const hasMap = mapPaths.has(sourceMapPath);
    let sourcePath: string | null = null;
    if (hasMap) {
      const record: unknown = readJsonFile(join(baselineDir, sourceMapPath));
      if (typeof record === "object" && record !== null) {
        const candidates: unknown[] = [];
        if ("source_path" in record) candidates.push(record.source_path);
        if ("entries" in record && Array.isArray(record.entries)) {
          for (const item of record.entries) {
            if (typeof item === "object" && item !== null && "source_path" in item) candidates.push(item.source_path);
          }
        }
        for (const candidate of candidates) {
          const normalized = normalize(candidate);
          if (normalized !== null) {
            sourcePath = normalized;
            break;
          }
        }
      }
    }
    links.push({
      path: entry.path,
      sha256: entry.sha256,
      sourcePath,
      sourceMapPath: hasMap ? sourceMapPath : null,
    });
  }
  return links;
}

export interface InventoryBuildRequest {
  readonly snapshot: SnapshotRecord;
  readonly snapshotDir: string;
  readonly baselineDir: string | null;
  readonly bridge: BridgeInventory;
  readonly probe: Gm2GodotProbe;
  readonly gmlApiEntries: readonly GmlApiEntry[];
  /** `<workspace>/evidence/inventory` */
  readonly evidenceInventoryDir: string;
  readonly now?: () => string;
}

/**
 * Assemble the file/resource/unit inventory, persist it, and persist the GML API manifest it was built
 * against so the analysis records can cite the exact upstream support table.
 */
export async function buildInventory(request: InventoryBuildRequest): Promise<InventoryRecord> {
  const walked = walkSnapshot(request.snapshotDir);
  const files: IndexedFile[] = [];
  for (const entry of walked) {
    const hash = await hashFileEntry(entry.absolute, entry.relative);
    const classification = classifyPath(entry.relative, hash.bytes);
    files.push({
      path: entry.relative,
      sha256: hash.sha256,
      bytes: hash.bytes,
      classification: classification.classification,
      classificationReason: classification.reason,
      resourceType: classification.resourceType,
      resourceName: classification.resourceName,
    });
  }
  for (const excluded of request.snapshot.excluded) {
    const classification = classifyPath(excluded.path, 0);
    files.push({
      path: excluded.path,
      sha256: "",
      bytes: 0,
      classification: "excluded",
      classificationReason: excluded.reason,
      resourceType: classification.resourceType,
      resourceName: classification.resourceName,
    });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));

  const generatedFiles =
    request.baselineDir === null
      ? []
      : generatedFileLinks(
          request.baselineDir,
          files.filter((file) => file.classification !== "excluded").map((file) => file.path),
        );
  const units = buildUnits({ projectName: request.bridge.project.name, files, generatedFiles });

  const byClassification: Record<string, number> = {};
  for (const file of files) {
    byClassification[file.classification] = (byClassification[file.classification] ?? 0) + 1;
  }
  const byUnitKind: Record<string, number> = {};
  for (const unit of units) byUnitKind[unit.kind] = (byUnitKind[unit.kind] ?? 0) + 1;

  const byStatus: Record<string, number> = {};
  for (const entry of request.gmlApiEntries) byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;

  const record: InventoryRecord = {
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    sourceSnapshotId: request.snapshot.snapshotId,
    baselineId: null,
    createdAt: (request.now ?? nowIso)(),
    tool: {
      gm2godotDeepVersion: packageVersion(),
      node: process.version,
      python: request.probe.pythonVersion,
      gm2godot: { version: request.probe.gm2godotVersion, commit: request.probe.commit },
    },
    files,
    resources: request.bridge.resources,
    objects: request.bridge.objects,
    rooms: request.bridge.rooms,
    units,
    counts: {
      total: files.length,
      excluded: files.filter((file) => file.classification === "excluded").length,
      byClassification,
      byUnitKind,
      unitsTotal: units.length,
      unitsRequiringAnalysis: units.filter((unit) => unit.analysisRequired).length,
      unitsDeterministicOnly: units.filter((unit) => !unit.analysisRequired).length,
    },
    gmlApi: {
      entryCount: request.gmlApiEntries.length,
      byStatus,
      digest: sha256Text(canonicalJson(request.gmlApiEntries)),
    },
  };

  writeJsonAtomic(join(request.evidenceInventoryDir, GML_API_FILENAME), {
    schemaVersion: 1,
    digest: record.gmlApi.digest,
    entries: request.gmlApiEntries,
  });
  writeJsonAtomic(join(request.evidenceInventoryDir, BRIDGE_FILENAME), request.bridge);
  writeJsonAtomic(join(request.evidenceInventoryDir, INVENTORY_FILENAME), record);
  return record;
}

export function readBridgeInventory(evidenceInventoryDir: string): BridgeInventory {
  return BridgeInventorySchema.parse(readJsonFile(join(evidenceInventoryDir, BRIDGE_FILENAME)));
}

export function readGmlApiEntries(evidenceInventoryDir: string): GmlApiEntry[] {
  const payload: unknown = readJsonFile(join(evidenceInventoryDir, GML_API_FILENAME));
  if (typeof payload !== "object" || payload === null || !("entries" in payload)) {
    throw new DeepError("GM2DEEP-EVIDENCE-MALFORMED", "gml-api.json has no entries array", {
      path: join(evidenceInventoryDir, GML_API_FILENAME),
    });
  }
  return z.array(GmlApiEntrySchema).parse(payload.entries);
}

export function readSnapshotRecord(evidenceInventoryDir: string): SnapshotRecord {
  return SnapshotRecordSchema.parse(readJsonFile(join(evidenceInventoryDir, SNAPSHOT_FILENAME)));
}

export function readInventory(evidenceInventoryDir: string): InventoryRecord {
  return InventoryRecordSchema.parse(readJsonFile(join(evidenceInventoryDir, INVENTORY_FILENAME)));
}

export function classificationOf(inventory: InventoryRecord, path: string): FileClassification | null {
  const file = inventory.files.find((candidate) => candidate.path === path);
  return file?.classification ?? null;
}

export function unitById(inventory: InventoryRecord, id: string): AnalysisUnit | null {
  return inventory.units.find((unit) => unit.id === id) ?? null;
}

export function inventoryHasFile(inventory: InventoryRecord, path: string, sha256?: string): boolean {
  const file = inventory.files.find((candidate) => candidate.path === path);
  if (file === undefined) return false;
  return sha256 === undefined || file.sha256 === sha256;
}
