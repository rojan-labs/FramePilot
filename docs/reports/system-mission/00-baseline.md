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

### Call ledger — montage, dumped run (44 requests, 86 tool calls, 7 diffs, 27 ops, 1,485 s, $2.04, rubric 1.0)

`reports/system-mission/runs/ledger-montage-30s-r1-t1.json`, rendered by
`scripts/mission-ledger.mjs`. Every request carried 20–25k tokens (system 2–5k, skill
1.6k, tool schemas 12.9–18.5k depending on stage). Classification of the 44 requests:

| # | What the request did | Why it existed | Class |
| --- | --- | --- | --- |
| 1 | `load_skill` ×2 | the model chose playbooks the classifier already knew | **deterministic** — attach skills chosen by the classifier; no model turn |
| 2, 4 | `map_footage`, `describe_footage` ×5 → "not indexed / no visual evidence" | the model asked for intelligence the project does not have | **structured state** — index status per asset in the P1.3 block; tools hidden when nothing is indexed |
| 3 | `detect_scenes` ×7 (serial, 0.15 s each from brain) + `get_transcript` | first look at the footage | **deterministic prefetch** — scene/beat/silence facts for placed assets computed before the first call |
| 5, 7 | `get_frame` ×5 at 640 px, then ×6 at the same timestamps at 480 px | look at the footage | keep one; **cache** by (time, ≤dimension) — 11 renders ≈ 50 s |
| 6, 8, 12, 27, 30, 34, 36, 43 | `list_assets` / `get_clips` / `get_clip` | re-read the timeline after every edit | **structured state** — timeline block refreshed per edit; zero calls |
| 9 | `delete_clips` → "would wipe existing work" | wipe guard refused a rebuild | keep guard; the model then spent 3 requests routing around it |
| 11, 13, 14, 18, 21 | output hit 8,192 with a partial tool batch (`__partial`) | no `maxTokens` on the wire | **fixed (P1.1a)** — 5 requests, ~7.5 min, ≈$0.60 |
| 13 ×2, 16 | `trim_clip` "invalid source range", `delete_clips` "end must be greater than start" | timeline-domain times passed as source times; a zero-length clip | contract clarity (Phase 2) + **defect**: degenerate clip (below) |
| 15, 22, 23, 32, 37, 38, 40 | `recall_evidence` ×7, five of them the same `ev_14` "orientation aspect letterbox" | the asset orientation fact was not in context | **structured state** — asset dimensions/orientation are project facts |
| 19, 23, 25 | `delete_clip clip_005__r` rejected ×4 | a split left a zero-length right half that cannot be deleted | **defect** (editor-core) |
| 29, 33, 39, 41, 42 | `get_frame` → "unavailable this turn" ×7 across 5 requests | the run stayed in `apply` (analysis withheld) from #11 to the end and never advanced to `verify`; the model kept calling a tool it had used earlier to check its crops | **stage advance** — after a committed edit batch the run should enter `verify`, where a bounded look is allowed; 5 requests × 22k tokens for nothing |
| 10, 19, 26, 28, 35 | the actual edits (ripple_delete, add_clips ×9, add_clip music, set_clip_crop ×8) | the work | **keep** — 5 of 44 requests did the editing |
| 44 | closing summary, 5.3k output tokens | narration | keep, cap length |

**Reading:** 5 requests did the work; 5 were truncation losses (now fixed); ~20 were the
model re-reading state it had just changed or recalling facts about assets; 5 were calls to
a tool that was listed but withheld; 3 were routing around the wipe guard. Removing the
structured-state and withheld-tool classes alone is ~25 of 44 requests.

### Full baseline — first pass (3 runs × 6 scenarios attempted)

| scenario · turn | runs | calls | prompt | out | cache | tools* | ops | wall | usd | score | notDone |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| montage-30s | 3 | 10 | 332k | 37.9k | 1.00 | 46 | 0 | 424 s | 0.57 | 0.25 | 2/3 |
| podcast-highlight-60s | 3 | 25 | 804k | 101k | 1.00 | 58 | 1 | 1,200 s | 1.54 | 1.00 | 2/3 (timeout) |

p50 over runs; `tools*` double-counts running+terminal rows (2× the real figure — fixed in
the script after this pass). Montage r1 scored 1.0 at 35 calls / $1.29 / 15 min; r2 and r3
died on the output-cap truncation (P1.1a). Podcast r1 and r2 hit the 20-minute turn
timeout; r3 finished in 592 s with one op and a rubric-perfect 60 s cut.

**The remaining four scenarios (remove-dead-air, beat-sync, refine-tighten,
memory-captions) did not run:** after ≈$8 of subscription-bridge calls the account
answered `429 Rate limited on the configured account` and every subsequent turn
recorded 1 call / 0 tokens / 0 s. They run again — baseline and after, same method,
same provider — once the account window resets (`reports/system-mission/baseline-orchestration.json`
carries the empty rows; the report only cites the measured ones).

### Full baseline — second pass, pre-Phase-1 build (worktree at `ae8e2c3`)

| scenario · turn | runs | calls | prompt | out | tools | repeats | ops | wall | usd | score | notDone |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| remove-dead-air | 3 | 4 | 153k | 17.8k | 4 | 0 | **0** | 193 s | 0.27 | 0.25 | 3/3 |
| beat-sync | 3 | 6 | 214k | 31.2k | 9 | 4 | 0 (one run: 5) | 340 s | 0.51 | 0.22 | 2/3 |
| refine-tighten · t1 | 1 | 7 | 141k | 29.7k | 11 | 5 | 1 | 418 s | 0.45 | 0.50 | 0/1 |

remove-dead-air: every run found the 110 silences and died echoing them back at the 8,192
output cap (0 operations, 3/3). beat-sync: 2 of 3 died the same way. The bridge answered
`429` again after ≈$4, so refine-tighten r2–r3 and memory-captions have no pre-Phase-1
rows (`baseline-orchestration-b.json` carries the empty turns). The harness now waits out
a 429 and retries the turn instead of recording it.

_(the after-measurement table is produced by `scripts/mission-report.mjs <baseline> <after>` — per-scenario p50 calls,
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
