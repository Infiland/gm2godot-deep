import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { DeepError } from "../util/result.ts";

export const PATH_ERRORS = {
  traversal: "GM2DEEP-PATH-TRAVERSAL",
  linkEscape: "GM2DEEP-PATH-LINK-ESCAPE",
  nested: "GM2DEEP-PATH-NESTED-WORKSPACE",
} as const;

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/**
 * Reject a path that must stay a plain relative path: no absolute form, no drive letter, no `..`
 * segment, no NUL. Used before any path joins an untrusted value.
 */
export function assertSafeRelativePath(candidate: string, label = "path"): void {
  if (candidate.length === 0) {
    throw new DeepError(PATH_ERRORS.traversal, `${label} is empty`);
  }
  if (candidate.includes("\0")) {
    throw new DeepError(PATH_ERRORS.traversal, `${label} contains a NUL byte`);
  }
  if (isAbsolute(candidate) || WINDOWS_ABSOLUTE.test(candidate)) {
    throw new DeepError(PATH_ERRORS.traversal, `${label} must be relative, got ${JSON.stringify(candidate)}`);
  }
  for (const segment of candidate.split("/")) {
    if (segment === "..") {
      throw new DeepError(PATH_ERRORS.traversal, `${label} contains a ".." segment: ${JSON.stringify(candidate)}`);
    }
  }
}

function assertInsideRoot(rootReal: string, realCandidate: string, original: string): void {
  if (realCandidate === rootReal || realCandidate.startsWith(rootReal + sep)) return;
  throw new DeepError(PATH_ERRORS.traversal, `${original} resolves outside ${rootReal}`, {
    root: rootReal,
    resolved: realCandidate,
  });
}

/** Real path of the nearest existing ancestor of `absolute` (or `absolute` itself when it exists). */
function nearestExistingAncestor(absolute: string): string {
  let current = absolute;
  for (;;) {
    try {
      statSync(current);
      return current;
    } catch {
      const parent = resolve(current, "..");
      if (parent === current) {
        throw new DeepError(PATH_ERRORS.traversal, `no existing ancestor for ${absolute}`);
      }
      current = parent;
    }
  }
}

/**
 * Resolve `candidate` against `root` and prove the result cannot escape `root`. The returned path is
 * absolute but **not** realpath'd at the tail, so callers may use it to create new files. Symlinks
 * that already exist along the path are resolved as part of the check.
 */
export function assertContained(root: string, candidate: string): string {
  const rootReal = realpathSync(resolve(root));
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(rootReal, candidate);
  const ancestorReal = realpathSync(nearestExistingAncestor(absolute));
  assertInsideRoot(rootReal, ancestorReal, candidate);
  return absolute;
}

/**
 * Walk every existing component of `path` below `root`; a symlink whose target escapes `root`
 * (directly or through a chain) is fatal even when the lexical path looks contained.
 */
export function assertNoEscapingLinks(root: string, path: string): void {
  const rootReal = realpathSync(resolve(root));
  const absolute = assertContained(rootReal, path);
  const relative = absolute === rootReal ? [] : absolute.slice(rootReal.length + 1).split(sep);
  let current = rootReal;
  for (const segment of relative) {
    current = join(current, segment);
    let stats;
    try {
      stats = lstatSync(current);
    } catch {
      return; // Nothing further exists; the lexical containment check already passed.
    }
    if (!stats.isSymbolicLink()) continue;
    const target = resolve(join(current, ".."), readlinkSync(current));
    const targetReal = realpathSync(nearestExistingAncestor(target));
    if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep)) {
      throw new DeepError(
        PATH_ERRORS.linkEscape,
        `${current} is a symlink to ${target} which escapes ${rootReal}`,
        { link: current, target, root: rootReal },
      );
    }
  }
}

/** `child` must not be inside `parent` (and vice versa is the caller's business). */
export function assertNotInside(child: string, parent: string): void {
  const parentReal = realpathSync(resolve(parent));
  const childReal = realpathSync(nearestExistingAncestor(resolve(child)));
  if (childReal === parentReal || childReal.startsWith(parentReal + sep)) {
    throw new DeepError(PATH_ERRORS.nested, `${child} is inside ${parent}`, { child: childReal, parent: parentReal });
  }
}
