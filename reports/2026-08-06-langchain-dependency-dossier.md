# LangChain dependency dossier — M0.4

> Input to the **§11.1 dependency gate** in [`plan/LANGCHAIN-MIGRATION.md`](../plan/LANGCHAIN-MIGRATION.md).
> **Measured 2026-08-06** by installing into an isolated scratch workspace — **no dependency was
> added to this repository**. Reproduce with `pnpm add @langchain/core @langchain/anthropic
> @langchain/langgraph` in an empty package.

## 1. Exact versions

| Package | Version | Role |
| --- | --- | --- |
| `@langchain/core` | **1.2.4** | chat-model base, messages, tools, runnables (M1) |
| `@langchain/anthropic` | **1.5.3** | Anthropic provider (M1) |
| `@langchain/langgraph` | **1.4.9** | `StateGraph`, checkpointer, interrupts (M5) |

**30 packages total** — 3 direct, 27 transitive. Full closure:

```
@anthropic-ai/sdk  @babel/runtime  @cfworker/json-schema  @langchain/langgraph-checkpoint
@langchain/langgraph-sdk  @langchain/protocol  @stablelib/base64  @standard-schema/spec
@types/json-schema  base64-js  eventemitter3  fast-sha256  is-network-error  js-tiktoken
json-schema-to-ts  langsmith  mustache  p-finally  p-queue  p-retry  p-timeout
standardwebhooks  ts-algebra  zod
```

## 2. Licenses

**26 MIT, 1 Unlicense, 0 unknown.** No copyleft, no missing license field.

- `fast-sha256@1.3.0` — **Unlicense** (public-domain dedication). Permissive; arrives transitively
  via `langsmith`. Worth noting only because the repo already carries one accepted unlicensed
  dependency (`twelvelabs`, ADR 0097) and this is a second, weaker instance — Unlicense is an
  explicit dedication rather than an absent license, so it is materially lower risk than that one.

`pnpm license:scan` is not run here because the packages are not installed in the workspace; it
must be run as part of M1 when they are.

## 3. Two findings that change what the gates are deciding

### 3.1 `langsmith` is a **hard dependency of `@langchain/core`**, not opt-in

```
@langchain/core@1.2.4 → dependencies: { "langsmith": ">=0.5.0 <1.0.0", ... }
```

It resolves to `langsmith@0.8.9` (5.0 MB) and is installed the moment `@langchain/core` is, at
**M1** — eight phases before M11 where the plan schedules the telemetry decision.

This does **not** mean data egresses: the client is inert unless `LANGCHAIN_TRACING_V2` /
`LANGSMITH_API_KEY` are set. But it changes the §11.2 framing in two ways worth stating plainly:

1. The privacy control becomes "this code ships and must stay unconfigured", not "we have not
   installed a tracing client". The plan's `FRAMEPILOT_LANGSMITH_ENABLED` flag defaulting to `off`
   is necessary but no longer sufficient on its own — an inherited `LANGSMITH_*` env var in a
   developer or CI environment would enable it without touching FramePilot's flag.
2. §11.2 is therefore worth answering at **M1**, not deferred to M11.

Recommended mitigation if M1 proceeds: assert in a test that tracing is disabled unless
FramePilot's own flag is set, rather than relying on the upstream default.

### 3.2 `@anthropic-ai/sdk` arrives transitively at M1

```
@langchain/anthropic@1.5.3 → dependencies: { "@anthropic-ai/sdk": "^0.115.0" }
```

`providers/anthropic.ts` documents the standing decision this reverses:

> *WHY raw `fetch` instead of `@anthropic-ai/sdk`: the Messages API is a single JSON POST, so
> calling it directly keeps the dependency surface (and license review burden) minimal.*

The reversal is more direct than §2.2 of the plan describes: the migration does not merely adopt a
different abstraction, it vendors **the exact SDK that decision declined**, plus a LangChain layer
above it. The M1.5 ADR should say this in those terms.

## 4. Zod compatibility — M0.3 validated

| Package | Declared zod range |
| --- | --- |
| `@langchain/core` | `^3.25.76 \|\| ^4` |
| `@langchain/anthropic` | `^3.25.76 \|\| ^4` |
| `@langchain/langgraph` | `^3.25.32 \|\| ^4.2.0` (peer) |

The repo resolves **zod@3.25.76** — *exactly* the floor of the `@langchain/core` range. Two
consequences:

- Adoption is compatible today, with **zero headroom**. Any transitive downgrade below 3.25.76
  breaks LangChain; this should be pinned, not left to a range.
- `@langchain/core` requires `zod/v4` semantics (3.25.76 is the first 3.x shipping the `zod/v4`
  subpath). The M0.3 unification landed on this branch — all 19 `ai-sdk` import sites now use
  `zod/v4`, matching `timeline-schema` and `mcp-server` — so the interop hazard in §3.6 of the plan
  is **closed before M1 starts**, as intended.

Note the scratch install resolved `zod@4.4.3` when unconstrained, and pnpm keyed peer-dependent
packages on it (`@anthropic-ai+sdk@0.115.0_zod@4.4.3`). Under the repo's `^3.23.0` it will key on
3.25.76 instead. Worth re-verifying the resolution after the real install.

## 5. Size — measured, with an explicit caveat

Unpacked on-disk size, largest first:

| Package | MB |
| --- | --- |
| `js-tiktoken` | 21.5 |
| `@langchain/core` | 12.9 |
| `@anthropic-ai/sdk` | 10.1 |
| `@langchain/langgraph-sdk` | 6.3 |
| `@langchain/langgraph` | 5.6 |
| `langsmith` | 5.0 |
| `@langchain/anthropic` | 1.3 |
| `json-schema-to-ts` | 1.1 |
| `@babel/runtime` | 1.1 |
| remainder (21 pkgs) | ~1.2 |
| **Total** | **~66 MB unpacked** |

`js-tiktoken` alone is a third of the footprint; it ships the BPE ranks for token counting, which
`ai-sdk` currently does without.

**This is install size, not bundle size — do not read it as the Electron delta.** Tree-shaking, and
whether the desktop main process pulls `js-tiktoken` and `langgraph-sdk` at all, decide the real
number.

## 6. What §11.1 still lacks

The gate asks for **measured** Electron bundle and cold-start deltas. Both are still **unmeasured**,
and cannot be measured without installing into the workspace and building the desktop app:

- `[ ]` Electron main bundle delta (bytes, before/after)
- `[ ]` Desktop cold-start delta (p50/p95, before/after)
- `[ ]` `pnpm license:scan` clean against the real workspace install

Per risk 13 the budget is "no material install-size or cold-start regression". The honest position
is that §11.1 can be answered on versions, license and Zod compatibility today, but the size and
startup half of it is a **measurement that M1 must produce first** — which is why the plan puts the
dossier before the gate rather than after.
