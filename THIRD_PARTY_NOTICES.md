# Third-party notices

`gm2godot-deep` orchestrates other tools. Only the npm packages below are bundled or linked into this
repository's process. GM2Godot and Godot are invoked as separate processes from user-supplied
installations and are **not** vendored here.

## Runtime dependencies

| Package | Version | License | Copyright |
|---|---|---|---|
| `@earendil-works/pi-agent-core` | 0.85.1 | MIT | Copyright (c) 2025 Mario Zechner |
| `@earendil-works/pi-ai` | 0.85.1 | MIT | Copyright (c) 2025 Mario Zechner |
| `zod` | 4.1.12 | MIT | Copyright (c) 2020 Colin McDonnell |

## Development dependencies

| Package | Version | License |
|---|---|---|
| `typescript` | 5.9.3 | Apache-2.0 |
| `@types/node` | 22.20.0 | MIT |

## External tools invoked as processes

### GM2Godot

- Repository: `https://github.com/earendil-works/GM2Godot` (user-supplied checkout)
- Pinned revision: tag `v0.7.74`, commit `38b364855f06e971d2676b921fd300e1f40f076a`
- License: Apache-2.0 (`LICENSE` in the checkout)
- Redistribution: none. This repository contains no GM2Godot source, headers or binaries. It shells out to
  `main.py`, imports the checkout's Python modules through `tools/gm2godot_bridge.py` at runtime, and reads
  the JSON artifacts GM2Godot writes. Apache-2.0 attribution obligations apply to the checkout itself, which
  the user obtains separately; the checkout's own `LICENSE` must be preserved there.

### Godot Engine

- Installed separately by the user (this machine: `/Applications/Godot.app/Contents/MacOS/Godot`,
  `4.7.2.stable.official.ed1daf0bf`).
- License: MIT.
- Redistribution: none. Invoked as a subprocess for headless validation only.

## Skills, extensions and resource loaders

`@earendil-works/pi-coding-agent` is deliberately **not** a dependency. `@earendil-works/pi-agent-core`
performs no automatic discovery of `AGENTS.md`, skills, extensions, prompts, themes or context files, so the
"treat project files as untrusted data" requirement holds structurally instead of by configuration. See
`docs/upstream-versions.md`.
