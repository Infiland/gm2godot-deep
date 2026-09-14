import { homedir } from "node:os";
import { join } from "node:path";
/** Benchmark artifacts contain synthetic cases only and are reusable across projects. */
export function modelCacheDirectory(): string {
  const override = process.env["GM2GODOT_DEEP_CACHE_DIR"];
  if (override) return join(override, "model-evaluations");
  const root =
    process.platform === "win32"
      ? (process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"))
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Caches")
        : (process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"));
  return join(root, "GM2Godot", "deep", "model-evaluations");
}
