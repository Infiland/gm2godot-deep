# Providers, agent tools, and model selection

`createRuntime` in `src/agents/factory.ts` selects Pi API providers, Codex app-server, Claude Code headless mode, or a local OpenCode server. The scheduler owns concurrency and retries. Adapters do not create child agents.

The settings use public role names: `researcher`, `planner`, `implementer`, and `reviewer`. Research maps to the internal analyst; planning maps to the reconciler; the two review roles share the reviewer override. A role can override runtime, provider, and model. An executable selection belongs to the base runtime; a role that changes runtime detects its own executable instead of inheriting that path. Internal role names are accepted for older configurations. Explicit selections never fall back to another paid provider.

## Installation and discovery

The application installs the optional extension and can install OpenCode in its private application-data directory. Existing executable paths are supported. `discoverAgent` performs account/model discovery without inference. Codex uses `account/read` and `model/list`; Claude uses `auth status`; OpenCode uses its authenticated local `/provider` API. Claude currently exposes no model-list endpoint, so the user may enter an alias or exact model id. Discovery distinguishes an unavailable authentication result from a known authenticated account.

Codex discovery and conversion share one executable resolver. An explicit path or executable name wins and fails closed if unavailable. Automatic lookup searches absolute PATH entries first, then bounded common CLI install locations, then macOS ChatGPT/Codex desktop bundles in `/Applications` and `~/Applications`. It ignores empty and relative PATH entries. On Windows, native `.exe` files run directly; an npm `codex.cmd` selection launches its known adjacent `node_modules/@openai/codex/bin/codex.js` entry with the extension's Node runtime, without executing a shell or parsing the shim. Other Windows scripts and incomplete npm installs are rejected.

Codex owns its saved ChatGPT/API sign-in, credential storage and token refresh. Deep keeps `CODEX_HOME` and the credential store intact and never opens, exports or copies Codex's auth cache. Discovery returns only the executable path, installation source, safe account-mode label, availability status and model identities; account email, tokens and provider errors are excluded. An installed executable whose protocol fails remains distinguishable from a missing executable. If OpenAI sign-in is required, the status recommends `codex login` with that installation; refresh models afterwards. A configured provider with `requiresOpenaiAuth: false` does not require ChatGPT sign-in. [Official authentication documentation](https://learn.chatgpt.com/docs/auth) and the [app-server account/model methods](https://learn.chatgpt.com/docs/app-server) describe these contracts.

The public provider label `codex` means “Codex configured provider”; it is normalized to the CLI's configured default for both discovery and conversion. Explicit custom provider IDs are retained and supplied to both operations. Discovery pages the live model catalog instead of hard-coding models. Existing ChatGPT sign-in uses that account's access and limits; an API sign-in uses its API account. Neither is treated as a verified free model.

Pi resolves API credentials from the host's in-memory credential map and provider-supported authentication. The host is responsible for its OS credential store. No adapter writes API keys into the job's configuration, report, or transcript. The adapters never record provider stderr or raw error payloads.

## Controlled host tools

Pi receives the host tool definitions directly. Installed coding agents use a JSON tool relay: one model response selects one host tool and its JSON arguments; Deep validates the arguments and executes the corresponding guarded handler. The final submission tool terminates the task. A fabricated tool name is a policy denial.

Coding-agent processes start in empty temporary working directories. Claude disables built-in tools, project settings and extra MCP servers. Codex disables hooks, plugins, shell, browser, app, image and multi-agent features at process startup, including during discovery. Conversion additionally requests an ephemeral read-only thread and rejects native tool/approval requests. These process-local overrides leave the user's saved configuration intact. [Codex hook controls](https://learn.chatgpt.com/docs/hooks) explain the hook feature flag. OpenCode disables native tools and applies deny permissions. Candidate changes are structured proposals validated by Deep; no model receives a shell tool from Deep.

A managed OpenCode server uses a random authentication password on loopback and private configuration. It pins default and helper models to the selected model and disables title, summary and compaction helpers. The JSON relay uses plain structured text instead of OpenCode's StructuredOutput native tool, which would conflict with the deny-all tool policy. Existing servers require a password; free-only mode uses a private server to guarantee helper-model selection without changing the user's configuration.

These controls restrict the agent tool surface. They are not a general OS isolation boundary for arbitrary third-party binaries. Install trusted official agents only.

## Automatic free selection

`automatic-free` is the application setting for automatic selection. `auto`, `auto-free`, and a null model are compatibility aliases. An explicit free model is included among the maximum five evaluated candidates and remains preferred if it passes.

Eligibility requires both:

- Current OpenCode metadata explicitly reports zero input/output and zero cache read/write prices, with no other nonzero price tier.
- The official Zen pricing table explicitly marks every applicable price free/zero. A dash is accepted only for inapplicable cache prices. Unknown, missing, malformed or inaccessible pricing cannot authorize a model call.

Each candidate runs four shipped synthetic cases covering lifecycle/state, shared dependencies, GDScript conversion, and unresolved dynamic calls. The model must request the fixture through the host source tool, return schema-valid answers, cite real fixture paths and lines, and pass every case. Scoring compares facts against shipped expectations; it does not ask another model to judge. The conversion case requires a matching GDScript method. Role-specific rankings use those same measured case scores, with latency as the tie-breaker.

Synthetic evaluation caches live in the user's cache directory, separate from projects. Their identity includes model/pricing metadata, fixtures, and tool contracts; entries expire after seven days. Pricing eligibility is checked again before each call, including evaluations and fallbacks. Failed eligible models are removed from the current fallback list. When no eligible passing candidate remains, the task fails recoverably so the host can pause; it never selects a paid model.

Evaluation is sequential and bounded by task timeout, per-case timeout, candidate count and budget admission. API-reported token/cost usage is accumulated. Some native coding-agent interfaces do not report cost or support hard output-token ceilings; the host additionally checks input-size estimates and turn/time limits, but these are not a guarantee of an exact financial ceiling for paid native agents. Free-only eligibility remains mandatory even when usage is unavailable.

Current model availability and data-use terms are at <https://opencode.ai/docs/zen/>. A free model can disappear, change terms or fail evaluation.

## Documentation and source evidence

`read_source` supports one-based `startLine`/`startColumn`, `maxLines` and `maxChars`. Responses include the next line and column. Long single-line resources are bounded and can be consumed completely. Real analyst submission requires merged read receipts covering every relevant source character. Binary assets return metadata and a distinct disposition.

`search_documentation` uses the official Godot Sphinx index, including stemmed API terms. GameMaker search uses the official YoYoGames manual source tree for page identities because the public sitemap is not consistently accessible. It reads actual content only from the selected official manual URL. Documentation records include URL, title, requested/resolved version, fallback, retrieval time and content hash. Outages can use cached pages; unknown content is never fabricated.

Real non-blocked research submissions must include actionable `conversionInstructions` and `documentationCitations` that match pages read through the documentation tool during that task. An unresolved documentation or semantic mapping can be recorded as blocked. Simulated runs are labelled separately and do not claim model research.
