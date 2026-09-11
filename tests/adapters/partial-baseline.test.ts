import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { generateBaseline, readBaselineEvidence } from "../../src/adapters/gm2godot/adapter.ts";
import { readBaselineProvenance } from "../../src/adapters/gm2godot/manifest.ts";
import { sha256Text } from "../../src/util/sha256.ts";
import { tempDir, testConfig, writeStubConverter, writeSyntheticBaseline } from "../helpers/environment.ts";

const TOOLCHAIN = { gm2godotVersion: "0.7.74", gm2godotCommit: null, pythonVersion: null };

test("a fresh partial generation is accepted and reported as partial, never as success", async () => {
  const temp = tempDir("gm2deep-partial");
  try {
    const stub = writeStubConverter(temp.path, "partial");
    const sourceDir = join(temp.path, "source");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "Counter.yyp"), "{}\n", "utf8");
    const baselineDir = join(temp.path, "baseline");
    const evidenceDir = join(temp.path, "evidence", "inventory");
    const config = testConfig({
      sourceDir,
      workspaceDir: join(temp.path, "workspace"),
      checkout: stub.checkout,
      python: stub.python,
    });

    const result = await generateBaseline({
      sourceDir,
      baselineDir,
      stagingRoot: join(temp.path, "staging"),
      evidenceInventoryDir: evidenceDir,
      config,
      python: stub.python,
      toolchain: TOOLCHAIN,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.interpretation.state, "partial");
    assert.equal(result.interpretation.outcome, "partial");
    assert.equal(result.promoted, true);
    assert.equal(result.provenance?.fresh, true, `expected a fresh generation: ${result.provenance?.reasons.join("; ")}`);
    assert.equal(result.provenance?.attemptState, "partial");
    assert.equal(result.provenance?.attemptStateAccepted, true);

    // The promoted baseline really is a fresh generation on disk, not just a claim in memory.
    const onDisk = readBaselineProvenance(baselineDir);
    assert.equal(onDisk.fresh, true);
    assert.equal(onDisk.baselineId, onDisk.manifestSha256);
    assert.equal(onDisk.inventoryEntryCount, 1);

    const evidence = readBaselineEvidence(evidenceDir);
    assert.equal(evidence.state, "partial");
    assert.equal(evidence.outcome, "partial");
    assert.notEqual(evidence.outcome, "success");
    assert.equal(evidence.baselineId, onDisk.baselineId);
    assert.deepEqual(evidence.reasons, []);
    assert.equal(evidence.exitCode, 0);
  } finally {
    temp.cleanup();
  }
});

test("a partial attempt whose recorded digest does not match the manifest bytes is not fresh", () => {
  const temp = tempDir("gm2deep-partial-digest");
  try {
    writeSyntheticBaseline(temp.path, {
      attemptState: "partial",
      canonicalStatus: "updated",
      canonicalUpdated: true,
      currentOutput: "verified",
      digest: sha256Text("a different manifest"),
    });
    const provenance = readBaselineProvenance(temp.path);
    assert.equal(provenance.fresh, false);
    assert.equal(provenance.attemptState, "partial");
    assert.equal(provenance.attemptStateAccepted, true);
    assert.ok(
      provenance.reasons.some((reason) => reason.includes("does not match the manifest bytes")),
      provenance.reasons.join("; "),
    );
  } finally {
    temp.cleanup();
  }
});
