# ADR 0108: A provider for any OpenAI-compatible server

Status: **Accepted** · Date: 2026-08-09 ·
Amends [ADR 0105](./0105-langchain-is-the-only-provider-implementation.md)

## Context

FramePilot's provider roster names services: `anthropic`, `nvidia`, `openrouter`, `groq`,
`google`, `deepseek`, plus `ollama` for a local daemon. Each carries a `baseUrl` slot that
overrides *its own* endpoint.

That roster has no way to say "a server I run, at this address". The gap surfaced through
the `trial/` auth2api proxy — a local process exposing a Claude subscription as
`POST /v1/chat/completions` on `127.0.0.1:8317` — but it is not specific to that trial.
vLLM, LM Studio, llama.cpp's server, LiteLLM and corporate gateways all speak the same
contract and none of them is a named provider.

Two workarounds existed, and both were wrong in the same way:

**Point Ollama at it.** Ollama is the only provider whose Server URL field the Settings UI
exposes, so this is what a user naturally does. Before ADR 0105 it even worked: the
hand-written `providers/ollama.ts` POSTed to `<baseUrl>/chat/completions` with a Bearer
key. ADR 0105 replaced that adapter with LangChain's `ChatOllama`, which speaks Ollama's
**native** protocol — it strips a `/v1` suffix and POSTs `<baseUrl>/api/chat` — and takes
no API key at all. An OpenAI-compatible server answers that request with a 404, whose HTML
error page then arrived in the chat sidebar as the failure message. The migration changed a
transport contract that documentation and users depended on, and nothing failed loudly at
the time because no test asserted the wire path.

**Point a named provider at it.** `openrouter` and `nvidia` are already `ChatOpenAI` with a
configurable `baseURL` and a Bearer key — the exact right transport. But there is one URL
slot per provider: aiming "OpenRouter" at localhost makes real OpenRouter unusable for as
long as the override stands, and Settings then reports a connection to a service that is
not the one being called.

A third defect sat underneath both. The native adapters owned their `fetch` and classified
their own HTTP failures; the LangChain adapters do not, and every thrown error fell through
to the catch-all in `retry.ts`, which types anything unrecognised as `network`. `network`
is retryable, so **every** provider failure became retryable: a 401 from a wrong key and a
404 from a wrong URL were each retried the full budget before surfacing, carrying the raw
upstream body as their message.

## Decision

**1. Add `openai-compatible` as a first-class provider.** It is `ChatOpenAI` with the host's
URL and an optional key — the same adapter class as OpenRouter and NVIDIA, differing only
in configuration.

**2. It has no default endpoint, and fails loudly without one.** Every other provider names
a service whose address we know. This one is the host's own server, so there is nothing to
default to, and a silent fallback to somebody else's API is precisely the failure the
provider exists to prevent. A missing URL raises a `bad_request` `ProviderError` — the
non-retryable kind, because retrying a missing setting three times only delays the message
the user needs to read. Readiness in Settings is gated on the URL rather than a key, so the
picker never offers a provider that would fail on its first call.

**3. Classify LangChain chat errors at the provider seam.** `classifyLangChainError` reads
the status the SDK already attached and maps it through the same `kindForStatus` the ASR
paths use, so permanent failures fail fast. Error bodies are made readable first: a wrong
endpoint is answered by whatever HTTP server is listening, usually with an HTML page, and
the reason inside it (`Cannot POST /api/chat`) is extracted rather than the markup shown.
Aborts pass through untyped, because both `resilient-provider.ts` and `retry.ts` identify a
user cancel by `error.name === 'AbortError'`.

**4. Restore the Ollama API key.** A configured key travels as an explicit
`Authorization: Bearer` header, since `ChatOllama` has no `apiKey` option. This is what the
adapter ADR 0105 deleted did, and it is the only way to reach an Ollama behind an
authenticating reverse proxy.

## Consequences

A new provider name enters `PROVIDER_NAMES`, and the exhaustive `Record<ProviderName, …>`
types made the compiler enumerate every site that had to follow: the capability floor, the
default-model table, the desktop and browser stores, the settings metadata. The Python
`AIProvider` enum mirrors the roster and is asserted against the TS source by
`test_config.py`; that test's quote scanner had to learn to skip `//` comments, since prose
explaining an entry contains apostrophes.

The persisted desktop config gains an `openai-compatible` key. This is backward compatible
— an older file yields an empty entry through `readEntry`, and `isProviderName` still
rejects unknown strings — so no migration is required.

Two conservative defaults are worth naming because they are guesses, not measurements. The
context floor is `CONSERVATIVE_FALLBACK` (32,768/4,096): nothing is knowable about an
arbitrary server, and a recognised model id still wins over it. The default model id is
`gpt-4o-mini`, chosen only because it is the id most widely mirrored by OpenAI-compatible
gateways and because context sizing needs *some* id before the first call — any real
deployment sets it.

Typed errors change retry behaviour for every LangChain provider, not just this one. Runs
that previously spent a full retry budget on a permanent 4xx now fail on the first attempt.
That is the intent, and it is the observable difference to look for if a provider's failure
timing changes.

Finally, `trial/README.md` documented `packages/ai-sdk/src/providers/ollama.ts` — a file
ADR 0105 deleted — and told users to configure the trial through the Ollama provider. It
now documents this provider instead. The general lesson is the one ADR 0105 did not act on:
deleting an implementation whose *wire contract* is documented elsewhere is not a deletion
alone.
