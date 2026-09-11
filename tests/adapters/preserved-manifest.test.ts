import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { generateBaseline, readBaselineEvidence, type BaselineEvidence } from "../../src/adapters/gm2godot/adapter.ts";
import { BASELINE_NOT_FRESH, readBaselineProvenance } from "../../src/adapters/gm2godot/manifest.ts";
import { DeepError } from "../../src/util/result.ts";
import { tempDir, testConfig, writeStubConverter, writeSyntheticBaseline } from "../helpers/environment.ts";

const TOOLCHAIN = { gm2godotVersion: "0.7.74", gm2godotCommit: null, pythonVersion: null };

function prepareSource(root: string): string {
  const sourceDir = join(root, "source");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, "Counter.yyp"), "{}\n", "utf8");
  return sourceDir;
}

test("a preserved manifest is not fresh and keeps the generation it describes", () => {
  const temp = tempDir("gm2deep-preserved");
  try {
    const written = writeSyntheticBaseline(temp.path, {
      attemptState: "failed",
      canonicalStatus: "preserved",
      canonicalUpdated: false,
      currentOutput: "unverified",
      digest: "sha256:".concat("1".repeat(64)),
    });
    const provenance = readBaselineProvenance(temp.path);
    assert.equal(provenance.fresh, false);
    assert.equal(provenance.attemptState, "failed");
    assert.equal(provenance.attemptStateAccepted, false);
    assert.equal(provenance.preservedGeneration?.present, true);
    assert.equal(provenance.preservedGeneration?.status, "preserved");
    assert.equal(provenance.preservedGeneration?.currentOutput, "unverified");
    assert.ok(
      provenance.reasons.some((reason) => reason.includes("preserved")),
      provenance.reasons.join("; "),
    );
    // The digest reported is the digest of the manifest bytes actually on disk.
    assert.equal(provenance.manifestSha256, written.manifestSha256);
    assert.equal(provenance.baselineId, written.manifestSha256);
  } finally {
    temp.cleanup();
  }
});

test("a conversion that preserves an older generation is rejected and leaves the baseline untouched", async () => {
  const temp = tempDir("gm2deep-preserved-reject");
  try {
    const stub = writeStubConverter(temp.path, "preserved");
    const sourceDir = prepareSource(temp.path);
    const baselineDir = join(temp.path, "baseline");
    // The destination already holds an older generation, which must survive the failed run byte for byte.
    mkdirSync(join(baselineDir, "gm2godot"), { recursive: true });
    writeFileSync(join(baselineDir, "gm2godot", "conversion_manifest.json"), '{"format_version": 2}\n', "utf8");
    writeFileSync(join(baselineDir, "sentinel.txt"), "previous generation\n", "utf8");
    const before = new Map<string, string>([
      ["gm2godot/conversion_manifest.json", readFileSync(join(baselineDir, "gm2godot", "conversion_manifest.json"), "utf8")],
      ["sentinel.txt", readFileSync(join(baselineDir, "sentinel.txt"), "utf8")],
    ]);

    const config = testConfig({
      sourceDir,
      workspaceDir: join(temp.path, "workspace"),
      checkout: stub.checkout,
      python: stub.python,
    });
    const attempts: BaselineEvidence[] = [];

    await assert.rejects(
      generateBaseline({
        sourceDir,
        baselineDir,
        stagingRoot: join(temp.path, "staging"),
        evidenceInventoryDir: join(temp.path, "evidence", "inventory"),
        config,
        python: stub.python,
        toolchain: TOOLCHAIN,
        onAttempt: (evidence) => {
          attempts.push(evidence);
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof DeepError);
        assert.equal(error.code, BASELINE_NOT_FRESH);
        assert.equal(error.detail["preservedGeneration"] !== null, true);
        assert.ok(JSON.stringify(error.detail["reasons"]).includes("preserved"), JSON.stringify(error.detail["reasons"]));
        return true;
      },
    );

    // The attempt was still recorded, as the rejected run.
    const attemptEvidence = attempts[0];
    assert.ok(attemptEvidence !== undefined, "the failed attempt must be reported to the caller");
    assert.equal(attemptEvidence.state, "failed");
    assert.equal(attemptEvidence.outcome.startsWith("rejected:"), true, attemptEvidence.outcome);

    // The pre-existing baseline is byte-identical and no baseline evidence was published.
    for (const [relative, content] of before) {
      assert.equal(readFileSync(join(baselineDir, relative), "utf8"), content, `${relative} must not be touched`);
    }
    assert.equal(existsSync(join(temp.path, "evidence", "inventory", "baseline.json")), false);
  } finally {
    temp.cleanup();
  }
});

test("allowStaleBaseline promotes the staged tree but still reports a preserved generation, not a success", async () => {
  const temp = tempDir("gm2deep-preserved-allowed");
  try {
    const stub = writeStubConverter(temp.path, "preserved");
    const sourceDir = prepareSource(temp.path);
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
      allowStaleBaseline: true,
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.interpretation.outcome, "failed");
    assert.equal(result.provenance?.fresh, false);
    assert.equal(result.provenance?.preservedGeneration?.present, true);
    assert.equal(result.promoted, true);

    const evidence = readBaselineEvidence(evidenceDir);
    assert.equal(evidence.preservedGeneration?.present, true);
    assert.equal(evidence.preservedGeneration?.status, "preserved");
    assert.notEqual(evidence.outcome, "success");
    assert.equal(evidence.outcome, "failed");
  } finally {
    temp.cleanup();
  }
});
