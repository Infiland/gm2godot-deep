# Sandbox and data handling

Isolation is a seam, not a policy scattered through the code: every isolation-requiring operation
describes *what* to run as a `SandboxSpec` and the selected backend decides *how* to isolate it
(`src/sandbox/backend.ts`).

## 1. The spec

```ts
interface SandboxSpec {
  argv: readonly string[];
  cwd: string;
  mounts: readonly { hostPath: string; mode: "ro" | "rw" }[];
  env: Readonly<Record<string, string>>;
  networkAllowed: boolean;
  timeoutSeconds: number;
  maxOutputBytes: number;
}
```

`assertSandboxSpec` rejects an empty `argv`, a `cwd` that is not an existing absolute path, and a
mount that is not an existing absolute path (`GM2DEEP-SANDBOX-INVALID-SPEC`). Mounts and `cwd` are
identity-mapped, so a silently relative mount could not be mistaken for a docker volume name or a
non-existent path under `sandbox-exec`. All three backends run through the shared child-process runner
`runSandboxCapture` (byte cap, wall-clock deadline, process-group kill, duration), so their behaviour
is identical apart from the isolation itself.

## 2. Backend selection (fail closed)

`selectSandboxBackend(config, deps?)` (`src/sandbox/select.ts`) resolves `sandbox.backend`:

| Requested | Behaviour |
|---|---|
| `unsafe-local` | Returns the unsafe backend, which the constructor refuses unless `policy.allowUnsafeLocal === true` as well. `auto` can never select this. |
| `docker` | Probes `docker info`; the daemon must answer, otherwise `SandboxUnavailableError`. |
| `sandbox-exec` | Probed only on darwin; otherwise `SandboxUnavailableError`. |
| `auto` | `docker` when `docker info` succeeds, else `sandbox-exec` when the platform is darwin and the probe succeeds, else **throws** `SandboxUnavailableError` (`GM2DEEP-SANDBOX-UNAVAILABLE`, detail includes `requested, platform, dockerImage, allowUnsafeLocal, dockerUsable, sandboxExecUsable`). |

There is no fallback to running unsandboxed: an unavailable backend is never silently replaced by a
local run. The plan's assumption holds on this machine — docker's CLI exists but its daemon is not
running, so `auto` resolves to `sandbox-exec`.

Current wiring: `selectSandboxBackend` is called by `runDoctor` (`src/scheduling/pipeline.ts`), which
reports `backend`, `available` and a detail string. The validation runners
(`src/validation/structural.ts`, `src/validation/godotRun.ts`) spawn their subprocesses directly with
the allowlisted environment from `src/sandbox/env.ts`; routing a check through a
`SandboxBackend.run(spec)` is the seam for isolation-requiring operations.

## 3. `sandbox-exec` (macOS, SBPL)

`buildSandboxExecProfile(spec, scratchDir)` (`src/sandbox/sandboxExec.ts`) emits:

```
(version 1)
(deny default)
(allow process-exec*)
(allow process-fork)
(allow sysctl-read)
(allow signal (target self))
(allow file-read* file-map-executable
  (literal "/") … (subpath "<granted tree>") …)
(allow file-write*
  (literal "/dev/null") … (subpath "<scratch>") (subpath "<rw mount>"))
(deny network*)                       ; or (allow network*) when spec.networkAllowed
```

Read grants are: the system paths that exist from `SYSTEM_READ_PATHS` (`/bin`, `/sbin`, `/usr/bin`,
`/usr/lib`, `/usr/libexec`, `/usr/sbin`, `/usr/share`, `/System`, `/private/etc`,
`/private/var/db/timezone`, `/private/var/folders`, `/private/var/select`, `/Library/Apple`), the safe
device literals (`/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom`), every directory the
executable's symlink chain passes through plus its install prefix (`executableReadRoots`), every mount
as read, the spec's `cwd`, and the scratch directory. `/dev` as a whole is never granted; ancestor
metadata literals are added for every granted path (without them dyld aborts during boot). Write
grants are the scratch directory, the safe devices, and only the `rw` mounts. The scratch directory
holds the profile (mode `0o600`) and is deleted after the run.

Invocation: `/usr/bin/sandbox-exec -f <profilePath> -- <argv>`. Availability probe:
`sandbox-exec -p "(version 1)(allow default)" /bin/echo ok`, exit status 0.

## 4. Docker

`buildDockerRunArgv(spec, sandbox)` (`src/sandbox/docker.ts`) builds:

```
docker run --rm --network none --cpus <sandbox.cpus> --memory <sandbox.memoryMb>m \
  -v <hostPath>:<hostPath>:<ro|rw> … \
  -e <KEY>=<VALUE> … \
  -w <spec.cwd> <sandbox.dockerImage> <spec.argv…>
```

`--network none` unless `spec.networkAllowed` (then `bridge`). Mounts are identity-mapped so a task's
absolute paths mean the same thing inside and outside the container. The docker CLI itself runs with
the host allowlist environment; `spec.env` is forwarded with `-e` because containers do not inherit
it, skipping any key that matches the credential pattern. Defaults: image `node:22-bookworm-slim`,
`cpus 2`, `memoryMb 2048`, `network false` (`src/config/schema.ts`). Availability probe: `docker info`
(30 s timeout, exit status 0); a missing CLI is "unavailable", not an error.

## 5. `unsafe-local`

`createUnsafeLocalBackend(gate)` (`src/sandbox/unsafeLocal.ts`) throws `SandboxUnavailableError`
unless **both** `sandbox.backend === "unsafe-local"` **and** `policy.allowUnsafeLocal === true`.
It then runs `spec.argv` in the host process's context via the shared runner and labels every result
`backendId: "unsafe-local"`. It is never the default, never selected by `auto`, and every record it
produces is intended to be rendered in the report under an unmissable `UNSAFE LOCAL MODE` banner
listing each check that used it.

## 6. Subprocess environment allowlist

`buildSubprocessEnv(overrides)` (`src/sandbox/env.ts`) is the only way a child environment is built.
It inherits exactly these host keys when set, and never `process.env` wholesale:

```
PATH  HOME  LANG  LC_ALL  TMPDIR          (+ SYSTEMROOT on win32)
```

Caller overrides are merged, keys whose value is `undefined` are omitted entirely, and any key
matching `MODEL_CREDENTIAL_PATTERN = /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i` is **dropped even
when the caller passes it explicitly**. Provider/model credentials stay in the host process: they are
never placed in a subprocess environment, never written to an artifact, log or transcript, and never
echoed into a prompt.

## 7. Tool permission model

`src/agents/roles.ts` fixes the tool list per role. No role gets a shell; the only role with a write
tool is the implementer.

| Role | Tools | Result tool | Max turns |
|---|---|---|---|
| `analyst` | `read_source, read_generated, grep_source, search_baseline, get_converter_diagnostics, list_unit_files, read_evidence, submit_analysis` | `submit_analysis` | 40 |
| `risk_reviewer` | `read_source, read_evidence, list_unit_files, read_generated, grep_source, submit_review` | `submit_review` | 30 |
| `reconciler` | `read_evidence, read_source, submit_plan` | `submit_plan` | 20 |
| `implementer` | `read_source, read_evidence, list_unit_files, read_generated, grep_source, search_baseline, propose_patch` | `propose_patch` | 60 |
| `patch_reviewer` | `read_source, read_generated, read_evidence, submit_review` | `submit_review` | 30 |

Every tool handler runs in the trusted host process (`src/agents/toolSpecs.ts`): it normalises the
requested path through `src/workspaces/guards.ts`, resolves it against the task-scoped root,
re-checks the path against the task's read allowlist, truncates reads (64 KiB per read, 96 KiB per
evidence artifact, 200 grep hits), and on any violation calls `recordPolicyDenial` (which writes a
`policy_denied` row to `task_events`) and throws `GM2DEEP-TOOL-DENIED`, so the model sees an ordinary
tool error. `propose_patch` additionally runs `validateProposedPatch` server-side: every path must
pass `assertAllowed` (`PROTECTED_PATHS` first, then the task write allowlist), paths may not repeat,
each `contentSha256` must match the content, a delete must declare its pre-image hash, and every
`.gd` file must have balanced brackets and no NUL byte (`checkGdSyntax`). The same gate runs again at
integration time (`src/integration/integrator.ts`), because the payload crosses a process boundary the
model controls.

## 8. What leaves the machine

Remote upload is **off by default**: `policy.allowRemoteSourceUpload` is declared in
`src/config/schema.ts` with `default(false)`. When it is enabled, the only data an agent session may
send is:

1. the whole file contents of the unit assigned to that agent,
2. the dependency snippets for that unit,
3. the generated Godot output for that unit,
4. the converter diagnostics for that unit.

Nothing else. No `.env` file, no credential, no configuration file and no unrelated project file is
ever sent; model credentials stay host-side (§6), and the environment the subprocesses receive cannot
carry them. No module in this repository reads the flag today — it is a declared, default-off policy
switch, and the four categories above are the only permitted payload when it is turned on.
