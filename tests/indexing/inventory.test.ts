import assert from "node:assert/strict";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";

import { sha256File } from "../../src/util/sha256.ts";
import { loadFixture, FIXTURE_PROJECT } from "../helpers/environment.ts";

/** Every regular file under `root`, as sorted POSIX-relative paths. */
function walkFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) found.push(relative(root, absolute).split(sep).join("/"));
    }
  };
  walk(root);
  return found.sort();
}

test("the inventory accounts for every fixture file exactly once, with matching hashes", async () => {
  const env = await loadFixture();
  try {
    const expectedPaths = walkFiles(FIXTURE_PROJECT);
    assert.ok(expectedPaths.length > 0, "the fixture project must contain files");

    const paths = env.inventory.files.map((file) => file.path);
    assert.equal(new Set(paths).size, paths.length, "every inventory path must appear exactly once");

    const included = env.inventory.files.filter((file) => file.classification !== "excluded");
    assert.deepEqual(
      included.map((file) => file.path).sort(),
      expectedPaths,
      "the file index must cover exactly the fixture's files",
    );

    for (const file of included) {
      const absolute = join(env.snapshotDir, file.path);
      assert.equal(file.sha256, await sha256File(absolute), `${file.path} sha256 must match the snapshot bytes`);
      assert.equal(file.bytes, statSync(absolute).size, `${file.path} byte count must match the snapshot`);
      assert.ok(file.classificationReason.length > 0, `${file.path} must record why it was classified`);
    }

    // Every kept file belongs to exactly one analysis unit.
    const membership = new Map<string, string[]>();
    for (const unit of env.inventory.units) {
      for (const path of unit.sourcePaths) {
        membership.set(path, [...(membership.get(path) ?? []), unit.id]);
        assert.equal(
          unit.sourceHashes[path],
          env.inventory.files.find((file) => file.path === path)?.sha256,
          `${unit.id} must carry the indexed hash of ${path}`,
        );
      }
    }
    for (const file of included) {
      assert.deepEqual(membership.get(file.path)?.length, 1, `${file.path} must belong to exactly one unit`);
    }

    const counts = env.inventory.counts;
    assert.equal(counts.total, env.inventory.files.length);
    assert.equal(counts.excluded, env.inventory.files.filter((file) => file.classification === "excluded").length);
    assert.equal(
      Object.values(counts.byClassification).reduce((sum, value) => sum + value, 0),
      counts.total,
      "every file must have exactly one classification",
    );
    assert.equal(counts.unitsTotal, env.inventory.units.length);
    assert.equal(counts.unitsRequiringAnalysis + counts.unitsDeterministicOnly, counts.unitsTotal);
  } finally {
    env.cleanup();
  }
});

test("excluded paths are recorded once, with the reason they were dropped", async () => {
  const env = await loadFixture({
    mutate(projectDir) {
      // Junk the snapshot rules must drop, and must say why.
      writeFileSync(join(projectDir, ".DS_Store"), "");
      writeFileSync(join(projectDir, "scripts/scr_math/scr_math.gml~"), "editor backup\n");
      mkdirSync(join(projectDir, "node_modules/deep"), { recursive: true });
      writeFileSync(join(projectDir, "node_modules/deep/leftover.js"), "x\n");
      mkdirSync(join(projectDir, "__pycache__"), { recursive: true });
      writeFileSync(join(projectDir, "__pycache__/x.cpython-312.pyc"), "x\n");
    },
  });
  try {
    const excluded = env.inventory.files.filter((file) => file.classification === "excluded");
    const excludedPaths = excluded.map((file) => file.path).sort();
    assert.deepEqual(excludedPaths, [".DS_Store", "__pycache__", "node_modules", "scripts/scr_math/scr_math.gml~"]);
    for (const file of excluded) {
      assert.ok(file.classificationReason.length > 0, `${file.path} must carry the exclusion reason`);
      assert.equal(file.bytes, 0, "an excluded path has no indexed bytes");
      assert.equal(file.sha256, "", "an excluded path was never hashed");
    }

    // The excluded junk did not enter the snapshot, so the kept set is still exactly the fixture's.
    assert.deepEqual(
      env.inventory.files
        .filter((file) => file.classification !== "excluded")
        .map((file) => file.path)
        .sort(),
      walkFiles(FIXTURE_PROJECT),
    );
  } finally {
    env.cleanup();
  }
});

test("project-level metadata is one project_settings unit and carries the project root files", async () => {
  const env = await loadFixture();
  try {
    const unitsForReadme = env.inventory.units.filter((unit) => unit.sourcePaths.includes("README.md"));
    assert.equal(unitsForReadme.length, 1, "README.md must be accounted for by exactly one unit");
    assert.equal(unitsForReadme[0]?.kind, "project_settings");
    assert.equal(unitsForReadme[0]?.analysisRequired, false, "deterministic metadata is never sent to a model");
    assert.ok(
      unitsForReadme[0]?.sourcePaths.includes("Counter.yyp"),
      "the .yyp belongs to the same project-level unit",
    );
    const unitIds = new Set(env.inventory.units.map((unit) => unit.id));
    assert.equal(unitIds.size, env.inventory.units.length, "unit ids are unique");
    assert.ok(unitIds.has("object:obj_counter"));
    assert.ok(unitIds.has("script:scr_math"));
    assert.ok(unitIds.has("script:scr_state"));
    assert.ok(unitIds.has("room:rm_main"));
    assert.ok(unitIds.has("sprite:spr_counter"));
  } finally {
    env.cleanup();
  }
});
