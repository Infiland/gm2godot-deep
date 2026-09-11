import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  EVIDENCE_STALE,
  analysisPathFor,
  listAnalyses,
  readAnalysis,
  validateAnalysisEvidence,
  writeAnalysis,
} from "../../src/evidence/store.ts";
import type { AnalysisRecord, EvidenceRef } from "../../src/evidence/schemas.ts";
import { InventoryRecordSchema, type InventoryRecord } from "../../src/indexing/inventory.ts";
import { sha256File, sha256Text } from "../../src/util/sha256.ts";
import { DeepError } from "../../src/util/result.ts";
import { tempDir } from "../helpers/environment.ts";

const SOURCE_PATH = "scripts/scr_demo/scr_demo.gml";
const UNIT_ID = "script:scr_demo";
const SOURCE_LINES = ["function scr_demo() {", "    return 1;", "}", ""];

function inventoryFor(sourceSha256: string, bytes: number): InventoryRecord {
  return InventoryRecordSchema.parse({
    schemaVersion: 1,
    sourceSnapshotId: sha256Text("snapshot"),
    baselineId: null,
    createdAt: "2026-01-01T00:00:00Z",
    tool: {
      gm2godotDeepVersion: "0.1.0",
      node: process.version,
      python: null,
      gm2godot: { version: "0.7.74", commit: null },
    },
    files: [
      {
        path: SOURCE_PATH,
        sha256: sourceSha256,
        bytes,
        classification: "code",
        classificationReason: "GML source file",
        resourceType: null,
        resourceName: null,
      },
    ],
    resources: [],
    objects: [],
    rooms: [],
    units: [
      {
        id: UNIT_ID,
        kind: "script",
        name: "scr_demo",
        sourcePaths: [SOURCE_PATH],
        sourceHashes: { [SOURCE_PATH]: sourceSha256 },
        generatedOutputs: [],
        analysisRequired: true,
      },
    ],
    counts: {
      total: 1,
      excluded: 0,
      byClassification: { code: 1 },
      byUnitKind: { script: 1 },
      unitsTotal: 1,
      unitsRequiringAnalysis: 1,
      unitsDeterministicOnly: 0,
    },
    gmlApi: { entryCount: 0, byStatus: {}, digest: sha256Text("gml-api") },
  });
}

function recordFor(inventory: InventoryRecord, reference: (line: number) => EvidenceRef): AnalysisRecord {
  const file = inventory.files[0];
  assert.ok(file !== undefined);
  const location = reference(2);
  return {
    schemaVersion: 1,
    unitId: UNIT_ID,
    unitKind: "script",
    sourceSnapshotId: inventory.sourceSnapshotId,
    baselineId: null,
    sourcePaths: [{ path: file.path, sha256: file.sha256 }],
    generatedOutputs: [],
    converterDiagnostics: [],
    purpose: { text: "A demo script used to exercise evidence validation.", basis: "observed" },
    behavior: { observed: [{ statement: "returns a constant", evidence: [location] }], inferred: [] },
    lifecycle: [
      { event: "call", responsibilities: [{ statement: "returns 1", basis: "observed" }], evidence: [location] },
    ],
    ownedState: [],
    sharedState: [],
    inputs: [],
    sideEffects: [],
    dependencies: { confirmed: [], inferred: [], unresolved: [] },
    hazards: [],
    strategy: "retain_generated",
    strategyRationale: { text: "the generated output is adequate", basis: "observed" },
    acceptanceScenarios: [],
    assumptions: [],
    uncertainties: [],
    blockers: [],
    evidence: [{ claim: "the script returns a constant", locations: [location] }],
    producedBy: {
      runtime: "mock",
      simulated: true,
      promptVersion: "1",
      schemaVersion: 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, reported: false },
    },
  };
}

async function setup(): Promise<{
  dir: string;
  snapshotDir: string;
  inventory: InventoryRecord;
  cleanup: () => void;
}> {
  const temp = tempDir("gm2deep-evidence");
  const snapshotDir = join(temp.path, "source");
  mkdirSync(join(snapshotDir, "scripts/scr_demo"), { recursive: true });
  const absolute = join(snapshotDir, SOURCE_PATH);
  writeFileSync(absolute, SOURCE_LINES.join("\n"), "utf8");
  const inventory = inventoryFor(await sha256File(absolute), Buffer.byteLength(SOURCE_LINES.join("\n")));
  return { dir: join(temp.path, "analyses"), snapshotDir, inventory, cleanup: temp.cleanup };
}

function referenceFor(inventory: InventoryRecord): (line: number) => EvidenceRef {
  const file = inventory.files[0];
  assert.ok(file !== undefined);
  return (line: number): EvidenceRef => ({
    path: file.path,
    sha256: file.sha256,
    line,
    column: 1,
    snippet: SOURCE_LINES[line - 1] ?? "",
  });
}

test("a valid analysis record round-trips through the evidence store", async () => {
  const { dir, snapshotDir, inventory, cleanup } = await setup();
  try {
    const record = recordFor(inventory, referenceFor(inventory));
    validateAnalysisEvidence(record, inventory, { snapshotDir });

    const written = writeAnalysis(dir, record);
    assert.equal(written.path, analysisPathFor(dir, UNIT_ID));
    assert.deepEqual(readAnalysis(dir, UNIT_ID), record);
    assert.deepEqual(
      listAnalyses(dir).map((candidate) => candidate.unitId),
      [UNIT_ID],
    );
  } finally {
    cleanup();
  }
});

test("a source hash that does not match the inventory is rejected as stale", async () => {
  const { snapshotDir, inventory, cleanup } = await setup();
  try {
    const record = recordFor(inventory, referenceFor(inventory));
    const source = record.sourcePaths[0];
    assert.ok(source !== undefined);
    const forged: AnalysisRecord = {
      ...record,
      sourcePaths: [{ path: source.path, sha256: sha256Text("not the file") }],
    };
    assert.throws(
      () => validateAnalysisEvidence(forged, inventory, { snapshotDir }),
      (error: unknown) => {
        assert.ok(error instanceof DeepError);
        assert.equal(error.code, EVIDENCE_STALE);
        const detail = JSON.stringify(error.detail);
        assert.ok(detail.includes("does not match inventory"), detail);
        assert.ok(detail.includes(SOURCE_PATH));
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test("an evidence line beyond the end of the file is rejected as stale", async () => {
  const { snapshotDir, inventory, cleanup } = await setup();
  try {
    const valid = recordFor(inventory, referenceFor(inventory));
    const file = inventory.files[0];
    assert.ok(file !== undefined);
    const tooFar: AnalysisRecord = {
      ...valid,
      evidence: [
        {
          claim: "a line that does not exist",
          locations: [{ path: file.path, sha256: file.sha256, line: 99, column: 1, snippet: "" }],
        },
      ],
    };
    assert.throws(
      () => validateAnalysisEvidence(tooFar, inventory, { snapshotDir }),
      (error: unknown) => {
        assert.ok(error instanceof DeepError);
        assert.equal(error.code, EVIDENCE_STALE);
        assert.ok(JSON.stringify(error.detail).includes("line 99"), JSON.stringify(error.detail));
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test("a reference to a path that is not in the inventory is rejected as stale", async () => {
  const { snapshotDir, inventory, cleanup } = await setup();
  try {
    const record = recordFor(inventory, referenceFor(inventory));
    const ghost: AnalysisRecord = {
      ...record,
      evidence: [
        {
          claim: "a file that never existed",
          locations: [{ path: "scripts/ghost/ghost.gml", sha256: sha256Text("ghost"), line: 1, column: 1, snippet: "" }],
        },
      ],
    };
    assert.throws(
      () => validateAnalysisEvidence(ghost, inventory, { snapshotDir }),
      (error: unknown) => {
        assert.ok(error instanceof DeepError);
        assert.equal(error.code, EVIDENCE_STALE);
        assert.ok(JSON.stringify(error.detail).includes("scripts/ghost/ghost.gml"));
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test("a record for a unit the inventory does not know is rejected as stale", async () => {
  const { snapshotDir, inventory, cleanup } = await setup();
  try {
    const record = recordFor(inventory, referenceFor(inventory));
    assert.throws(
      () => validateAnalysisEvidence({ ...record, unitId: "script:absent" }, inventory, { snapshotDir }),
      (error: unknown) => {
        assert.ok(error instanceof DeepError);
        assert.equal(error.code, EVIDENCE_STALE);
        return true;
      },
    );
  } finally {
    cleanup();
  }
});
