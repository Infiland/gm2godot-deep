import { copyFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureDir, readJsonFile, writeJsonAtomic } from "../util/json.ts";
import { copyTree } from "../workspaces/staging.ts";
import { executedEvidence, failedResult, passedResult, skippedResult } from "./levels.ts";
import type { ValidationResult } from "./levels.ts";
import { runGodotHeadless } from "./godotRun.ts";
import type { GodotVersionExpectation } from "./godotRun.ts";
import { compareTraces, describeDifferences, observeTrace, parseTrace } from "./trace.ts";
import { DeepError } from "../util/result.ts";

/**
 * Level D behavioural verification: step the candidate port under a scenario harness and compare the
 * trace it prints against a recorded expectation.
 *
 * The expectation's provenance is written into the check name and reason verbatim, so a `synthetic`
 * expectation can never be read as observed original behaviour. A missing engine or a missing
 * expectation is `skipped` with a reason — never `passed`.
 */

/** Where the scenario harness is installed inside the candidate project copy. */
export const BEHAVIORAL_SCENARIO_RELATIVE_PATH = "tools/deep_trace.gd";
export const BEHAVIORAL_DIFF_SUFFIX = ".diff.json";

export interface BehavioralDeps {
  readonly candidateProjectDir: string;
  readonly scenarioSourcePath: string;
  readonly expectedTracePath: string;
  readonly workspaceValidationDir: string;
  readonly godotBinary: string | null;
  readonly timeoutSeconds: number;
  readonly inputRevision: string;
  readonly checkId: string;
  readonly expectedGodot?: GodotVersionExpectation;
  /** Payload keys the recorded expectation declares optional; nothing else is normalised. */
  readonly optionalPayloadKeys?: readonly string[];
}

export async function checkBehavioral(deps: BehavioralDeps): Promise<ValidationResult> {
  const level = "D" as const;
  const identity = {
    level,
    checkId: deps.checkId,
    name: `level D behavioural — scenario trace comparison (expected trace provenance: unknown)`,
    inputRevision: deps.inputRevision,
  };

  if (deps.godotBinary === null || deps.godotBinary.trim().length === 0) {
    return skippedResult({
      ...identity,
      reason: "godot binary not configured or not found; the scenario cannot be stepped",
    });
  }

  if (!existsSync(deps.expectedTracePath)) {
    return skippedResult({
      ...identity,
      reason: `no recorded expectation at ${deps.expectedTracePath}, so there is nothing to compare against`,
    });
  }

  const expected = parseTrace(readJsonFile(deps.expectedTracePath));
  const named = {
    ...identity,
    name: `level D behavioural — scenario trace comparison (expected trace provenance: ${expected.provenance})`,
  };

  const projectCopy = join(deps.workspaceValidationDir, deps.checkId);
  rmSync(projectCopy, { recursive: true, force: true });
  copyTree(deps.candidateProjectDir, projectCopy);
  const scenarioTarget = join(projectCopy, ...BEHAVIORAL_SCENARIO_RELATIVE_PATH.split("/"));
  ensureDir(dirname(scenarioTarget));
  copyFileSync(deps.scenarioSourcePath, scenarioTarget);

  const run = await runGodotHeadless({
    binary: deps.godotBinary,
    projectPath: projectCopy,
    scriptPath: BEHAVIORAL_SCENARIO_RELATIVE_PATH,
    timeoutSeconds: deps.timeoutSeconds,
    logsDir: join(deps.workspaceValidationDir, "logs"),
    checkId: deps.checkId,
    inputRevision: deps.inputRevision,
    level,
    name: named.name,
    ...(deps.expectedGodot === undefined ? {} : { expectedGodot: deps.expectedGodot }),
  });

  if (run.state !== "passed") {
    return failedResult({
      ...named,
      reason: `scenario run did not pass: ${run.reason ?? run.state}`,
      ...(run.command === undefined ? {} : { command: run.command }),
      ...(run.engineVersion === undefined ? {} : { engineVersion: run.engineVersion }),
      exitStatus: run.exitStatus,
      durationMs: run.durationMs,
      logsPath: run.logsPath,
      artifacts: run.artifacts,
    });
  }

  const evidence = executedEvidence(run);
  if (evidence === null) {
    return failedResult({
      ...named,
      reason: "scenario run is marked passed but carries no command, engine build and exit status",
      logsPath: run.logsPath,
      artifacts: run.artifacts,
    });
  }

  let observed;
  try {
    observed = observeTrace(run.stdout);
  } catch (error) {
    if (error instanceof DeepError && error.code.startsWith("GM2DEEP-TRACE")) {
      return failedResult({
        ...named,
        reason: `scenario output could not be read: ${error.message}`,
        ...evidence,
        durationMs: run.durationMs,
        logsPath: run.logsPath,
        artifacts: [run.logsPath, ...run.artifacts],
      });
    }
    throw error;
  }

  const comparison = compareTraces(expected.events, observed, {
    ...(deps.optionalPayloadKeys === undefined ? {} : { optionalPayloadKeys: deps.optionalPayloadKeys }),
  });

  if (comparison.equal) {
    return passedResult({
      ...named,
      ...evidence,
      durationMs: run.durationMs,
      logsPath: run.logsPath,
      artifacts: [run.logsPath, deps.expectedTracePath],
      reason: `observed ${String(observed.length)} event(s) match the expectation exactly (expected trace provenance: ${expected.provenance}; randomness ${expected.randomness.mode}${expected.randomness.seed === undefined ? "" : ` seed ${String(expected.randomness.seed)}`})`,
    });
  }

  const diffPath = join(deps.workspaceValidationDir, `${deps.checkId}${BEHAVIORAL_DIFF_SUFFIX}`);
  ensureDir(deps.workspaceValidationDir);
  writeJsonAtomic(diffPath, {
    schemaVersion: 1,
    checkId: deps.checkId,
    expectedTracePath: deps.expectedTracePath,
    expectedProvenance: expected.provenance,
    expectedEvents: expected.events.length,
    observedEvents: observed.length,
    differences: comparison.differences,
  });
  return failedResult({
    ...named,
    reason: `observed trace differs from the expectation in ${String(comparison.differences.length)} place(s) (expected trace provenance: ${expected.provenance}): ${describeDifferences(comparison.differences)}`,
    ...evidence,
    durationMs: run.durationMs,
    logsPath: run.logsPath,
    artifacts: [diffPath, run.logsPath, deps.expectedTracePath],
  });
}
