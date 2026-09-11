import type { CommandRunner } from "../main.ts";
import { DeepError } from "../../util/result.ts";
import { openWorkspace } from "../../workspaces/workspace.ts";
import { runDoctor, type DoctorReport } from "../../scheduling/pipeline.ts";
import { EXIT } from "../exit.ts";
import { flagString, renderKeyValues  } from "../output.ts";

/**
 * `doctor` answers one question: can this machine run the pipeline, and with which pinned tools?
 *
 * Every line is what a probe actually observed. A probe that failed prints the failure; it is never
 * rendered as a version, and the exit status is non-zero whenever any required tool does not match.
 */
function shortCommit(commit: string | null): string {
  return commit === null ? "unknown" : `${commit.slice(0, 7)}…`;
}

function gm2godotLine(report: DoctorReport): string {
  const { gm2godot } = report;
  if (gm2godot.version === null) {
    return `GM2Godot unavailable (${gm2godot.error ?? "no version reported"})`;
  }
  return `GM2Godot ${gm2godot.version} (commit ${shortCommit(gm2godot.commit)})`;
}

function pythonLine(report: DoctorReport): string {
  return `python ${report.gm2godot.python} (${report.gm2godot.pythonVersion ?? "version not reported"})`;
}

function godotLine(report: DoctorReport): string {
  const { godot } = report;
  if (godot.path === null || godot.version === null) {
    return `Godot not found (${godot.reason})`;
  }
  return godot.matchesExpected
    ? `Godot ${godot.version} (matches expected)`
    : `Godot ${godot.version} (mismatch: expected ${godot.reason})`;
}

function sandboxLine(report: DoctorReport, configured: string): string {
  const { sandbox } = report;
  if (sandbox.available) return `sandbox: ${sandbox.backend} (available)`;
  if (configured === "docker" || (sandbox.backend === "none" && sandbox.detail.includes("docker"))) {
    return `sandbox: docker (daemon unavailable) — ${sandbox.detail}`;
  }
  return `sandbox: none — isolation-requiring operations will fail closed (${sandbox.detail})`;
}

export const run: CommandRunner = async (context) => {
  const root = flagString(context.flags, "workspace");
  if (root === null) {
    throw new DeepError("GM2DEEP-CLI-USAGE", "doctor requires --workspace");
  }
  const workspace = openWorkspace(root);
  const report = await runDoctor({ workspace, logger: context.logger });

  for (const line of [
    gm2godotLine(report),
    pythonLine(report),
    godotLine(report),
    sandboxLine(report, workspace.config.sandbox.backend),
  ]) {
    context.stdout(line);
  }
  context.stdout("");
  context.stdout(
    renderKeyValues([
      ["checkout", report.gm2godot.checkout],
      ["expected GM2Godot", report.gm2godot.expected.join(", ")],
      ["bridge", report.bridge.reachable ? "reachable" : `unreachable (${report.bridge.error ?? "unknown"})`],
      ["gml api entries", report.gmlApiEntryCount === null ? "not reported" : String(report.gmlApiEntryCount)],
      ["godot binary", report.godot.path ?? "not configured or not found"],
      ["godot expected", `${workspace.config.godot.expectedVersion} (${workspace.config.godot.expectedVersionPrefix})`],
      ["sandbox configured", workspace.config.sandbox.backend],
      ["agent runtime", workspace.config.agent.runtime],
    ]),
  );

  const healthy =
    report.gm2godot.matchesExpected && report.bridge.reachable && report.godot.matchesExpected && report.sandbox.available;
  if (!healthy) {
    context.logger.warn("doctor: at least one required tool does not match this workspace's pins");
    return EXIT.failure;
  }
  return EXIT.ok;
};
