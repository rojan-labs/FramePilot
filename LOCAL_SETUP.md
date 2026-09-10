# LOCAL_SETUP.md — running FramePilot on this machine

This is the practical, desktop-first setup guide: what to install, what `pnpm dev`
actually starts, where the AI configuration really lives, which model to pick, how the
visual-understanding packs and transcription are wired, and the checks that prove every
agent tool is reachable. It complements `docs/guides/getting-started.md` (the generic
walkthrough) with what was verified on a real machine on 2026-09-09.

> Product focus is the **desktop app**. Everything below assumes the Electron path
> (`apps/desktop` + the sidecar it supervises). The browser build is a UI convenience.

---

## 1. Toolchain

| Tool        | Required           | Verified here                   | Notes                                                                 |
| ----------- | ------------------ | ------------------------------- | --------------------------------------------------------------------- |
| Node.js     | ≥ 22.15 (`.nvmrc`) | 24.13.0                         | `nvm use` picks the repo baseline; newer works.                       |
| pnpm        | 9.x                | 9.12.0                          | `corepack enable` gives you the pinned version.                       |
| Python      | 3.11 – 3.13        | 3.13.14                         | **Use 3.13.** The system 3.14 breaks the engine's native wheels.      |
| uv          | current            | 0.11                            | Runs every engine command (`uv run …`).                               |
| FFmpeg      | recent             | 8.1                             | `ffmpeg` + `ffprobe` on PATH for dev; packaged builds ship their own. |
| whisper-cli | for local ASR      | `/opt/homebrew/bin/whisper-cli` | `brew install whisper-cpp`. Model download happens from Settings.     |
| claude CLI  | for the free model | 2.1.x, logged in                | Only needed for the `claude-agent-sdk` provider (§4).                 |

```bash
node -v && pnpm -v && python3.13 --version && uv --version && ffmpeg -version | head -1
which whisper-cli claude
```

## 2. Install

```bash
pnpm install                    # JS/TS workspaces (pnpm-workspace.yaml)
pnpm engine:sync                # uv sync --extra dev in engine/python (creates .venv)
cp .env.example .env            # fill in only what you need (see §4)
```

If `uv` picks the wrong interpreter: `cd engine/python && uv python pin 3.13 && uv sync --extra dev`.

## 3. Run it

### `pnpm dev` (the desktop app)

`pnpm dev` is `turbo run dev` with the web-editor and website **excluded**, which means it
runs the desktop `dev` script plus `tsc --watch` for the packages. The desktop script does,
in order:

1. builds `shared-types`, `timeline-schema`, `editor-core`, `ai-sdk` (the desktop and the
   editor import these from their built `dist/` — an unbuilt or stale `dist` is the most
   common "my fix isn't there" cause);
2. bundles the Electron main process (`build:main`);
3. starts Vite for the editor on **http://localhost:5173** and launches Electron once it
   answers;
4. Electron spawns the Python sidecar from `.venv` on **127.0.0.1:8765** and supervises it.

Equivalent single-app command: `pnpm desktop:dev`.

### Ports

| Port  | What                                     | Started by                                       |
| ----- | ---------------------------------------- | ------------------------------------------------ |
| 5173  | Vite (editor renderer)                   | `pnpm dev`                                       |
| 8765  | Python sidecar (render, analysis, brain) | Electron (child process, restarted with the app) |
| 19789 | MCP server for external agents (`/mcp`)  | you, manually (§7) — the app does not start it   |
| 8799  | a second, manual sidecar                 | only for the golden harness / headless scripts   |
| 4321  | marketing website (`pnpm website:dev`)   | optional                                         |

Two sidecars are fine as long as the desktop talks to 8765 (`FRAMEPILOT_PYTHON_API_PORT`).
A sidecar you started by hand with `uv run framepilot serve` does **not** die with the app;
kill it yourself when you are done.

### Browser-only editor (no Electron)

```bash
pnpm --filter @framepilot/web-editor dev          # http://localhost:5173
cd engine/python && uv run framepilot serve       # sidecar on 8765, if you need analysis
```

No `fp-media://` protocol, no proxies, no durable runs, no capability packs. Use it for UI
work only.

## 4. AI configuration — where it really lives

On the desktop the source of truth is **Settings → AI**, persisted to

```
~/Library/Application Support/@framepilot/desktop/ai-config.json
```

`.env` is only the fallback for values Settings has not set (and the only source for the
browser build and headless scripts). Concretely: `FRAMEPILOT_AI_PROVIDER=deepseek` in `.env`
does nothing while `ai-config.json` says `activeProvider: openrouter`. When a run behaves
differently from what `.env` says, read `ai-config.json` first.

Keys you can put in either place (Settings wins): provider API keys and models,
`nvidiaEmbeddings` (visual embeddings), `twelveLabs` (hosted media understanding),
`asrProvider` / `asrApiKey` (transcription), `pexelsApiKey` (stock). Never commit `.env` or
`ai-config.json`.

### Which model to use

Measured on the captured run in `run.md` (9.5-minute GoPro take, agent mode,
`deepseek/deepseek-v4-flash-vision-exp` via OpenRouter):

| Metric            | Value                               |
| ----------------- | ----------------------------------- |
| Model calls       | 13                                  |
| Tokens            | 483,656                             |
| Cost              | $2.23 (session total $2.93)         |
| Thinking per turn | 50 – 120 s                          |
| Clips on timeline | 0 (run failed before the first cut) |

Prompt caching was not the problem here (about 25k of each call's ~30k input tokens came
back cached). The cost and the wall clock went to _reasoning_: roughly 160k of the 484k
tokens were input, the rest was the model thinking for one to two minutes per turn, and it
still misread a status line and asked a question it could have answered with a tool call.
The recommendation, in order:

1. **`claude-agent-sdk` + `claude-sonnet-5` — recommended, effectively free.** Desktop
   only. It spends your Claude subscription through the `claude` CLI login (already logged
   in on this machine) instead of an API account: no per-token bill, native tool calling,
   vision for `get_frame`, and prompt caching. Settings → AI → provider _Claude (login)_,
   model `claude-sonnet-5` (full id, never the alias `sonnet`). `.env` equivalent:
   ```bash
   FRAMEPILOT_AI_PROVIDER=claude-agent-sdk
   FRAMEPILOT_CLAUDE_AGENT_SDK_MODEL=claude-sonnet-5
   ```
   Use `claude-opus-5` only when Sonnet visibly misjudges a long, multi-part brief; on API
   billing it is materially more expensive per token and no faster.
2. **`anthropic` + `claude-sonnet-5` — if you want API billing.** Anthropic-direct is the
   only path where the golden runs measured 95–100 % prompt-cache hits, which is what makes a
   25-turn agent run cost cents instead of dollars. Add
   `FRAMEPILOT_TIER_SMALL_MODEL=claude-haiku-4-5` so the per-turn route classifier runs on
   Haiku.
3. **Avoid for agent runs:** OpenRouter (cache misses, variable tool-call quality),
   reasoning-heavy "flash/exp" models (the 50–120 s thinking above), and any model without
   vision if you want the AI to look at frames. They are fine for the _chat/question_ route.

`ai-config.json` on this machine also carries leftovers worth cleaning in Settings: `groq`
points at a Gemini model id and `ollama`/`openai-compatible` point at a local proxy on
`:8317`. They are harmless until selected.

## 5. Visual understanding (what the AI can "see")

Two independent arms; either makes `search_visual`, `describe_footage`, `map_footage` and
`index_media` real instead of "not indexed":

- **TwelveLabs (hosted).** Put the key in Settings → AI (`twelveLabs`). Indexing runs in the
  background after import; `map_footage` (chapters + highlights) took ~120 s on a 9.5-minute
  asset here. Check what the sidecar believes about a project:
  ```bash
  curl 'http://127.0.0.1:8765/brain/visual/status?projectId=<project id>'
  ```
  `indexedAssets`/`totalAssets` and `lastJob.state` are the truth. (`keyConfigured` used to
  read `false` for a Settings-keyed project and the model was told there was no index — fixed
  on 2026-09-09.)
- **Local Capability Packs (on-device).** Register once per machine; ~4.2 GiB of weights on
  first run:
  ```bash
  pnpm packs:register
  node -e "const d=require(process.env.HOME+'/Library/Application Support/@framepilot/desktop/capability-packs/index.json');d.records.forEach(r=>console.log(r.identity.id,r.state,r.health.status))"
  ```
  Expected: `tracking-lite`, `subject-intelligence`, `visual-embed`, `visual-describe`, all
  `installed healthy`. That is the state on this machine. The packs point at the worker
  `.venv` in this checkout — moving the repo means re-registering.

## 6. Transcription

Settings → AI → Transcription. Local default is `whisper-cli` with the
`large-v3-turbo-q5_0` model in `~/.framepilot/models/` (downloaded from Settings; `curl
http://127.0.0.1:8765/asr/status` shows `binaryAvailable` and `modelPresent`). Hosted
providers (Groq/NVIDIA) are selectable the same way and run from the desktop host, not the
sidecar.

Wind-only or music-only audio makes whisper hallucinate a looping phrase; the engine now
collapses a phrase repeated five or more times in a row, so a transcript no longer arrives as
2,400 words of the same sentence.

## 7. Stock, music, MCP

- **Stock footage/photos:** Pexels key in Settings (free). Only your search text leaves the
  machine.
- **Music:** Openverse, no key. Relevance is text-match only — "driving electronic" can return
  a "hard drive" noise sample; the AI should `add_music` + `detect_beats` before committing.
- **MCP server (drive the editor from Claude Code / Claude Desktop):** not started by the
  app. Build once, then run it while the app is open:
  ```bash
  pnpm --filter @framepilot/mcp-server build
  FRAMEPILOT_PROJECTS_ROOT="$HOME/Documents/FramePilot Projects" node packages/mcp-server/dist/bin.js
  ```
  It listens on `http://127.0.0.1:19789/mcp`; that URL is what the `framepilot` entry in your
  Claude Code MCP settings expects. "Unable to connect" from Claude Code means this process
  is not running. Full guide: `docs/guides/mcp-server.md`.

## 8. Prove the tools are reachable

With the app open and a project loaded:

```bash
curl -s http://127.0.0.1:8765/health                      # {"status":"ok"}
curl -s http://127.0.0.1:8765/asr/status                  # whisper binary + model present
curl -s 'http://127.0.0.1:8765/brain/visual/status?projectId=<id>'
curl -s http://127.0.0.1:8765/openapi.json | python3 -c "import json,sys;print(len(json.load(sys.stdin)['paths']),'routes')"
```

Inside a run the AI loads tool domains on demand (`load_tools`); the ten domains are
`captions, audio, color, motion, effects, footage, sourcing, tracking, media, professional`.
The captured run loaded eight of them in two calls and every tool it named resolved
(silence, scenes, footage map, markers, music search/download, transitions/effects catalogs,
add_track, add_clips, reframe). What failed was not tool reachability but the host commit
path and two status/timeout bugs — all listed in §10.

Agent playbooks (skills) are capped at **8 loaded per run**; the ninth `load_skill` is
refused with a note. Load the ones the brief needs, not all of them.

## 9. Tests, scoped

Do not run the full suites locally to check a change; run the files you touched and let CI
(on the PR) run the rest.

```bash
pnpm --filter @framepilot/ai-sdk exec vitest run src/<file>.test.ts
pnpm --filter @framepilot/desktop exec vitest run electron/<file>.test.ts
pnpm --filter @framepilot/desktop typecheck
cd engine/python && uv run pytest tests/<file>.py -q
pnpm engine:lint && pnpm engine:typecheck
```

`pnpm format:check` fails on `main` already (~90 pre-existing files); format only what you
touched. `pnpm verify` is the release gate and takes a long time.

## 10. Troubleshooting (all seen on 2026-09-09)

| Symptom                                                                                  | Cause / fix                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Track not found: V1. This timeline has no tracks." right after the AI added the track   | A repeat of a patch already in project history (after **Reset timeline**, undo, or a manual delete) was treated as already applied. Fixed: repeats re-apply unless they would change nothing. |
| `describe_footage` "timed out after 120s" on a TwelveLabs project                        | It walks the Pegasus chapter map, the same call class as `map_footage`; it now gets the same 15-minute budget.                                                                                |
| The AI says "no embeddings key configured, search returns nothing" on an indexed project | Status line read `keyConfigured` from the env var only. Fixed in the sidecar and in the status summary.                                                                                       |
| `analyze_silence` at `-40 dB` reports "stretches under -30 dB"                           | Response echoed the default floor. Fixed.                                                                                                                                                     |
| Transcript is one sentence repeated hundreds of times                                    | whisper loop on wind/music. Fixed by the repetition collapse; re-run `transcribe` on the asset.                                                                                               |
| Your code change is not in the running app                                               | Desktop/editor import `ai-sdk`, `editor-core`, `timeline-schema` from `dist/`. Restart `pnpm dev` (it rebuilds) or `pnpm --filter @framepilot/ai-sdk build`.                                  |
| Python changes not in effect                                                             | The sidecar is a child process; restart the app (or your manual `framepilot serve`).                                                                                                          |
| Two `python3` listeners on 8765 and 8799                                                 | Normal if you also ran a manual sidecar. The desktop uses 8765.                                                                                                                               |
| Runs are slow (a minute of "thinking" per turn) and cost dollars                         | Reasoning model through OpenRouter. Switch to §4 option 1.                                                                                                                                    |
| `pnpm` warns "workspaces field is not supported"                                         | Cosmetic; `pnpm-workspace.yaml` is the real workspace definition.                                                                                                                             |
| `framepilot` MCP server "Unable to connect"                                              | Start it (§7).                                                                                                                                                                                |

## 11. Where things live on disk

```
~/Documents/FramePilot Projects/                 projects root (FRAMEPILOT_PROJECTS_ROOT)
  <project id>.fp.json                           the project document (history included)
  media/<project id>/                            imported + downloaded media
~/Library/Application Support/@framepilot/desktop/
  ai-config.json                                 Settings → AI (keys, provider, model)
  capability-packs/index.json                    installed packs + health
  conversations/, orchestration/                 durable runs and chat history
~/.framepilot/models/                            whisper models
~/.framepilot/asr-cache/                         transcription cache
```
