# Hosted extension protocol v1

GM2Godot installs the platform bundle and starts `engine/dist/host/main.js` using its bundled Node executable. The hosted path never invokes Python or imports another checkout. Development can run `node src/host/main.ts` on a supported Node version.

Each stdin line is a JSON request `{ "protocolVersion": 1, "id": "unique-id", "method": "capabilities", "params": {} }`. Stdout contains only JSONL responses and durable job events. Diagnostics from child processes belong in stderr or structured progress events. `schemas/` publishes the same validators used by the runtime; contract tests detect drift.

Methods:

- `capabilities`: optionally pass provider settings in `params.settings`; returns installed/authenticated status and discovered models for an external agent. This performs no research.
- `research`: supply `jobRoot`, `sourcePath`, `baselinePath`, `hostSnapshotPath`, and `settings`. A baseline must already contain `project.godot`. The snapshot is schema v1 with `gm2godotVersion`, `inventory` and `gmlApiEntries`. Only client bookkeeping (`client.json`, `host-snapshot.json`) may preexist in a new job root.
- `convert`: supply `jobRoot` after research reaches `review`. Uses the recorded plan and research cache, validates candidate edits, and exposes a new numbered sibling output without overwriting source or baseline.
- `status`, `pause`, `resume`, `cancel`: supply `jobRoot` (or the current process's `jobId`). Pause/resume preserve inputs, task attempts, usage and accepted output revisions. A resume may include settings to change worker counts, consent or budget ceilings; runtime/provider/model changes require a new research job. Token and cost limits remain cumulative totals; a resume maxSeconds value grants that many additional seconds. Cancel is terminal.

A long operation first returns `type: "result"` with `state: "running"`, then emits `progress` and a final `completed` event. Every durable event includes `jobId` and a monotonically increasing `seq`. Completion has `result.state`, `result.artifacts`, and optionally `result.error`. Already completed/review jobs replay a completion event. Input/dispatch errors use a top-level `type: "error"` with `error.code/message/recoverable`.

Settings include `runtime` (`mock`, `pi`, `codex`, `claude`, `opencode`), provider/model, optional executable/endpoint, role overrides, `analysisWorkers` (1–32), `freeOnly`, `freeProviderConcurrency` (default 1), consent `allowRemoteSourceUpload`, `godotBinary`, and budgets. Client budget names `maxTokens`, `maxCostUsd`, `maxSeconds` map to cumulative job limits; advanced per-task and per-run token/cost fields are also accepted. Free mode caps workers independently of the ordinary four-worker default. Credentials are not protocol/job fields.

The journal and SQLite evidence survive process termination. A job lock prevents concurrent extension processes from editing one job. Recovery completes recorded publication intents before rescheduling interrupted tasks. Source/baseline changes fail closed and require a fresh job; an already reviewed snapshot is never silently replaced. Selective cross-job reuse is not implemented.

`research.json` and `research.md` report purpose, behavior, lifecycle, state, dependencies, GDScript mappings, planned outputs, documentation citations and acceptance scenarios. File accounting, model findings, engine checks and behavioral evidence remain separate. Mock results are simulations. Missing Godot does not block research and never produces an engine-pass claim. Filesystem copies are staging, not a process sandbox.

The legacy standalone CLI remains available for development compatibility; its checkout bridge is not used by the hosted extension.
