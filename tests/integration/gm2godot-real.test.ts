import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { bridgeGmlApi, bridgeInventory, probeGm2Godot } from "../../src/adapters/gm2godot/bridge.ts";
import { generateBaseline } from "../../src/adapters/gm2godot/adapter.ts";
import { MANIFEST_RELATIVE_PATH } from "../../src/adapters/gm2godot/manifest.ts";
import {
  FIXTURE_PROJECT,
  GM2GODOT_CHECKOUT,
  GM2GODOT_PYTHON,
  createTestWorkspace,
  readJson,
} from "../helpers/harness.ts";

const SKIP = process.env["DEEP_INTEGRATION"] === "1" ? false : "DEEP_INTEGRATION is not set";

test("the real bridge probes the pinned GM2Godot and parses the fixture inventory", { skip: SKIP }, async () => {
  const options = { checkout: GM2GODOT_CHECKOUT, python: GM2GODOT_PYTHON };
  const probe = await probeGm2Godot(options, ["0.7.74"]);
  assert.equal(probe.gm2godotVersion, "0.7.74");
  assert.equal(probe.checkout, GM2GODOT_CHECKOUT);
  assert.equal(probe.pythonExecutable, GM2GODOT_PYTHON);
  assert.match(probe.pythonVersion, /^3\./);
  assert.match(probe.commit ?? "", /^38b3648/);

  const inventory = await bridgeInventory(options, FIXTURE_PROJECT);
  assert.equal(inventory.project.name, "Counter");
  assert.equal(inventory.project.ideVersion, "2026.0.0.16");

  const parent = inventory.objects.find((object) => object.name === "obj_counter");
  const child = inventory.objects.find((object) => object.name === "obj_counter_child");
  assert.ok(parent !== undefined && child !== undefined);
  assert.equal(parent.parentObjectName, null);
  assert.equal(child.parentObjectName, "obj_counter");
  assert.deepEqual(
    parent.events.map((event) => event.file).sort(),
    ["Create_0.gml", "Step_0.gml"],
  );

  const room = inventory.rooms.find((entry) => entry.name === "rm_main");
  assert.ok(room !== undefined);
  assert.ok(room.creationCodeFile !== null, "the fixture room declares a creation-code file");
  assert.deepEqual(room.instances.map((instance) => instance.objectName), ["obj_counter"]);
  assert.equal(room.ordered, true);

  assert.deepEqual(
    inventory.scripts.map((script) => script.name).sort(),
    ["scr_math", "scr_state"],
  );
  assert.deepEqual(
    inventory.sprites.map((sprite) => sprite.name),
    ["spr_counter"],
  );

  const entries = await bridgeGmlApi(options);
  assert.ok(entries.length > 1000, `expected the full GML API manifest, got ${String(entries.length)} entries`);
  const statuses = new Set(entries.map((entry) => entry.status));
  assert.deepEqual([...statuses].sort(), ["implemented", "partial", "planned", "unsupported"]);
  const instancePosition = entries.find((entry) => entry.name === "instance_position");
  assert.ok(instancePosition !== undefined);
  assert.equal(instancePosition.status, "partial");
  assert.equal(instancePosition.issueNumber, 487);
});

test("a real conversion of the fixture produces a fresh, promotable baseline", { skip: SKIP }, async () => {
  const ws = createTestWorkspace("gm2godot-real", { sourceDir: FIXTURE_PROJECT });
  try {
    const result = await generateBaseline({
      sourceDir: FIXTURE_PROJECT,
      baselineDir: ws.workspace.paths.baseline,
      stagingRoot: ws.workspace.paths.staging,
      evidenceInventoryDir: ws.workspace.paths.evidenceInventory,
      config: ws.workspace.config,
      python: GM2GODOT_PYTHON,
      toolchain: { gm2godotVersion: "0.7.74", gm2godotCommit: null, pythonVersion: null },
    });

    assert.equal(result.exitCode, 0, result.interpretation.summaryLine ?? "conversion did not exit 0");
    assert.equal(result.promoted, true);
    assert.ok(result.provenance !== null);
    assert.equal(result.provenance?.fresh, true, result.provenance?.reasons.join("; "));
    assert.equal(result.provenance?.attemptStateAccepted, true);
    assert.match(result.provenance?.baselineId ?? "", /^sha256:[0-9a-f]{64}$/);
    assert.ok((result.provenance?.inventoryEntryCount ?? 0) > 0);
    assert.match(result.interpretation.summaryLine ?? "", /^GM2Godot conversion outcome: /);

    const manifestPath = `${ws.workspace.paths.baseline}/${MANIFEST_RELATIVE_PATH}`;
    assert.equal(existsSync(manifestPath), true);
    const manifest = readJson<{ format_version: number; conversion: { state: string } }>(manifestPath);
    assert.equal(manifest.format_version, 2);
    assert.ok(
      ["success", "partial"].includes(manifest.conversion.state),
      `unexpected conversion state ${manifest.conversion.state}`,
    );
    assert.equal(existsSync(`${ws.workspace.paths.baseline}/project.godot`), true);

    const evidence = readJson<{ baselineId: string | null; exitCode: number | null }>(
      `${ws.workspace.paths.evidenceInventory}/baseline.json`,
    );
    assert.equal(evidence.baselineId, result.provenance?.baselineId);
    assert.equal(evidence.exitCode, 0);
  } finally {
    ws.cleanup();
  }
});
