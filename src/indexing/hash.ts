import { statSync } from "node:fs";
import { sha256File } from "../util/sha256.ts";

export interface FileHash {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mode: number;
}

/** Hash one file and capture the size/permission bits the inventory record needs. */
export async function hashFileEntry(absolutePath: string, relativePath: string): Promise<FileHash> {
  const stats = statSync(absolutePath);
  return {
    path: relativePath,
    sha256: await sha256File(absolutePath),
    bytes: stats.size,
    mode: stats.mode & 0o777,
  };
}
