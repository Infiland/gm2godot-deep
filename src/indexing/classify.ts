import { exclusionFor } from "./exclude.ts";

export const FILE_CLASSIFICATIONS = [
  "code",
  "resource_metadata",
  "binary_asset",
  "configuration",
  "included_data",
  "excluded",
] as const;

export type FileClassification = (typeof FILE_CLASSIFICATIONS)[number];

export interface Classification {
  readonly classification: FileClassification;
  readonly reason: string;
  readonly resourceType: string | null;
  readonly resourceName: string | null;
}

/** GameMaker resource directories, in the plural form used on disk. */
export const RESOURCE_DIR_KINDS: readonly string[] = [
  "objects",
  "sprites",
  "sounds",
  "fonts",
  "tilesets",
  "paths",
  "sequences",
  "timelines",
  "particlesystems",
  "notes",
  "shaders",
  "scripts",
  "rooms",
  "animcurves",
  "extensions",
  "datafiles",
];

const RESOURCE_METADATA_EXTENSIONS = [".yy", ".yyp", ".resource_order"];

const BINARY_ASSET_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".webp",
  ".wav",
  ".mp3",
  ".ogg",
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
  ".bin",
  ".dat",
  ".zip",
  ".json5",
  ".csv",
  ".ini",
  ".txt",
];

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

function resourceIdentity(relativePath: string): { resourceType: string | null; resourceName: string | null } {
  const segments = relativePath.split("/");
  const name = segments[segments.length - 1] ?? "";
  const extension = extensionOf(name);
  const stem = extension.length > 0 ? name.slice(0, -extension.length) : name;
  if (extension !== ".yy") return { resourceType: null, resourceName: null };
  const kindDir = segments.length >= 3 ? (segments[segments.length - 3] ?? null) : null;
  const resourceType = kindDir !== null && RESOURCE_DIR_KINDS.includes(kindDir) ? kindDir : null;
  return { resourceType, resourceName: stem };
}

/**
 * Exactly one classification per path. Nothing is dropped without a recorded reason, including files
 * whose extension this repository does not recognise.
 */
export function classifyPath(relativePath: string, bytes: number): Classification {
  const exclusion = exclusionFor(relativePath, bytes);
  const identity = resourceIdentity(relativePath);
  if (exclusion.excluded) {
    return { classification: "excluded", reason: exclusion.reason, ...identity };
  }

  const name = relativePath.split("/").pop() ?? relativePath;
  const extension = extensionOf(name);

  if (extension === ".gml") {
    return { classification: "code", reason: "GML source file", ...identity };
  }
  if (RESOURCE_METADATA_EXTENSIONS.includes(extension)) {
    return { classification: "resource_metadata", reason: `GameMaker metadata file (${extension})`, ...identity };
  }
  if (relativePath === "options" || relativePath.startsWith("options/")) {
    return { classification: "configuration", reason: "platform and project option metadata", ...identity };
  }
  if (relativePath.startsWith("datafiles/")) {
    return { classification: "included_data", reason: "included file payload", ...identity };
  }
  if (BINARY_ASSET_EXTENSIONS.includes(extension)) {
    return { classification: "binary_asset", reason: `binary or opaque payload (${extension})`, ...identity };
  }
  return {
    classification: "binary_asset",
    reason: `unrecognised extension "${extension.length > 0 ? extension : "(none)"}" treated as an opaque asset payload`,
    ...identity,
  };
}
