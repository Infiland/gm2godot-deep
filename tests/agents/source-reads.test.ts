import test from "node:test";
import assert from "node:assert/strict";
import {
  SourceReadCoverage,
  readTextRange,
} from "../../src/agents/sourceReads.ts";
import { sphinxMatches } from "../../src/documentation/sphinx.ts";
import { roleAgentConfig } from "../../src/agents/factory.ts";
import { sampleConfig } from "../helpers/harness.ts";
test("single-line source can be consumed completely through bounded column continuations", () => {
  const content = '{"data":"' + "a".repeat(140000) + '"}\nsecond line\n';
  let line = 1,
    column = 1;
  let consumed = 0;
  const coverage = new SourceReadCoverage();
  do {
    const result = readTextRange(content, {
      startLine: line,
      startColumn: column,
      maxLines: 300,
      maxChars: 64000,
    });
    assert.ok(result.endOffset - result.startOffset <= 64000);
    coverage.record(
      "large.yy",
      result.startOffset,
      result.endOffset,
      result.totalChars,
    );
    consumed += result.endOffset - result.startOffset;
    if (result.nextLine === null) break;
    assert.equal(coverage.complete("large.yy"), false);
    line = result.nextLine;
    column = result.nextColumn!;
  } while (true);
  assert.equal(consumed, content.length);
  assert.equal(coverage.complete("large.yy"), true);
});
test("coverage rejects skipped ranges and combines overlapping reads", () => {
  const c = new SourceReadCoverage();
  c.record("a", 5, 10, 10);
  assert.equal(c.complete("a"), false);
  c.record("a", 0, 3, 10);
  assert.equal(c.complete("a"), false);
  c.record("a", 2, 6, 10);
  assert.equal(c.complete("a"), true);
  assert.equal(c.complete("unread"), false);
});
test("official Sphinx stemmed terms find API symbols absent from page filenames", () => {
  const index = {
    docnames: ["classes/class_node", "classes/class_characterbody2d"],
    terms: { get_tre: 0, move_and_slid: 1 },
  };
  assert.equal(sphinxMatches(index, "get_tree").get("classes/class_node"), 2);
  assert.equal(
    sphinxMatches(index, "move_and_slide").get("classes/class_characterbody2d"),
    2,
  );
});
test("public role names apply to all internal agent roles", () => {
  const config = sampleConfig({
    sourcePath: "/tmp/source",
    workspacePath: "/tmp/work",
  });
  config.agent.roleOverrides = {
    researcher: { runtime: "codex", model: "research" },
    planner: { runtime: "claude", model: "plan" },
    reviewer: { runtime: "pi", model: "review" },
    implementer: { runtime: "opencode", model: "build" },
  };
  for (const [role, expected] of [
    ["analyst", "research"],
    ["reconciler", "plan"],
    ["risk_reviewer", "review"],
    ["patch_reviewer", "review"],
    ["implementer", "build"],
  ] as const)
    assert.equal(roleAgentConfig(config, role).model, expected);
});

test("role runtime overrides do not inherit an executable belonging to another runtime", () => {
  const config = sampleConfig({ sourcePath: "/tmp/source", workspacePath: "/tmp/work" });
  config.agent.runtime = "codex";
  config.agent.executable = "/custom/Codex tools/codex";
  config.agent.roleOverrides = {
    researcher: { runtime: "codex", model: "research" },
    planner: { runtime: "claude", model: "plan" },
    implementer: { runtime: "opencode", model: "build" },
    reviewer: { model: "review" },
  };
  assert.equal(roleAgentConfig(config, "analyst").executable, config.agent.executable);
  assert.equal(roleAgentConfig(config, "risk_reviewer").executable, config.agent.executable);
  assert.equal(roleAgentConfig(config, "reconciler").executable, null);
  assert.equal(roleAgentConfig(config, "implementer").executable, null);
});

test("analyst submission is rejected until all source characters have been read", async () => {
  const {
    createTestWorkspace,
    insertTask,
    minimalInventory,
    writeFileEnsured,
  } = await import("../helpers/harness.ts");
  const { buildToolSpecs } = await import("../../src/agents/toolSpecs.ts");
  const { createLogger } = await import("../../src/util/log.ts");
  const { join } = await import("node:path");
  const ws = createTestWorkspace("source-receipts");
  try {
    writeFileEnsured(
      join(ws.workspace.paths.source, "large.gml"),
      "a".repeat(70000),
    );
    const task = insertTask(ws.repo, {
      id: "receipt-task",
      read: ["source:large.gml"],
    });
    const context = {
      role: "analyst" as const,
      taskId: task.id,
      workspaceRoots: {
        source: ws.workspace.paths.source,
        baseline: ws.workspace.paths.baseline,
        port: ws.workspace.paths.port,
        task: ws.workspace.paths.tasks,
        evidence: ws.workspace.paths.evidence,
      },
      allowlist: task.allowlist,
      logger: createLogger({ stderr: () => {} }),
      recordPolicyDenial: () => {},
      signal: new AbortController().signal,
      attempt: 1,
    };
    const specs = buildToolSpecs("analyst", {
      context,
      task,
      unitId: "script:large",
      unitSourcePaths: ["large.gml"],
      unitGeneratedOutputs: [],
      converterDiagnostics: [],
      inventory: minimalInventory(),
    });
    const read = specs.find((s) => s.name === "read_source")!;
    const submit = specs.find((s) => s.name === "submit_analysis")!;
    await assert.rejects(submit.execute({}, context), /Read every line/);
    await read.execute({ path: "large.gml", maxChars: 40000 }, context);
    await assert.rejects(submit.execute({}, context), /Read every line/);
    await read.execute(
      { path: "large.gml", startColumn: 40001, maxChars: 40000 },
      context,
    );
    await assert.rejects(
      submit.execute({}, context),
      (error) =>
        error instanceof Error && !error.message.includes("Read every line"),
    );
  } finally {
    ws.cleanup();
  }
});
