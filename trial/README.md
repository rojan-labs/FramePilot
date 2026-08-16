# auth2api trial (not a core module)

Trial of [`auth2api`](https://github.com/AmazingAng/auth2api): a local proxy that
turns a **Claude (Anthropic)** or **ChatGPT (Codex)** OAuth login into
OpenAI-compatible API endpoints, so the orchestrator (`packages/ai-sdk`) can call
it exactly like any other OpenAI-style provider — backed by a subscription
instead of a metered API key.

This folder is intentionally **outside** the pnpm workspace
(`pnpm-workspace.yaml` only globs `apps/*`, `packages/*`, `tests/e2e`), so it
never affects the main install, build, lint, or test pipeline. Delete `trial/`
at any time with no impact on the rest of the repo.

> Replaces the previous `switchboard-ai-sdk` trial. auth2api speaks the OpenAI
> protocol **natively** — real `tool_calls` and real SSE streaming — so the text
> based tool-call bridge and the `claude -p` CLI patch that trial needed are both
> gone.

## Setup

auth2api is not published to npm; the only supported install is a git clone +
build. `setup.mjs` does that idempotently into `trial/auth2api` (gitignored):

```bash
cd trial
npm run setup
```

Requires Node 20+ (verified on v24).

Convenience wrappers exist at the repo root — `pnpm trial:setup`, `pnpm
trial:login`, `pnpm trial:start`. They use `npm --prefix trial`, which runs with
the working directory set to `trial/`, so the `config.yaml` path below is the
same either way.

## Log in

Pick the subscription you want to expose. Both open a browser:

```bash
npm run login          # Claude (Anthropic) — default
npm run login:codex    # ChatGPT Plus/Pro
npm run login:manual   # paste-the-code flow, for headless/remote machines
```

Tokens are stored in `~/.auth2api`. **The server refuses to start with zero
accounts** — logging in is not optional.

## Run

```bash
npm start
```

Listens on **http://127.0.0.1:8317** and exposes:

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI-compatible chat (what FramePilot uses) |
| `POST /v1/responses` | OpenAI Responses API |
| `POST /v1/messages` | Claude native passthrough |
| `POST /v1/messages/count_tokens` | Token counting |
| `GET /v1/models` | List available models |
| `GET /health` | Health check |
| `GET /admin/accounts`, `GET /admin/stats` | Account health, call stats |

On first start it generates an API key and saves it to `config.yaml`. Note that
auth2api resolves that path **relative to the working directory**, so running via
these npm scripts puts it at `trial/config.yaml` (gitignored — it is a
credential). Start from `trial/config.example.yaml`'s upstream copy
(`auth2api/config.example.yaml`) if you want to tune port, timeouts, or debug
level.

Smoke-test the build (36 mocked-upstream tests, no network, no account needed):

```bash
npm run test:smoke
```

## Point the orchestrator at it

Use the **`openai-compatible`** provider (ADR 0108) — `ChatOpenAI` pointed at a URL
you supply, sending `Authorization: Bearer <apiKey>`, which is exactly auth2api's
contract.

In the app: **Settings → AI → OpenAI-compatible server**. Set Server URL to
`http://127.0.0.1:8317/v1`, the API key to the one in `trial/config.yaml`, and the
model to something the account serves (e.g. `claude-sonnet-4-6`); `GET /v1/models`
lists what the logged-in account exposes.

From the environment instead:

```bash
FRAMEPILOT_AI_PROVIDER=openai-compatible \
FRAMEPILOT_OPENAI_COMPATIBLE_BASE_URL=http://127.0.0.1:8317/v1 \
FRAMEPILOT_OPENAI_COMPATIBLE_API_KEY=<the key from trial/config.yaml> \
FRAMEPILOT_OPENAI_COMPATIBLE_MODEL=claude-sonnet-4-6 \
pnpm --filter <app> dev
```

> **Do not use the Ollama provider for this.** An earlier version of this file said
> to, and it was correct until 2026-08-07: the hand-written `providers/ollama.ts` it
> named POSTed to `<baseUrl>/chat/completions` with a Bearer key. ADR 0105 deleted
> that adapter for LangChain's `ChatOllama`, which speaks Ollama's own protocol at
> `<baseUrl>/api/chat` and sends no key — so auth2api answers 404 and its HTML error
> page lands in the chat sidebar.

Because tool calls are native here, agent mode keeps its normal semantics —
**manual** saves each edit as a reviewable patch, **auto** applies it
immediately.

## Known limitations

- Unofficial: auth2api reverse-engineers the CLI wire protocol and sends
  cloaking headers that impersonate the Claude Code / Codex CLI version. Using a
  subscription this way may conflict with the provider's terms; that is a
  deliberate, accepted risk for a local trial and it is why this stays out of
  the workspace.
- The `cloaking.cli-version` values in `config.example.yaml` go stale. A
  "requires a newer version" 400 from upstream means bump them.
- The Cursor provider is explicitly experimental upstream; only Claude and Codex
  were exercised here.
