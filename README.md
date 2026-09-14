# GM2Godot Deep

Optional AI research and conversion for [GM2Godot](https://github.com/Infiland/GM2Godot). Deep reads a GameMaker project, researches how its resources interact, prepares GDScript conversion instructions, and implements a reviewed plan into a separate Godot project.

**Most users should enable Deep conversion in GM2Godot.** The client installs compatible extension packages and their runtime. Cloning this repository or installing Node is only necessary for engine development. Normal GM2Godot conversion does not use Deep.

## User workflow

1. Enable Deep conversion in GM2Godot settings and install the extension.
2. Select an API provider, Codex, Claude Code, or OpenCode. OpenCode can be installed privately from the same panel.
3. Select a model or Automatic Free, configure research concurrency and limits, and review which provider receives the source.
4. Convert normally; Deep researches the source against the resulting baseline and official GameMaker/Godot documentation.
5. Review the research and conversion instructions, then start implementation.
6. Open the separate `-deep` Godot result and inspect its validation report.

Closing the client pauses work. Reopen GM2Godot to resume. Source/baseline changes are checked before resuming; stale reviewed inputs cannot silently be reused.

Free mode admits only currently advertised zero-price Zen models and never switches to a paid model. Availability, limits, model behavior and data-use terms are controlled by the provider. A small synthetic evaluation selects candidates; it is not a promise that a complete game can be converted perfectly or for free indefinitely. Native-agent subscription usage may not expose monetary accounting; token/time limits and reported usage are kept distinct.

## Development

Use Node 22.19 or newer:

```sh
npm ci
npm run typecheck
npm test
npm run build
node dist/host/main.js
```

The host reads versioned JSONL on stdin and streams responses/progress on stdout. It receives source paths, a GM2Godot-produced inventory/capability snapshot and the existing conversion baseline. Hosted conversion never invokes another Python checkout. See [host integration](docs/host-protocol.md).

The legacy developer CLI remains available through `npm run deep-convert -- --help`; its checkout bridge is for standalone developer workflows only. Mock tests are simulated and explicitly labeled.

## Module ownership

- `host`: protocol, job preparation, checkpoint identity, progress and output publication.
- `indexing` and `analysis`: source inventory, resource units, dependency graph and hazards.
- `scheduling`: independent research, planning, implementation, validation and reporting phases; bounded concurrency and budgets.
- `agents`: provider adapters and controlled source/documentation/result tools.
- `documentation` and `models`: official documentation retrieval and free-model eligibility/evaluation.
- `planning`, `integration`, `validation`, `evidence`: contracts, candidate changes and auditable results.

Dependencies flow through explicit data/adapter interfaces. Keep GUI concerns in GM2Godot and provider-specific code behind `AgentRuntime`. Add protocol and behavioral tests when extending a boundary. Do not weaken mock provenance or treat source coverage as behavioral proof.

## Distribution

GM2Godot pins an exact source commit and builds platform ZIPs with compiled code, a verified Node runtime and locked production dependencies. Optional extension releases use immutable `deep-vX.Y.Z` tags in GM2Godot Releases, independently of application releases. `tools/build_bundle.py` rejects dirty or mismatched release sources; `--allow-dirty` produces a local test bundle that publication rejects. `tools/smoke_bundle.py` exercises the bundled host with Node removed from PATH.

Supported package targets match GM2Godot: Windows x64, macOS arm64 and Linux x64. Real-provider checks and Godot validation are separate from offline tests and require their respective tools/accounts. See [limitations](docs/limitations.md) and [third-party notices](THIRD_PARTY_NOTICES.md).
