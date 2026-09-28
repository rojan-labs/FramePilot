# Headless agent-run harness

`apps/desktop/scripts/agent-run.ts` sends one Agent-mode prompt through the same
main-process path the desktop app uses, then writes down what happened. Use it to iterate on
agent-loop fixes and to measure real runs with the real model and real tools, without
clicking through the app.

## Why it exists

Unit tests and the golden harness drive the orchestrator directly. The desktop app adds a
lot on top of that: durable run start, the `AiStreamHub` hooks, host auto-commit of each
proposed patch, the auto-accept memory write, the sidecar executor with the desktop's
stock/music/sticker/transcription hooks, the tracking and masking executors, the temporal
evidence acquirer, the footage map, the shot ledger, session memory and the carried-forward
ledger. A fix that looks right in a unit test can still behave differently in the app. This
harness runs the desktop's own modules (`apps/desktop/electron/**`) wherever they don't need
Electron, so a run here behaves like a run there.

## Run it

Build first, one package at a time. The harness imports the built `dist/`:

```sh
pnpm --filter @framepilot/shared-types build
pnpm --filter @framepilot/timeline-schema build
pnpm --filter @framepilot/editor-core build
pnpm --filter @framepilot/capability-packs build
pnpm --filter @framepilot/ai-sdk build
```

Then run it detached, so a concurrent vitest can't kill it:

```sh
TSX=$(ls -d node_modules/.pnpm/tsx@*/node_modules/tsx | tail -1)/dist/cli.mjs
nohup node "$TSX" apps/desktop/scripts/agent-run.ts \
  --project "$HOME/Documents/FramePilot Projects/<project>.fp.json" \
  --prompt-file brief.txt \
  --out /path/to/scratch/run-1 \
  --max-usd 26.5 --max-minutes 120 > run-1.out 2>&1 &
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--project` | required | Source project. It is only read. |
| `--prompt-file` | required | The exact text the editor would type. |
| `--out` | required | Output directory. It must not be inside the source projects root. |
| `--timeline` | `empty` | `empty` gives the baseline: a fresh project's timeline (`tracks: []`) and no history. Assets, folders, fps, resolution and `aiMemory` stay as they are. `keep` uses the project unchanged, which is what you want for a follow-up turn on a previous `final-project.fp.json`. |
| `--history` | none | Earlier turns for a follow-up: an `AiMessage[]` JSON file, or a saved `conversation.json` (projected the way the sidebar does it). |
| `--conversation-id` | new UUID | Reuse this when you chain turns. |
| `--max-usd` / `--max-minutes` | SDK defaults ($5 / 20 min) | Settings → AI → Run budget. |
| `--plan-first` | off | The composer's plan-first toggle. |
| `--provider` | `activeProvider` from `ai-config.json` | For example `mock` for a free plumbing check. |
| `--ask-policy` | `first-option` | How `ask_user` gets answered: `first-option`, `text:<answer>`, or anything else to send a fixed "decide yourself" sentence. |
| `--port` | `8812` | The harness starts its own sidecar on this port. |
| `--max-rss-gb` / `--max-swap-growth-gb` | `10` / `1.5` | Watchdog limits. Crossing either kills the whole process tree. |
| `--skip-memory-check` | off | Skips the refusal to start when less than 40% of memory is free. |

## Outputs (in `--out`)

- `events.jsonl`: every `AiEvent` as published to the renderer, including the `commit` stamp
  on each diff and transport truncation. It's the same stream the app stores.
- `conversation.json` and `run.md`: the conversation built the way `AiSidebar` builds it,
  exported with the app's own `toMarkdown`. Same format as the app's export.
- `final-project.fp.json`: the working project after every committed patch.
- `summary.json`: final status and settlement, wall time, model calls and tokens, tool calls
  by name and status, each diff with its operation types and commit verdict, steps
  (committed patches), operations applied, notices, errors, asks, the last two assistant
  messages, and peak process-tree RSS.
- `harness.log`, `sidecar.log`, `projects/` (the scratch projects root), and `state/` (run
  WAL, revisions, stock quota, empty pack store).

## What differs from the app, and why

The header of the script lists every substitution. In short:

1. **Fetch.** Node's `fetch` stands in for `electronFetch`.
2. **Where state is written.** Writes that would go to `userData` land in `<out>/state/`.
   `ai-config.json` is read in place, read-only. The stock-quota file is copied in.
3. **Projects root.** It is `<out>/projects/`. The media folder, the project's brain dir and
   the proxy/thumbnail dirs its assets reference are **APFS-cloned**, not symlinked. The
   engine's `resolve_within` resolves symlinks with realpath, so a symlink that points out
   of the sandbox is refused as path traversal. Clones cost no disk space and are
   independent of the source files. Nothing is ever written under the source projects root.
4. **Sidecar.** The harness starts its own `uv run framepilot serve`, spawned the way
   `sidecar/spawn.ts` does it in dev.
5. **Capability packs.** The real `CapabilityPackDesktopService` runs over an **empty**
   store. Tracking, masking and `detect_subjects` return exactly what the app returns when
   no pack is installed. No visual-pack handles are sent.
6. **Renderer.** The harness sends what the renderer sends: the project snapshot, the
   interaction context at playhead 0 with no selection, empty user memory, the agent
   options, and the active provider. It appends events the way the sidebar does. The usage
   chip and the "no edits" notice come from sidebar settings and are not reproduced.
7. **Host side effects.** The file watcher, recovery snapshot, active-project pointer,
   `projectChanged` push, telemetry and license gate are dropped. The active project is
   fixed to the scratch copy.
8. **`ask_user`.** Questions are answered through the same durable `answer` command the
   renderer sends, following `--ask-policy`. `summary.json` lists every ask.
9. **Session warm-up.** The warm-up the app runs when a project opens is awaited before the
   prompt is sent.
10. **Claude Code session variables.** `CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_PID` and
    `CLAUDE_EFFORT` are removed from the environment. This keeps them from leaking into
    the `claude-agent-sdk` provider's `claude` child when you launch the harness from a
    Claude Code session.

## Traps

- The harness runs whatever `packages/*/dist` holds. Rebuild after editing SDK source, and
  record `git rev-parse HEAD` plus any uncommitted files the build included.
- An exported `FRAMEPILOT_AI_PROVIDER=mock` does **not** change the provider. The harness
  uses `ai-config.json`'s `activeProvider`, the same as the app, unless you pass `--provider`.
- Debug logging from the repo `.env` makes `run.out` large. `harness.log` is the short
  progress log.
- On a 16 GB machine, run one heavy job at a time. Don't run e2e, Playwright or a website
  build next to it.
