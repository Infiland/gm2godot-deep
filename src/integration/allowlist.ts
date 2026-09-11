import { PATH_ERRORS, assertSafeRelativePath } from "../workspaces/guards.ts";
import { DeepError } from "../util/result.ts";
import type { TaskRecord } from "../storage/types.ts";

/**
 * Paths no patch may ever touch, evaluated **before** the task write allowlist. This is what makes it
 * impossible for a patch author to weaken its own acceptance tests, rewrite expected results, or
 * modify the frozen source snapshot, the converter baseline or the harness itself.
 */
export const PROTECTED_PATHS: readonly string[] = [
  "tests/**",
  "fixtures/**",
  "evidence/**",
  "source/**",
  "baseline/**",
  "deep-convert.config.json",
  "bin/**",
  "src/**",
];

export const PATCH_ERRORS = {
  protectedPath: "GM2DEEP-PATCH-PROTECTED-PATH",
  outsideAllowlist: "GM2DEEP-PATCH-OUTSIDE-ALLOWLIST",
  deleteOutsideAllowlist: "GM2DEEP-PATCH-DELETE-OUTSIDE-ALLOWLIST",
} as const;

/**
 * Normalise an untrusted patch path into a POSIX-style relative path with no `.` or empty segments.
 * Refuses absolute paths, Windows drive letters, `..` segments and NUL bytes.
 */
export function normalizeRepoPath(raw: string, label = "patch path"): string {
  const slashed = raw.replace(/\\/g, "/");
  assertSafeRelativePath(slashed, label);
  const segments = slashed.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0) {
    throw new DeepError(PATH_ERRORS.traversal, `${label} has no path segments: ${JSON.stringify(raw)}`);
  }
  return segments.join("/");
}

/**
 * Segment-respecting containment: the pattern `gm2godot/**` matches `gm2godot/x.gd` and `gm2godot`
 * itself, but never a file literally named `gm2godotX/file.gd`. A trailing slash on the pattern is
 * stripped before comparison.
 */
function matchesPattern(path: string, pattern: string): boolean {
  let root = pattern;
  if (root.endsWith("/**")) root = root.slice(0, -3);
  else if (root.endsWith("/")) root = root.slice(0, -1);
  return path === root || path.startsWith(`${root}/`);
}

/** True when `path` falls under any {@link PROTECTED_PATHS} entry. Unrepresentable paths fail closed. */
export function isProtected(path: string): boolean {
  let normalised: string;
  try {
    normalised = normalizeRepoPath(path);
  } catch {
    return true;
  }
  return PROTECTED_PATHS.some((root) => matchesPattern(normalised, root.replace(/\\/g, "/")));
}

/** True when `path` is inside the task's write allowlist. Unrepresentable paths fail closed. */
export function isAllowedWrite(task: TaskRecord, path: string): boolean {
  let normalised: string;
  try {
    normalised = normalizeRepoPath(path);
  } catch {
    return false;
  }
  return task.allowlist.write.some((root) => matchesPattern(normalised, root.replace(/\\/g, "/")));
}

/**
 * The single gate every patch path passes before it is applied or published. Protected paths are
 * rejected before the allowlist is consulted; a delete outside the allowlist gets a distinct code so
 * the failure names the intent it violated.
 */
export function assertAllowed(task: TaskRecord, path: string, action: "create" | "update" | "delete"): void {
  const normalised = normalizeRepoPath(path);
  if (isProtected(normalised)) {
    throw new DeepError(PATCH_ERRORS.protectedPath, `patch may not touch the protected path ${normalised}`, {
      taskId: task.id,
      path: normalised,
      action,
    });
  }
  if (isAllowedWrite(task, normalised)) return;
  const code = action === "delete" ? PATCH_ERRORS.deleteOutsideAllowlist : PATCH_ERRORS.outsideAllowlist;
  throw new DeepError(code, `patch ${action} of ${normalised} is outside the task write allowlist`, {
    taskId: task.id,
    path: normalised,
    action,
    writeAllowlist: task.allowlist.write,
  });
}
