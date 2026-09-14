import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  RequestSchema,
  ResearchParamsSchema,
  HostSnapshotSchema,
} from "../../src/host/protocol.ts";
import { join } from "node:path";
import { repoRoot } from "../../src/util/package.ts";

test("shipped JSON schemas exactly match runtime protocol validators", () => {
  for (const [name, schema] of Object.entries({
    request: RequestSchema,
    "host-snapshot": HostSnapshotSchema,
    research: ResearchParamsSchema,
  }))
    assert.deepEqual(
      JSON.parse(
        readFileSync(join(repoRoot, `schemas/${name}.v1.schema.json`), "utf8"),
      ),
      z.toJSONSchema(schema),
    );
});
test("client budget names and worker preferences round trip without silently dropping limits", () => {
  const parsed = ResearchParamsSchema.parse({
    jobRoot: "job",
    sourcePath: "source",
    baselinePath: "baseline",
    hostSnapshotPath: "snapshot",
    settings: {
      runtime: "opencode",
      freeOnly: true,
      analysisWorkers: 4,
      freeProviderConcurrency: 2,
      budgets: { maxTokens: 1000, maxCostUsd: 0, maxSeconds: 60 },
    },
  });
  assert.deepEqual(parsed.settings.budgets, {
    maxTokens: 1000,
    maxCostUsd: 0,
    maxSeconds: 60,
  });
  assert.equal(parsed.settings.freeProviderConcurrency, 2);
});
