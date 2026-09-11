# Upstream versions and schema compatibility

This repository is verified against exactly two upstream sources. Both are pinned; neither is
vendored or copied.

## 1. GM2Godot (deterministic converter)

| | |
|---|---|
| Version | `0.7.74` |
| Commit | `38b364855f06e971d2676b921fd300e1f40f076a` |
| Checkout on this machine | `/Users/infi/Documents/Github/GM2Godot` |
| Licence | Apache-2.0 |
| How it is used | spawned as a separate process from the user-supplied checkout (`main.py <subcommand>`); never imported in-process, never patched |

The supported version list is `SUPPORTED_GM2GODOT_VERSIONS = ["0.7.74"]` in
`src/adapters/gm2godot/versions.ts`; the config key `gm2godot.expectedVersions` defaults to
`["0.7.74"]` (`src/config/schema.ts`) and `doctor` reports whether the probed version is in that set
(`src/scheduling/pipeline.ts`).

### Supported upstream schema versions

From `src/adapters/gm2godot/versions.ts`:

| Constant | Value | Artifact |
|---|---|---|
| `SUPPORTED_MANIFEST_FORMAT_VERSION` | `2` | `gm2godot/conversion_manifest.json` |
| `SUPPORTED_ATTEMPT_FORMAT_VERSION` | `1` | `gm2godot/conversion_attempt.json` |
| `SUPPORTED_GENERATION_INVENTORY_FORMAT_VERSION` | `1` | `generation_inventory` inside the manifest |
| `SUPPORTED_ARCHITECTURE_POLICY_FORMAT_VERSION` | `1` | `gm2godot/architecture_policy.json` |
| `SUPPORTED_SOURCE_MAP_VERSION` | `1` | per-file `<generated>.gmlmap.json` |

### How an unknown upstream schema is rejected

`assertSupportedFormatVersion(what, observed, supported)` throws
`UnsupportedUpstreamSchemaError` with code `GM2DEEP-UPSTREAM-UNSUPPORTED-SCHEMA`, carrying the
observed value and the supported set. It is called on every upstream JSON artifact **before any field
is read** (manifest and generation inventory in `readBaselineProvenance`, attempt in the same
function), so a newer GM2Godot can never be silently interpreted with older assumptions. A tool
version string is checked the same way by `assertSupportedToolVersion`.

The Python bridge has its own hard failure for the same class of problem: if importing or calling
upstream code raises `ImportError`, `AttributeError` or an unexpected `TypeError`, it exits `3` with
`{"error":"BRIDGE_API_MISMATCH","detail":…}` (`tools/gm2godot_bridge.py`), and
`src/adapters/gm2godot/bridge.ts` maps that to `GM2DEEP-BRIDGE-API-MISMATCH` (`BRIDGE_API_MISMATCH`).
A mismatch is refused, never degraded into a partial result.

The bridge is stdlib-only, writes exactly one JSON document to stdout (all diagnostics to stderr), and
is invoked with `PYTHONDONTWRITEBYTECODE=1` from the repository root with a scrubbed environment
(`src/adapters/gm2godot/bridge.ts`, `src/sandbox/env.ts`).

### Pinned engine

Godot `4.7.2.stable.official.ed1daf0bf` at `/Applications/Godot.app/Contents/MacOS/Godot`, exactly
GM2Godot's target build. `godot.expectedVersion` defaults to that build string and
`compareGodotVersion` (`src/adapters/godot/version.ts`) reports a different build of the same release
as a mismatch with a reason saying the release prefix was right — so engine-backed checks are recorded
as blocked/skipped rather than passed against an unverified engine. Re-verification: see §4.

## 2. Pi (agent runtime)

| | |
|---|---|
| Package | `@earendil-works/pi-agent-core` `0.85.1` |
| Package | `@earendil-works/pi-ai` `0.85.1` |
| Git tag | `v0.85.1` = commit `d981de1229ef899957bbe968bc8dcda02a21f477` |
| Licence | MIT (`Copyright (c) 2025 Mario Zechner`) |
| Engine floor | Node `>=22.19.0` (matches `package.json` `engines`) |
| How it is used | embedded in-process: the `Agent` class with explicitly registered tools, behind `src/agents/runtime.ts` |

Both pins are exact (no `^`/`~`) in `package.json`; `zod` `4.1.12`, `typescript` `5.9.3` and
`@types/node` `22.20.0` are pinned the same way. Third-party attribution lives in
`THIRD_PARTY_NOTICES.md`.

### Why `@earendil-works/pi-coding-agent` is deliberately not a dependency

`pi-agent-core` performs **no** automatic discovery of instruction files, skills, extensions, prompts
or themes — there is no loader at that layer. The "treat project files as untrusted data" requirement
therefore holds structurally: the only tools a model has are the ones `src/agents/roles.ts` lists, and
every one of them is path-guarded by the host (`docs/sandbox-and-data-handling.md` §7).

If Pi's file/skills tooling is ever needed, it must be added behind the agent-runtime adapter using
`DefaultResourceLoader` with **all** of `noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`
and `noContextFiles` set true — and that decision must be recorded in this file. `pi-agent-core` has
no equivalent switch to disable, which is why it is the package in use.

### Offline determinism

The mock runtime (`src/agents/mock/`) never imports Pi and never touches the network; it drives the
real host tool handlers over the real artifacts and labels every payload `runtime: "mock"`,
`simulated: true`, `usage.reported: false` (see `docs/limitations.md` §7). Pi-adapter tests are
intended to be driven against `pi-ai`'s deterministic offline provider; a live-provider run is gated
and reported separately.

## 3. Node and the toolchain

Node `>=22.19.0` (`package.json` `engines`), ESM, TypeScript executed directly by type stripping.
`tsconfig.json` sets `module`/`moduleResolution` `nodenext`, `target es2023`, `strict`,
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules`,
`erasableSyntaxOnly`, `allowImportingTsExtensions`, `noEmit`. `erasableSyntaxOnly` is why there is no
`enum`, `namespace` or parameter property anywhere in `src/`.

## 4. Re-verification commands

Run from `/Users/infi/Documents/Github/gm2godot-deep`:

```sh
# GM2Godot version (must print: GM2Godot 0.7.74)
PYTHONDONTWRITEBYTECODE=1 \
  /Users/infi/Documents/Github/.gm2godot-campaign-venv/bin/python \
  /Users/infi/Documents/Github/GM2Godot/main.py --version

# Pinned commit (must print: 38b364855f06e971d2676b921fd300e1f40f076a)
git -C /Users/infi/Documents/Github/GM2Godot rev-parse HEAD

# Engine build (must print: 4.7.2.stable.official.ed1daf0bf)
/Applications/Godot.app/Contents/MacOS/Godot --version
```

The bridge itself can be probed directly, and is the fastest way to notice a broken checkout:

```sh
node -e 'import("./src/adapters/gm2godot/bridge.ts").then(async (m) => console.log(await m.probeGm2Godot({ checkout: "/Users/infi/Documents/Github/GM2Godot", python: "/Users/infi/Documents/Github/.gm2godot-campaign-venv/bin/python" })))'
```
