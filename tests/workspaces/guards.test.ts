import assert from "node:assert/strict";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DeepError } from "../../src/util/result.ts";
import { ConfigSchema } from "../../src/config/schema.ts";
import { createWorkspace } from "../../src/workspaces/workspace.ts";
import {
  PATH_ERRORS,
  assertContained,
  assertNoEscapingLinks,
  assertNotInside,
  assertSafeRelativePath,
} from "../../src/workspaces/guards.ts";
import { GM2GODOT_CHECKOUT, GM2GODOT_PYTHON, makeTempDir, removeTree } from "../helpers/harness.ts";

function assertCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof DeepError, `expected a DeepError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

test("assertSafeRelativePath rejects traversal, absolute paths, drive letters and NUL bytes", () => {
  assertCode(() => assertSafeRelativePath("../escape.gd"), PATH_ERRORS.traversal);
  assertCode(() => assertSafeRelativePath("a/../../b.gd"), PATH_ERRORS.traversal);
  assertCode(() => assertSafeRelativePath("/etc/passwd"), PATH_ERRORS.traversal);
  assertCode(() => assertSafeRelativePath("C:\\Windows\\system32"), PATH_ERRORS.traversal);
  assertCode(() => assertSafeRelativePath("a\0b"), PATH_ERRORS.traversal);
  assertCode(() => assertSafeRelativePath(""), PATH_ERRORS.traversal);

  assert.doesNotThrow(() => assertSafeRelativePath("gm2godot/managers/foo.gd"));
  assert.doesNotThrow(() => assertSafeRelativePath("a..b/c"));
});

test("assertContained rejects a lexical escape and accepts a nested path that does not exist yet", () => {
  const root = makeTempDir("guards-contained");
  try {
    mkdirSync(join(root, "inside"), { recursive: true });
    assertCode(() => assertContained(root, "../../outside.gd"), PATH_ERRORS.traversal);
    assertCode(() => assertContained(root, join(root, "..", "sibling.gd")), PATH_ERRORS.traversal);

    const nested = assertContained(root, "inside/new/file.gd");
    assert.equal(nested, join(root, "inside", "new", "file.gd"));
    assert.equal(assertContained(root, join(root, "inside")), join(root, "inside"));
  } finally {
    removeTree(root);
  }
});

test("a symlink pointing outside the root is rejected with a guard code; an internal symlink is allowed", () => {
  const root = makeTempDir("guards-links");
  const outside = makeTempDir("guards-outside");
  try {
    mkdirSync(join(root, "inner"), { recursive: true });
    mkdirSync(join(outside, "secret"), { recursive: true });
    // Live target outside the root: containment resolves the link and rejects the resolved path.
    symlinkSync(join(outside, "secret"), join(root, "escape"), "dir");
    // Dangling target outside the root: containment cannot resolve it, so the link walk names the escape.
    symlinkSync(join(outside, "not-yet-created"), join(root, "dangling-escape"), "dir");
    symlinkSync(join(root, "inner"), join(root, "internal"), "dir");

    assertCode(() => assertNoEscapingLinks(root, "escape/secret.gml"), PATH_ERRORS.traversal);
    assertCode(() => assertNoEscapingLinks(root, "dangling-escape"), PATH_ERRORS.linkEscape);
    // Containment alone cannot see a dangling link: statSync fails, so the lexical path looks fine.
    // The link walk is what catches a path that would escape once the target appears.
    assert.doesNotThrow(() => assertContained(root, "dangling-escape/child.gml"));
    assertCode(() => assertNoEscapingLinks(root, "dangling-escape/child.gml"), PATH_ERRORS.linkEscape);
    assert.doesNotThrow(() => assertNoEscapingLinks(root, "internal/notes.gml"));
    assert.doesNotThrow(() => assertNoEscapingLinks(root, "does/not/exist/yet.gml"));
  } finally {
    removeTree(root);
    removeTree(outside);
  }
});

test("assertNotInside rejects a child inside its parent and accepts disjoint siblings", () => {
  const root = makeTempDir("guards-nested");
  try {
    mkdirSync(join(root, "parent", "child"), { recursive: true });
    mkdirSync(join(root, "sibling"), { recursive: true });

    assertCode(() => assertNotInside(join(root, "parent", "child"), join(root, "parent")), PATH_ERRORS.nested);
    assertCode(() => assertNotInside(join(root, "parent"), join(root, "parent")), PATH_ERRORS.nested);
    assert.doesNotThrow(() => assertNotInside(join(root, "sibling"), join(root, "parent")));
  } finally {
    removeTree(root);
  }
});

test("createWorkspace refuses a workspace nested inside the source and a source inside the workspace", () => {
  const root = makeTempDir("guards-workspace");
  try {
    const source = join(root, "source");
    mkdirSync(join(source, "workspace"), { recursive: true });
    const nestedConfig = ConfigSchema.parse({
      version: 1,
      source: { path: source },
      workspace: { path: join(source, "workspace") },
      gm2godot: { checkout: GM2GODOT_CHECKOUT, python: GM2GODOT_PYTHON },
    });
    assertCode(() => createWorkspace(join(source, "workspace"), nestedConfig), PATH_ERRORS.nested);
    assert.equal(
      existsSync(join(source, "workspace", "deep-convert.config.json")),
      false,
      "the refused workspace wrote a config",
    );

    const workspace = join(root, "workspace");
    const innerSource = join(workspace, "inner-source");
    mkdirSync(innerSource, { recursive: true });
    const sourceInsideConfig = ConfigSchema.parse({
      version: 1,
      source: { path: innerSource },
      workspace: { path: workspace },
      gm2godot: { checkout: GM2GODOT_CHECKOUT, python: GM2GODOT_PYTHON },
    });
    assertCode(() => createWorkspace(workspace, sourceInsideConfig, { force: true }), PATH_ERRORS.nested);

    const goodConfig = ConfigSchema.parse({
      version: 1,
      source: { path: join(root, "elsewhere", "project") },
      workspace: { path: join(root, "good-workspace") },
      gm2godot: { checkout: GM2GODOT_CHECKOUT, python: GM2GODOT_PYTHON },
    });
    assert.doesNotThrow(() => createWorkspace(join(root, "good-workspace"), goodConfig));
  } finally {
    removeTree(root);
  }
});
