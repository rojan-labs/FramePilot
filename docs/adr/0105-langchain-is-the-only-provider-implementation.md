# ADR 0105: LangChain is the only provider implementation

Status: **Accepted** · Date: 2026-08-07 · Phase M2.5 of
[`plan/LANGCHAIN-MIGRATION.md`](../../plan/LANGCHAIN-MIGRATION.md) ·
Completes [ADR 0098](./0098-langchain-adapter-at-the-provider-seam.md) ·
Unblocked by [ADR 0104](./0104-remove-github-providers.md)

## Context

FramePilot carried two complete provider implementations: seven hand-written `fetch`
adapters, and the LangChain adapters added by M1/M2 behind `FRAMEPILOT_AI_PROVIDER_IMPL`.
M2.5 always intended to delete one. The question was which, and on what evidence.

**The dependency argument was already spent.** M12 deleted the orchestration kernel
(ADR 0102/0103), so LangGraph is the agent runtime and `@langchain/core` ships whether or
not the providers use it. `ai-sdk`'s "zero runtime dependencies but `zod`" — the strongest
case for the hand-written adapters — stopped being available the moment the graph landed.
Keeping native meant maintaining **4,589 lines** (2,222 source + 2,367 test) of HTTP
adapters _on top of_ a dependency already in the tree, against **814 lines** doing the same
job for six providers.

**The measurement then agreed.** M0.1 captured both adapters on `deepseek-v4-pro`, same
project, same prompt set, 3 of 5 runs failed on each side —
`reports/2026-08-07-ai-orchestration-{native,langchain}.md`:

|                       | native           | langchain     |        |
| --------------------- | ---------------- | ------------- | ------ |
| TTFT p50              | 1,563 ms         | **1,521 ms**  | −2.7%  |
| TTFT p95              | 2,953 ms         | **2,377 ms**  | −19.5% |
| TTFT max              | 86,556 ms        | **5,226 ms**  | −94%   |
| Wall p50              | 19,519 ms        | **14,839 ms** | −24%   |
| Prompt-cache hit rate | **not reported** | 79.9%         |        |

`checkAgainstBudget(native, langchain, 0.05)` → `{ withinBudget: true, regressions: [] }`.

Two anomalies appeared on the native side and neither on LangChain: one call took 86.5s to
first token, and one sample recorded 10.6s of wall time with zero input, zero output and
zero cost — a call that accounted for nothing.

**The cost column is not evidence and was not used as any.** Native reports no cache counts
at all, so it prices every cached token at full rate; its $4.54 overstates what DeepSeek
billed. The apparent 72% saving is an accounting artifact (M0.1d).

**The decisive qualitative finding** is that both defects found during this migration were
provider quirks — DeepSeek's sidecar `reasoning_content` field, and cache-count accounting.
LangChain had the first; it was fixed in one shared place. **Native has the second, still,
and nothing had caught it.** Nine hand-written adapters is nine places for that class of
bug; one adapter layer over a maintained library is one place plus a dependency that tracks
provider changes on our behalf.

## Decision

**Delete the native provider implementations.** Every hosted provider is served by
LangChain through `LazyLangChainProvider`. `FRAMEPILOT_AI_PROVIDER_IMPL` is removed: with
one implementation it selects between one option, which is configuration that lies to
whoever sets it — the same reasoning that retired `FRAMEPILOT_AI_ORCHESTRATOR` at M12.

Deleted: `anthropic`, `nvidia`, `openrouter`, `groq`, `google`, `ollama`, `deepseek`, and
the shared wire layer they alone used (`openai-compatible`, `openai-reasoning`, `reasoning`,
`sse`).

**`mock` stays native, by design.** The offline path must not require a network client, and
it is what the browser falls back to when no key is saved.

**The ASR providers are untouched.** `groq-asr`, `nvidia-asr`, `local-asr` and
`twelvelabs-asr` are transcription, not chat, and share nothing with this decision. They
were the most obvious thing to delete by name-matching and the most damaging.

## Consequences

**Two things moved rather than died.** Model defaults and base URLs became
`providers/provider-defaults.ts` — the LangChain adapters had been importing them _from the
implementations they replaced_, so deletion alone was impossible. Anthropic's protocol
shaping (`resolveMaxTokens`, `ANTHROPIC_CACHE_CONTROL`, `splitAnthropicMessages`) moved into
`langchain.ts`: none of it was about transport, and that adapter is now its only caller.

**Three host call sites collapsed into one seam.** The desktop main process and the browser
renderer each imported concrete adapter classes and constructed them directly, so three
places knew how to map a provider name to an implementation — and the LangChain path reached
none of them. Both now call `createProviderFromConfig`.

**Desktop loses `net.fetch`.** The native adapters were handed Electron's `net.fetch`, which
routes through Chromium's network stack — system proxy configuration and enterprise root
CAs. The LangChain clients bring their own HTTP. On an ordinary network this is invisible;
behind a corporate proxy or with a custom CA it is not. **Recorded as a known consequence,
not an oversight.** Several LangChain clients accept an injected fetch
(`clientOptions.fetch`, `configuration.fetch`); wiring it is follow-up work, and pre-launch
with a single maintainer is the cheapest possible time to carry the gap.

**The browser now really runs these adapters.** `@langchain/anthropic` had been aliased to a
throwing stub in the web-editor Vite build, on the reasoning that the renderer could never
select it — true while a `process.env` flag gated the choice, false once LangChain became
the only implementation. Removing the alias exposed the defect the stub had been hiding:
Rollup does not apply the `./lib/*` pattern in `@anthropic-ai/sdk`'s `exports` map, so the
build failed to resolve `lib/transform-json-schema`. A small Vite plugin resolves those
subpaths through `@langchain/anthropic`, computing the path rather than hardcoding one —
pnpm store paths carry content hashes.

The vite config had also documented a contract the code did not keep: it claimed the browser
uses the offline mock provider, while `buildBrowserProvider` has constructed real providers
from a localStorage key since H11. The comment now describes what actually happens.

**Bundle:** the main chunk got _smaller_ (795.81 → 788.62 kB gzip) because the native
adapters left it. The chat SDKs are lazy chunks — Anthropic 63.5 kB gzip, the other five
104 kB gzip as one group — fetched on first real AI use, not at startup. Splitting that
group per provider is tracked follow-up: today, selecting DeepSeek also downloads Groq,
Google, Ollama and OpenAI.

**Test coverage moved with the code, deliberately.** Two suites compared native against
LangChain and could not survive the deletion; deleting them would have taken real protection
with them. `langchain-parity.test.ts` now asserts the Anthropic wire body against frozen
literals — the values the native adapter produced — so the prompt-cache contract is stated
directly instead of by comparison. `langchain-session-parity.test.ts` records whole runs as
golden fixtures under `__fixtures__/langchain-anthropic-sessions/`. The renderer-safety
guard (no bare `process.env`) moved onto `createProvider`, and `ResilientProvider.modelId`'s
"delegated, not copied" test moved out of the deleted `model-id.test.ts`. Coverage held at
100% on all four metrics throughout, which is what surfaced each gap.

**Reversal** means restoring eleven files from history and re-adding the flag. The migration
is past its point of no return in both senses now — the runtime and the providers.
