# ADR 0171 — The login you already have

- **Status:** Accepted
- **Date:** 2026-09-03
- **Supersedes in practice:** the `trial/auth2api` arrangement recorded in ADR 0108
  (that trial stays documented; it is no longer the answer for Claude subscribers)

## Context

Every provider in `packages/ai-sdk/src/providers` authenticates the same way: the user
pastes an API key into Settings → AI. That is the right shape for NVIDIA, Groq, OpenRouter
and the rest, and it is the wrong shape for the single largest group of people who already
pay Anthropic — Claude subscribers, who have a login and no API key at all.

Until now the only way to spend a Claude subscription on FramePilot was `trial/auth2api`: a
third-party OAuth→OpenAI proxy that had to be git-cloned, built into `trial/auth2api/`,
logged into, and kept running on port 8317, after which the user selected the generic
`openai-compatible` provider and pointed it at localhost. It worked. It was also a
credential-handling dependency with no LICENSE file, a second process to keep alive, and a
setup path that no editor was ever going to follow.

`@anthropic-ai/claude-agent-sdk` resolves the same credential the `claude` CLI already
stored, so the first-party path exists now and the proxy does not have to.

## The problem with the obvious reading

The package is called the **Agent SDK** because it is one. It ships the Claude Code harness:
its own multi-turn loop, its own Read / Write / Edit / Bash / Glob / Grep / WebSearch tools,
and a system prompt assembled partly from whatever is in the user's `~/.claude`.

FramePilot already has an agent. AGENTS.md invariant 5 says the AI edits only through
registered, schema-validated tools, and the module header of `providers/types.ts` spells out
the consequence: a provider returns `ToolCall`s and the orchestrator is the sole component
that turns one into a patch, so a misbehaving model cannot bypass the tool boundary.

Handing the SDK real tool handlers would mean the SDK owns the loop, and the Conductor
reducer, the WAL, the progress guards, the run budget and every golden eval are bypassed.
That is not a provider. It is a second agent kernel, and we would then have two.

So the question this ADR answers is narrow: **can the Agent SDK be used as a transport —
a way to reach a model and get tool calls back — rather than as an agent?**

## Decision

Yes, and the mechanism is the SDK's own. We add a `claude-agent-sdk` provider that runs the
Agent SDK in a deliberately degenerate mode.

### 1. The sandbox is a security contract, not configuration

`SANDBOX_OPTIONS` is one frozen object, and `claude-agent-sdk.test.ts` asserts every field,
because each one closes a specific hole:

| Option | What it prevents |
|---|---|
| `tools: []` | The model getting Read/Write/Edit/Bash against the user's disk, bypassing `electron/ipc/sandbox.ts` outright. Verified: the init frame reports `tools: []`. |
| `settingSources: []` | The user's personal `~/.claude/CLAUDE.md` being folded into FramePilot's system prompt — which would make our prompt a function of the developer's machine, and move the golden token manifests that track prompt text byte for byte. |
| `systemPrompt: {type:'custom'}` | The `claude_code` preset, i.e. the prompt that makes it a coding agent. |
| `permissionMode: 'default'` | `bypassPermissions`. |
| `maxTurns: 1` | The SDK continuing a conversation the orchestrator never saw. |
| `strictMcpConfig: true` | MCP servers discovered from the user's machine joining the tool list. |

These were verified against the installed SDK, not inferred from documentation. An early
research pass claimed `allowedTools: []` was insufficient and that built-ins always load;
the init frame says otherwise, and `tools: []` is documented as "disable all built-in tools".

### 2. Tool calls come back by deferral, not by denial

FramePilot's registry is published to the model as an in-process MCP server built from the
tools' raw JSON Schema. A `PreToolUse` hook then returns `permissionDecision: 'defer'`,
which stops the turn *before* execution and ends it with `terminal_reason: 'tool_deferred'`.

Deferral rather than denial matters: a denied tool is something the model sees and reasons
about, so it tries something else. A deferred one is simply handed back. Measured against
the real SDK, deferral produced `permission_denials: []` and the tools never ran.

Two consequences worth writing down:

- **The MCP call handler is unreachable by construction, and throws if reached.** It is the
  tripwire for a regression that re-enables execution.
- **Tool calls are read from the assistant messages' `tool_use` content blocks, never from
  the result's `deferred_tool_use`.** That field is singular and therefore lossy. Measured:
  a turn making two parallel calls produced two content blocks and one deferred entry. A
  montage turn asking for sixty cuts would have reported one.

### 3. Raw JSON Schema, so zod 3 stays

The SDK ships a `tool()` helper that builds MCP tools from zod schemas, and it declares a
`zod@^4` peer. This package is on zod 3, as is `timeline-schema` and the rest of the repo.
Using the helper would have meant zod 4 alongside zod 3 in one package.

It is not needed. `@modelcontextprotocol/sdk` — already in this workspace at 1.29.0 for
`packages/mcp-server`, running on zod 3 — exposes a low-level `Server` whose
`tools/list` handler returns raw JSON Schema, which is what the tool registry already holds.
Converting to zod and back would have been a lossy hop for no gain.

## Consequences

### It is desktop-only, and the browser must not be able to pick it

The SDK spawns a subprocess. A browser tab cannot. It is therefore absent from the
web-editor's `REAL_PROVIDERS` and must stay absent — not merely "unlikely to be selected".
Because it needs no API key, listing it would make Settings report it **ready** while
`buildBrowserProvider` silently fell back to the offline mock. A provider that looks
configured and answers with fixture text is a worse failure than one that is not offered.

Keeping the Node-only package out of the renderer bundle takes more than lazy loading: a
dynamic `import()` of a **string literal** is still statically analyzable, so Rollup follows
it into the graph. Both SDKs are loaded through specifiers held in consts, and
`renderer-bundle-boundary.test.ts` asserts that — a tidy-up refactor is exactly how it would
be lost.

### Four capabilities are genuinely unavailable

Named here rather than discovered later:

- **No `temperature`.** Callers that pass `temperature: 0` for determinism (the tier
  proposers, the vision judge) get default sampling. Expect more golden-eval variance on
  this provider than on `anthropic`, and do not misattribute it to prompt drift.
- **No `maxTokens`.** The SDK owns the output budget.
- **No `cacheBoundary`.** The run-stable prefix breakpoint is ignored; the SDK does its own
  caching.
- **No images.** A string prompt has nowhere to put an image block. `supportsVision` is
  therefore gated on the **transport**, not the model id: `claude-opus-5` can see, but this
  is a blind pipe, and offering `get_frame` would mean frames dropped and described anyway.

### The error taxonomy could not be reused

`classifyLangChainError` reads an HTTP status off a thrown error and, finding none, calls
everything `network` — which is retryable. Every permanent failure here (no `claude` binary,
not signed in) has no status, so a missing login would have spawned three subprocesses with
backoff before the user saw a word. This provider classifies by message shape instead.

The copy needed the same care. The generic `auth` sentence is "check the API key in
Settings → AI", and this provider has no API key; worse, `runFailure.ts` regex-matches raw
error text, and the SDK says things like "Invalid API key · Please run /login", which the
existing auth family matched happily. A `claude login` family now runs first.

### Cost is reported in tokens, and the dollar figure is not ours to state

`cost-meter.ts` prices by tier: tokens × a USD/Mtok table. Under a subscription the user
pays none of that, and the SDK's own `total_cost_usd` is the API-equivalent price they are
*not* charged. Both numbers are false as "this run cost $X". Tokens are reported truthfully;
`usage-summary.ts` has no way to express "real cost, but not in dollars", and that gap is
left open rather than filled with a fabricated zero.

### Scene captioning stays off under this provider

Captioning runs in the Python sidecar and authenticates with a key it is handed. This
provider's credential is an OS-keychain login usable only by the `claude` binary in the main
process, so there is nothing to forward. Commented at the branch in `main.ts` so it is not
"fixed" by adding it to the `ollama` exemption, which would send an empty key and fail per
media file.

### Readiness is optimistic, deliberately

Settings reports it ready and says "Uses your Claude Code login" rather than "Key saved" or
"No key", neither of which is true. Whether the login is *valid* is not knowable without
reading the OS keychain, and doing that to answer a settings dialog would trigger a
permission prompt on a screen someone opened to look around. This follows the existing
`ollama` precedent — offered ready even when the local server is down — and puts the real
answer in the first call's error, which names `claude login`.

### Not yet done: the packaged desktop build

This works in development. Shipping it in a signed `.app` needs work this ADR does not
cover, and the provider should be treated as dev/self-build only until it lands:

- The SDK ships its own `claude` native binary per platform via optionalDependencies. An
  executable cannot be spawned from inside `app.asar`, so it needs `extraResources` plus a
  `signIgnore` entry and staged signing, the same treatment the Python engine got.
- The OAuth token in the macOS Keychain is bound to Claude Code's own code signature. A
  differently-signed app may be prompted for access or denied it. That has to be tested
  against a real notarized build, not asserted.

### License

`@anthropic-ai/claude-agent-sdk` declares `SEE LICENSE IN README.md`; the file reads
"© Anthropic PBC. All rights reserved", under Anthropic's legal terms. `license:scan` passes
it because the string is non-empty and matches no denylist entry — a green check, not a
finding of fact. This is an accepted proprietary dependency on the same footing as the
TwelveLabs SDK in ADR 0071, and it is recorded here so the acceptance is deliberate.

## Alternatives considered

**Read the OAuth token ourselves and call the Messages API.** No new dependency, and it
would work in more places. Rejected: it reimplements an unsupported auth path that breaks
whenever the credential format or refresh flow changes — the same brittleness that made
`auth2api` a liability rather than a solution.

**Let the SDK run the agent and put FramePilot's editing behind an MCP server it calls.**
This is what the SDK is designed for and it would be less code. Rejected: it moves the loop
out of the Conductor and bypasses the WAL, the progress guards and the run budget. The
result would not be a provider, and FramePilot would have two agent kernels.

**Keep `auth2api`.** Rejected: an unlicensed third-party proxy in the credential path, plus
a second process, plus a setup no editor will do.
