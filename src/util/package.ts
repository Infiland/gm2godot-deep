import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";

const PackageJson = z.object({ version: z.string().min(1) });

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Version reported by `--version`, read from this repository's own package.json. */
export function packageVersion(): string {
  return PackageJson.parse(JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"))).version;
}
