/** Excluded paths, each with the reason it was excluded. Nothing is dropped silently. */

export const EXCLUDED_DIR_NAMES: readonly string[] = [
  ".git",
  ".godot",
  "__pycache__",
  ".svn",
  ".hg",
  "node_modules",
  ".cache",
  ".vscode",
  ".idea",
];

export const EXCLUDED_FILE_PATTERNS: readonly RegExp[] = [
  /\.pyc$/,
  /\.pyo$/,
  /\.DS_Store$/,
  /~$/,
  /\.swp$/,
  /\.tmp$/,
];

export const MAX_FILE_BYTES = 64 * 1024 * 1024;

export interface ExclusionDecision {
  readonly excluded: boolean;
  readonly reason: string;
}

const INCLUDED: ExclusionDecision = { excluded: false, reason: "" };

/** Decide whether a workspace-relative path (POSIX separators) is excluded from the snapshot. */
export function exclusionFor(relativePath: string, bytes: number): ExclusionDecision {
  const segments = relativePath.split("/");
  for (const segment of segments.slice(0, -1)) {
    if (EXCLUDED_DIR_NAMES.includes(segment)) {
      return { excluded: true, reason: `directory name "${segment}" is never part of a source snapshot` };
    }
  }
  const name = segments[segments.length - 1] ?? "";
  if (EXCLUDED_DIR_NAMES.includes(name)) {
    return { excluded: true, reason: `directory name "${name}" is never part of a source snapshot` };
  }
  for (const pattern of EXCLUDED_FILE_PATTERNS) {
    if (pattern.test(name)) {
      return { excluded: true, reason: `file name matches ${pattern.source}` };
    }
  }
  if (bytes > MAX_FILE_BYTES) {
    return { excluded: true, reason: `file is ${bytes} bytes, above the ${MAX_FILE_BYTES}-byte snapshot limit` };
  }
  return INCLUDED;
}
