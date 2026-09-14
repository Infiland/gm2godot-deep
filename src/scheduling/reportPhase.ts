/**
 * Phase orchestration: analyze → plan → implement → validate → report.
 *
 * Every phase receives the single {@link PipelineRun} context, so no phase ever reaches for a collaborator
 * that was not handed to it. Identity and provenance fields on every artifact written here are host-owned:
 * a model describes what it found, never who it is or what it ran against.
 */

import { writeReport } from "../evidence/report.ts";
import { type PipelineRun } from "./pipeline.ts";

export async function phaseReport(run: PipelineRun): Promise<void> {
  const written = await writeReport({
    workspace: run.options.workspace,
    repo: run.repo,
    logger: run.options.logger,
  });
  run.options.logger.info(`report: ${written.markdownPath}`);
}
