# TRACKING.md — 1.0 Readiness Loop

**Session:** 2026-09-13 · main @ `5f4b4da1` · Opus 5
**Goal:** run FramePilot end to end, confirm capability packs, audit the edits the agent
made in the real projects under `~/Documents/FramePilot Projects`, then loop find→fix
until the app is release-ready for 1.0 — aggressively better at editing, faster, more precise.

**Rule for this file:** every claim carries the command that produced it. A hypothesis that
turned out wrong stays in, marked `DISPROVED`, so nobody re-chases it.

---

## Legend

| Mark | Meaning |
|------|---------|
| ✅ | Verified with evidence in-session |
| ❌ | Confirmed defect, not yet fixed |
| 🔧 | Fixed in this session |
| ⚠️ | Risk / accepted for 1.0 with a note |
| ❓ | Open, not yet measured |
| 🚫 | DISPROVED — hypothesis chased and closed |

---

## A. Environment & runtime truth

| # | Item | State | Evidence |
|---|------|-------|----------|
| A1 | Desktop runtime config source | ✅ `~/Library/Application Support/@framepilot/desktop/ai-config.json` is the truth, **not** `.env` | read both; they disagree (below) |
| A2 | Active provider | ✅ `claude-agent-sdk`, model `claude-opus-5` | `ai-config.json` |
| A3 | `.env` disagrees with runtime | ⚠️ `.env` says `FRAMEPILOT_AI_PROVIDER=deepseek`, `ANTHROPIC_MODEL=claude-opus-4-8` (stale id). Harmless today because desktop ignores `.env` for provider choice — but it is a live foot-gun for anyone debugging from `.env`. | `grep FRAMEPILOT_AI_PROVIDER .env` |
| A4 | User asked for **sonnet-5**; config runs **opus-5** | ❓ decide before any measured run — model choice changes both cost and the editing quality being judged | `ai-config.json` |
| A5 | `framepilot` MCP server | ❌ fails to connect (ConnectionRefused) this session | session startup notice |

## B. Capability packs — **all connected and healthy** ✅

Ran the real worker health-check protocol (`--framepilot-health-check` with the
`FRAMEPILOT_CAPABILITY_PACK_*` env contract from `packages/capability-packs/src/node/worker-health.ts`).

| Pack | v | Health | Backend |
|------|---|--------|---------|
| `framepilot.tracking-lite` | 1.0.0 | ✅ exit 0 | `opencv-5.0.0-cpu` — tracking.planar/point/region |
| `framepilot.subject-intelligence` | 1.0.0 | ✅ exit 0 | `opencv-dnn-5.0.0` (YuNet + PPHumanSeg) — subject.detect/segment |
| `framepilot.visual-embed` | 1.0.0 | ✅ exit 0 | `onnxruntime-CoreMLExecutionProvider` (SFace) — visual.embed/text |
| `framepilot.visual-describe` | 1.0.0 | ✅ exit 0 | `llama.cpp/smolvlm2-2.2b` — visual.describe |

**B1 ⚠️ Packaging risk for 1.0 (real):** every pack entrypoint's shebang points *outside*
the pack, into the repo working tree:
`#!/Users/rjach/Stuffs/FramePilot/workers/tracking-lite/.venv/bin/python3`.
These are `register-local` dev registrations. They work on this machine only; moving or
deleting the repo breaks all four packs, and a shipped 1.0 pack must be self-contained.
Not a bug in the app — a release-blocking property of how these particular packs were installed.

**B2 — my own false alarm, recorded so it is not repeated:** an initial sweep reported all
four entrypoints exiting `127`. That was **my test harness**, not the packs: macOS has no
`timeout(1)`, so `127` was `timeout: command not found`. The packs were healthy all along.

## C. Timeline engine integrity — **clean** ✅

Built a final-state auditor calling the engine's own `clipTimelineDuration()` from
`packages/editor-core/dist/speed-curve.js`, plus overlap / source-overrun / frame-grid /
ramp-bounds checks. Ran it over **all six** real projects.

| Project | Errors | Warnings |
|---------|--------|----------|
| `project_editing_test_mtl8rrmietle` | 0 | 0 |
| `project_new_app_mtt1sp9ru285` | 0 | 9 (gaps, caption/graphics tracks) |
| `project_raw_mttqrhhzjy9w` (**the target**) | **0** | **0** |
| `project_talking_head_mtsc142j5rak` | 0 | 0 |
| `project_talking_ne_mtfnjwek2zac` | 0 | 23 (gaps, caption track) |
| `project_test_new_raw_mtr2vsanbiun` | 0 | 1 (gap, overlay track) |

Zero structural errors anywhere. The warnings are all **gaps on caption/graphics/overlay
tracks**, which are expected (speech has pauses; overlays are intermittent) — not defects.

Auditor kept at `scratchpad/audit.mjs`; worth promoting to a repo script (see F1).

## D. The target project — what the agent actually built

`project_raw_mttqrhhzjy9w.fp.json` · schema v21 · 1080×1920 @ 30fps · revision 130 · 27 history entries.
Source: one 575.9s GoPro take (`raw_skating.mp4`) → a **60.87s vertical cut**, 20 clips on `v1`,
music bed, one title, 2 Pexels stock cutaways.

**Quality findings — the agent's editing is good:**

| # | Check | Verdict |
|---|-------|---------|
| D1 | 9:16 crop math from a 16:9 source | ✅ **exact**: `width=0.316406` = (9/16)÷(16/9) = 81/256, `x=0.341797` = perfectly centred |
| D2 | Stock clips left uncropped | ✅ **correct** — both Pexels assets are natively 1080×1920; cropping them would have been the bug |
| D3 | Clip coverage | ✅ zero gaps, zero overlaps across all 3 tracks; music bed ends exactly at 60.87s with the picture |
| D4 | Source ranges | ✅ none exceed the 575.85s asset; none negative |
| D5 | Shot pacing | ✅ 0.90s–4.80s, mean ~3.0s — varied, not a metronome grid |
| D6 | Cut rationale | ✅ patches carry real prose (scene index, salience, onset-aligned boundaries) |

**D7 🚫 DISPROVED — "a clip plays 3.32s of source in a 3.03s slot with no speed declared."**
Real: `clip__v1_asset_raw_skating_55217` carries a 3-point `speedRamp` (1.8x → 0.35x → 1.6x,
a ramped whip into slow-mo). `clipTimelineDuration()` integrates the curve to exactly the
slot duration. My first dump printed only `effects[].type` and so missed `speedRamp`,
which is a sibling field. **The engine is right; the dump was wrong.**

**D8 🚫 DISPROVED — "the agent thrashes: builds a montage then tears it down, three times."**
History entries 2, 12–15, 21–23 are **user** actions, not agent ones: they have no
`groupId`, and their `reason` is a generic UI label (`Reset timeline`, `Delete 13 clip(s)`,
`Reset AI memory`, `Remove asset … from bin`). Every AI patch carries a `groupId` **and**
prose reasoning (entries 3, 4, 16, 20, 24, 25, 26). The user reset twice and asked for a
rebuild; the agent did not undo its own work.

**D9 🚫 DISPROVED — "7 consecutive `adjust_audio` entries = a volume drag not coalesced into one undo step."**
The seven entries are *distinct* control changes ~3s apart — gain −24→−10, then duck-under
`A1`, then normalize, then mute on, mute off, gain −15. Separate deliberate toggles, so
separate undo steps are correct behaviour.

**D10 ❓ AI memory is not learning.** `aiMemory.acceptedEdits` and `rejectedEdits` are both
**empty** after 27 history entries and three full builds; only `preferredPacing` and one
`provenance` entry are set. If the Memory Store (PRD §8.7) is meant to accumulate
accept/reject signal, it is inert here. Needs confirming against `packages/ai-sdk` before
being called a defect — it may simply require explicit user accept/reject gestures.

**D11 ❓ `v1` (the camera A-roll track) has `role: "sfx"`,** and every camera clip carries
`audio_gain −24dB`. Plausibly deliberate for a music-led montage, but `sfx` on the primary
picture track is the kind of mislabel that silently changes the mix (see the
video-track-mix-roles rule). Verify against the render before judging.

---

## E. Not yet done

| # | Item | State |
|---|------|-------|
| E1 | Run the app end to end (desktop + sidecar) | ✅ **done** — see §G |
| E2 | Render the target project and inspect the output | 🔄 in flight — see §H |
| E3 | Editing speed / latency measurement | ❓ |
| E4 | Decide sonnet-5 vs opus-5 (A4) | ❓ |

## F. Candidate improvements

| # | Idea | Why |
|---|------|-----|
| F1 | Promote `audit.mjs` to `scripts/audit-project.mjs` | A project-file linter that found 0 errors on 6 real projects is a cheap permanent regression net, and it reuses the engine's own arithmetic rather than reimplementing it |
| F2 | Reconcile `.env` provider keys with `ai-config.json` (A3) | One source of truth; `.env` currently names a stale model id |
| F3 | Ship self-contained packs (B1) | 1.0 blocker for anyone who is not this machine |


---

## G. End-to-end run — the app boots ✅

`pnpm desktop:dev` from a cold start:

| Stage | Result |
|-------|--------|
| Workspace package builds (shared-types → timeline-schema → editor-core → ai-sdk) | ✅ |
| Autonomous tool contract codegen | ✅ mirrored 22 capabilities at v2 |
| Vite dev server | ✅ ready in **257 ms** on :5173 |
| Electron main | ✅ started |
| Project revisions restored | ✅ 32 |
| Sidecar spawn (`dev-uv`, pid tracked in the process registry) | ✅ `phase: ready` in **2.7 s** |
| Sidecar health | ✅ `GET /health → 200 (4 ms)` on :8765 |

The full desktop path — renderer, main, sidecar, process registry, orphan sweep — comes up
clean with no errors. `FRAMEPILOT_PROJECTS_ROOT` is passed correctly to the spawned sidecar.

**G1 🔧 FIXED — the startup log lied about the AI provider.**

`apps/desktop/electron/main.ts:3505` logged:

```ts
aiProvider: process.env.FRAMEPILOT_AI_PROVIDER ?? 'mock',
```

`FRAMEPILOT_AI_PROVIDER` is not set in the packaged app or under `desktop:dev`, so **every
desktop launch announced `aiProvider: 'mock'`** — while the app went on to use
`claude-agent-sdk`, the provider persisted in `ai-config.json`. The comment at
`main.ts:1808` is explicit that the config file wins and env is only the fallback, so the
one log line whose job is to say what the AI layer is doing was the one line guaranteed to
be wrong.

Not a functional bug — the app was never in mock mode — but a costly one: it is the first
thing anyone reads when the AI "isn't working", and it sends them to debug a mock provider
that isn't in play. It cost me a detour in this very session.

Fixed to report the provider the launch will actually use:

```ts
aiProvider: new AiConfigStore(
  path.join(app.getPath('userData'), 'ai-config.json'),
).activeProvider(),
```

`AiConfigStore`'s constructor only stores a path (reads are lazy), so this is side-effect
free at `whenReady` time. **`pnpm --filter @framepilot/desktop typecheck` passes.**

**G2 ⚠️ Two sidecars, two sandbox roots — a real trap.** A sidecar was already listening on
**:8799** sandboxed to `tests/fixtures/mission/projects` (started for the golden harness).
The desktop spawns its own on **:8765** rooted at the real projects dir. Rendering a user
project through :8799 fails with `Path escapes sandbox`. Correct security behaviour — the
sandbox did its job — but the error names the base path, not the fact that *this process
was started for something else*, so it reads as "the app can't open my project".

## H. Render pipeline

First attempt produced **no output and no error** after 10+ minutes, then the process was
gone. Re-ran detached with `PYTHONUNBUFFERED=1`; the pipeline then logged immediately:

```
ACT encode: 1080x1920@30 h264_videotoolbox (hardware) -movflags +faststart
           -allow_sw 1 bitrate=8000 audio=192 → audit_raw_1080x1920.mp4
```

✅ Hardware encode (VideoToolbox) is being selected, which is the right call on this machine.

**H1 ❓ The CLI render is silent while it works.** No progress output at all between start
and finish on a multi-minute job. For a 1.0 CLI that is a usability gap — indistinguishable
from a hang, which is exactly how I first read it. Needs confirming whether the desktop
render path surfaces progress (it has `/render/jobs/{job_id}`) before calling this a defect
of the product rather than of the CLI.

**H2 ❓ Throughput.** The render is genuinely CPU-bound — 100% CPU with 10+ child
processes (per-clip ffmpeg work) — not hung. Elapsed time for the 61s vertical output is
being measured; result pending. A first attempt died when its foreground tool call timed
out, which is a harness artefact, not an engine fault.

---

## I. Fixes landed this session

Branch **`fix/release-1.0-audit-2026-09-13`** (worktree `../FramePilot-release-audit`),
pushed. The main checkout stays on `main`, per this repo's worktree rule.

| Commit | Fix | Verification |
|--------|-----|--------------|
| `2fb8b200` | **G1** — desktop startup log reports the real active provider instead of the unset env var | `pnpm --filter @framepilot/desktop typecheck` ✅ |
| `2fb8b200` | **F1** — `scripts/audit-project.mjs` promoted to a repo script (portable path, actionable "build it first" error, multi-file, exits non-zero only on errors) | run over all 6 real projects: 0 errors, exit 0 ✅ |
| `8f9541dc` | **J1** — successful `/health` probes drop to DEBUG so the request log stops being 2000 heartbeat lines an idle hour; failing probes stay at INFO | `tests/test_service.py` **107 passed**, ruff ✅, mypy ✅ |

### J1 detail — the health heartbeat was burying the request log

The desktop polls `/health` every 5s for as long as it is open, and the request middleware
logged every call at INFO. With uvicorn's own access line that is **three lines every five
seconds** — the render/analyze/transcribe calls the log exists to show are buried in
heartbeats, and an engine log attached to a bug report is mostly noise.

A passing probe now logs at DEBUG; a **non-200 probe still logs at INFO**, because "health
started returning 503" is the one thing worth reading that log for.

Two tests lock both halves. The failing-probe test replaces the real `/health` route rather
than adding a second one — FastAPI matches the *first* route registered for a path, so an
added route never runs and the test would have passed for the wrong reason. It did, until
I checked.

---

## K. Loop status — what I'd do next, in priority order

1. **Finish the render measurement (H2)** and, if 61s of output really costs minutes,
   profile where: per-clip ffmpeg spawn, the grade chain, or the ramp resampling.
2. **Render progress reporting (H1)** — the CLI is silent for the whole job.
3. **Self-contained capability packs (B1)** — the one item I'd call a genuine 1.0 blocker,
   because the current packs only work on this machine.
4. **Confirm D10** (AI memory never accumulating accept/reject) against `packages/ai-sdk`.
5. **Reconcile `.env` with `ai-config.json` (A3/F2)** — stale `claude-opus-4-8`, and a
   `FRAMEPILOT_AI_PROVIDER=deepseek` that no longer matches anything the app does.
