# Configuration

Copy [`.env.example`](../../.env.example) to `.env` for local development:

```bash
cp .env.example .env
```

`.env.example` is the exhaustive variable inventory and should remain safe to commit. This
guide explains the groups, authority boundaries, defaults, and security implications.
Never commit `.env`, API keys, signing credentials, or local project paths.

## Configuration precedence

The exact precedence depends on the surface:

- Desktop Settings can own normal user-facing provider, model, embeddings, transcription,
  editor, and runtime preferences.
- Environment variables provide development defaults, deployment values, secret material,
  base URL overrides, and advanced controls.
- Explicit environment overrides used by packaging or debugging can take precedence over
  automatically discovered bundled resources.
- Project-authored settings belong in the project document only when they affect the edit or
  render. Secrets and machine paths do not.

## AI provider selection

```bash
FRAMEPILOT_AI_PROVIDER=mock
```

Supported values:

```text
anthropic | nvidia | openrouter | groq | google | ollama | deepseek |
openai-compatible | mock
```

`mock` is deterministic, offline, and intended for automated tests and UI development. Read
[`ai-providers.md`](ai-providers.md) for capability and provider-specific behavior.

### Anthropic

| Variable             | Purpose                                      |
| -------------------- | -------------------------------------------- |
| `ANTHROPIC_API_KEY`  | Anthropic credential.                        |
| `ANTHROPIC_MODEL`    | Active Claude model id.                      |
| `ANTHROPIC_BASE_URL` | Optional API or compatible gateway override. |

### NVIDIA chat

| Variable          | Purpose                            |
| ----------------- | ---------------------------------- |
| `NVIDIA_API_KEY`  | NVIDIA chat credential.            |
| `NVIDIA_MODEL`    | OpenAI-compatible NVIDIA model id. |
| `NVIDIA_BASE_URL` | NVIDIA chat endpoint.              |

### OpenRouter

| Variable              | Purpose                         |
| --------------------- | ------------------------------- |
| `OPENROUTER_API_KEY`  | OpenRouter credential.          |
| `OPENROUTER_MODEL`    | Upstream provider/model id.     |
| `OPENROUTER_BASE_URL` | OpenRouter-compatible endpoint. |

### Vercel AI Gateway

| Variable              | Purpose                             |
| --------------------- | ----------------------------------- |
| `AI_GATEWAY_API_KEY`  | Vercel AI Gateway credential.       |
| `AI_GATEWAY_MODEL`    | Upstream `provider/model` slug.     |
| `AI_GATEWAY_BASE_URL` | Gateway OpenAI-compatible endpoint. |

### Groq

| Variable                    | Purpose                                               |
| --------------------------- | ----------------------------------------------------- |
| `GROQ_API_KEY`              | Groq credential used by chat and optional hosted ASR. |
| `GROQ_MODEL`                | Chat model id.                                        |
| `GROQ_BASE_URL`             | Groq OpenAI-compatible endpoint.                      |
| `FRAMEPILOT_ASR_GROQ_MODEL` | Optional Groq model override for transcription.       |

### Google Gemini

| Variable          | Purpose                          |
| ----------------- | -------------------------------- |
| `GOOGLE_API_KEY`  | Gemini Developer API credential. |
| `GOOGLE_MODEL`    | Gemini model id.                 |
| `GOOGLE_BASE_URL` | Gemini REST API root.            |

### Ollama

| Variable          | Purpose                                               |
| ----------------- | ----------------------------------------------------- |
| `OLLAMA_API_KEY`  | Optional credential, sent as `Authorization: Bearer`. |
| `OLLAMA_MODEL`    | Installed local or remote model id.                   |
| `OLLAMA_BASE_URL` | Ollama server root. A `/v1` suffix is stripped.       |

### DeepSeek

| Variable            | Purpose                       |
| ------------------- | ----------------------------- |
| `DEEPSEEK_API_KEY`  | DeepSeek credential.          |
| `DEEPSEEK_MODEL`    | Chat or reasoning model id.   |
| `DEEPSEEK_BASE_URL` | DeepSeek-compatible endpoint. |

### OpenAI-compatible server

For any server speaking OpenAI's `/chat/completions` that is not one of the named
providers above (vLLM, LM Studio, llama.cpp, LiteLLM, a local proxy).

| Variable                                | Purpose                                                              |
| --------------------------------------- | -------------------------------------------------------------------- |
| `FRAMEPILOT_OPENAI_COMPATIBLE_BASE_URL` | **Required.** Endpoint root. No default — unset means the run fails. |
| `FRAMEPILOT_OPENAI_COMPATIBLE_MODEL`    | Model id the server serves.                                          |
| `FRAMEPILOT_OPENAI_COMPATIBLE_API_KEY`  | Optional; most self-hosted servers ignore it.                        |

## Media intelligence and embeddings

| Variable                            | Purpose                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FRAMEPILOT_NVIDIA_EMBEDDINGS_KEYS` | Comma-separated NVIDIA keys for hosted visual embeddings with rotate-on-failure behavior. Separate from the chat key.                                                                                                                                                          |
| `FRAMEPILOT_EMBEDDINGS_MODEL_DIR`   | Local ONNX model and tokenizer directory for optional text similarity. Missing configuration degrades to keyword search.                                                                                                                                                       |
| `TWELVELABS_API_KEY`                | TwelveLabs credential when the supported hosted media-understanding backend is enabled. It may be stored through Settings rather than the example environment file.                                                                                                            |
| `PEXELS_API_KEY`                    | Pexels credential for stock photo and video search (Settings → AI → Stock media). Free and instant from pexels.com/api. Usually stored through Settings; this variable is a fallback for headless setups. Only your search text is sent — see `docs/guides/stock-sourcing.md`. |

Hosted visual embeddings and media understanding can send sampled frames, audio, or other
selected media data to the configured service. Treat credential configuration as explicit
consent for that provider boundary and keep the UI disclosure current.

## Transcription and ASR

| Variable                        | Purpose                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`                | Optional hosted transcription credential for supported paths.                            |
| `WHISPER_MODEL`                 | Default Whisper model name.                                                              |
| `FRAMEPILOT_WHISPER_CLI`        | Path to a whisper.cpp-compatible executable. Packaged builds can inject a staged binary. |
| `FRAMEPILOT_ASR_MODEL_DIR`      | Directory containing local ASR model files.                                              |
| `FRAMEPILOT_ASR_CACHE_DIR`      | Directory for cached transcription artifacts.                                            |
| `FRAMEPILOT_ASR_<MODEL>_SHA256` | Advanced per-model checksum override for explicitly trusted local model files.           |
| `FRAMEPILOT_ASR_GROQ_MODEL`     | Optional hosted Groq transcription model.                                                |

Transcription backends are separate from the chat provider. Choosing Groq or another chat
provider does not automatically choose the same service for ASR.

## Python sidecar

| Variable                     | Default or behavior                       | Purpose                                                                              |
| ---------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------ |
| `FRAMEPILOT_PYTHON_API_URL`  | `http://127.0.0.1:8765`                   | Address used by clients to reach the sidecar.                                        |
| `FRAMEPILOT_PYTHON_API_HOST` | `127.0.0.1`                               | Sidecar bind host. Keep loopback unless an accepted design changes the threat model. |
| `FRAMEPILOT_PYTHON_API_PORT` | `8765`                                    | Sidecar port.                                                                        |
| `FRAMEPILOT_CORS_ORIGINS`    | Development and packaged renderer origins | Comma-separated allowed origins for browser requests.                                |
| `FRAMEPILOT_LOG_LEVEL`       | `info`                                    | Python sidecar log level.                                                            |
| `LOG_LEVEL`                  | `info`                                    | Engine/application log level used by existing settings paths.                        |

## Desktop sidecar and packaged engine

| Variable                        | Purpose                                                                                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FRAMEPILOT_ENGINE_DIR`         | Force source-engine execution from a specific directory, including packaged-app debugging. Normal packaged builds use the bundled PyInstaller engine. |
| `FRAMEPILOT_SIDECAR_TIMEOUT_MS` | Startup health-check timeout for the desktop-managed sidecar.                                                                                         |
| `FRAMEPILOT_FFMPEG`             | Explicit ffmpeg binary path.                                                                                                                          |
| `FRAMEPILOT_FFPROBE`            | Explicit ffprobe binary path.                                                                                                                         |

Development binary resolution checks explicit overrides, `PATH`, and supported fallbacks.
Packaged builds stage media binaries and inject their paths into the sidecar environment.

## Project storage and safety budgets

| Variable                                 | Default or behavior             | Purpose                                                                                                                                                                          |
| ---------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FRAMEPILOT_PROJECTS_ROOT`               | OS/application project location | Sandbox root for project and accepted media operations.                                                                                                                          |
| `FRAMEPILOT_RENDER_TIMEOUT_SECONDS`      | `900`                           | Maximum duration of one render job.                                                                                                                                              |
| `FRAMEPILOT_ASSET_MEDIA_TIMEOUT_SECONDS` | `60`                            | Probe and derived-media subprocess budget.                                                                                                                                       |
| `FRAMEPILOT_ASSET_MEDIA_CONCURRENCY`     | `2`                             | Derivations in flight at once. Each is a probe, a waveform decode, thumbnails and a proxy transcode of the original, so this bounds memory, not latency. `1` is strictly serial. |
| `FRAMEPILOT_PROXY_TIMEOUT_SECONDS`       | `300`                           | Preview proxy transcode budget.                                                                                                                                                  |
| `FRAMEPILOT_PROXY_MAX_DURATION_SECONDS`  | `900`                           | Sources longer than this skip synchronous proxy generation.                                                                                                                      |
| `FRAMEPILOT_AI_MAX_TOKENS`               | `8192`                          | Request token budget used by orchestration.                                                                                                                                      |
| `FRAMEPILOT_MAX_TOOL_CONCURRENCY`        | `4`                             | Maximum parallel concurrency-safe read or analysis tools in one turn.                                                                                                            |
| `FRAMEPILOT_MAX_REVIEW_CONCURRENCY`      | `1`                             | Perceptual reviews in flight at once (ADR 0123). Each is a real frame batch at project resolution, so this multiplies memory, not latency.                                       |
| `FRAMEPILOT_SOUL_ROOT`                   | `~/.framepilot`                 | Cross-project working-style memory root.                                                                                                                                         |

Timeouts, token budgets, concurrency limits, and project-root containment are correctness and
security controls. Do not silently ignore invalid values or replace them with an unbounded
path.

## MCP server

The TypeScript MCP server uses Streamable HTTP on loopback.

| Variable              | Default     | Purpose                       |
| --------------------- | ----------- | ----------------------------- |
| `FRAMEPILOT_MCP_HOST` | `127.0.0.1` | Listener host.                |
| `FRAMEPILOT_MCP_PORT` | `19789`     | Listener port.                |
| `FRAMEPILOT_MCP_PATH` | `/mcp`      | Streamable HTTP request path. |

The MCP server also uses project-root and sidecar settings. Keep the listener on loopback and
preserve DNS-rebinding and session protections. See [`mcp-server.md`](mcp-server.md).

## Licensing

| Variable                         | Exposure               | Purpose                                                                            |
| -------------------------------- | ---------------------- | ---------------------------------------------------------------------------------- |
| `FRAMEPILOT_FREEMIUS_PRODUCT_ID` | Desktop runtime        | Product id used by the license gate. Takes precedence over the generic product id. |
| `FREEMIUS_PRODUCT_ID`            | Server/build context   | Generic Freemius product id and pricing sync value.                                |
| `FRAMEPILOT_LICENSE_DEV_BYPASS`  | Local development only | Explicitly bypass the desktop license gate. Never enable in production builds.     |

When product configuration is absent, development behavior should be explicit. A production
build must not accidentally inherit a local bypass.

## Marketing website and checkout

### Browser-visible values

| Variable                               | Purpose                                     |
| -------------------------------------- | ------------------------------------------- |
| `NEXT_PUBLIC_FREEMIUS_PRODUCT_ID`      | Freemius product id exposed to the website. |
| `NEXT_PUBLIC_FREEMIUS_PUBLIC_KEY`      | Public checkout key.                        |
| `NEXT_PUBLIC_FREEMIUS_PLAN_ID_MONTHLY` | Optional monthly plan fallback.             |
| `NEXT_PUBLIC_FREEMIUS_PLAN_ID_ANNUAL`  | Optional annual plan fallback.              |
| `NEXT_PUBLIC_SITE_URL`                 | Canonical public website origin.            |
| `NEXT_PUBLIC_DEMO_YOUTUBE_ID`          | Optional homepage demo video id.            |

`NEXT_PUBLIC_*` values are bundled into browser assets. They must never contain secrets.
They also need to be present in the deployment build environment because a local `.env`
does not automatically configure a hosted build.

### Server-only values

| Variable                | Purpose                                             |
| ----------------------- | --------------------------------------------------- |
| `FREEMIUS_PUBLIC_KEY`   | Server-side pricing request value.                  |
| `FREEMIUS_SECRET_KEY`   | Server-only Freemius secret.                        |
| `FREEMIUS_BEARER_TOKEN` | Optional bearer-token alternative for pricing sync. |

Keep server-only values out of `NEXT_PUBLIC_*`, client components, generated static JSON,
logs, screenshots, and pull-request descriptions.

## Packaging and release credentials

| Variable                      | Purpose                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `CSC_NAME`                    | macOS signing identity used by the engine signing helper and Electron Builder. Unset permits unsigned local builds. |
| `PYTHON_PATH`                 | Python executable used by packaging tools on hosts without a `python` shim.                                         |
| `APPLE_ID`                    | Apple notarization credential supplied by CI or the release environment.                                            |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple notarization password.                                                                                        |
| `APPLE_TEAM_ID`               | Apple developer team id.                                                                                            |

Release secrets belong in the secure CI or release environment. They are referenced by
release configuration even when they are not included as blank values in `.env.example`.

## Adding or changing configuration

A configuration change is complete when applicable updates include:

1. executable parsing and validation,
2. safe defaults and explicit invalid-value behavior,
3. `.env.example`,
4. this guide,
5. Settings UI and persistence,
6. host or sidecar IPC contracts,
7. packaging injection or deployment configuration,
8. tests for precedence, malformed values, and secret boundaries,
9. changelog and plan updates when user-visible,
10. an ADR when the configuration changes a durable architecture or privacy boundary.

The source code remains authoritative for exact runtime parsing. Correct this guide whenever
it drifts from the implementation.
