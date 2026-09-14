import { verifySelection, selectionChanged } from "./selection.ts";
import { readMonitoring } from "./monitoring.ts";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { discoverAgent, discoverPi } from "../agents/capabilities.ts";
import { writeResearchReport } from "../evidence/researchReport.ts";
import { PatchRecordPayloadSchema } from "../evidence/schemas.ts";
import { applyFileEntry } from "../integration/diff.ts";
import { TaskMachine } from "../scheduling/machine.ts";
import { openWorkspaceRepo, runPipeline } from "../scheduling/pipeline.ts";
import { newId } from "../util/ids.ts";
import { readJsonFile } from "../util/json.ts";
import { createLogger } from "../util/log.ts";
import { packageVersion } from "../util/package.ts";
import { DeepError } from "../util/result.ts";
import { copyTree } from "../workspaces/staging.ts";
import { openWorkspace } from "../workspaces/workspace.ts";
import { journalEvent, loadJob, saveJob, type JobRecord } from "./journal.ts";
import { acquireJobLock } from "./lock.ts";
import { prepareHostJob, verifyHostInputs } from "./prepare.ts";
import {
  HostSettingsSchema,
  ConfigureParamsSchema,
  ResearchParamsSchema,
  type HostEvent,
  type HostRequest,
} from "./protocol.ts";
import { updateResumeSettings } from "./settings.ts";

interface ActiveJob {
  record: JobRecord;
  controller: AbortController;
  done: Promise<void>;
  analysisWorkers: number;
}

/** One running project per subprocess. The host can still pause or inspect it while work is in flight. */
export class HostService {
  readonly send: (event: HostEvent) => void;
  active: ActiveJob | null = null;
  private preparing = false;
  constructor(send: (event: HostEvent) => void) {
    this.send = send;
  }
  async handle(request: HostRequest): Promise<void> {
    try {
      const result = await this.dispatch(request);
      this.send({ protocolVersion: 1, id: request.id, type: "result", result });
    } catch (error) {
      this.send({
        protocolVersion: 1,
        id: request.id,
        type: "error",
        error: {
          code: error instanceof DeepError ? error.code : "HOST_REQUEST_FAILED",
          message: error instanceof Error ? error.message : String(error),
          recoverable: true,
        },
      });
    }
  }
  private record(params: Record<string, unknown>): JobRecord {
    const root =
      typeof params["jobRoot"] === "string" ? resolve(params["jobRoot"]) : null;
    if (
      this.active !== null &&
      (root === this.active.record.jobRoot ||
        params["jobId"] === this.active.record.jobId)
    )
      return this.active.record;
    if (root === null)
      throw new DeepError(
        "HOST_JOB_REQUIRED",
        "A jobRoot is required to reopen a job",
      );
    return loadJob(root);
  }
  private async dispatch(request: HostRequest): Promise<unknown> {
    if (request.method === "capabilities") {
      const settings = HostSettingsSchema.parse(
        request.params["settings"] ?? request.params,
      );
      const base = {
        protocolVersion: 1,
        extensionVersion: packageVersion(),
        features: {
          monitoring: true,
          liveConfiguration: true,
          resumeModelSelection: true,
        },
        methods: [
          "configure",
          "research",
          "convert",
          "status",
          "pause",
          "resume",
          "cancel",
        ],
        runtimes: ["mock", "pi", "codex", "claude", "opencode"],
        maxAnalysisWorkers: 32,
        requiresPython: false,
      };
      if (settings.runtime === "mock")
        return {
          ...base,
          provider: {
            runtime: "mock",
            installed: true,
            authenticated: true,
            models: [],
            reason: "Simulated local runtime",
          },
        };
      if (settings.runtime === "pi")
        return {
          ...base,
          provider: await discoverPi(settings.provider ?? "", {}),
        };
      const provider = await discoverAgent({
        runtime: settings.runtime,
        ...(settings.provider ? { provider: settings.provider } : {}),
        freeOnly: settings.freeOnly,
        ...(settings.executable ? { executable: settings.executable } : {}),
        ...(settings.endpoint ? { endpoint: settings.endpoint } : {}),
        signal: AbortSignal.timeout(20000),
      });
      return { ...base, provider };
    }
    if (request.method === "research") {
      if (this.active !== null || this.preparing)
        throw new DeepError(
          "HOST_BUSY",
          "Pause the current job before starting another",
        );
      this.preparing = true;
      try {
        const params = ResearchParamsSchema.parse(request.params);
        const workspace = await prepareHostJob(params);
        const record: JobRecord = existsSync(
          join(workspace.root, "host-job.json"),
        )
          ? loadJob(workspace.root)
          : {
              schemaVersion: 1,
              jobId: newId("job"),
              jobRoot: workspace.root,
              state: "prepared",
              operation: "research",
              seq: 0,
              artifacts: {},
              extensionVersion: packageVersion(),
            };
        if (
          record.state === "review" ||
          record.state === "complete" ||
          record.state === "partial"
        ) {
          this.send(
            journalEvent(record, "completed", {
              state: record.state,
              artifacts: record.artifacts,
            }),
          );
          return record;
        }
        return this.start(record, "research");
      } finally {
        this.preparing = false;
      }
    }
    const record = this.record(request.params);
    if (request.method === "status")
      return {
        ...record,
        monitoring: readMonitoring(
          record.jobRoot,
          this.active?.record.jobId === record.jobId,
        ),
      };
    if (request.method === "configure") {
      const params = ConfigureParamsSchema.parse(request.params);
      if (!["running", "paused", "prepared", "review"].includes(record.state))
        throw new DeepError(
          "HOST_CONFIGURATION_UNAVAILABLE",
          "This job is not running or resumable",
        );
      const { jobRoot: _root, jobId: _id, ...settings } = params;
      updateResumeSettings(record, settings);
      const config = openWorkspace(record.jobRoot).config;
      if (this.active?.record.jobId === record.jobId)
        this.active.analysisWorkers = config.concurrency.analysis;
      const result = {
        analysisWorkers: config.concurrency.analysis,
        requestedAnalysisWorkers: params.analysisWorkers,
        freeProviderConcurrency: config.host?.freeProviderConcurrency ?? 1,
      };
      this.send(
        journalEvent(record, "progress", { phase: "configuration", ...result }),
      );
      return result;
    }
    if (request.method === "pause" || request.method === "cancel") {
      record.state = request.method === "pause" ? "pausing" : "cancelled";
      saveJob(record);
      if (this.active?.record.jobId === record.jobId)
        this.active.controller.abort(new Error(request.method));
      else {
        record.state = request.method === "pause" ? "paused" : "cancelled";
        saveJob(record);
      }
      return record;
    }
    if (this.active !== null || this.preparing)
      throw new DeepError(
        "HOST_BUSY",
        "The previous operation has not stopped yet",
      );
    if (request.method === "convert" && record.state !== "review")
      throw new DeepError(
        "HOST_REVIEW_REQUIRED",
        "Research must reach plan review before conversion",
      );
    if (record.state === "cancelled")
      throw new DeepError(
        "HOST_CANCELLED",
        "This job was cancelled; start a new research job",
      );
    if (
      record.state === "complete" ||
      record.state === "partial" ||
      (record.state === "review" && request.method === "resume")
    ) {
      this.send(
        journalEvent(record, "completed", {
          state: record.state,
          artifacts: record.artifacts,
        }),
      );
      return record;
    }
    if (
      request.method === "resume" &&
      request.params["settings"] !== undefined
    ) {
      const supplied = request.params["settings"] as Record<string, unknown>;
      const current = openWorkspace(record.jobRoot).config.agent;
      const candidate = updateResumeSettings(record, supplied, true).agent;
      if (selectionChanged(current, candidate))
        await verifySelection(candidate);
      if (this.active !== null || this.preparing)
        throw new DeepError(
          "HOST_BUSY",
          "Another operation started while checking the selected model",
        );
    }
    return this.start(
      record,
      request.method === "convert" ? "convert" : record.operation,
      request.method === "resume" ? request.params["settings"] : undefined,
    );
  }
  private start(
    record: JobRecord,
    operation: "research" | "convert",
    settings?: unknown,
  ): unknown {
    const unlock = acquireJobLock(record.jobRoot);
    try {
      if (settings !== undefined) {
        if (record.state !== "paused")
          throw new DeepError(
            "HOST_PAUSE_REQUIRED",
            "Pause the job before changing its model",
          );
        updateResumeSettings(record, settings);
        const selected = openWorkspace(record.jobRoot).config.agent;
        this.send(
          journalEvent(record, "settings_changed", {
            runtime: selected.runtime,
            provider: selected.provider,
            model: selected.model,
            roleOverrides: selected.roleOverrides,
            freeOnly: selected.freeOnly,
          }),
        );
      }
    } catch (error) {
      unlock();
      throw error;
    }
    const controller = new AbortController();
    record.operation = operation;
    record.state = "running";
    record.ownerPid = process.pid;
    saveJob(record);
    // Defer work until handle emits the acceptance response.
    const done = new Promise<void>((resolveDone) =>
      setImmediate(resolveDone),
    ).then(() => this.execute(record, controller).finally(unlock));
    this.active = {
      record,
      controller,
      done,
      analysisWorkers: openWorkspace(record.jobRoot).config.concurrency
        .analysis,
    };
    return {
      jobId: record.jobId,
      jobRoot: record.jobRoot,
      state: record.state,
    };
  }
  private async execute(
    record: JobRecord,
    controller: AbortController,
  ): Promise<void> {
    const emit = (type: string, result: unknown): void =>
      this.send(journalEvent(record, type, result));
    let opened: ReturnType<typeof openWorkspaceRepo> | null = null;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    try {
      const workspace = openWorkspace(record.jobRoot);
      const maxSeconds = workspace.config.host?.maxSeconds;
      if (maxSeconds) {
        const remaining = maxSeconds - (record.elapsedSeconds ?? 0);
        if (remaining <= 0)
          throw new DeepError(
            "HOST_TIME_BUDGET_EXHAUSTED",
            "The job time budget is exhausted",
          );
        deadline = setTimeout(
          () => controller.abort(new Error("job time budget exhausted")),
          remaining * 1000,
        );
      }
      await verifyHostInputs(workspace);
      controller.signal.throwIfAborted();
      opened = openWorkspaceRepo(record.jobRoot);
      const { repo } = opened;
      for (const lease of repo.listLeases())
        if (lease.owner) repo.releaseLease(lease.taskId, lease.owner);
      // Recover any publication interrupted between its durable intent and revision commit.
      for (const integration of repo.listIntegrations()) {
        if (integration.publishedRevision <= repo.currentPortRevision())
          continue;
        const patch = repo
          .listPatches(integration.taskId)
          .find((p) => p.sha256 === integration.patchSha256);
        if (!patch)
          throw new DeepError(
            "HOST_RECOVERY_MISSING_PATCH",
            "An interrupted publication has no recorded patch",
          );
        const payload = PatchRecordPayloadSchema.parse(
          readJsonFile(patch.path),
        );
        for (const file of payload.files)
          applyFileEntry(workspace.paths.port, file, {
            tolerateIdentical: true,
          });
        repo.bumpPortRevision({
          taskId: integration.taskId,
          integrationId: integration.id,
          files: integration.files,
        });
      }
      const machine = new TaskMachine(repo);
      for (const task of repo.listTasks()) {
        if (task.state === "VALIDATING") {
          const patch = repo
            .listPatches(task.id)
            .find((p) => p.attempt === task.attempt);
          const published = repo
            .listIntegrations()
            .find(
              (i) =>
                i.taskId === task.id &&
                i.patchSha256 === patch?.sha256 &&
                i.publishedRevision <= repo.currentPortRevision(),
            );
          if (published) {
            machine.transition(task.id, "ACCEPTED", {
              detail: {
                reason: "recovered committed publication",
                revision: published.publishedRevision,
              },
            });
            repo.setTaskPublishedRevision(task.id, published.publishedRevision);
            continue;
          }
        }
        if (["RUNNING", "IMPLEMENTED", "VALIDATING"].includes(task.state)) {
          machine.transition(task.id, "CANCELLED", {
            detail: { reason: "interrupted operation recovered" },
          });
          machine.transition(task.id, "READY", { reason: "resume" });
        }
      }
      const logger = createLogger({
        stdout: (message) =>
          emit("progress", { phase: record.operation, message }),
        stderr: (message) =>
          emit("progress", { phase: record.operation, message }),
      });
      const outcome = await runPipeline({
        workspace,
        repo,
        logger,
        through: record.operation === "research" ? "plan" : "report",
        execute: record.operation === "convert",
        maxWorkers: null,
        currentMaxWorkers: () =>
          this.active?.analysisWorkers ?? workspace.config.concurrency.analysis,
        taskFilter: [],
        allowStaleBaseline: false,
        signal: controller.signal,
        reusePlan: record.operation === "convert",
        onProgress: (event) => emit("progress", event),
      });
      controller.signal.throwIfAborted();
      Object.assign(record.artifacts, writeResearchReport(workspace));
      if (record.operation === "research") record.state = "review";
      else {
        const allTasks = repo.listTasks();
        const unfinished = allTasks.filter((t) => t.state !== "ACCEPTED");
        record.state =
          outcome.failed.length || outcome.blocked.length || unfinished.length
            ? "partial"
            : "complete";
        record.artifacts["output"] = publishSibling(
          workspace.config.host!.baselinePath,
          workspace.paths.port,
          record.jobId,
        );
        record.artifacts["report"] = workspace.paths.evidenceReports;
      }
      emit("completed", {
        state: record.state,
        artifacts: record.artifacts,
        outcome,
        simulated: workspace.config.agent.runtime === "mock",
      });
    } catch (error) {
      record.state = controller.signal.aborted
        ? record.state === "cancelled"
          ? "cancelled"
          : "paused"
        : "paused";
      emit("completed", {
        state: record.state,
        artifacts: record.artifacts,
        error: {
          code:
            error instanceof DeepError ? error.code : "HOST_JOB_INTERRUPTED",
          message: error instanceof Error ? error.message : String(error),
          recoverable: record.state !== "cancelled",
        },
      });
    } finally {
      record.elapsedSeconds =
        (record.elapsedSeconds ?? 0) + (Date.now() - startedAt) / 1000;
      clearTimeout(deadline);
      opened?.db.close();
      saveJob(record);
      this.active = null;
    }
  }
  async close(): Promise<void> {
    if (this.active) {
      this.active.record.state = "pausing";
      this.active.controller.abort(new Error("host disconnected"));
      await this.active.done;
    }
  }
}

function publishSibling(baseline: string, port: string, jobId: string): string {
  let target = `${baseline}-deep`;
  let suffix = 2;
  while (existsSync(target)) target = `${baseline}-deep-${suffix++}`;
  const staged = `${target}.staging-${jobId}`;
  mkdirSync(staged, { recursive: true });
  try {
    copyTree(port, staged);
    renameSync(staged, target);
    return target;
  } catch (error) {
    rmSync(staged, { recursive: true, force: true });
    throw error;
  }
}
