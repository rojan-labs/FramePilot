# AI Providers

FramePilot uses one provider interface across hosted, gateway, and local models. The
active provider is selected in **Settings > AI > Providers** or through
`FRAMEPILOT_AI_PROVIDER`.

Every hosted provider is served by a LangChain chat model (ADR 0105). FramePilot's own HTTP
clients were removed on 2026-08-07 after measurement showed the LangChain path faster on
every latency figure and the only one reporting prompt-cache counts. There is no switch
between implementations, and `FRAMEPILOT_AI_PROVIDER_IMPL` is no longer read — delete it if
you have it set. `mock` is the one exception and stays client-free by design, so the offline
path works with no network at all.

Provider selection changes model transport and capability. It does not change editing
authority. Every provider remains behind the same tool registry, input schemas, patch
validation, host authorization, usage events, cancellation, and completion rules.

## Supported provider ids

```text
anthropic
nvidia
openrouter
vercel-gateway
groq
google
ollama
deepseek
openai-compatible
mock
```

## Configuration summary

| Provider id         | Required or typical values                                                                                                                  | Transport                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `anthropic`         | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, optional `ANTHROPIC_BASE_URL`                                                                       | Anthropic Messages API                 |
| `nvidia`            | `NVIDIA_API_KEY`, `NVIDIA_MODEL`, optional `NVIDIA_BASE_URL`                                                                                | OpenAI-compatible chat API             |
| `openrouter`        | `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, optional `OPENROUTER_BASE_URL`                                                                    | OpenAI-compatible chat API             |
| `vercel-gateway`    | `AI_GATEWAY_API_KEY`, `AI_GATEWAY_MODEL`, optional `AI_GATEWAY_BASE_URL`                                                                    | OpenAI-compatible chat API             |
| `groq`              | `GROQ_API_KEY`, `GROQ_MODEL`, optional `GROQ_BASE_URL`                                                                                      | OpenAI-compatible chat API             |
| `google`            | `GOOGLE_API_KEY`, `GOOGLE_MODEL`, optional `GOOGLE_BASE_URL`                                                                                | Native Gemini REST API                 |
| `ollama`            | `OLLAMA_MODEL`, optional `OLLAMA_BASE_URL` and `OLLAMA_API_KEY`                                                                             | Local OpenAI-compatible endpoint       |
| `deepseek`          | `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`, optional `DEEPSEEK_BASE_URL`                                                                          | OpenAI-compatible chat API             |
| `openai-compatible` | **required** `FRAMEPILOT_OPENAI_COMPATIBLE_BASE_URL`, `FRAMEPILOT_OPENAI_COMPATIBLE_MODEL`, optional `FRAMEPILOT_OPENAI_COMPATIBLE_API_KEY` | OpenAI-compatible chat API             |
| `mock`              | No credentials                                                                                                                              | Deterministic in-process test provider |

The complete environment reference lives in [`.env.example`](../../.env.example) and
[`configuration.md`](configuration.md).

## Selecting a provider

```bash
FRAMEPILOT_AI_PROVIDER=mock
```

The desktop Settings interface can store provider and model choices for normal use. Keep
`.env` for local development, CI-safe defaults, base URL overrides, and services that are
not yet represented by a settings control.

One provider and model own an entire request. Classification, planning, editing, repair,
and completion do not silently jump between providers midway through a run.

## Mock

`mock` is the deterministic default for automated tests and offline development.

- No key or network is required.
- Responses and tool calls are reproducible.
- It exercises orchestration and patch paths without measuring live-model quality.
- It should stay representative when tools, events, or contracts change.

A passing mock test does not prove that every live model follows tool instructions equally
well.

## Anthropic

```bash
FRAMEPILOT_AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-opus-4-8
ANTHROPIC_BASE_URL=https://api.anthropic.com
```

The adapter uses Anthropic's native message, content block, tool-use, streaming, usage, and
image shapes. Vision is available only when the selected model is recognized as
vision-capable by the current capability policy.

## NVIDIA

```bash
FRAMEPILOT_AI_PROVIDER=nvidia
NVIDIA_API_KEY=nvapi-...
NVIDIA_MODEL=<tool-capable-model-id>
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
```

NVIDIA chat uses the shared OpenAI-compatible provider path. Visual embeddings are a
separate media-intelligence capability with separate keys:

```bash
FRAMEPILOT_NVIDIA_EMBEDDINGS_KEYS=key-one,key-two
```

Or set the same keys per-user in **Settings → AI → Media intelligence → On-device
embeddings key** (comma-separated), which forwards them with the index/search request
instead of requiring a server-side env var.

Those embedding keys can rotate on failure. Configuring them permits selected sampled
frames to leave the device for hosted embedding generation. This is distinct from giving the
chat model visual access to the current edit.

If a **TwelveLabs** key is also configured, it wins: the engine resolves the hosted
backend before the on-device embedder, and Settings names the backend that will actually
run. Clear the TwelveLabs key to fall back to on-device embeddings. See
[`twelvelabs-understanding.md`](./twelvelabs-understanding.md).

## OpenRouter

```bash
FRAMEPILOT_AI_PROVIDER=openrouter
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=<provider/model>
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
```

OpenRouter exposes many upstream models through one OpenAI-compatible endpoint. Select a
model that supports the tools and context required by the requested edit. Model names alone
do not guarantee reliable tool use, streaming usage, or vision.

## Vercel AI Gateway

```bash
FRAMEPILOT_AI_PROVIDER=vercel-gateway
AI_GATEWAY_API_KEY=...
AI_GATEWAY_MODEL=anthropic/claude-sonnet-4.6
AI_GATEWAY_BASE_URL=https://ai-gateway.vercel.sh/v1
```

Like OpenRouter, the gateway fronts many upstream vendors behind one OpenAI-compatible
endpoint, and model ids are `provider/model` slugs — a bare id is rejected. Create the key
in the Vercel dashboard under **AI Gateway**; `AI_GATEWAY_API_KEY` is Vercel's own name for
it, so a machine already set up for Vercel tooling needs no second variable.

FramePilot reads that static key only. Vercel's OIDC flow (`VERCEL_OIDC_TOKEN`, refreshed
by `vercel env pull`) is deliberately not used: those tokens expire in about a day, and a
desktop editor cannot assume the Vercel CLI is installed to renew them.

Model choice still decides capability. Pick a slug whose upstream model supports the tool
use, context, and vision the requested edit needs.

## Groq

```bash
FRAMEPILOT_AI_PROVIDER=groq
GROQ_API_KEY=gsk_...
GROQ_MODEL=<tool-capable-model-id>
GROQ_BASE_URL=https://api.groq.com/openai/v1
```

Groq chat uses the shared OpenAI-compatible path. Groq-backed ASR is configured separately
through `FRAMEPILOT_ASR_GROQ_MODEL` and the transcription settings. Chat-provider selection
does not automatically select the transcription backend.

## Google Gemini

```bash
FRAMEPILOT_AI_PROVIDER=google
GOOGLE_API_KEY=...
GOOGLE_MODEL=<gemini-model-id>
GOOGLE_BASE_URL=https://generativelanguage.googleapis.com/v1beta
```

The Google adapter uses Gemini-native contents, function declarations, function responses,
streaming, usage, and image parts. Tool and image conversion belongs in the adapter so the
orchestrator remains provider-neutral.

## Removed: GitHub Models and GitHub Copilot

Both were removed on 2026-08-07. They needed a bespoke token exchange (and, for Copilot,
IDE-style client headers) that no other provider requires, and neither earned its
maintenance cost. `FRAMEPILOT_AI_PROVIDER=github` / `github-copilot` are no longer valid
values, and `GITHUB_MODELS_PAT`, `GITHUB_MODELS_MODEL`, `GITHUB_COPILOT_TOKEN` and
`GITHUB_COPILOT_MODEL` are no longer read.

If either was your active provider, the app falls back to the offline `mock` provider —
which does not call any model — so pick a real one in Settings. For an OpenAI-compatible
endpoint, OpenRouter is the closest replacement.

## Ollama

```bash
FRAMEPILOT_AI_PROVIDER=ollama
OLLAMA_MODEL=<installed-model>
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
OLLAMA_API_KEY=
```

Ollama keeps model inference local by default. The selected local model still needs enough
context and dependable tool calling for the workflow. Small local models can be useful for
focused requests and can struggle with long, multi-step agent runs.

A configured `OLLAMA_API_KEY` is sent as an `Authorization: Bearer` header, for an Ollama
behind an authenticating reverse proxy. Note that this provider speaks Ollama's **own**
API (`/api/chat`), not the OpenAI-compatible one — a `/v1` suffix on the base URL is
stripped. To reach an OpenAI-compatible server, use the `openai-compatible` provider
below instead.

Ollama and other compatible proxies can reject sampling parameters supported by another
model. When a response explicitly states that `temperature` is unsupported or deprecated,
FramePilot can retry once without that field and remember the model capability for the
provider instance. Unrelated request failures are not retried through this negotiation.

## OpenAI-compatible server

```bash
FRAMEPILOT_AI_PROVIDER=openai-compatible
FRAMEPILOT_OPENAI_COMPATIBLE_BASE_URL=http://127.0.0.1:8000/v1
FRAMEPILOT_OPENAI_COMPATIBLE_MODEL=<model-the-server-serves>
FRAMEPILOT_OPENAI_COMPATIBLE_API_KEY=
```

For any server that speaks OpenAI's `/chat/completions` contract but is not one of the
named services above: vLLM, LM Studio, llama.cpp's server, LiteLLM, a corporate gateway,
or a local proxy. In Settings > AI it appears as **OpenAI-compatible server**, with a
Server URL field.

This is the only provider with **no default endpoint**. The URL is the entire
configuration, and without one the provider fails immediately with a message saying so
rather than falling back to another service's API. It is also the reason not to reuse a
named provider's base-URL override for this purpose: each of those owns a single URL slot
pointed at its own service, so borrowing one makes that service unusable and mislabels
the connection in Settings.

The API key is optional — most self-hosted servers ignore it. A placeholder is sent when
none is configured, because the OpenAI client refuses to construct without one; a server
that does check the header receives the real key.

Per-request sampling settings are forwarded consistently across OpenRouter, the Vercel AI
Gateway, NVIDIA, and
custom OpenAI-compatible servers. When FramePilot sets a temperature, the adapter sends
that exact value; when it does not, the field is omitted so the selected model or gateway
retains its own default.

Because the served model can be anything, FramePilot sizes context from the configured
model id when it recognises it and otherwise applies a conservative floor. Set the model
id to what the server actually serves.

## DeepSeek

```bash
FRAMEPILOT_AI_PROVIDER=deepseek
DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_BASE_URL=https://api.deepseek.com
```

DeepSeek uses the shared OpenAI-compatible path. Reasoning-capable responses can include a
separate reasoning field, which is normalized into FramePilot's reasoning event stream rather
than mixed into the visible answer.

## Vision capability

Vision support is conservative and model-specific.

A vision-capable run can receive `get_frame`. The tool renders a composited frame from the
current working project through the Python export compiler and attaches the image to a later
provider request using the provider's native image format.

A provider being listed here does not mean every model on that provider supports images. A
text-only or unrecognized model must not receive a visual-inspection path that would let it
claim to have seen the edit.

Visual embeddings, TwelveLabs media understanding, transcription, and `get_frame` are
separate capabilities. They can use different services and credentials.

## Provider failures

Errors from a provider are typed before they reach the run, from the HTTP status the SDK
reports: `401`/`403` and other 4xx are permanent and fail immediately, while `429`, `5xx`
and transport faults are retried under the single retry policy. A misconfigured endpoint
therefore surfaces its message at once instead of after a full retry budget.

Error bodies are made readable before display. A wrong base URL is usually answered by an
HTML error page from whatever server is listening; FramePilot extracts the reason from it
(`Cannot POST /api/chat`) rather than showing the markup.

## Usage reporting

OpenAI-compatible streamed requests ask providers to include usage. When a provider returns
usage, FramePilot reports model calls, tokens, and available cost information. When a model
was called but the provider returns no usage, the UI reports that usage was not provided. It
does not label the run as free or as a zero-token run.

## Provider-neutral safety contract

Every provider must preserve these rules:

1. The model sees only tools allowed for the request and current capability state.
2. Tool input is validated before execution.
3. Read and analysis tools cannot mutate the project.
4. Mutation tools produce typed operations or patches.
5. Host authority and revision checks decide whether a mutation can commit.
6. Cancellation stops provider work and prevents late mutation.
7. Tool results and model context are bounded.
8. Visual completion is claimed only when visual evidence was actually supplied.
9. Missing capability degrades explicitly.
10. Secrets are never placed in project JSON or ordinary model context.

## Adding a provider

1. Implement the provider interface in `packages/ai-sdk`.
2. Normalize request messages, tools, streaming, tool calls, usage, errors, cancellation, and
   optional image content.
3. Register the provider id and settings metadata.
4. Add environment variables to `.env.example` and `configuration.md`.
5. Add deterministic tests for request mapping, streaming, tool-call assembly, malformed
   responses, usage, cancellation, and any parameter negotiation.
6. Verify the provider cannot bypass the canonical tool and patch boundaries.
7. Update this guide, the changelog when user-visible, and the current plan entry.

Read [`../architecture/ai-engine.md`](../architecture/ai-engine.md),
[`../api/ai-tools.md`](../api/ai-tools.md), and the AI safety material under
[`.agents/`](../../.agents) before changing the provider layer.
