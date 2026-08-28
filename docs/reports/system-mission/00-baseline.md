# System mission — Phase 0 baseline

**Date:** 2026-08-29 · **Branch:** `feat/system-mission` · **Machine:** Apple Silicon Mac
(`ffmpeg` 8.1 Homebrew with `h264_videotoolbox`/`hevc_videotoolbox`; local whisper
`large-v3-turbo-q5_0`) · **Provider for AI runs:** `openai-compatible` → auth2api bridge
(`trial/`) → `claude-sonnet-5` (the only provider on this machine that answered: DeepSeek
402, NVIDIA 410, OpenRouter 401, Anthropic key empty).

Every number below is reproducible with the command beside it. Fixture checksums are in
`tests/fixtures/mission/manifest.json` (80 files; media not committed, see its README).

## 0. Fixtures

| Project | Media | Timeline | Transcript |
| --- | --- | --- | --- |
| `mission-montage` | 4K60 HEVC camera 40 s, 4 b-roll (9–50 s, 4K/1080p), 1080×1920 30 s, silent 1080p 98 s, 2 generated beat tracks | 5 clips, 134.7 s, 9:16 | — |
| `mission-podcast` | 9.6-min 360p dialogue | 1 clip, 575.9 s, 16:9 | 2,431 words (local whisper) |
| `mission-talk` | 8.8-min 360p narration + beat track | 1 clip, 528.7 s, 16:9 | 1,465 words |
| `mission-photos` | 60 real JPEG stills + beat track | empty | — |
| `mission-export-30s` / `-60s` | derived from the two above | 30 s + music / 60 s | — |

**Residual (fixtures):** no ≥10-minute 1080p talking head and no 20-minute 4K file exist on
this machine; the long-dialogue fixtures are 360p. Unblock: drop such files into
`MISSION_MEDIA_DIR` and extend `fetch-fixtures.sh`.

Build: `./tests/fixtures/mission/fetch-fixtures.sh`, then with a sidecar on :8799 rooted at
`tests/fixtures/mission/projects`: `node packages/ai-sdk/scripts/mission-fixture-projects.mjs`
and `node packages/ai-sdk/scripts/mission-export-projects.mjs`.

## 1. System map

`docs/architecture/system-map.md` — every boundary, owner, crossing shape, and seven
parity candidates (§10 there).

## 2. Orchestration and token baseline (P0.2)

Instrument: `packages/ai-sdk/scripts/mission-baseline.mjs` — real `Orchestrator.streamAgent`,
real sidecar executor, real provider, diffs folded like the host; 3 runs × 6 scenarios.
Output: `reports/system-mission/baseline-orchestration.json`.

### Fixed prompt cost (deterministic, provider-free)

From the token manifest of the first request of every run on the podcast fixture:

| Section | Tokens | Share of 25.4k |
| --- | --- | --- |
| tool_schemas (86 tools) | 18,469 | **73%** |
| retrieved_evidence | 3,133 | 12% |
| system | 2,169 | 9% |
| skill | 1,645 | 6% |
| latest_user_message | 18 | — |

Per-tool schema cost (top): `set_caption_style` 1,145 · `auto_emphasize_captions` 1,025 ·
`set_track_caption_style` 964 · `professional_audio` 894 · `read_edit_signals` 434 ·
`professional_color` 420 · `professional_edit` 375. Three caption-style tools alone are
3,134 tokens — more than everything the prompt says about the user's video.
(`node -e` one-liner over `toolDescriptors(() => true)` + `estimateTokens`.)

### Smoke run (remove-dead-air, 1 run) — the shape of a real turn today

4 model calls · prompt 112k tokens (303 uncached + 111.8k cache-read) · 17.2k output ·
184 s · $0.26 · 8 tool calls, **every one repeated once** (`load_skill`, `list_assets`,
`get_clip`, `analyze_silence` ×2 each) · two calls ran to the 8,192 output cap at ~90 s
each · 0 valid diffs · final status `failed` ("model returned an empty response … on every
attempt") · rubric 0.25. `reports/system-mission/smoke.json`.

### Full baseline

_(filled in when `baseline-orchestration.json` completes — per-scenario p50 calls,
prompt/output tokens, cache share, tool calls + repeats, wall, USD, rubric score, and the
call ledger.)_

## 3. Editing outcome baseline (P0.3)

Rubric: `packages/ai-sdk/src/eval/mission-rubric.ts` (11 table tests). Scores per scenario
are in the full-baseline table above.

## 4. Application resource baseline (P0.4)

Instrument: `tests/e2e-desktop/specs/resource-baseline.spec.ts` (real Electron app, real
sidecar, 10-minute scripted session, reopen ×3). Output:
`reports/system-mission/baseline-resources.json`.

| Checkpoint | Main RSS | Main heap | Main open files | Renderer JS heap used/total | DOM nodes | Listeners | Children RSS (renderer+GPU+sidecar) | ffmpeg |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| idle after load (8 s) | 167 MB | 29 MB | 130 | 34 / 39 MB | 1,929 | 816 | 641 MB (6 procs) | 0 |
| loop 10 (24 s) | 238 MB | 30 MB | 126 | 43 / 72 MB | 2,918 | 933 | 1,045 MB | 0 |
| loop 250 (405 s) | 236 MB | 30 MB | 128 | 44 / 93 MB | 2,919 | 933 | 1,134 MB | 0 |
| loop 260 (421 s) | 151 MB | 30 MB | 128 | 44 / 93 MB | 2,918 | 933 | 744 MB | 0 |
| after 10 min, 376 loops | 124 MB | 30 MB | 128 | 44 / 96 MB | 2,919 | 933 | 647 MB | 0 |

Reading: after the first loop's warm-up (thumbnails, waveform, preview decode) every
renderer metric is flat for nine minutes — heap used 43.7–44.0 MB, nodes 2,913–2,967,
listeners 933–935, documents 1. Main RSS and the renderer/GPU helpers fall by ~45% around
loop 260 (memory-pressure release), never climb back. Nothing in this session type
(select / seek / play-pause / wheel / tab switches) leaks. **Not covered:** AI turns
(`MISSION_AI=1` requires a provider in the app's config), export, and close/reopen ×3 —
the reopen step failed because the launch screen is not reachable after ⌘W + reload
(project auto-restores); P6.6 reopens through the bridge instead. Largest child: the
renderer at 423 MB RSS.

Sidecar idle (uv wrapper + python), before any work: 19.9 MB RSS wrapper, 1 child, 15
open files.

## 5. Export baseline (P0.5)

Instrument: `packages/ai-sdk/scripts/mission-export-baseline.mjs` (POST `/render`, poll,
1 s `ps` sampling). Output: `reports/system-mission/baseline-export.json`. Default preset
(Reels 1080×1920 30 fps, libx264/aac, synchronous MoviePy driver, no hardware encoder).

| Project | Wall | Realtime factor | Peak ffmpeg RSS | Peak python RSS | ffmpeg CPU avg |
| --- | --- | --- | --- | --- | --- |
| 30 s, 4K60 HEVC + 4K b-roll → 1080×1920 + music | **94.2 s** | 0.32× | 1,727 MB | 53 MB | 146% |
| 60 s, 360p → 1920×1080 | **27.1 s** | 2.2× | 924 MB | 44 MB | 216% |

Stage timestamps: the job record only exposes `queued → running → completed`; the
pipeline's inner states (preparing_assets / rendering_frames / encoding / validating) are
not surfaced through `/render/jobs/{id}` while running, and `progress` stayed at the
default — **progress reporting is effectively absent** (Phase 7 P7.6). The ffmpeg command
line is not logged by the sidecar (P7.4 adds it).

## 6. UI/UX walkthrough (P0.6)

`docs/reports/system-mission/00-ux-findings.md` — 16 numbered findings with screenshots.

## 7. Discovered during measurement

See `plan/system-mission/00-BASELINE.md` §Discovered: transcribe on a silent video → raw
ffmpeg 422; a run whose provider fails every call still reports `completed` with an edit
applied; desktop `.env` loader overrode the parent environment (fixed, `electron/env.ts`);
`electron` 39.8.10 declared but 32.3.3 installed until `pnpm install` (lockfile refreshed).
