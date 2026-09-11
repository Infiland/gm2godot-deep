import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DeepError } from "../util/result.ts";
import { loadConfig, writeConfig, type ConfigOverrides } from "../config/load.ts";
import type { Config } from "../config/schema.ts";
import { assertNotInside, assertSafeRelativePath } from "./guards.ts";
import { WORKSPACE_DIRECTORIES, workspacePaths, type WorkspacePaths } from "./paths.ts";

export interface Workspace {
  readonly root: string;
  readonly paths: WorkspacePaths;
  readonly config: Config;
}

/**
 * A workspace may not be nested inside the source project (the snapshot would be recursive) and the
 * source may not live inside the workspace (the snapshot would be mutable through the workspace).
 */
export function assertDisjoint(sourcePath: string, workspaceRoot: string): void {
  if (existsSync(workspaceRoot) && existsSync(sourcePath)) {
    assertNotInside(resolve(workspaceRoot), resolve(sourcePath));
    assertNotInside(resolve(sourcePath), resolve(workspaceRoot));
  }
}

export function createWorkspace(root: string, config: Config, options: { force?: boolean } = {}): Workspace {
  if (existsSync(root) && !options.force) {
    const entries = readdirSync(root);
    if (entries.length > 0 && !entries.includes("deep-convert.config.json")) {
      throw new DeepError("GM2DEEP-WORKSPACE-NOT-EMPTY", `${root} already exists and is not a workspace`, {
        entries: entries.slice(0, 20),
      });
    }
  }
  assertDisjoint(config.source.path, root);
  for (const directory of WORKSPACE_DIRECTORIES) {
    assertSafeRelativePath(directory, "workspace directory");
    mkdirSync(join(root, directory), { recursive: true });
  }
  writeConfig(root, config);
  return { root: resolve(root), paths: workspacePaths(root), config };
}

export function openWorkspace(root: string, overrides: ConfigOverrides = {}): Workspace {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new DeepError("GM2DEEP-WORKSPACE-MISSING", `no workspace directory at ${root}`);
  }
  const missing = WORKSPACE_DIRECTORIES.filter((directory) => !existsSync(join(root, directory)));
  if (missing.length > 0) {
    throw new DeepError("GM2DEEP-WORKSPACE-INCOMPLETE", `${root} is missing required directories`, { missing });
  }
  const config = loadConfig(root, overrides);
  assertDisjoint(config.source.path, root);
  return { root: resolve(root), paths: workspacePaths(root), config };
}

/** Resolve a workspace-relative path, refusing traversal and escaping symlinks. */
export function workspacePath(workspace: Workspace, relative: string): string {
  assertSafeRelativePath(relative);
  return join(workspace.paths.root, relative);
}

/** Remove a directory tree. Used for staging areas and rejected candidates. */
export function removeTree(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
