# TRACKING.md — 1.0 Readiness Loop

**Session:** started 2026-09-13 from main @ `5f4b4da1` · Opus 5 · **last updated 2026-09-14**
**Branches:** the audit landed as **PR #117** (`fix/release-1.0-audit-2026-09-13`, merged). The
close-out of every item it left open is `fix/tracking-closeout-2026-09-14` (worktree
`../FramePilot-closeout`) — see §T.
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

## Status at a glance — the current truth

Sections A–S below are the chronological log. Where a later section changed an earlier verdict,
the earlier heading now points forward; **this table is what holds today**.

### Fixed on this branch

| ID | What was wrong | Commit(s) |
|---|---|---|
| G1 | the desktop startup log reported the wrong AI provider | `2fb8b200` |
| F1 | project-file auditor promoted to `scripts/audit-project.mjs` | `2fb8b200` |
| J1 | successful `/health` probes buried the request log | `8f9541dc` |
| L4 | trimming a speed-ramped clip was refused | `c79889a9` |
| M1 · E2 · H2 | the render was ~10⁶× slow on ramped audio — a 61 s export now takes 77.7 s | `84ff4719` |
| L1 · N2 | 14% of perceptual reviews failed — the same ramp bug | `84ff4719` |
| M2 · N1 | non-Anthropic runs were priced at invented Anthropic rates | `2023d700` |
| Q2 | an unpriced run was reported as a real $0 | `ab4ecae8` |
| M5 | each call was priced by its tier label, not by the model that served it | `d59cc710` |
| M4 | the `usage` event had no prompt-cache read/write split | `22ec3d84` |
| N4 | restating a marker threw away the whole patch | `7ea55250` |
| O1 | a title that overran the frame was refused instead of fitted | `54509997` |
| O3 | `normalize_exposure`'s refusal did not name the clips to measure | `b2c4fe04` |
| H1 | the CLI render printed no progress | `a1c4772e` |
| R1 | the visual-embed/describe packs never ran on desktop; search used the wrong vector space | `c8a5aa20` `b7cb08dd` `0dccf35f` |
| R2 | the local describer returned its own prompt as every field | `0408680b` |
| S1 | `/analyze` on video-only media, `index_media` over-claiming, no `no_api_key` guidance, transcript time base | `a1c4772e` `14414c1e` |
| S2 | hosted agent transcription wiped other assets' transcripts; local-whisper setup and cache; silent/missing media | `ca3e10e4` `2402a8cf` `a1c4772e` |
| S3 | tracking: the mask never moved, Follow silhouette failed, segment overflow, fps window, point-track size, timing, speed | `f494917e` `0374ec43` `b98a7d0b` `ba8a4baf` `dc453d8a` `29092bfb` |
| S3 · preview | masks and tracked motion were not drawn in either preview player | `eb9c5f5c` |
| S5.1 | the browser build offered desktop-only tracking tools | `b67388c9` |
| Q4b · transitions | a zero-op `add_transitions` gave no reason, so the run retried and ended with no text | `ca3e10e4` |
| Q5 | the agent could not tell a repeated take from a different moment; the eval scored a precondition | `7c33bc7a` `39596077` |
| B1 · O4 · P1–P4 | no pack could be installed from a catalog (5 blockers); pack CI and release pipeline | `4b412900` `f9019e66` `8a249d5d` `254b69c4` `9f341daf` `a0f5409c` `d1f5aa12` `051b8a37` |
| P2 | two packs exceeded their size caps — **decided: caps raised** (2000 / 3000 MiB) | `9e75fd8b` |
| CI | an unused `type: ignore` failed CI mypy | `57d157ef` |

### Closed on `fix/tracking-closeout-2026-09-14` (§T)

| ID | Resolution | Commit(s) |
|---|---|---|
| D10 | **decided: record it, labelled.** Desktop auto-commit records `accepted` with `origin: auto_applied`; any undo of an AI patch (Cmd+Z, menu, History panel, "Undo run") records `rejected` once | `3c28696d` `fda36e2d` |
| L5 | **no schema change needed.** The synthetic point's *rate* is solved so each piece conserves area; the seam stays exact; a same-segment double cut is solved jointly | `3de8a146` `3fee9eab` |
| Q4b | **decided: label the fixture with real measurements.** `mission-montage` indexed by the installed visual-embed pack; the rubric now needs a confirmed setting change, never asset identity | `8710d4f1` `4c8a1e47` `7787e6af` |
| P4 | everything that needs no credential: visual-pack SBOM generators + PR drift check, weight caching, Windows release leg, CDN publish + catalog merge (tested, secret-gated) | `257f002c` `a1ac5101` `df05d461` |
| S2 · S5 | packaged sidecar accepts only `FRAMEPILOT_WHISPER_CLI`, never PATH; the refusal names the pack and hosted providers | `d03c9019` |
| R4 | invented `onScreenText` dropped; per-request double hashing removed (3.10 s → 1.38 s) and multi-keyframe `--image` bug fixed; lease held for an engine-started run; `find_similar`'s reindex no longer erases captions (ADR 0064 honoured) | `87c3ac5d` `c0a04dd2` `2efc6ee3` `319d1f0c` |
| S3 residual | mask **and** tracker replace in place; `output_too_large` protocol code; VFR sampled by real timestamp, with a seek that cannot overshoot | `3de8a146` `3fee9eab` `7de5cc37` `07646099` `e9a4395c` `d76a661b` |
| S5 | wrong-kind skip names only assets a probe **verified** would work | `34a96ae4` `46263240` |
| A4 · E4 | **decided: `claude-sonnet-5`** is the Claude-login default (desktop config switched too; backup kept) | `0610d627` |
| E3 | measured over 417 conversations — model round trips are 91% of a turn; the lever is call count | `abad60d8` |
| D11 | **not a defect**: `Track.role` never reaches the mixer; measured on a real render; pinned by a test | `c545f941` |
| G2 | the refusal names this engine's projects root and says another sidecar may be answering | `1ef47ee6` |
| A5 | **not a defect**: the MCP server on :19789 is started by hand (`LOCAL_SETUP.md` §7); the app never starts it | — |
| A3 | **not stale**: `claude-opus-4-8` is a catalog model id. `.env` left as the user's own (an edit was declined) | — |

### Still open — needs a credential, a dashboard, or new infrastructure

| ID | Item | Waiting on |
|---|---|---|
| P4 | signing, notarization, Authenticode, catalog signing, CDN upload | **credentials** — checklist in `docs/api/capability-packs.md`; then a first real signed run |
| P4 · win32 | the Windows leg has never run; no `win32-x64` SBOM exists; the host has no Authenticode trust verifier | a `windows-latest` CI run, then the verifier |
| S2 | the local-whisper pack installs only once a signed catalog exists | P4 |
| R4 | tier 2 still reloads the model per request (5–40 s cold) | a resident model needs a bundled `llama-server` |
| security | the NVIDIA-embeddings and TwelveLabs keys were printed into tool output — **again on 2026-09-14** by a redaction filter that matched only fields named `*key*` | **rotate both keys** |
| CI | the Vercel check is "Deployment was blocked" on every PR while `main` deploys | Vercel dashboard: the PR commit author email is not recognised by the project |

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
**→ Superseded:** the real gap and its fix are in §O4 and §P4.

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
| E2 | Render the target project and inspect the output | ✅ **done** — 77.7 s export, all 11 `validate-render` checks pass (§M1) |
| E3 | Editing speed / latency measurement | ❓ |
| E4 | Decide sonnet-5 vs opus-5 (A4) | ❓ |

## F. Candidate improvements

| # | Idea | Why |
|---|------|-----|
| F1 🔧 `2fb8b200` | Promote `audit.mjs` to `scripts/audit-project.mjs` | A project-file linter that found 0 errors on 6 real projects is a cheap permanent regression net, and it reuses the engine's own arithmetic rather than reimplementing it |
| F2 | Reconcile `.env` provider keys with `ai-config.json` (A3) | One source of truth; `.env` currently names a stale model id |
| F3 🔧 §P4 | Ship self-contained packs (B1) | 1.0 blocker for anyone who is not this machine |


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

**H1 🔧 (fixed `a1c4772e`, §S4) The CLI render is silent while it works.** No progress output at all between start
and finish on a multi-minute job. For a 1.0 CLI that is a usability gap — indistinguishable
from a hang, which is exactly how I first read it. Needs confirming whether the desktop
render path surfaces progress (it has `/render/jobs/{job_id}`) before calling this a defect
of the product rather than of the CLI.

**H2 ✅ (measured in §M1 — 77.7 s once the ramp fix landed) Throughput.** The render is genuinely CPU-bound — 100% CPU with 10+ child
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

> **Update 2026-09-14:** items 1–3 are done (§M1, `a1c4772e`, §P4). Item 4 is root-caused and
> waits on a maintainer decision (§S4). Item 5 is deliberately untouched (A3). See "Status at a
> glance" for everything that remains.

1. **Finish the render measurement (H2)** and, if 61s of output really costs minutes,
   profile where: per-clip ffmpeg spawn, the grade chain, or the ramp resampling.
2. **Render progress reporting (H1)** — the CLI is silent for the whole job.
3. **Self-contained capability packs (B1)** — the one item I'd call a genuine 1.0 blocker,
   because the current packs only work on this machine.
4. **Confirm D10** (AI memory never accumulating accept/reject) against `packages/ai-sdk`.
5. **Reconcile `.env` with `ai-config.json` (A3/F2)** — stale `claude-opus-4-8`, and a
   `FRAMEPILOT_AI_PROVIDER=deepseek` that no longer matches anything the app does.

---

## L. Run-transcript mining (418 conversations)

Source: `~/Library/Application Support/@framepilot/desktop/conversations/`.
417 have events; **226 actually edited a timeline** (191 are chat-only).

### L1 — Perceptual review fails on 14% of the runs that attempt it

| | |
|---|---|
| Runs that edited the timeline | 226 |
| Of those, a review was attempted | 153 |
| **Review failed** | **22 (14%)** |
| Review succeeded | 131 |

Breakdown: 8 cancelled · 7 other · 5 timed out · 5 came back *after the run ended*.
The timeouts are large and real — `307500ms for 5 requests`, `323500ms for 32 requests`.
The user-facing sentence is honest ("Your edits are applied and validated, but were not
perceptually checked"), but the accuracy guarantee is the thing silently skipped, and
the engine's own message blames queueing: *"The engine serializes one batch at a time."*

Not fixed here — it needs the temporal-evidence path profiled, which is its own piece of work.
**→ Later fixed:** it was the same bug as the slow render (§N2, `84ff4719`).

### L2 — Why edits don't land, by operation (all-time, with last-seen)

| op | n | last seen | still live? |
|----|---|-----------|-------------|
| `add_text_layer` | 9 | 2026-09-09 | **FIXED, see O1** — text that doesn't fit the frame |
| `add_clip` | 8 | 2026-09-08 | yes — unknown asset id |
| `add_marker` | 6 | 2026-09-09 | **FIXED, see N4** — duplicate marker id |
| `delete_clip` | 6 | 2026-08-28 | no |
| `caption_the_edit` | 5 | 2026-09-04 | **closed, see L3** |
| `normalize_exposure` | 3 | 2026-09-12 | **refusal now names the clips, see O3** — called before anything is measured |
| `set_clip_speed_ramp` | 3 | 2026-09-12 | yes |
| `add_clips` | 3 | 2026-09-06 | yes — duplicate shot over the same moment |
| `trim_clip` | 2 | 2026-09-12 | **FIXED, see L4** |
| `add_transition` | 1 | 2026-09-12 | yes — "continuity" is a hard cut by policy |
| `add_music` | 1 | 2026-09-04 | yes — one bad param fanned into **3129** rejections |

### L3 🚫 `caption_the_edit` emitting 584 invalid cues — already fixed, not a live bug

One run (2026-08-30 16:03) produced **584** rejected ops, all
`add_caption_layer.end must be greater than start`. That is the same day commit
`e4dc3e90` — *"stop the run clamp squeezing a cue out of existence at a cut"* — landed the
fix in `captions/derive.ts`, which now absorbs a squeezed cue into the previous one of the
same run. One occurrence, never since. Closed.

### L4 🔧 FIXED — trimming a speed-ramped clip did not work

The freshest run (09-12, opus-5) failed three ops, **all on the same ramped clip**. The
`trim_clip` one is a genuine arithmetic defect, reproduced from the real project file:

```
TRIM 55.233→56.967   tl=1.733333  impliedByRamp=1.663106   DRIFT=7.0e-2  *** REJECTED ***
TRIM 55.233→57.500   tl=2.266667  impliedByRamp=2.266667   ok
TRIM 56.000→58.267   tl=2.266667  impliedByRamp=2.254589   DRIFT=1.2e-2  *** REJECTED ***
```

**Cause.** The trim solves the new source window against the clip's *current* curve, then
`rebaseSpeedRamp` replaces that curve — points outside the new source range must go, and
the curve closes with a synthetic endpoint at the rate at the cut. The rebased point moved
from `1.4@1.6` to `1.245@1.36`: an `ease-in-out` segment restricted to part of its span is
**not** another `ease-in-out` between the endpoint values, because the easing re-runs its
whole S over the shorter interval and sweeps a different area. 70ms ≈ 2 frames at 30fps,
and `speed_duration_mismatch` refuses the patch. **Trimming a ramped clip failed whenever
the cut landed past a control point.**

**Fix** (`c79889a9`). The schema cannot express "half of an ease", so the curve cannot be
preserved. The editor's *intent* can: invert the **composed** function — pick the source
window whose own rebased curve integrates to the requested duration. Monotonic, so the
same bisection works; where nothing is clipped the rebase is the identity and the result
is unchanged. A head trim gets the mirror solve, since its tail is pinned.

All three cases now land exactly. **1187 editor-core tests pass**, typecheck and eslint clean.

**L5 ⚠️ A conflict I deliberately did not resolve.** `split_clip` and `delete_range` share
`truncateClip` but must partition the source *exactly* — one piece's `sourceEnd` is the
next's `sourceStart`. The solve moves that seam by ~1e-6s and broke a split test. For a
ramped clip those two invariants genuinely conflict, because rebasing changes each half's
area. Resolving it properly needs a schema that can express a partial ease, which is a
schema change and therefore a maintainer decision. The fix is scoped to `trim_clip` via an
explicit flag; split and delete_range keep their exact partition and their existing drift.

**L6 🔧 Cost (see M5 and N1 — the reported $5.04 was itself mispriced).** The 09-12 opus-5 run: **1.81M tokens, $5.04, 38 model calls** for one
conversation. Worth a budget look before 1.0.

---

# M. Performance / cost / token / context sweep

## M1 🔧 FIXED — the render was ~1,000,000× slower than it needed to be

Exporting the target project ran **35+ minutes at 100% CPU and never wrote a file**. It was
not hung, and it was not the encoder — VideoToolbox hardware encode was selected correctly.

Sampling the process showed `PyArray_FromIter` → `gen_iternext`: numpy pulling a Python
generator one element at a time. The generator was in `render/compiler.py#ramped_time_map`.

**Cause.** MoviePy hands the picture a scalar `t`, but hands **audio the whole array of
sample times**. The map went through `source_time_at` per element — and that inverts the
speed curve by *bisection*: `INVERSION_STEPS` passes, each re-normalising the ramp and
Simpson-integrating every segment. Picture asks 30×/second and never noticed. **Audio asks
44,100×/second**, so one 3.3s ramped clip is ~8 million integrations.

**Fix** (`84ff4719`). The curve is strictly increasing — which is exactly why it is
invertible — so invert it *once* into a monotonic table and apply it to the whole array
with `np.interp` in C. Built lazily; `np.interp` clamps at both ends, which is the
saturation `source_time_at` already had.

| | before | after |
|---|---|---|
| map 44,100 samples (1s of audio) | **~1090 s** | **0.00095 s** |
| speedup | | **1,152,740×** |
| **full 61s export** | **35+ min, no file** | **77.7 s** |
| accuracy vs exact bisection | — | max err **6.7e-07 s** = 0.032 of *one* sample @48kHz, monotonic |

The 77.7s export passes **all 11 `validate-render` checks**: duration 60.867s exact,
1080×1920@30, no black frames, no black tail, audio −3.1 dBFS (no clipping), no silent tail.
So the agent's edit is also confirmed correct end to end, through a real render.

Tests: 173 passed (ramp/speed/compiler/retime) + 26 passed (render parity, frame grab,
cross-runtime) · ruff clean · mypy clean.

The TypeScript mirror was checked for the same hazard — `sourceTimeAt` has only scalar
call sites there, so the preview path is unaffected.

## M2 🔧 COST — the dollar figure is fabricated for every non-Anthropic provider (fixed in §N1, `2023d700`)

**This is not theoretical. A real run was killed by it:**

```
09-04  inclusionai/ling-3.0-flash
"Reached this run's $26.50 budget after 153 steps ($26.61 spent) — stopping"
```

`$26.61` is **Anthropic list pricing applied to a cheap third-party flash model**.

The chain:
- `cost-meter.ts#estimateUsd` prices by `ModelTier`, from `DEFAULT_TIER_PRICING`
  (`small $1/$5`, `mid $3/$15`, `large $15/$75` per MTok) — Anthropic list rates.
- Nothing anywhere passes the `prices` override. Verified: the only references to
  `DEFAULT_TIER_PRICING` outside `cost-meter.ts` are in `baseline-capture.ts`, which
  re-exports it. **The documented config seam — "a deployment overrides this via the
  `prices` argument … so a price change is config, not code" — is dead code.**
- `conductor.ts#budgetExhausted` **stops the run** on `runUsd >= maxUsd`
  (`DEFAULT_MAX_RUN_USD = 5`).
- That function's own comment says *"An unpriced provider (usd stays 0) never trips this"* —
  but **no provider is ever unpriced**, because the tier table always returns a number.

Consequences: the spend shown to the user is wrong for most providers, and runs on cheap
models are terminated as though they were Opus. Measured totals across 255 runs —
**$193.54 / 38.5M tokens** — are unreliable in the dollar column; the token column is honest.

**Not fixed here, deliberately** (fixed afterwards on request — §N1). The fix is to thread real prices from `ai-config.json`
through `AgentOptions` → `ConductorConfig` → `costFromUsage`, and to treat a provider with
unknown prices as genuinely unpriced so the USD cap cannot fire on a number we invented.
That is multi-file plumbing into a **shipped budget feature**, which `CLAUDE.md` says to
propose rather than land unreviewed. Proposed, with the evidence above.

## M3 ✅ CONTEXT — measured, no issue

Across every run that reported context usage:

| | |
|---|---|
| runs above **80%** of their context window | **0** |
| runs above 60% | 2 (72%, 63% — both `ling-3.0-flash`, 128k window) |
| mean tokens per model call, 128k-window models | 18,437 |
| mean tokens per model call, 1M-window models | 10,025 |

No run came close to exhausting its window, and none was truncated for context. **Context
is not a problem in this product today** — worth stating plainly rather than "fixing".

## M4 🔧 TOKEN EFFICIENCY — cache split now reported (`22ec3d84`); model choice and call count remain the lever

Token spend concentrates in small-context models: the three most expensive runs are all
`ling-3.0-flash` (128k) at 149–156 model calls and ~34k tokens/call, versus opus-5 (1M) at
21–38 calls. More calls × similar per-call context = the token bill. The lever is model
choice and call count, not context size (M3).

Prompt-cache hit rate **cannot be measured from the transcripts** — the `usage` event
carries only `{tokens, usd, modelCalls}`, with no cache-read/cache-write split, even though
`cost-meter.ts#TokenUsage` models both. Adding that to the event is the prerequisite for
any honest cache-efficiency work.

## M5 🔧 COST (second, independent defect) — every editing turn is priced as `mid`, whatever model ran (resolved to the core at the end of this section, `d59cc710`)

`costFromUsage(usage, tier: ModelTier = 'mid')`. The call sites:

| site | tier | what it prices |
|------|------|----------------|
| `orchestrator.ts:7274` | `'small'` | the classifier call |
| `orchestrator.ts:8940` | *default* `'mid'` | a superseded (retried) editing turn |
| `orchestrator.ts:8955` | *default* `'mid'` | **every editing turn** |
| `orchestrator.ts:9451` | `'large'` | the repair pass |

There is no `tier` variable in scope anywhere near 8940/8955 — the main agent turns simply
take the default. So the run's dominant cost is always billed at the `mid` rate
(`$3`/`$15` per MTok) no matter which model is configured.

**This one hits the current setup directly.** `ai-config.json` runs `claude-opus-5`, an
opus-class (`large`) model, which the app's own table prices at `$15`/`$75` — **5× the rate
it is actually charged at**. The 09-12 run reported **$5.04**; by the product's own pricing
table it should have reported roughly five times that.

So the two cost defects push in opposite directions, which is why neither is obvious:

- **M2** over-bills non-Anthropic providers (Anthropic rates on a cheap model) → killed a
  real run at a fictional $26.61.
- **M5** under-bills large models (mid rate on an opus-class model) → the budget that is
  supposed to bound an expensive run does not fire when it should.

Together: the USD figure is not trustworthy in either direction, and `DEFAULT_MAX_RUN_USD`
is guarding with it.

**Recommended fix (one change, covers both):** give `costFromUsage` the *actual* model, not
a hard-coded tier — resolve `{tier, prices}` from the active provider/model, thread it via
`AgentOptions` → `ConductorConfig` (where `maxUsd` already lives), and make a model with no
known price genuinely **unpriced** (`usd = 0`), which restores the invariant
`budgetExhausted` already documents: *"An unpriced provider (usd stays 0) never trips this."*
Then the USD cap only ever fires on a number the product can actually stand behind.

Not landed: it is multi-file plumbing into a shipped budget feature, and the
"what happens when prices are unknown" half is a product decision. Ready to land on request.

**🔧 Resolved to the core (2026-09-14, `d59cc710`).** N1 fixed the price TABLE; the tier LABEL
was still what got priced. Every cost site now asks `pricingForCall(tier)` — the class of the
model `providerForTier(tier)` actually resolves to, or unpriced:

| call | was priced as | now |
|---|---|---|
| classifier | `small`, on the run provider's table | the model routing ran on (a configured cheap model, else the run's own) |
| editing turns (`tier: 'mid'` effects) | `this.provider` | `providerForTier('mid')` |
| repair pass | `large` | the model serving `large` |
| edit variations | fixed `mid` | the run model's own class |

A run is `priced` only when no call ran on an unpriceable model. The six golden scenarios that
flipped to `priced: true` all have `modelCalls: 0` — genuinely free. Tests: Opus routing bills at
the large rate, a Haiku classifier at small, an unpriceable classifier marks the run unpriced.

---

# N. Fix pass — in order

## N1 🔧 COST (M2 + M5) — fixed · `2023d700`

`runPricingFor` resolves what a run may honestly be charged for and returns **undefined —
unpriced** when this SDK cannot know. Unpriced keeps metering tokens and reports `usd 0`,
which finally makes `budgetExhausted`'s own documented invariant reachable.

| | |
|---|---|
| **Priced** | the `anthropic` provider on a Claude model whose class is readable — the one case `DEFAULT_TIER_PRICING` actually describes |
| **Unpriced** | every other provider (their rates are not in this repo, and guessing killed run `33f7e787`) |
| **Unpriced** | `claude-agent-sdk` — it runs on the user's Claude Code **subscription**; "stopped at $5 spent" would stop a run for money nobody spends |
| **Unpriced** | any Claude model whose class can't be read — a wrong tier is how the under-billing happened |

An unpriced run is still bounded by `maxSteps` and `maxWallMs`. Only the dollar bound
stands down, because it was the one enforced with an invented figure.

**The frozen parity fixtures confirmed M5 exactly.** `CONFIG` runs `claude-opus-4-8`, and
all four recorded sessions differ by **exactly 5.0×** in `usd` — one line each, `usd` only,
nothing else. The recordings had encoded the bug.

`ai-sdk: 5018 passed, 0 failed` · typecheck · eslint clean.

## N2 🔧 REVIEW FAILURES (L1) — fixed by the render fix, verified

The 14% review-failure rate and the render blow-up were **the same bug**. `temporal_evidence.py`
imports `compile_timeline` from the render compiler, and the compiler's own docstring names
"the temporal-evidence review" as a caller of the vectorised-audio path — the path that was
doing a 60-step bisection per sample.

The causal chain, readable in the code's own comments: the ramp map once crashed on array
input → was fixed to map element-wise → which made it ~10⁶× too slow → so the review stopped
crashing and started **timing out** instead.

The transcripts split cleanly on it:

| | |
|---|---|
| review failures **before** 2026-09-06 | 10 — **none** involve a speed ramp |
| review failures **from** 2026-09-06 | 12 — **all 12** involve a speed ramp |

**Measured after the fix**, on the real ramped clip through the real endpoint:

```
POST /review/temporal-evidence  (frames 1657–1748, the ramped clip)  →  6.06 s
```

with real evidence returned (luma, blackRatio, perceptual hashes). The same reviews
previously timed out at **307,500 ms** and **323,500 ms**.

## N3 🚫 EMPTY REJECTION REASONS — already fixed, verified not live

Two runs reported `313 / 685 proposed changes couldn't be applied to the timeline (; ; )` —
empty strings where reasons belonged. Root cause was two divergent op caps (100 in the
enforcing half, 200 in the reporting half), so a turn between them was refused by one and
invisible to the other. Unified by `87740dd1` on **2026-09-01**; the last occurrence was
2026-09-01, none in the twelve days since. Closed without new work.

## N4 🔧 `add_marker` — restating a marker no longer throws the patch away · `7ea55250`

Marker ids are derived from the label, so an agent that mentions a beat twice mints the same
id twice — and because a rejected op fails the **whole** patch, one repeated marker discarded
every edit beside it. **Six runs lost work this way.**

An identical marker now applies as a no-op. A genuine conflict still refuses, but names what
is already there and what was asked for, instead of only the id — which is what left the
captured runs reissuing the identical call.

## N5 — open at the time, in order (each since resolved or decided — see the notes)

| # | Item | Note |
|---|------|------|
| 1 | `add_text_layer` doesn't fit (9×) | refusal already gives exact numbers; the question is whether the tool should auto-fit — product decision — **fixed, O1 `54509997`** |
| 2 | `add_clip` unknown asset (8×) | model naming assets that aren't in the bin — **no fix warranted, O2** |
| 3 | `normalize_exposure` before measuring (3×) | ordering precondition; auto-measure is a product decision — **refusal names the clips, O3 `b2c4fe04`** |
| 4 | Self-contained capability packs (B1) | the genuine 1.0 blocker — current packs are `register-local` and work on this machine only — **resolved up to credentials, P4** |
| 5 | `.env` staleness (A3) | deliberately not edited — it is the user's own gitignored config, holding live keys |

---

# O. Open-items pass

## O1 🔧 `add_text_layer` — fits the title instead of refusing it · `54509997`

The tool measured the text against its box and threw, **naming the largest size that would
fit**. The model does not act on that. Run `160b7557` asked for five titles, was refused
once each, **retried none**, and the export shipped with no titles at all.

| run | `add_text_layer` calls | overlays that landed |
|-----|-----------------------|----------------------|
| `160b7557` | 10 | **0** |
| `b5be5130` | 24 | 6 |
| `c200d9df` | 30 | 5 |

Refusing spends a whole model call to be told a number `largestFittingSizePercent` has
already computed. A title one size smaller is an ordinary typographic compromise; a missing
title is a hole in the edit. Widening the box is preferred where it suffices (it keeps the
requested size), capped at 92% so a title never touches both frame edges; shrinking is the
fallback. The result is **re-measured** rather than assumed, and the chosen values ride the
ops so the patch states the size really used.

Checked against every real refusal in the captured runs: **11 of 11 now land, none
overflowing.** Previously none landed.

```
BILLION-DOLLAR  14/80 -> 6.3/80  FITS      PRINCIPLES  18/54 -> 6.1/54  FITS
SUBSCRIBERS     15/78 -> 7.5/78  FITS      MASTER      16/82 -> 13.1/82 FITS
557,000         18/58 -> 9.7/58  FITS      SCHOOL      14/88 -> 13.5/88 FITS
```

## O2 ✅ `add_clip` — mostly correct refusals, no fix warranted

Of the 11 captured failures: seven are the **single-picture-layer constraint** (ADR 0140) —
*"a second copy of the same shot over the same moment cannot be seen behind the first"* —
which is the product working as designed; the real answer is picture-in-picture, already
deferred as SUC-P1. Three are from 2026-07-19 (image clips with a source range that
outran their slot) and have not recurred. One is a genuine model error (naming a music
asset not in the bin). No systemic defect; nothing changed.

## O3 🔧 `normalize_exposure` — the refusal now names the clips · `b2c4fe04`

Same failure mode as O1: the message named the *tool* (*"measure_color reads one clip"*) and
the model did not act on it. Run `3ed87ff0` called it twice, measured nothing, then fell
back to **36 hand-picked `apply_color_grade` calls carrying identical numbers on every
shot** — guessed grades standing in for solved ones, which is the whole thing the solver
exists to avoid. Run `3b340e68` called it twice and stopped.

It now names the clips (up to four, then a count) and says to call `normalize_exposure`
again afterwards.

**Scope note:** the tool genuinely cannot measure for itself. `measure_color` is a
host-executed analysis (the sidecar reads frames) and `buildOps` is synchronous, so a
mutate tool cannot obtain a measurement mid-call. Letting it request one is a change to the
tool/host boundary, not a message fix, and was left alone.

## O4 🔧 Capability packs — I had this wrong; the real gap is narrower (resolved up to credentials in §P4)

**Correction to B1.** I wrote that the packs "aren't self-contained" as though the design
were at fault. It is not. `workers/*/pack/manifest.toml` specifies exactly the right thing:

> *"The build embeds a self-contained interpreter so the worker never depends on a user's
> Python."*

— along with a signed catalog record, Apple Developer ID + notarization (and Authenticode
for win32), an SBOM, a 400 MiB unpacked cap, and three verification tiers that must pass
before an artifact may be signed.

What is actually missing is the **build**:

| | tracking-lite | subject-intelligence | visual-embed | visual-describe |
|---|---|---|---|---|
| verification workflow | ✅ | ✅ | ❌ none | ❌ none |
| artifact build / sign / publish | ❌ | ❌ | ❌ | ❌ |

The two workflows that exist run unit/lint/typecheck, a decoded-media pixel proof, and an
SBOM drift check — then upload **the SBOM**. No step embeds an interpreter, signs,
notarizes, or publishes; `release.yml` does not build packs either. So the manifest's
"artifact hash produced by the build job" refers to a job that does not exist.

**Consequence for 1.0:** every pack-backed capability — tracking, subject detect/segment,
visual embed/describe — can only reach a machine through `register-local`, which points the
entrypoint shebang at this repo's dev venv. That is precisely what I measured on this
machine, and it is why it works here and nowhere else.

**Not attempted here** (later done up to the credential boundary — §P4). Building a cross-platform signed, notarized pack pipeline needs signing
identities, notarization credentials and a distribution decision. That is release
engineering and a maintainer call, not a code fix.

---

# P. The capability-pack blocker — build closed, signing still open

## P1 🔧 There is now a build · `4b412900`

`scripts/build-capability-pack.sh` produces a genuinely standalone pack artifact. **(It did
not: the payload still used this machine's Python and was archived in a format the installer
rejects — corrected in §P4, rows 1–2.)**

Three things make the payload independent of this repo, and the script **asserts all
three** rather than trusting them:

1. **`uv venv --relocatable`** — console scripts resolve the interpreter beside
   themselves instead of naming a build-machine path in a shebang.
2. **The worker installed NON-editable.** `uv sync` installs the project *editable* — a
   `.pth` holding `<repo>/workers/<pack>/src`. My first draft asserted only over `bin/`
   and produced a payload that would have imported nothing on any other machine. That
   miss is why the assert now covers the whole payload, and why PEP 610 `direct_url.json`
   is stripped.
3. **Interpreter symlinks replaced by real files** — `uv` links them to its managed
   CPython, absent on a user's machine.

Then it **proves** it: the worker's own health handshake runs against the built payload,
with `FRAMEPILOT_CAPABILITY_PACK_ROOT` set the way the host sets it.

The artifact digest hashes the **content** (every path + sha256, sorted), not the tarball
— a `.tar.gz` embeds mtimes, ownership and gzip metadata that differ between bsdtar here
and GNU tar in CI, so digesting the archive would make the two places that must agree
disagree.

### Measured — each artifact extracted elsewhere and re-checked standalone

| pack | unpacked | cap | standalone health check |
|------|---------:|----:|---|
| `tracking-lite` | 213 MiB | 400 | ✅ `opencv-5.0.0-cpu`, zero repo references |
| `subject-intelligence` | 254 MiB | 500 | ✅ pinned ONNX digests intact, zero repo references |
| `visual-embed` | **1821 MiB** | 1200 | ✅ health OK — **over its own cap** |
| `visual-describe` | **2755 MiB** | 2600 | ✅ health OK — **over its own cap** |

## P2 ✅ Two packs exceed their own declared size cap — decided: caps raised to 2000 / 3000 MiB (`9e75fd8b`)

Not visible before, because nothing built them. `visual-embed`'s SigLIP2 **text** encoder
alone is 1078 MiB of its 1502 MiB of weights.

Raising the cap or shipping a smaller/quantized encoder is a download-size decision for
the maintainer, so the build **fails** rather than choosing. This is the kind of drift a
build job exists to catch.

## P3 ⏳ Still open, and genuinely not mine

| | |
|---|---|
| **Signing / notarization** | needs an Apple Developer ID and notarization credentials |
| **Publishing** | needs the signed-catalog endpoint and a distribution decision |
| **CI wiring** | 🔧 done (`8a249d5d`, `051b8a37`): protocol, lint and typecheck for both visual packs on every PR; the weight-fetching proofs are dispatch-only |

The build now emits the unsigned artifact and the digest those steps consume, so the
remaining work is credentialed release engineering rather than missing capability.

## P4 🔧 O4 resolved to the core (2026-09-14) — everything short of credentials

"Credentialed release engineering" turned out to be wrong too: going deeper found that **no
pack could have been installed from a catalog on any machine**, signed or not, for five
independent reasons. All five are fixed and each is proven, not asserted:

| # | root cause | fix | proof |
|---|---|---|---|
| 1 | the "standalone" payload still used this machine's Python: `pyvenv.cfg` pointed at `~/.local/share/uv/...` and the stdlib was never copied (a moved copy: `No module named 'encodings'`) | `f9019e66` stdlib copied, `pyvenv.cfg` removed, uv paths stripped | the payload is MOVED and run under `env -i`; every import path must resolve inside it, then the worker handshake runs from there |
| 2 | the build emitted `.tar.gz`; the installer accepts only raw or zip | `f9019e66` zip, with `--stage payload\|finalize` so CI signs between | tracking-lite zip holds exactly its 1232 payload files, no symlinks |
| 3 | the extractor wrote every file `0644` and made only the entrypoint executable — a pack's own interpreter could not run | `9f341daf` signed `executables` list in the artifact record, derived from real payload modes at `prepare-artifact`, applied by the installer (archive modes never trusted) | installed through the REAL extractor: `bin/python` executable, handshake OK; without the list, `exit 126 … Permission denied` |
| 4 | the macOS entrypoint was a `#!/bin/sh` wrapper whose signature lives in xattrs, lost by a zip — the host trust check could never pass | `a0f5409c` native Mach-O launcher (`scripts/pack-launcher/launcher.c`), module baked in and signed with the binary | ad-hoc-signed build, zipped and installed: `codesign --verify --strict` → valid, satisfies its Designated Requirement |
| 5 | the catalog installer's health check never passed `FRAMEPILOT_CAPABILITY_PACK_ROOT` (local registration did), so every weights-backed pack would have been QUARANTINED | `d1f5aa12` staging root on install, committed root on recovery | installer tests assert both |

Also landed: CI verification for visual-embed and visual-describe on every PR (`8a249d5d`), and
`capability-pack-release.yml` (`254b69c4`) chaining build → codesign → zip → notarize →
`prepare-artifact` → `prepare-release` → catalog → `sign-catalog` → `publication-plan`, run end to
end on a real tracking-lite build with a throwaway catalog key. Signing, notarization and catalog
signing run only when their secrets exist and skip with a visible warning otherwise; an unsigned
build carries `UNSIGNED00` and can never reach a signed catalog. `CAPABILITY_PACK_CATALOG_VERSION`
stays 1: `executables` is additive, and a host that predates it fails the release digest rather
than installing with the wrong modes. No signed catalog has been published.

**What is left is genuinely not code** — needs a person, a credential, or a decision:

- ~~**Size caps**~~ — **decided 2026-09-14: raised.** visual-embed 1200 → 2000 MiB (payload
  1781 MiB, weights alone 1501.6), visual-describe 2600 → 3000 MiB (payload 2709 MiB), each with
  ~10–12% headroom so unexpected growth still fails the build. No weight was changed; the fp16/int8
  text encoder and the separate low-RAM pack were not taken.
- **Credentials:** `MAC_CERT_P12`, `MAC_CERT_PASSWORD`, `CSC_NAME`, `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `CAPABILITY_PACK_CATALOG_SIGNING_KEY`; variables
  `CAPABILITY_PACK_CATALOG_KEY_ID`, `CAPABILITY_PACK_ARTIFACT_BASE_URL`,
  `CAPABILITY_PACK_MIN_APP_VERSION`. A Developer ID run must still confirm Team ID match, Gatekeeper
  and whether hardened-runtime signing of the interpreter needs entitlements.
- **Licences:** no SBOM generator for visual-embed/visual-describe (the release generator refuses to
  hand-type a licence list), and the C libraries bundled in the interpreter are not yet listed.
- **Windows:** no Windows builder; visual-describe pins no Windows runtime.
- **Distribution:** CDN upload, live-catalog merge and moving `latest` remain manual.

---

# Q. Live agent run — find and fix

Real `Orchestrator.streamAgent`, `claude-agent-sdk` / **claude-sonnet-5**, against a sidecar
built from the current tree (port 8802, mission fixtures root), so every fix in this branch
is in play. Run detached, as the harness requires.

## Q1 — Batch 1: clean sweep

`montage-30s`, `trim-first-clip-10s`, `captions-plain`, `match-color-to-first-clip`

| metric | value |
|---|---|
| intent accuracy · target resolution · boundary precision | **100% · 100% · 100%** |
| operation validity · first-pass acceptance · reversibility | **100% · 100% · 100%** |
| accepted edits · silent successes · failures | 4 · 0 · **0** |
| grade/transition numbers with no measured basis | **0%** of 1 |
| tokens / accepted edit | 86,990 |

All four cases scored **1.00**, first-pass, undo OK — including `captions-plain` at 1457
operations and `montage-30s` at 26. No functional gap surfaced.

**Two numbers I checked rather than assumed.** `frames seen / accepted edit: 0.00` and
`footage-surface calls / run: 0.00` look alarming — the model edited without ever pulling a
frame. They are not a defect here: the harness **does** now pass `ctx.ledger`
(`mission-baseline.mjs:373`), so the cheap perception path is live, and
`match-color-to-first-clip` produced its one numeric **with a measured basis** (0% guessed).
The ledger is what a frame pull would otherwise have been for. The older note about the
harness never sending the ledger is stale.

## Q2 🔧 The run found a real gap in my own cost fix · `ab4ecae8`

Every case reported `usd=0`, and the summary printed
`tier-priced cost / accepted edit  $0.000`.

For `claude-agent-sdk` that is nearly right — a subscription has no per-token charge. But
the **same 0** is produced for `openrouter` or `deepseek`, where it means *"this SDK has no
rates for that provider"*, not *"this run was free"*. My N1 fix made the budget honest and
left the **reporting** ambiguous: `usd: 0` now meant two different things.

That is precisely the ambiguity `modelCalls` already exists to resolve on the other axis —
its own comment says *"a $0/0-token run means two completely different things depending on
this number"*. So `UsageEvent.priced` draws the same distinction for the dollar figure.

The metrics layer was **already built for this**: `usd: number | null`, with every dollar
aggregate filtering on `!== null`. It was simply never handed a null, so an unpriced
provider's 0 flowed in as a measurement and `usdPerAcceptedEdit: 0` rendered as good news
instead of as no data. The harness now maps `priced: false` → `null`; the existing filters
do the rest.

Additive and optional, so an event persisted before the field existed keeps the old reading.
Golden fixtures regenerated — the only content change is `priced` (`true` for the Anthropic
adapter sessions, `false` for the mock-provider corpus).

**ai-sdk: 5020 passed, 0 failed** · typecheck · eslint clean.

## Q3 — Batch 2: cut short by the Claude subscription's session limit

`hook`, `broll` ×3, `vague`, `impossible`, `guard`, `clarify`, `question` ×3,
`transitions`, `duplicates` — 13 cases, of which only **2½ produced evidence**:

| case | score | intent | note |
|------|------:|--------|------|
| `hook-strongest-line` | **1.00** | 100% | 6 calls, 90s |
| `broll-first-20s` | **1.00** | 100% | 3 calls, 17.9s |
| `broll-empty-overlay-track` | 1.00 | **failed** | 2 valid ops landed, then quota hit mid-turn |

Everything after that: `calls=1 prompt=0 out=0 tools=0 ops=0 wall=2s`.

```
Claude Code returned an error result:
You've hit your session limit · resets 4:45pm (Asia/Katmandu)
```

**Every layer handled it correctly**, which is worth recording as a positive result:

- the provider surfaced an actionable message, not an empty response;
- the harness classified it `loud: true, explained: true`;
- `summarizeGoldenRun` excluded the 12 dead turns from every rate **and** counted them;
- `summary.md` printed, in bold:
  `| **turns the provider never answered** | **12 — excluded from every rate above; re-run them** |`

Also visible: `tier-priced cost / accepted edit (not billed) | —`. That dash is Q2's fix
working end to end — batch 1 printed `$0.000` for the same provider.

### Three defects I claimed here and disproved

Recorded because each cost me a detour, and because the pattern is the same one as O4:
reading a correct mechanism as a broken one.

| claim | reality |
|-------|---------|
| "10 of 13 cases were silently dropped from the metrics" | 🚫 They are excluded *and* counted as `voidTurns`, exactly as the code comment promises. |
| "A total provider failure scores 1.00 — the eval can't tell success from doing nothing" | 🚫 Void turns are excluded from every rate before scoring; the 1.00s I saw were on turns already removed from the aggregate. |
| "`summary.md` never renders `voidTurns`" | 🚫 It renders it **in bold**. I grepped for the word "void"; the rendered wording is "turns the provider never answered". |

### Still owed (since completed — §Q4)

Ten cases have no evidence yet — `vague`, `impossible`, `guard`, `clarify`, the three
`question` cases, `transitions`, `duplicates`, `broll-over-sentence`. They need a re-run
after the session limit resets. `--force` is not needed: the harness skips case files that
already exist, and these were written as void, so re-running the label picks up exactly the
ones that produced nothing.

## Q4 — Batch 2 complete (13 cases, 15 turns), after the quota reset

| metric | value |
|---|---|
| cases · turns | 13 · 15 |
| **operation validity** · **boundary precision** · **reversibility** | **100% · 100% · 100%** |
| intent accuracy | 60% |
| first-pass acceptance | 53% |
| scores | **10 of 13 at 1.00**, one 0.75, one 0.56 |

### Q4a — The intent figure is mostly an artifact, not a product result

Five of the six intent "misses" are classification, not behaviour:

- **Three `question` cases** (`which-clips-show-host`, `whats-on-screen-at`, `find-dark-clips`)
  scored intent 0% while answering **correctly** — e.g. *"clip_004 (70.2–84.9s on video_1) is
  the underexposed one… the only shot out of the four measured assets that reads that way."*
  Reproduced minimally: a text-only `streamAgent` turn ends `thinking → generating → **failed**`
  with **zero error events**.
  **Cause — and it is deliberate.** ADR 0081 (run-state causal integrity) forbids completion
  without a traceable succeeded operation, enforced in `conductor.ts` *and* at the
  `working-state.ts` schema layer. A run that edits nothing is "an honest `failed` with no
  diff" by design. **And a real user never hits it**: `streamAuto` routes `question` →
  `streamChat`, not `streamAgent`. Only the harness calls `streamAgent` with a question, so
  these three cases are structurally unable to score intent. **Harness artifact, not a bug.**
- **`impossible-8k-drone`** scored 0% for answering `ask` where `decline` was expected — but
  its answer was good: no drone footage in the bin, 8K adds no detail from a 640×360 source,
  upscale is a render setting not a clip op, then four concrete options.
- **`broll-empty-overlay-track`** failed intent because the session limit hit mid-turn, after
  its 2 ops had already landed.

### Q4b 🔧 Two REAL editing failures, both on a follow-up turn — root-caused in §S4; duplicates fixed in §Q5

| case | turn 2 | failed checks |
|---|---|---|
| `transitions-where-they-belong` (0.56) | "Add transitions where they belong." | `timeline-changed: unchanged`; `transition-at-a-scene-change: **0/16** source-change cuts carry a transition` |
| `remove-duplicate-takes` (0.75) | "Drop the duplicate takes." | `duplicate-takes-removed: the timeline had no repeated material`; `unique-takes-kept: **also dropped** clip__…_15000, clip__…_26000` |

The transitions run did everything right — loaded the `cut-and-transition-grammar` skill,
loaded the `effects` domain, called `list_edit_boundaries`, then `add_transitions(trackId,
reason: "auto")` **twice**. Both returned `warning`, applied nothing, and the turn ended with
**empty assistant text**. So the editor asked for transitions, got none, and got no account of
why.

`reason: "auto"` is valid and is the documented default ("reads each cut"). What I have **not**
established is why the policy returned a hard cut at all 16 cross-asset cuts — whether the
policy is too conservative, the fresh turn-1 boundaries carry no measurements for
`MeasuredCut` to read, or the rubric is too strict. Root-causing that means reading
`transition-policy.ts#decide` against the real measured cuts, which is its own piece of work.

`remove-duplicate-takes` is the more serious of the two: it **removed unique takes**. That is
an accuracy failure on real footage, and it deserves its own investigation.

Both are recorded rather than patched, because a speculative change to transition policy or
delete targeting is exactly the kind of fix that should not be written from a rubric line.

### Q4c — Six hypotheses raised and disproved in this round

`voidTurns` silently dropped · eval scoring a failure as 1.00 · `summary.md` not rendering
void turns · `guard-wipe-timeline` stale against ADR 0166 (reconciled 2026-09-04) ·
`__unparsedToolInput` recoverable (the raw had XML markup spliced into JSON — genuinely
malformed, correctly rejected) · question-case `failed` status a product bug (ADR 0081, and
the real route is `streamChat`).

**The pattern is mine to own**: I repeatedly read a correct, documented mechanism as a defect
and moved toward a fix before confirming the fault. Every one was caught by checking the
source or the ADR — but each cost a detour, and one (the `__unparsedToolInput` "recovery")
would have shipped dead code.

## Q5 🔧 Root-caused: "drop the duplicates" deleted unique footage because nothing can identify a duplicate (resolved at the end of this section)

`remove-duplicate-takes`, turn 2 — the full chain, from the recorded calls:

```
turn 1  "Build a 30-second montage … and use the opening shot three times."
        → delete_clips, add_clips, add_clip   (19 edits applied)
turn 2  "Drop the duplicate takes."
        → delete_clips(clipIds: […], ripple: true)   ← DELETED FIRST
        → get_timeline                                ← LOOKED AFTER
        "Ripple-deleted range Video 1 · 26s–30s / 15s–19s"
```

**What a duplicate take actually is.** `mission-rubric.ts#checkDuplicateTakesRemoved` defines
it deterministically: *two clips playing **overlapping source** of the same asset — a fact the
project file proves.* Explicitly **not** tier 1's `duplicateOf`, which is a phash cluster over
two different recordings of the same action, and which "no committed fixture ships".

**What the agent used instead:** asset identity. Both clips it deleted were
`asset_001` at **different source offsets** (`_15000`, `_26000`) — different moments, i.e.
distinct takes. The rubric's `unique-takes-kept` names exactly those two as wrongly dropped.

**Two compounding failures:**

1. Turn 1 did not follow "use the opening shot three times" — the incoming timeline had **no**
   overlapping-source pairs at all, which is why `duplicate-takes-removed` came back
   `skipped`.
2. Asked to remove duplicates when **none existed**, the agent deleted two unique clips rather
   than answering "there are none". A no-op request became a destructive edit — and it
   deleted *before* reading the timeline.

**Why this is a capability gap, not a bug to patch.** The deterministic notion of a duplicate
take (overlapping source of one asset) exists **only in the eval**. Nothing product-side
offers it to the agent: tier 1's `duplicateOf` is phash-based and does not fire here, and
`delete_clips` cannot infer intent. So the model has no way to identify a duplicate take and
falls back to asset identity — which destroys distinct footage.

Closing it means a deterministic duplicate-take fact or tool on the product side. That is a
**new capability**, so it goes through the product-scope gate in
`.agents/rules/product-discipline.mdc` with the maintainer, not into this branch. Recorded
with the evidence above so the gate has something concrete to judge. **The maintainer then
asked for it on this branch — see the resolution below.**

**Severity note:** of everything found this session, this is the one that *destroys user
footage* on a plausible instruction. I would rank it above the remaining pack-pipeline work.

**🔧 Resolved to the core (2026-09-14).** Both halves:

- **The product now knows what a repeated take is** (`7c33bc7a`). `editor-core/source-repeats.ts`
  is the single definition — picture clips of one asset whose source overlaps by more than
  0.5 s, each repeat naming the first clip that plays the material. The agent reads it where it
  plans: the clip row gains `replays <clip> source`, and `get_clips` rows carry
  `replaysSourceOf`. The rubric scores against the same function. Different moments of one
  asset — the clips the recorded run destroyed — are explicitly NOT repeats (tested). A project
  with no repeats renders a byte-identical prompt.
- **The case measures removal, not a precondition** (`39596077`): the runner places the repeats
  (`setup: repeat-opening-shot`) and the case is one "Drop the duplicate takes." turn.

---

# R. Visual embed + visual describe, end to end

## R1 🔧 The packs were healthy and never ran on desktop

B above showed both packs pass their health handshake. That was never the question. The
engine runs a local pack only when handed a verified JSON handle, and **the desktop host
never built one** — `FRAMEPILOT_PACK_VISUAL_EMBED` / `_DESCRIBE` were the only route, and
nothing sets them in a packaged app. Plan 05 recorded it as open for both VU5 and VU6; the
register scripts claimed the opposite.

Two more gaps sat behind it:

| gap | effect |
|---|---|
| `/brain/visual/search` always embedded the query with the hosted NVIDIA arm | a keyless pack-indexed brain answered every search `no_api_key` |
| `VisualVectorStore.search` scored every stored vector, any model | with both spaces present, a query was cosine-scored against another model's vectors |

Fixed in `c8a5aa20` (engine), `b7cb08dd` (ai-sdk), `0dccf35f` (desktop).

## R2 🔧 First real run: the describer returned its own prompt

Driven through a sidecar built from this branch, with handles produced by the compiled
desktop resolver from the REAL pack index, on two real camera clips:

```
labelled:  framepilot/siglip2-base-patch16-224-onnx   CU/none · WS/place     ✅
described: "subject": "who or what the shot is of"                            ❌
           "action":  "what they are doing"   "setting": "where it is"
```

Every free-text field was a `field: hint.` phrase from `DESCRIBE_INSTRUCTION`. Ruled out
first: the projector pairing (the 2.2B mmproj is used; the 500M one is refused with an
`n_embd` mismatch). Reproduced at temperature 0 on the worker's own 768 px keyframes with
one frame and with three; a prompt naming no field describes the same frames correctly.
Plan 05 had already logged "the model collapses subject/action/setting to one filler
string" — that string was this. Fixed in the describe commit; the eval that scored 9/9
through it now checks `no_instruction_echo`.

## R3 ✅ Verified end to end after both fixes

| step | result |
|---|---|
| index, all tiers, real packs | 2/2 assets · measured 2 · labelled 2 · described 2 · ~186 s |
| described (clip_b) | "A ski lift is seen against a backdrop of a cloudy sky and snow-covered mountains…" |
| `/brain/visual/search` with the handle | packets from both clips, query embedded by the pack |
| same search, no handle | `no_api_key` — honest, unchanged |
| `/brain/visual/describe` | one packet per asset carrying the local description |

Scoped tests: engine 25 (search/tier-1) + 32 (vector store) + 58 (described/drift/local
describe) · worker 92 · ai-sdk 5 · desktop 6 · desktop typecheck, eslint, ruff, mypy clean.

## R4 ⚠️ Open, recorded not fixed

- **`onScreenText` is invented** on frames with no text (words from the summary, `unknown`).
- **Tier 2 is slow**: ~90 s per short shot on this machine. Unattended import now runs it
  when the pack is installed; the governor yields it to render/export/frame, but a long
  import will keep a core busy.
- **No lease across a worker run started by the engine.** A pack evicted mid-index fails
  that slice; the next handle refresh drops it.
- **`find_similar`** is untouched.

---

# S. Integration audit — every other pack and the AI SDK host surface

Four read-only audits ran in parallel (Opus 5), each tracing entry point → host → worker or
engine → result → timeline op, and each proving its findings against the real installed
workers or a live sidecar rather than reading code alone.

## S1 🔧 AI SDK ↔ engine contracts (21 host-executed tools, ~30 contract rows)

Every body the TS builders produce is accepted by its engine route; no registered tool is
unroutable on desktop. The defects were all in how an honest engine answer was *read*:

| # | defect | fix |
|---|---|---|
| S1.1 | `/analyze` returned `skipped` for an audio analysis of a **video-only** asset — settled as a hard `failed`, while the per-analysis routes say `unavailable` (a warning) for the same fact. Stock video is usually video-only. | `a1c4772e` engine returns `unavailable` |
| S1.2 | `index_media` said *"You can search_visual now"* when only the keyless measured tier ran; the next three reads all refused (proved live). | `14414c1e` warns and names what is missing |
| S1.3 | `search_visual`'s `no_api_key` had no guidance entry — the model got a bare token. | `14414c1e` |
| S1.4 | Transcript search hits were documented as timeline time; transcript words are **asset** time. | `14414c1e` hits carry their asset's clip placements |

## S2 🔧 Transcription (local-whisper pack + hosted providers)

Local whisper is correct end to end on real speech: 149 words on a 49.8 s clip, pauses within
~0.1 s of `silencedetect`, cache hit on repeat. (It runs through Homebrew's `whisper-cli`: the
`framepilot.local-whisper` pack is not installed on this machine.)

| # | defect | fix |
|---|---|---|
| S2.1 ❗ | **Data loss.** Agent `transcribe` through a hosted provider (groq/nvidia) built an **unattributed** `set_transcript`, which applies as a whole-project replacement — every other asset's transcript was replaced. | `ca3e10e4` host stamps the asset; orchestrator always scopes the op |
| S2.2 | Settings → local transcription dead-ended on any build without a signed pack catalog. | `2402a8cf` falls back to local setup |
| S2.3 | The pack runtime env derived the ASR cache from the model dir's parent — the read-only signed install. | `2402a8cf` cache in app data |
| S2.4 | A video with no audio returned ffmpeg's whole version banner (classifier caught the wrong exception type). | `a1c4772e` |
| S2.5 | A media file missing from disk returned a 500. | `a1c4772e` 404 naming the asset |

## S3 🔧 Tracking-lite + subject-intelligence

Both workers run correctly against the real installed packs (point 100 frames/0.9 s, region,
detect 100 frames/49.7 s, segment 60 masks), and results convert to valid, reversible ops. But:

| # | severity | defect | fix |
|---|---|---|---|
| S3.1 | blocker | tracked motion was written to an `object_track` effect the export never reads — a successful track never moved the mask | `f494917e` the command also re-states `<clip>__mask` with the tracked keyframes; an engine test renders it and asserts the mask moves |
| S3.2 | blocker | Inspector "Follow silhouette" always failed (`kind:'segment'` rejected) | `0374ec43` masks converted to a track in main and in `MaskPackActions` |
| S3.3 | major | `subject.segment` > ~200 frames overflowed the 1 MiB worker line | `b98a7d0b` chunked to ≤150 frames under one lease |
| S3.4 | major | frame window computed with project fps; workers seek by file frame index | `ba8a4baf` workers sample the request's time grid (skip/hold frames) |
| S3.5 | major | a point track collapsed the mask to a ~2% box | `f494917e` point tracks move the centre only |
| S3.6 | minor | first usable sample timed at the range start | `f494917e` `dc453d8a` keyframes anchored at the requested first frame |
| S3.7 | minor | clip speed ≠ 1 broke keyframe timing | `f494917e` scaled by speed; curves/freeze/reverse refused with a reason |
| S3.9 | minor | output overflow marked retryable | `b98a7d0b` |

Findings 8 (detection stride) and 10 (a lost target returns no partial track) are design
decisions, left unchanged. Re-verified independently after the fixes: editor-core 35,
ai-sdk tracking + golden 8, desktop tracking 19, web MaskPackActions 3, engine mask render,
and the capability/eval suites the changed capability table feeds (40) — all pass.

**Preview masks — 🔧 fixed after this pass (`eb9c5f5c`).** Neither preview player drew a mask at all, so a
tracked mask moved in the export only. `apps/web-editor/src/preview/clip-mask.ts` resolves a
clip's mask per frame exactly as `render/masks.py` does (keyframed x/y/width/height/feather/
opacity, feather = blur of `feather × min(side)`, invert, polygon ≥ 3 points) and both players
apply it in the clip's own frame, before placement, as the export does: the DOM `<video>` pool
as an SVG `mask-image` (intersected with a wipe when both run), the WebCodecs canvas engine on
an offscreen layer so `destination-in` cannot erase the transition's held frame. Verified in
real Chromium: canvas alpha 255 inside the ellipse and 0 outside, the CSS mask cuts the element
to the ellipse, and a keyframed mask resolves 0.1 → 0.3 → 0.5 across the clip. Web tests: 10
new + 476 existing preview/selector tests pass.

**Residual, recorded:** `add_mask` moves the mask effect to the end of the
clip's effect list; overflow is detected by message text, not a protocol code; a
variable-frame-rate file may drift slightly on the time grid.

## S4 — TRACKING.md open items, root-caused

| item | verdict | action |
|---|---|---|
| Q4b transitions | **wiring bug** (zero-op result dropped the plan's own note → identical retry → empty text) **+ fixture limit** (mission ledger has no tier-1 labels, so `sameSetting` is null at every cut) | note fixed `ca3e10e4`; treating "different asset" as a location change is a guess ADR 0175 rules out → **maintainer** |
| Q5 duplicate takes | **eval case**: turn 1 placed non-overlapping windows, so by the rubric's own definition nothing was a duplicate, and "drop the duplicate takes" right after "use the opening shot three times" naturally means those repeats | 🔧 `39596077` the runner places the repeats (`setup: repeat-opening-shot`) and the case is one "drop the duplicate takes" turn. The product fact landed too: `7c33bc7a` (`replays <clip> source` on the context row, `replaysSourceOf` in `get_clips`) |
| D10 AI memory | **bug on desktop**: `recordAccepted` runs only in `AiSidebar.applyPatch`, which returns early when Electron commits the patch; Electron never records acceptance | **maintainer**: with auto-apply every validated patch is "accepted", so recording it is weak signal |
| H1 silent CLI render | bug | `a1c4772e` |
| M4 cache split | bug | `22ec3d84` |
| L5 split/delete_range on ramps | unchanged | maintainer (needs a schema that can express a partial ease) |

## S5 — recorded, not fixed

- ~~Browser build advertises `detect_subjects` / `track_subject_automatically`, which fail there.~~ 🔧 `b67388c9`.
- `/analyze` wrong-kind skip reason names no asset that would work.
- The local-whisper pack cannot be installed until a signed catalog is published (release blocker if the packaged app should transcribe locally without Homebrew).
- The packaged sidecar still searches PATH for `whisper-cli` (docs say it never adopts one). 🔧 `d03c9019`, §T.

---

# T. Close-out pass (2026-09-14)

Every row of the "Still open" table, decided and executed without further questions. Code
was written by Sonnet 5 subagents working disjoint files in one worktree; every commit was
reviewed here before the next step, and three review findings went back as follow-ups.

## T1 — decisions taken

| item | decision | why |
|---|---|---|
| D10 | record auto-applied patches as accepted, labelled `auto_applied` | weak signal honestly labelled beats no signal; the label lets a consumer discount it |
| L5 | solve the synthetic point's rate rather than change the schema | the schema already lets a point carry any rate — area is the invariant, shape was never representable |
| Q4b | label the fixture with a real pack run | hand-authored labels would be the guess ADR 0175 rules out |
| S2 | packaged mode never reads PATH | the documented security posture; hosted providers still transcribe |
| A4 | Sonnet 5 default | subscription quota (§Q3); note E3's caveat below |
| R4 · `find_similar` | fix the caption-erasing reindex, do **not** blend raw visual vectors | ADR 0064 decided against the blend with measurements |

## T2 — review findings sent back, all fixed

- **L5**: a piece cut at both edges inside one eased segment solved each rate against an
  endpoint the other cut had removed. Reachable through `trim_clip` directly and through
  `split_clip`/`delete_range` by a float boundary artifact → joint solve, `3fee9eab`.
- **S5**: "assets that would work instead" named video assets that can be silent themselves
  → verify by probe before naming, `46263240`.
- **VFR**: six halvings can still overshoot on a badly mislabelled file → last retry seeks
  frame 0, `d76a661b`.
- **Q4b harness**: the same-setting map was built from the BEFORE project while the check reads
  the AFTER timeline, so every cut a turn created scored as unlabelled → `7787e6af`.
- **D10**: Cmd+Z / menu / History undo never recorded a rejection → `fda36e2d`.
- **S3 tracker**: `track_object` had `add_mask`'s reorder bug → `3fee9eab`.

## T3 — E3 caveat on the A4 decision

Across the transcripts, `claude-sonnet-5` (n = 7 turns) ran **437.6 s** p50 to run end at
23 calls/turn; `claude-opus-5` (n = 81) ran **154.6 s** at 10 calls. Seven turns, most of
them eval cases, is too few to overturn the quota argument — but if Sonnet's call count holds
on real sessions, it costs latency. Re-measure with `packages/ai-sdk/scripts/measure-edit-latency.mjs`
after a week of use.

## T4 — process note

One subagent ran `git stash` to check a baseline, against this repo's rule; the stash was
popped with nothing lost (verified: only the maintainer's own stash remains). Baselines are
now taken with a detached `git worktree`.

## T5 — golden re-run

The two cases the open items were about, re-run after every fix landed:
`claude-agent-sdk` / `claude-sonnet-5`, sidecar built from this branch on :8812, rooted at the
worktree's fixtures (so the real Q4b labels were in the brain), ai-sdk dist rebuilt first.
Result: `reports/golden/closeout-2026-09-14/summary.md`.

| case · turn | before (§Q4) | now |
|---|---|---|
| `transitions-where-they-belong` · turn 2 "Add transitions where they belong." | **0.56** — 0/16 scene-change cuts carried a transition, no text | **1.00**, first pass |
| `transitions-where-they-belong` · turn 1 (montage) | — | 0.88 — `min-clips`: 5 picture clips, needs ≥ 6 |
| `remove-duplicate-takes` "Drop the duplicate takes." | **0.75** — deleted two unique takes | **1.00**, first pass |

| metric | value |
|---|---|
| intent · target · boundary · operation validity · reversibility | 100% · 100% · 100% · 100% · 100% |
| first-pass acceptance | 67% (the one miss is turn 1's clip count) |
| silent successes · failures | 0 · 0 |
| grade/transition numbers with no measured basis | 0% of 4 |

**Not claimed:** one run per case (not a floor), and turn 1's 5-clip montage is a separate,
pre-existing prompt-following miss that nothing on this branch touched.

## T6 — what CI caught that the scoped local runs did not

| failure | cause | fix |
|---|---|---|
| visual-embed / visual-describe lint | two SBOM-generator lines over 100 chars; the agent's local ruff run did not use the pack's line length | `f9835350` |
| visual-describe mypy | a tuple-trick lambda in a new test | `59919dd0` |
| engine mypy (tests included in CI) | `asr.sys` implicit re-export; untyped `.json()` return in the caption-reindex test | `7df05d39` |
| `release-cli.test.ts` | **not from this branch**: a catalog fixture with `expiresAt: 2026-09-14` verified against the real clock went red *today* on every branch, `main` included | `65d8e193` — dated relative to now; the other catalog tests already pin `now` |

Lesson kept: scoped local runs must use the **CI command** for lint/type steps (`uv run mypy .`
in `engine/python`, the pack's own `ruff check .`), because both include tests.

---

# U. Latency · accuracy · precision pass (2026-09-14)

Branch `perf/ai-latency-accuracy-2026-09-14` (worktree `../FramePilot-ai-latency`).

## U1 — Where a turn's time actually goes (measured)

`node packages/ai-sdk/scripts/measure-edit-latency.mjs <conversations>` over 418 conversations /
785 turns: **model calls are 91.2% of wall time**, host tools 6.8%, review 2.0%.

Per-call decomposition of the two freshest runs (`55bf6774`, claude-sonnet-5; `3ed87ff0`,
claude-opus-5), from each call's `context_usage` pair (`providerReportedOutputTokens`, wall ms):

| finding | evidence |
|---|---|
| a call's latency is its **output tokens ÷ ~85 tok/s** | every segment lands at 47–95 tok/s |
| the output is **hidden thinking**, not tool arguments | seg-3 of `55bf6774`: **14,768** output tokens, 10 tool calls with 520 chars of arguments, **164.7 s** |
| input is small and cached — prefill is not the cost | 2.6k–13.7k uncached input per call |
| **apply-stage steps think as hard as planning** | sonnet turn: apply steps 7,980 + 4,828 + 1,037 + 2,254 tok (≈190 s); opus turn `014f`: 8 apply steps ≈ 25k tok (≈330 s) — all at `reasoningEffort: 'medium'`, the only value `orchestrator.ts` ever sends |
| **catalog ping-pong** costs whole round trips | turn "add effects and transitions": 5 of 12 calls were one-or-two-query `discover_effects`/`discover_transitions` lookups (≈95 s of 212 s), one refused by the novelty guard as a repeat |

Cache: `cacheWriteTokens` is 1.07–2.0× `cacheReadTokens` on claude-agent-sdk. Recorded, **not
chased** — prefill is not where the seconds are, and this provider is unpriced (subscription).

## U2 — Precision: a refused solver becomes guessed grades

`55bf6774` turn 1: `normalize_exposure` refused ("nothing on track v1 has been measured … call
measure_color on … and the other 6 clips"), and the **next** step applied `apply_color_grade`
to 10 clips, eight of them `exposure: 0.3` — numbers with no measured basis, exactly what O3
tried to stop by naming the clips. `measure_color` takes ONE `clipId`, so obeying the refusal
means ten calls; the model takes the cheaper wrong path.

## U3 — Accuracy: top live refusal classes (last seen)

`add_stock` over picture (48, 09-08 — already names a free slot and the add_clip layer route,
ADR 0169; left as is) · `add_music` on a bin track (13, 09-08 — message is already actionable) ·
image-clip source/duration rejections (29, last 07-18 — not live).

## U4 — Plan

| slice | lever | change |
|---|---|---|
| U4.1 | latency | reasoning effort follows the run stage: `low` while executing a locked plan (`apply`/`enhance`) with no pending action recovery; `medium` for interpret/inspect/analyze/plan/verify/repair and any recovery step |
| U4.2 | call count | `discover_effects` / `discover_transitions` take several queries in one call |
| U4.3 | precision | `measure_color` measures several clips in one call, so a refused `normalize_exposure` is one step from solved rather than ten |

## U5 — Landed, and what is still owed

| slice | commit | verification |
|---|---|---|
| U4.1 stage-scoped effort | `e9066c5b` | stage-policy 39/39, output-room 23/23 (asserts `medium, low, low, medium` across plan → apply → apply → recovery), streamAgent-golden + golden-corpus + session-parity 17/17 unchanged, typecheck, eslint |
| U4.2 batched discovery | `d71370a8` | effect-tools / describe / tool-registry / tool-parity / tool-domains / input-contract / router 140 + 228 pass, Python parity 191 pass, typecheck, eslint, ruff; goldens unchanged (effects domain not loaded in any golden session) |
| U4.3 exposure refusal (re-scoped) | `b9db418d` | solved-color 18/18, eslint |

**Residual — recorded, deliberately not changed:**

- **Quality at `low` effort is unmeasured.** The stage machine locks the plan before `apply`, which
  is the argument; a live or golden run is the proof, and none was run on this branch.
- **Latency and call-count wins are unmeasured.** Every number in §U1 is from runs recorded
  before these commits. Re-measure with `measure-edit-latency.mjs` after real use (U4.4).
- **A reordered `queries` batch is a "new" call to the novelty guard.** `callNoveltyKey`
  stringifies arguments in order. Not sorted on purpose: that key is shared by every guard, and
  order is meaningful for other tools' arrays (`reorder_clips`).
- **The compact `discover_styles` surface still takes one `query`**, because it also routes to
  `discover_caption_styles`, which has no batch form.
- **Cache writes ≈ reads on claude-agent-sdk** (§U1): cost, not latency, on an unpriced provider.
