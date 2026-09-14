import { roleAgentConfig } from "../agents/factory.ts";
import type { PipelineRun } from "./pipeline.ts";

export function emitImplementationTasks(run: PipelineRun): void {
  const selected = roleAgentConfig(run.options.workspace.config, "implementer");
  run.options.onProgress?.({
    phase: "tasks",
    tasks: run.repo.listTasks().map((task) => ({
      taskId: task.id,
      label: task.unitIds.join(", ") || task.id,
      phase: "implementation",
      role: task.role,
      state: task.state.toLowerCase(),
      attempt: task.attempt,
      provider: selected.provider,
      model: selected.model,
      reason: task.blockReason,
      summary: task.strategy,
    })),
  });
}
