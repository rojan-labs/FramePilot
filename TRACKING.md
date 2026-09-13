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

### L2 — Why edits don't land, by operation (all-time, with last-seen)

| op | n | last seen | still live? |
|----|---|-----------|-------------|
| `add_text_layer` | 9 | 2026-09-09 | yes — text that doesn't fit the frame |
| `add_clip` | 8 | 2026-09-08 | yes — unknown asset id |
| `add_marker` | 6 | 2026-09-09 | yes — duplicate marker id |
| `delete_clip` | 6 | 2026-08-28 | no |
| `caption_the_edit` | 5 | 2026-09-04 | **closed, see L3** |
| `normalize_exposure` | 3 | 2026-09-12 | yes — called before anything is measured |
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

**L6 ❓ Cost.** The 09-12 opus-5 run: **1.81M tokens, $5.04, 38 model calls** for one
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

## M2 ❌ COST — the dollar figure is fabricated for every non-Anthropic provider

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

**Not fixed here, deliberately.** The fix is to thread real prices from `ai-config.json`
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

## M4 ❓ TOKEN EFFICIENCY — one clear lever, not yet acted on

Token spend concentrates in small-context models: the three most expensive runs are all
`ling-3.0-flash` (128k) at 149–156 model calls and ~34k tokens/call, versus opus-5 (1M) at
21–38 calls. More calls × similar per-call context = the token bill. The lever is model
choice and call count, not context size (M3).

Prompt-cache hit rate **cannot be measured from the transcripts** — the `usage` event
carries only `{tokens, usd, modelCalls}`, with no cache-read/cache-write split, even though
`cost-meter.ts#TokenUsage` models both. Adding that to the event is the prerequisite for
any honest cache-efficiency work.

## M5 ❌ COST (second, independent defect) — every editing turn is priced as `mid`, whatever model ran

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

## N5 — still open, in order

| # | Item | Note |
|---|------|------|
| 1 | `add_text_layer` doesn't fit (9×) | refusal already gives exact numbers; the question is whether the tool should auto-fit — product decision |
| 2 | `add_clip` unknown asset (8×) | model naming assets that aren't in the bin |
| 3 | `normalize_exposure` before measuring (3×) | ordering precondition; auto-measure is a product decision |
| 4 | Self-contained capability packs (B1) | the genuine 1.0 blocker — current packs are `register-local` and work on this machine only |
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

## O4 ⚠️ Capability packs — I had this wrong; the real gap is narrower and still a blocker

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

**Not attempted.** Building a cross-platform signed, notarized pack pipeline needs signing
identities, notarization credentials and a distribution decision. That is release
engineering and a maintainer call, not a code fix.
