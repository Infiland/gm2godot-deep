import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { readArchitecturePolicy, readBaselineProvenance } from "../../src/adapters/gm2godot/manifest.ts";
import {
  SUPPORTED_ARCHITECTURE_POLICY_FORMAT_VERSION,
  SUPPORTED_ATTEMPT_FORMAT_VERSION,
  SUPPORTED_GENERATION_INVENTORY_FORMAT_VERSION,
  SUPPORTED_MANIFEST_FORMAT_VERSION,
  UPSTREAM_SCHEMA_ERROR,
} from "../../src/adapters/gm2godot/versions.ts";
import { DeepError } from "../../src/util/result.ts";
import { tempDir, writeSyntheticBaseline } from "../helpers/environment.ts";

test("an unsupported manifest format version is rejected before its contents are interpreted", () => {
  const temp = tempDir("gm2deep-schema-manifest");
  try {
    // The payload's *semantic* fields would otherwise produce a verdict (no inventory entries, an
    // unknown attempt state, a preserved canonical manifest) — the version guard must win.
    writeSyntheticBaseline(temp.path, {
      manifestFormatVersion: 3,
      entryCount: 0,
      attemptState: "not-a-real-state",
      canonicalStatus: "preserved",
      canonicalUpdated: false,
      currentOutput: "unverified",
    });
    assert.throws(
      () => readBaselineProvenance(temp.path),
      (error: unknown) => {
        assert.ok(error instanceof DeepError);
        assert.equal(error.code, UPSTREAM_SCHEMA_ERROR);
        assert.equal(error.detail["observed"], 3);
        assert.deepEqual(error.detail["supported"], [SUPPORTED_MANIFEST_FORMAT_VERSION]);
        return true;
      },
    );
  } finally {
    temp.cleanup();
  }
});

test("an unsupported generation-inventory format version is rejected", () => {
  const temp = tempDir("gm2deep-schema-inventory");
  try {
    writeSyntheticBaseline(temp.path, { inventoryFormatVersion: 2, entryCount: 0 });
    assert.throws(
      () => readBaselineProvenance(temp.path),
      (error: unknown) => {
        assert.ok(error instanceof DeepError);
        assert.equal(error.code, UPSTREAM_SCHEMA_ERROR);
        assert.equal(error.detail["observed"], 2);
        assert.deepEqual(error.detail["supported"], [SUPPORTED_GENERATION_INVENTORY_FORMAT_VERSION]);
        assert.ok(JSON.stringify(error.detail["what"]).includes("generation_inventory"));
        return true;
      },
    );
  } finally {
    temp.cleanup();
  }
});

test("an unsupported attempt format version is rejected instead of being read as a preserved generation", () => {
  const temp = tempDir("gm2deep-schema-attempt");
  try {
    writeSyntheticBaseline(temp.path, {
      attemptFormatVersion: 2,
      attemptState: "failed",
      canonicalStatus: "preserved",
      canonicalUpdated: false,
      currentOutput: "unverified",
    });
    assert.throws(
      () => readBaselineProvenance(temp.path),
      (error: unknown) => {
        assert.ok(error instanceof DeepError);
        assert.equal(error.code, UPSTREAM_SCHEMA_ERROR);
        assert.equal(error.detail["observed"], 2);
        assert.deepEqual(error.detail["supported"], [SUPPORTED_ATTEMPT_FORMAT_VERSION]);
        assert.ok(JSON.stringify(error.detail["what"]).includes("conversion_attempt.json"));
        return true;
      },
    );
  } finally {
    temp.cleanup();
  }
});

test("an unsupported architecture-policy format version is rejected before the policy body is read", () => {
  const temp = tempDir("gm2deep-schema-policy");
  try {
    mkdirSync(join(temp.path, "gm2godot"), { recursive: true });
    writeFileSync(
      join(temp.path, "gm2godot", "architecture_policy.json"),
      `${JSON.stringify({ format_version: 9, conversion: null }, null, 2)}\n`,
      "utf8",
    );
    assert.throws(
      () => readArchitecturePolicy(temp.path),
      (error: unknown) => {
        assert.ok(error instanceof DeepError);
        assert.equal(error.code, UPSTREAM_SCHEMA_ERROR);
        assert.equal(error.detail["observed"], 9);
        assert.deepEqual(error.detail["supported"], [SUPPORTED_ARCHITECTURE_POLICY_FORMAT_VERSION]);
        return true;
      },
    );
  } finally {
    temp.cleanup();
  }
});

test("a supported version set still produces a verdict, and an absent policy is null", () => {
  const temp = tempDir("gm2deep-schema-supported");
  try {
    writeSyntheticBaseline(temp.path, {});
    const provenance = readBaselineProvenance(temp.path);
    assert.equal(provenance.fresh, true, provenance.reasons.join("; "));
    assert.equal(provenance.manifestFormatVersion, SUPPORTED_MANIFEST_FORMAT_VERSION);
    assert.equal(readArchitecturePolicy(temp.path), null);
  } finally {
    temp.cleanup();
  }
});

test("a newer version with an incompatible shape is refused rather than interpreted with older assumptions", () => {
  const temp = tempDir("gm2deep-schema-malformed");
  try {
    mkdirSync(join(temp.path, "gm2godot"), { recursive: true });
    writeFileSync(
      join(temp.path, "gm2godot", "conversion_manifest.json"),
      `${JSON.stringify({ format_version: 3, conversion: null }, null, 2)}\n`,
      "utf8",
    );
    assert.throws(
      () => readBaselineProvenance(temp.path),
      (error: unknown) => {
        assert.ok(error instanceof DeepError);
        const refused = error.code === UPSTREAM_SCHEMA_ERROR || error.code === "GM2DEEP-UPSTREAM-MALFORMED";
        assert.ok(refused, `expected the manifest to be refused, got ${error.code}`);
        return true;
      },
    );
  } finally {
    temp.cleanup();
  }
});
