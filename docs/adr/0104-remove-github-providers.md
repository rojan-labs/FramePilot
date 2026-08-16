# ADR 0104: Remove the GitHub Models and GitHub Copilot providers

Status: **Accepted** · Date: 2026-08-07 · Supersedes the H11 decision recorded in
[ADR 0038 §6](./0038-production-hardening-milestone.md)

## Context

FramePilot shipped nine AI providers. Two of them — `github` (GitHub Models) and
`github-copilot` — were added in Phase 15 H11 as first-class providers.

They were never like the others. Every other hosted provider is a base URL plus a Bearer
key. GitHub Copilot exchanges a PAT for a short-lived session JWT at an undocumented
`copilot_internal/v2/token` endpoint, caches it until near expiry, distinguishes `gho_`
OAuth tokens (sent directly) from `ghp_` classic PATs (rejected), and sends IDE-style
client headers — a missing `editor-version` yields HTTP 400. That is a reverse-engineered
integration with a surface that can change without notice.

The cost of keeping them showed up repeatedly during the LangChain migration:

- **M2.3** had to record them as **permanently native**. LangChain's chat classes do not
  model a bespoke token exchange, so wrapping them would have meant reimplementing the
  exchange around a client that does not expect it, for no gain.
- That in turn meant **M2.5 could never be a clean sweep**: two native adapters had to
  survive the deletion of the rest, so `providers/` would keep two parallel
  implementations indefinitely.

The maintainer's assessment on 2026-08-07 was simply that neither provider is needed.

## Decision

**Remove both providers entirely** — the adapters, their configuration entries, their
settings-UI rows, their environment variables, and their documentation.

`PROVIDER_NAMES` and `AiProviderName` lose `'github'` and `'github-copilot'`, so a stale
value fails the same narrowing that already guards untrusted config.

## Consequences

**M2.5 becomes a clean sweep.** `mock` is now the only provider without a LangChain
adapter, and it must stay native by design — the offline path cannot require a network
client. Once the LangChain path is proven, the entire native hosted roster can be deleted
rather than most of it.

**One extraction was forced, and it is an improvement.** `providers/github.ts` also held
`buildOpenAiBody` and `parseOpenAiCompletion` — the shared OpenAI `/chat/completions`
request builder and response parser used by **DeepSeek, Groq, OpenRouter, NVIDIA and
Ollama**. They lived there only because GitHub Models happened to be the first provider
written against that format. Deleting the file would have taken five unrelated providers
with it, so the shared half moved to `providers/openai-compatible.ts` under the name it
should always have had. No behaviour changed in the move.

That extraction carried a real risk worth naming: **the code moved and its tests did
not**. `github.test.ts` was deleted with the providers, and it was where the parser's
usage-handling branches were covered — a module five providers depend on would have ended
up less tested than the day before. `openai-compatible.test.ts` now covers the parser
directly, rather than incidentally through whichever provider calls it.

**Existing users of these providers are degraded, not broken.** A stored `activeProvider`
of `github` or `github-copilot` no longer narrows, so config loading falls back to `mock`
— the offline stub, which calls no model. That is safe (no crash, no key leak, no silent
call to a different model) but it is **silent**: the user sees an assistant that stops
producing real work until they pick a provider in Settings. The removal is documented in
`docs/guides/ai-providers.md` with OpenRouter named as the closest OpenAI-compatible
replacement. A one-time migration notice was judged not worth building for a
single-maintainer product.

**Four environment variables are retired**: `GITHUB_MODELS_PAT`, `GITHUB_MODELS_MODEL`,
`GITHUB_COPILOT_TOKEN`, `GITHUB_COPILOT_MODEL`. Removed from `turbo.json` `globalEnv`;
their removal from the root `.env.example` is the maintainer's, as that file is outside
the agent's permitted paths.

**Reversal** means restoring `providers/github.ts` from history — but the OpenAI-compatible
half now lives in its own module, so a revert would restore only the GitHub-specific
classes and re-add them to the two name unions.
