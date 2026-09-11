import { DeepError } from "../util/result.ts";
import type { FileClassification } from "./classify.ts";

export const UNIT_KINDS = [
  "object",
  "script",
  "script_group",
  "room",
  "shader",
  "extension",
  "sprite",
  "sound",
  "font",
  "tileset",
  "path",
  "sequence",
  "timeline",
  "particle_system",
  "note",
  "animcurve",
  "project_settings",
  "included_data",
] as const;

export type UnitKind = (typeof UNIT_KINDS)[number];

/** Unit kinds that are sent to a model. Everything else is deterministic metadata. */
export const ANALYSIS_UNIT_KINDS: readonly UnitKind[] = ["object", "script", "script_group", "room", "shader", "extension"];

const KIND_BY_DIRECTORY: Record<string, UnitKind> = {
  objects: "object",
  scripts: "script",
  rooms: "room",
  shaders: "shader",
  extensions: "extension",
  sprites: "sprite",
  sounds: "sound",
  fonts: "font",
  tilesets: "tileset",
  paths: "path",
  sequences: "sequence",
  timelines: "timeline",
  particlesystems: "particle_system",
  notes: "note",
  animcurves: "animcurve",
  datafiles: "included_data",
};

export interface IndexedFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly classification: FileClassification;
  readonly classificationReason: string;
  readonly resourceType: string | null;
  readonly resourceName: string | null;
}

export interface GeneratedFileLink {
  readonly path: string;
  readonly sha256: string;
  /** Source file this output was generated from, from the converter's `.gmlmap.json`, when available. */
  readonly sourcePath: string | null;
  readonly sourceMapPath: string | null;
}

export interface UnitGeneratedOutput {
  readonly path: string;
  readonly sha256: string;
  readonly sourceMapPath: string | null;
}

export interface AnalysisUnit {
  readonly id: string;
  readonly kind: UnitKind;
  readonly name: string;
  readonly sourcePaths: string[];
  readonly sourceHashes: Record<string, string>;
  readonly generatedOutputs: UnitGeneratedOutput[];
  readonly analysisRequired: boolean;
  /** Set when the unit was formed by merging others (cycle groups). */
  readonly memberUnitIds?: string[] | undefined;
}

export interface UnitBuildInput {
  readonly projectName: string;
  readonly files: readonly IndexedFile[];
  readonly generatedFiles: readonly GeneratedFileLink[];
}

function unitId(kind: UnitKind, name: string): string {
  return `${kind}:${name}`;
}

/** Directory prefix and resource name for a path that lives under a GameMaker resource directory. */
function resourceLocation(path: string): { directory: string; kind: UnitKind; name: string } | null {
  const segments = path.split("/");
  if (segments.length < 2) return null;
  const kind = KIND_BY_DIRECTORY[segments[0] as string];
  if (kind === undefined) return null;
  const name = segments[1] as string;
  return { directory: `${segments[0]}/${name}`, kind, name };
}

/**
 * Build analysis units: one per GameMaker resource directory (its `.yy` plus every file beneath it),
 * one for project metadata, and one for included data. Every non-excluded file lands in at least one
 * unit; the coverage check in the validation phase enforces that.
 */
export function buildUnits(input: UnitBuildInput): AnalysisUnit[] {
  const byUnitId = new Map<string, { kind: UnitKind; name: string; files: IndexedFile[] }>();

  const add = (kind: UnitKind, name: string, file: IndexedFile): void => {
    const id = unitId(kind, name);
    const bucket = byUnitId.get(id);
    if (bucket === undefined) byUnitId.set(id, { kind, name, files: [file] });
    else bucket.files.push(file);
  };

  for (const file of input.files) {
    if (file.classification === "excluded") continue;
    const location = resourceLocation(file.path);
    if (location !== null) {
      add(location.kind, location.name, file);
      continue;
    }
    // Anything outside a resource directory (`.yyp`, `.resource_order`, `options/**`, stray root files)
    // belongs to project-level metadata, which is deterministic and never sent to a model.
    add("project_settings", input.projectName, file);
  }

  const generatedBySource = new Map<string, GeneratedFileLink[]>();
  for (const generated of input.generatedFiles) {
    if (generated.sourcePath === null) continue;
    const bucket = generatedBySource.get(generated.sourcePath);
    if (bucket === undefined) generatedBySource.set(generated.sourcePath, [generated]);
    else bucket.push(generated);
  }

  const units: AnalysisUnit[] = [];
  for (const [id, bucket] of byUnitId) {
    bucket.files.sort((a, b) => (a.path < b.path ? -1 : 1));
    const sourceHashes: Record<string, string> = {};
    const outputs: UnitGeneratedOutput[] = [];
    for (const file of bucket.files) {
      sourceHashes[file.path] = file.sha256;
      for (const generated of generatedBySource.get(file.path) ?? []) {
        outputs.push({ path: generated.path, sha256: generated.sha256, sourceMapPath: generated.sourceMapPath });
      }
    }
    outputs.sort((a, b) => (a.path < b.path ? -1 : 1));
    units.push({
      id,
      kind: bucket.kind,
      name: bucket.name,
      sourcePaths: bucket.files.map((file) => file.path),
      sourceHashes,
      generatedOutputs: outputs,
      analysisRequired: ANALYSIS_UNIT_KINDS.includes(bucket.kind),
    });
  }

  units.sort((a, b) => (a.id < b.id ? -1 : 1));
  return units;
}

export function unitKindOf(id: string): UnitKind {
  const kind = id.slice(0, id.indexOf(":")) as UnitKind;
  if (!UNIT_KINDS.includes(kind)) {
    throw new DeepError("GM2DEEP-UNIT-ID-INVALID", `unit id ${JSON.stringify(id)} does not carry a known kind`);
  }
  return kind;
}

export function unitNameOf(id: string): string {
  return id.slice(id.indexOf(":") + 1);
}
