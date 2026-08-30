# FramePilot — Master Build Plan

> **This is the single source of truth for execution.** Every AI agent and human
> contributor MUST read this file before starting work and update it immediately
> after finishing a unit of work. See `.agents/skills/plan-keeper/SKILL.md` and
> `.agents/rules/plan-management.mdc` for the rules governing this file.

**Legend:** `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked
Each task links to its phase. Keep tasks small enough to complete and check off in one PR.

**Strategy (non-negotiable order):** Build the reliable **timeline + patch engine first**,
then deterministic **render + validation**, then the **AI layer** on top, then
**professional compositing**, then **full agent mode**. The AI layer is only
powerful if the editing engine is structured, testable, and deterministic.

**Status snapshot (2026-08-29, SYSMISSION — system mission plan):** `[~]` **The end-to-end
system mission is executed on `feat/system-mission`: 65 of 69 tasks `[x]`, none partial,
four `[!]` that the maintainer verifies by hand (the AI journey and adversarial pass).** The suites were run: **failure paths 12/12**
including all four rows against a real model provider, **references 3/3** on the real
fixtures, **export matrix 8/8 on BOTH encoder paths**, web-editor **2762**, ai-sdk **3875**,
engine render-queue **24**. Running them was worth more than any of the code review that
preceded it: it found a 360p source exporting as a real 4K file, a cancelled export leaving
a half-written file where the finished one goes, and every dropdown in the export dialog
closing the dialog — none of which any unit test could see, because all three lived in seams
(a spawn payload, a SIGTERMed process group, a portalled listbox). Three of the harness failures looked exactly like product bugs and were not — the last, "Recent
projects is empty after a reload", turned out to be `page.goto` not re-injecting Electron's
preload, so the renderer had no IPC bridge while the file was intact throughout. The four
remaining `[!]` tasks are the AI journey and the adversarial pass, which the maintainer
verifies by hand. All six scenarios are measured and every one
improved — podcast 25 → 5 model calls and 1200s → 253s at held quality; montage, beat-sync,
dead-air, refine-tighten and memory-captions all went from *not completing* or *zero
operations* to real edits (rubric 1.00 / **1.00** / 0.75 / 0.63–0.88 / 0.63–0.71 — beat-sync
reached 1.00 once `detect_beats` learned which onsets are beats rather than transients). Seven of
nine turns went 0 → real operations. The root cause behind most of it was agent requests
carrying no `maxTokens`, truncating at 8,192 and retrying into the same wall. A 30s 4K
export went **48.2s → 11.5s** once profiling showed 69% of it was one PIL resize discarding
pixels ffmpeg had just produced. Export is CapCut-style with every platform preset gone.
Reports: `docs/reports/full-system-mission-2026-08-29.md`,
`docs/reports/system-mission/10-definition-of-done.md` (7 of 12 DoD lines met), and
`00-baseline` → `0X-after` per phase. **What remains** is evidence that needs a billed
provider (the AI journey and four failure rows are written and wired, never run green), one
aggregate measurement needing the desktop harness, the engine-kill e2e that still does not
pass, and a day of adversarial use.

**Status snapshot (2026-08-29, run `ea8e46ec` — the beat-grid evidence deadlock):** `[x]`
**A beat-synced montage can no longer be deadlocked by the run's own beat evidence.** The
brief said "evaluate multiple suitable tracks and select the strongest one"; the run did
exactly that, and the runtime could remember only one of the three — not reliably the one it
placed. Every montage proposal after that was refused for not placing a track nobody had
chosen, the model diagnosed it correctly and asked to re-analyse the placed music, and the
stage policy refused: `detect_beats` is an `analysis` tool, closed once a run is executing,
while `add_clips` — whose validation reads that very payload — stays open. Six proposals, one
verbatim rejection, 35 minutes, $4.40, no picture on the timeline, and a closing notice that
said no edits could be found.

Beat evidence is now a per-asset ledger (concurrent writes commute), the grid resolves to the
music actually under the picture, an ungrounded grid is measured rather than vetoed unless
the run declared `hardSync`, a tool whose output a validator consumes may not be withheld
from that validator's stage, an identical refusal no longer counts as progress, and a run
that cannot act says what stopped it. See **ADR 0157** and
**`plan/BEAT-GRID-EVIDENCE-DEADLOCK.md`**.

**Status snapshot (2026-08-28, high-severity dependency alerts):** `[x]` **The 59 open
high-severity Dependabot alerts are down to 1, and the one that remains has no fix to take.**
Fetched from the alerts API rather than the UI, so the fix targets resolved versions instead
of advisory titles. Direct bumps: `electron` 32 → **39.8.10** (the alerts wanted 39.8.10 and
32.x is long out of support), `electron-builder` 25 → **26.15**, `electron-updater` 6.3 →
**6.8.9** (this is what moves `builder-util-runtime` to the patched 9.7.0), `vite` 5.4 →
**6.4.3** in both `apps/web-editor` and `apps/desktop`, `next` 15.1.6 → **15.5.21**, and
`pillow` >=10.3 → **>=12.3**. Eight transitive packages with no direct owner —
`brace-expansion` (three majors live in the tree), `js-yaml` (two), `nanoid`, `fast-uri`,
`ip-address`, `postcss`, `sharp`, `shell-quote` — are pinned through `pnpm.overrides`, keyed
per major where the tree carries more than one so no package is forced across a major.

Two things needed a judgment call rather than a version bump:

- **Pillow could not be resolved cleanly.** `moviepy` 2.2.1 (latest) still caps
  `pillow<12.0`, but every Pillow below 12.3 carries high-severity decoder bugs (alerts
  #140–#157: OOB writes on the PSD and McIdas paths, FITS/JPEG2000 decompression bombs) that
  are reachable from any still the engine opens. moviepy's cap reads as precautionary — it
  names no incompatibility — so it is overridden via `[tool.uv] override-dependencies` in the
  root `pyproject.toml`, with the reason in a comment there, and the choice is gated on the
  engine suite: **2687 passed, 1 skipped, 0 failed** on Pillow 12.3.
- **`electron-builder-squirrel-windows` had to become an explicit devDependency.** It was
  arriving as an auto-installed optional peer pinned at 25.1.8, which held vulnerable
  `app-builder-lib@25` and `builder-util-runtime@9.2.10` in the tree; `pnpm.overrides` does
  not reach auto-installed peers. Declaring it at `^26.15.7` in `apps/desktop` is what clears
  alerts #100 and #101. The repo only builds nsis and dmg, so nothing actually calls it.

**`extract-zip` (#138, GHSA-jmr9-qjv8-65gv) stays open** — no patched version exists at any
release. It arrives only under the `electron` npm package, which uses it at install time to
unpack the checksum-verified Electron binary; it ships in nothing and never sees user media.
Recorded as an accepted advisory in `SECURITY.md` so the next agent does not re-litigate it.

Verification, desktop path first per the product focus: **the packaged desktop app boots on
Electron 39** — renderer loads, sidecar spawns via `dev-uv`, `GET /health → 200`. Beyond
that: engine 2687 pass, all 18 TS test tasks pass, `turbo run typecheck` 17/17, `turbo run
lint` 17/17, `turbo run build` 10/10, Playwright e2e **83 passed** under Vite 6, and
`pnpm license:scan` clean on the new packages. `pnpm audit --audit-level high` now reports
the single `extract-zip` finding.

One real defect surfaced while verifying and is fixed in the same change: `ai-sdk`'s
`critic-scale.test.ts` guard was flaky. It compares the cost of critiquing ten times the
project against a 25x ceiling, and it summed three timed repeats per size — which collects
every scheduling hiccup instead of averaging them out, and a ratio is only as honest as its
noisiest term. Reproduced on a 10-core machine under coverage plus 12-way CPU saturation:
four consecutive runs measured 9.8x, 10.5x, 21.5x and **26.9x**, the last failing a suite
that had found nothing wrong. It now keeps the FASTEST of five runs per size — contention
and GC can only add time to a sample, never subtract it, so the minimum is the least
contaminated one. Same load, same estimator: **11.8x, 13.5x, 14.8x, 16.3x**, all passing.
`MAX_GROWTH` is deliberately left at 25 rather than tightened onto the new spread: the guard
exists to catch a change in shape (the version it was written against measured 67x), not to
police millisecond drift. ai-sdk coverage gate still green (3687 pass, 94.46%).

**Last updated:** 2026-08-30

**Status snapshot (2026-08-30, runs `2d0b0395` / `145ec3f3` — the talking-head mission):**
Two runs of the same end-to-end "cut my talking-head footage" prompt (`run.md`, `run1.md` at
the repo root). One was **cancelled** by the editor after 36 model calls / 354,707 tokens
produced almost no edit; the other **failed** on a provider key limit after 33 model calls /
402,506 tokens and 315 applied edits, with the editor's own verdict: *"no proper caption
handling creative way with emphasis / and also the background music is so loud that my actual
voice is not audible."* Three root causes are `[x]` fixed at source (PR #67):

- `[x]` **Captioning had no bulk path.** 107 `add_caption_layer` calls for one 47 s video,
  hand-segmenting ~35 cues and being rejected mid-run for >12-word spans and cues crossing a
  cut; then a later cut made every cue stale and the only repair was to delete all 106 and
  re-add them (190 more ops). `deriveCaptionCues` in editor-core already did all of this
  correctly and idempotently — **only the web-editor UI could reach it.** New
  `caption_the_edit` exposes it: one call captions the edit, and re-running it *is* the
  repair path for what `verify_captions` reports. Measured: **107 tool calls → 1**, at
  +369 tokens/request of tool description (17,795 → 18,164, read off the regenerated
  goldens).
- `[x]` **Emphasis could not name a phrase.** `auto_emphasize_captions` grounded keywords
  against a *bag* of single spoken words and both renderers matched one bare token at a
  time, so `"stop scrolling"` — plainly spoken — folded to `stopscrolling` and was rejected.
  The model asked twice across two turns and was refused both times by a rule it could not
  satisfy. Now grounded and rendered as a consecutive run over word ORDER, in parity across
  all three sites (ai-sdk grounding, `accentRunIndices`, `_accent_indices`) per the
  `captionStyle.ts` ↔ `captions.py` contract. +38 tokens/request.
- `[x]` **The preview mixer lied about the mix.** It played every clip at flat gain, so a bed
  authored *with* a duck was loudest exactly where the render is quietest — that is the
  "music is drowning my voice" complaint, about a mix the render already had right. The agent
  then cut the bed's clip gain to -16 dB: a destructive edit stacked on a working duck. A
  monitor that lies does not just mislead the person, it teaches the agent to damage the
  edit. `previewClipVolume` now samples the engine's own envelope (`fade_gain_at` ×
  `duck_gain_at`, ramp included); tests assert the engine's own numbers to 9 dp.

Open from the same runs, **not** addressed here: the orchestration spin in `145ec3f3`
(13 `recall_evidence`, 9 `get_project`, 6+6 timeline reads, four "that last look turned up
nothing new" notices before the editor gave up), and the fact that a retryable provider 403
ended a run holding 315 applied edits.

**Status snapshot (2026-08-28, run `bfb5c75b` memory spike):** `[x]` **Sourced assets were
throwing away the proxy the engine had just built for them.** A 50+ clip nature montage
(`run.md` at the repo root, conversation `bfb5c75b`) spiked memory until the app had to be
force-quit. The cause was not the timeline: that project's history commits cleanly, 123 ops
collapsing to 45 inverse ops, and the saved file is 268 KB. It was that every one of the 55
sourced assets carried `media: {proxyPath: null, peaks: null, thumbnailPaths: null}` — while
all 54 proxies existed on disk. `StockService.materialize` and `MusicService.materialize`
read `derived.proxyPath` / `.peaks` / `.thumbnailPaths` off the top level of
`importAssetViaSidecar`'s result, which has always nested them under `media`. Every field is
optional, so both flat shapes were structurally assignable and the compiler was silent; the
stock test cast its stub `as never` and the music test's stub restated the same flat mistake,
so the suite agreed with the bug. Verified live against the sidecar with the run's own
184 MB 4K source: `derived.proxyPath` is `undefined`, `derived.media.proxyPath` is
`.framepilot-derived/25e69ad7b4bc/proxy.mp4`. Consequence: `webCodecsPreviewEligible`
returns false for any clip without a proxy and `previewMediaSrc` falls back to the original,
so the editor previewed **1,523.5 MB of 4K originals where 63.2 MB of proxies existed**
(24x; a 184.2 MB source has a 4.5 MB proxy), ran the client-side `<video>`→canvas capture
pool over 4K files for every filmstrip, and re-decoded audio in the renderer for waveforms.
Both services now bind to a named `DerivedAssetMedia` type so the drift is a compile error;
the stock stub is typed instead of cast. Verification: 502 desktop tests pass, the new
regression test fails on the old read, desktop lint + typecheck clean.

**The three acquisition-path bounds the same run exposed** — `[x]` all fixed, all measured:

- [x] **`/asset-media` had no concurrency gate.** One call is an ffprobe, a full waveform
      decode, five thumbnail extractions and a proxy transcode of the ORIGINAL 4K source; the
      route's only bound was arrival rate, and each caller held one of Starlette's 40 threadpool
      slots while it ran. Now gated by `settings.asset_media_concurrency`
      (`FRAMEPILOT_ASSET_MEDIA_CONCURRENCY`, default 2), acquired in the event loop with the
      body moved to `run_in_threadpool` — so a queued caller costs nothing while it waits.
      Same shape as `_temporal_evidence_gate`. **Measured on six and twelve real 4K sources,
      peak RSS of the sidecar and every ffmpeg child:**

  | concurrent callers | ungated peak | gated (2) peak | ungated wall | gated wall |
  | ------------------ | -----------: | -------------: | -----------: | ---------: |
  | 6                  |     1,399 MB |         956 MB |        30.6s |      34.7s |
  | 12                 |     2,583 MB |         970 MB |        65.5s |      68.5s |

  Ungated peak grows with arrivals; gated it is flat (956 → 970 MB) for ~5% wall time.
  That flatness is the fix: the captured run's 42 arrivals had nothing holding them back.

- [x] **`enrolStockAsset` started one uncancellable index loop per `add_stock`.** No dedupe
      (the warm pass and the serial commit both enrolled, and a bin-dedupe hit enrolled again),
      no bound, no signal. `/brain/visual/index` takes `assetIds` as a LIST and paces its own
      slices behind a per-project lock, so N single-asset loops could only queue on that lock —
      each holding a threadpool slot while it waited, starving the render/analysis/asset-media
      calls the same run depended on. New `electron/ai/asset-enrolment.ts`: one batch in flight
      per project, ids arriving during a batch fold into the next, nothing enrolled twice,
      bounded project memory, and an abort signal fired from `before-quit`.

- [x] **Derivation ran twice per sourced asset.** ADR 0150 acquires concurrently and commits
      serially, resting on the promise that the second call "hits the dedupe path at zero bytes
      and returns immediately" — but `materialize` derives on both passes, so zero bytes were
      downloaded and a full derivation was paid for anyway (1.5–3.2s per dedupe call in the
      captured run). New `electron/media/derived-media-cache.ts` memoizes per derive-request
      shape, validating BOTH that the source is unchanged (size + mtime) and that every artefact
      the cached result names is still on disk — so clearing `.framepilot-derived` re-derives
      instead of handing back a path that resolves to nothing. Failures are never cached.

**Status snapshot (2026-08-28, photo-montage run gap analysis, round 6):** `[x]` **All six
closed in code; the re-run is what settles them.** Run `4c9b5f82` answered a 61-photo,
"20–35 second" brief with ten photos over the first 10.0s of a 36.1s music bed — 72% of the
programme black — and reported `completed`. Six layers each had a reason not to catch it,
and all six are fixed: `picture_coverage` (a new deterministic check comparing picture
against the whole programme), the acceptance reader (photos are shots; a stated range is a
length), the early-done guard (the model's "done" now answers to the request's own failing
checks and buys one bounded recovery turn), the representative frame probes (they measured
black and asserted nothing), the review's account of a finding it never reached, and two
tool dead ends that cost five of seventeen model calls (`get_timeline` took no window;
a stale music id reported "provider not responding, try again"). ADR **0153**.
`packages/ai-sdk/src/critic.test.ts` asserts the whole chain, brief to verdict, and that a
cut which actually answers the brief still passes.

**Round 6 was measured.** Run `accd014d` settled `failed` with all three checks naming the
real defect — 28.489s with no picture, 14 shots of 61, 36.5s against 27.5s — instead of
`completed`. The verdict is fixed; the montage is not. It ran out of turns FETCHING the
descriptions of the photos it was asked to edit: the digest showed 24 of 61 and told it to
look up the rest, and the payload it then paged was 28,264 characters against a
16,000-character recall, where a recall is a whole model turn. Its last four turns applied
nothing and the research budget correctly settled it.

**Status snapshot (2026-08-28, photo-montage run gap analysis, round 7):** `[x]` **The
fetch is gone.** Three measurements off that run's own map, all the same shape — a thing
that says nothing costing characters, and characters costing model turns: all 61 chapters
had `title` byte-identical to `summary` (37% of the payload); `map_footage` settled past
its own schema so the model was the only reader getting the un-normalised map; and the
digest cap was a row count sized for hour-long video. Payload 28,264 → 15,794 chars (two
recalls → one); digest 24 rows → all 61, no fetch needed. ADR **0154**. The guards
(research budget, no-progress, semantic loop) are deliberately unchanged — they fired
correctly, and loosening them would have bought more turns to keep fetching.

**Not yet measured.** The next run settles whether a run holding all 61 descriptions from
turn one places all 61 photos, lands inside 20–35 seconds, and covers the bed.

**Status snapshot (2026-08-28, run `fc10301a` gap analysis, round 8):** `[x]` **All 21 gaps
closed.** The re-run of the 61-photo montage after ADR 0154. It placed 34 of 61 photos over
0–24.079s of a 47.8s bed, applied no motion, transitions, grade or crop, and settled
`failed` with 11 of 30 steps unspent. [`docs/reports/2026-08-28-run-fc10301a-gap-index.md`](../docs/reports/2026-08-28-run-fc10301a-gap-index.md)
indexes all 21 gaps and where each was closed; the
short account of what was actually wrong:

- **The run was never told what "done" meant.** `acceptance.ts` derived "about 27.5s" and
  "at least 61 shots" before turn one, `critic.ts` failed the run on exactly those, and
  `briefing.ts` printed neither — the section was gated on the objective not being the
  request echoed back, and a seeded objective always is. A test asserted the suppression.
- **The spin guard killed it.** `turnSignature` hashed tool names and arguments only, so a
  montage that must re-read the timeline between batches collided with itself; and the
  exact-repeat arm ended runs in silence.
- **Every applied patch wiped the run's timeline memory**, forcing that read. A turn now
  carries the arrangement it just produced.
- **`add_clip` was exempt from the frame grid** — the one authoring operation that was, and
  the most common one. Fixing it exposed two seams where an ungridded value was compared
  against a gridded timeline.
- **Nothing carried an asset's shape**, so 34 landscape photos went into a 1080x1920 frame
  against a brief reading "No black bars". Schema **v21** adds `media.width/height`; ADR
  **0155**.
- **Per-clip granularity made the brief unreachable**: 61 placements against a 30-step
  budget. `add_clips` places a sequence in one patch.

ADR **0155**. Skills, goldens and both tool surfaces re-recorded; the branch is
`fix/run-gap-analysis-fc10301a`.

**Not yet measured.** As with round 7, the next run settles whether these hold end to end.

**Status snapshot (2026-08-28, media-intelligence closure):** a reported "footage map is
never created for images" turned out to be photos being dispatched to a video-only hosted
index, where one refusal froze the whole project's preparation at asset #1. Phase 1 of
`plan/media-intelligence-closure/` is shipped and tested; phases 2-5 (time base, parallel
preparation, per-asset outcomes, removals) are open.

**Status snapshot (2026-08-27, montage run gap analysis, round 5):** `[x]` **All five closed
in code; the re-run is what settles them.** See `plan/structural-changes/` for the per-plan
account. ADRs **0149** (a run holding unspent candidates may not fetch more, narrowing
0147), **0150** (acquire in parallel, commit in series), **0151** (the findings budget
scales with the window).

**Nothing below has been measured against a live run** — every figure is read from the
captured transcript, and the targets are projections. The round-5 re-run settles three at
once: whether the timeline reaches 50 clips, whether ≈960s of serial downloading became
≈250s, and what the cached share actually is. Read a flat download-failure rate as the QUIC
hypothesis being wrong rather than as noise.

**The cache question was closed by acting, not measuring.** `cacheBoundary` appeared nowhere
in the OpenAI-compatible adapter, so the marker the agent loop places was dropped on the path
the captured run used. It is carried everywhere now: a gateway that understands it uses it,
one that does not ignores an unknown key on a content part, and automatic prefix caching is
unaffected because it keys on the byte prefix. Underneath it was a reporting bug that would
have invalidated any earlier measurement anyway — `withProviderUsage` read
`cachedInputTokens` while every caller passes `cacheReadInputTokens`, so the field was
`undefined` on every manifest ever built.

**The harness was no longer the blocker; the gate was off and the strategy was unforced.** Run `e36235cc` is the
same brief again. Rounds 1-4 worked: it reached `apply`, held a 121-beat grid and 12
downloaded clips, made 143 tool calls -- and delivered a timeline with **one clip on it**
(the music bed), then reported **`completed`**. 30 minutes, 367,398 billed tokens (1,223,811
assembled across 52 model calls), $1.4288.
Full forensics and the end-to-end plan: **`plan/structural-changes/`**.

1. **One regex disabled the entire quality gate.** `acceptance.ts:explicitMinShotCount`
   reads `50` from `50+ visually distinct clips`, then discards it: the guard meant to reject
   "30 second cuts" also matches `0.50s` in the brief's own beat-map **example table** (`.`
   is a non-word character, so `\b` matches inside `0.50s`). With no `minShotCount`,
   `critic.ts:checkShotCount` reports `skipped`, `r.ok` stays true, and `conductor.ts:1783`
   folds a 1-clip timeline to `complete`. The gate was built, wired and correct -- a false
   positive switched it off. This is the same family as round 2's pacing-table duration bug,
   now biting the shot count. **Fix this first: nothing else is measurable until a 1-clip run
   stops reporting success.** → `01-ACCEPTANCE-GATE.md`
2. **Sequential downloads consumed half the run.** All 18 `add_stock` calls ran strictly
   serially (verified by timestamp: each starts as the previous ends) -- ~960s, 16 of 30
   minutes, 6/18 failing. `search_stock` is already parallel; `add_stock` is excluded by one
   `tool-contract.ts` row that conflates a network fetch with a timeline patch. Failures
   cluster at the tail of each chain and degrade in character (timeout → QUIC →
   `ERR_NAME_NOT_RESOLVED` → `ERR_INTERNET_DISCONNECTED` in 74ms), so this is Chromium
   session state, not Pexels. → `03-PARALLEL-ACQUISITION.md`
3. **The model gathers instead of committing, and the recovery turn cannot stop it.**
   62 `recall_evidence` calls. `loop-detector.ts:216`'s "Do not read anything else first"
   fired and was ignored -- it is advisory text against a model already ignoring advisory
   text. Round 3's first-time-recall credit was right and has the side effect that gathering
   now satisfies the progress test without bound. **Note two inversions:** recalls are cheap
   in latency (0ms each) but cost **~289,370 tokens, 37% of all tool output** -- the largest
   line item in the run; and refusing a _recall_ would re-open the round-3 trap, because a
   stock `remoteId` exists nowhere else. The correct target is the next **search** when
   unconsumed results are already banked. Requires an ADR amending 0147.
   → `02-COMMITMENT-GATE.md`
4. **Five supporting defects.** `describe_footage` returned `not_indexed` for all 11 calls
   (agent-downloaded stock is never enrolled -- `stock-host.ts:97-131` has no hook, unlike
   the human import path), so a montage judged on visual variety was assembled blind; every
   search asked for `orientation: "landscape"` on a 9:16 brief; music queries silently
   degrade to their first two words (10 searches, 76k tokens, and a 70 BPM track for a
   "super-fast-paced" montage); the 9,885-char brief is serialized twice in every run-state
   block; and `continue from here` discarded the 50-clip requirement outright.
   → `04-SUPPORTING-DEFECTS.md`

5. **Context is rebuilt 52 times and 60% of it is a tool catalogue.** All 105 context
   manifests parsed: **52 model calls, 1,223,811 estimated input tokens**, of which
   `tool_schemas` alone is **736,595 (60.2%)**. Context per call never grows and never
   compacts (`compaction.occurred` false in all 105; window 128k, peak use 33%) -- which is
   why the per-call figure looks healthy and the run does not. Against 16,962 tokens of tool
   definitions in one message, the findings budget is
   `AGENT_LOG_CLEAR_THRESHOLD_TOKENS = 1000`: past ~two tool calls, every payload older than
   `AGENT_LOG_PAYLOAD_FRESH = 2` becomes `[old result cleared -- recall ev_N]`. **The model
   holds ~17x more context about tools it could call than about what it has found**, and a
   stock `remoteId` lives only in a payload that survives two turns -- so the 62 recalls are
   _mandated_, not chosen. Round 3 stopped the harness killing runs that recall; it did not
   change the reason they must. Multiplier: 144 tool calls over 51 turns, **mean 2.82**, with
   63% of turns making one or two calls, each paying a full ~23,500-token rebuild.
   **Take one measurement first:** whether the live OpenRouter path honours the cache
   breakpoint (`splitAnthropicMessages` is Anthropic-specific). If it does not, those 736,595
   tokens were billed at full price and that outranks every other item in this snapshot.
   → `05-CONTEXT-ECONOMICS.md`

**Previous snapshot (2026-08-27, montage run gap analysis, round 4):** `[x]` **Two more
defects from run `2131d2c5`.** The recall credit from round 3 worked — the run reached 34
model calls instead of dying at 4 — and it still downloaded nothing, at 546,932 tokens and
$1.95.

1. **A recall cost ten times what the read cost.** `recall_evidence` renders the STORED
   payload, and the store held the provider's whole record: `variants` (six renditions),
   `licenseUrl`, `sourceUrl`, `creatorUrl`, `attribution`. ~900 tokens for three clips, of
   which the model can act on none — `add_stock` takes a `remoteId` and the host picks the
   rendition. The `search_stock` digest already says "provider URLs never reach it at all";
   `evidencePayload` now makes that true of the stored copy too, so recall returns what the
   search returned.
2. **The one playbook explaining stock sourcing was never loaded.** The run took
   `footage-intelligence` and `beat-synced-editing`; `search_stock`/`add_stock` are covered
   only in `broll-and-layering`, whose description spoke solely of b-roll over narration.
   It now names stock sourcing, so a montage built entirely from searched footage can find
   it. (Round 3's wording fix inside that file was therefore never consulted by this run.)

**Previous snapshot (2026-08-27, montage run gap analysis, round 3):** `[x]` **The recall
trap is closed.** Run `09529490` is the same brief again: every one of its fifteen stock
searches SUCCEEDED (round 2's fixes confirmed live, queries now visible on each card), it
had the beat grid at 162 BPM and ~600 candidates — and it still applied nothing.

The agent log keeps payloads for only the two freshest entries
(`AGENT_LOG_PAYLOAD_FRESH`), and a stock `remoteId` exists nowhere else, so a run holding
twenty-one search handles could see the ids of at most eighty of its candidates. The
contract's own answer is `recall_evidence` — and every recall is `fromCache` by
construction, so each of those turns scored as learning nothing. The run said what it was
doing ("I'll recall the search results to get remoteIds"), recalled eighteen times, and was
killed by `STALL_CONFIRM_TURNS` for obeying its instructions.

A recall of a handle the run has not opened before is now progress; a repeat of one is not
— the novelty key already distinguishes them by `evidenceId`, so the "recalling forever"
guard is untouched. The `broll-and-layering` skill's "gather first, place second" was also
read as "run every search before downloading anything" and now says plainly to download
from a search while its results are still in front of you.

**Previous snapshot (2026-08-27, montage run gap analysis, round 2):** `[x]` **Five further
defects traced from captured run `f014f3ac` are closed.** That run is `f1d5285e` re-run
after the fixes below: the guards no longer ended it early (28 model calls, 71 tool calls,
reached `apply`), and it still delivered no montage — for reasons that were never in the
agent kernel.

1. **The panel's search cancelled the agent's searches.** `StockService.search` was
   single-flight, latest-wins — right for a person typing, fatal for an agent that fires
   four deliberate queries at once. The fourth of every batch returned forty clips; the
   first three came back `cancelled` in ~120ms. Fifteen of twenty-one stock searches died
   that way. Superseding is the caller's declaration now. ADR 0148.
2. **Those failures reached the model as nothing at all.** `cancelled` renders as the empty
   string by design (a user's own Stop should not be narrated back), which became a red
   cross with no reason and a blank action-log line. The agent boundary now guarantees a
   sentence for the whole class.
3. **`picture_present` passed on a timeline with no picture.** "Picture" was derived as
   "not an overlay", so the music bed counted and the check written for exactly this
   failure (ADR 0144) reported "pass: 1 picture clip". All three picture checks exclude
   audio-backed clips now.
4. **The duration target was invented from a pacing table.** `### BUILD` +
   `**0.3–0.6s per clip**` produced a 0.6-second target for a fifty-clip montage, and the
   self-check failed the run by 202.468 seconds. A range's far end and a per-unit figure
   are both refused now.
5. **Every catalogue search looked identical.** `search_stock`/`search_music` were never
   entered in the descriptor tables, so four searches showed four identical rows — and the
   evidence handles carried the same label, so the run spent 30 of 71 tool calls opening
   its own results to find out what they held.

**Previous snapshot (2026-08-27, montage run gap analysis):** `[x]` **Five defects traced
from captured run `f1d5285e` are closed.** The run was asked for a 50-clip beat-synced
nature montage on an empty project. It searched for music four times, was told it was
going in circles, was switched to a recovery surface that had no way to find footage, and
terminated after four turns and forty-five seconds having applied **no edit at all**.

1. **Every catalogue search in a run shared one novelty key.** `search_music`,
   `search_stock`, `search_media`, `search_visual` and `find_similar` are
   `kind: 'analysis'` and take no `assetId`, so `callNoveltyKey` collapsed all of them to
   `name:*`. The second search of any run — however different its query, however many new
   clips it returned — was scored "learned nothing new". That drove `stallStreak` to
   `STALL_CONFIRM_TURNS` in four turns and ended the run. An unasseted analysis is now
   keyed by the arguments that carry its question. A request needing 80–120 stock searches
   could not previously clear its own second turn. ADR 0147.
2. **A failed call banked its key against the retry that worked.** The first
   `search_music` was rejected by the provider; `mergeSeenKeys` recorded the key anyway, so
   every later search inherited "already seen". Only calls that actually answered are
   recorded now.
3. **The loop detector judged the model's prose and nothing else.** `'find the'` is an
   `analyze` marker, so three productive searches described consistently read as one intent
   repeated three times. The intent window now holds turns that learned nothing; a turn
   that discovers something empties it. The failure the detector was built for — one
   purpose, four wordings, nothing learned — still trips it.
4. **The recovery turn withheld the only tool that could have obeyed it.** ADR 0143 let
   `add_stock` survive that turn but not `search_stock`, which is a complete surface only
   for a run that has already searched. On an empty project there was no legal move at all.
   The whole `sourcing` role survives recovery now. ADR 0147 amends ADR 0143.
5. **The editor's request was re-billed uncached on every turn.** `assembleContext`'s own
   comment called the request cacheable prefix while the code put it in the volatile half.
   A 2,672-token brief was paid for on all four model calls. It sits above the cache
   boundary now.

**Previous snapshot (2026-08-27, context-management programme complete):** `[x]` **All five
phases of `plan/context-management/` are closed** — see **CTX-PHASES** below and
`reports/context-benchmark-after.{txt,json}`. On a 60-minute project the model went from
seeing 2.1% of its clips and 6.7% of its dialogue to **100% of both**, at a cacheable
prefix share that went **up** (81% → 91.6%). Cuts land on frames for manual edits as well
as AI ones (ADR 0146), preview/export divergence is measured at **0 frames**, the Critic
has six editorial checks it did not have, and a follow-up request inherits what the last
run learned. Two targets were consciously not met and say why: the 60-minute "unused
capacity" target is retired (coverage is 100%, so the spare window is spare, not waste),
and P5.3's behavioural half is held back pending real run logs, with its cost now measured
rather than invisible.

**Previous snapshot (2026-08-26, context-management audit + second run gap analysis):** `[x]` **Eleven gaps found by
tracing captured run `e30c1fe9` against the codebase are closed on
`fix/agent-run-gap-analysis`.** The run was asked for a 30-second vertical Reel on an empty
project. It searched a stock library eight times, found eighty usable clips, and delivered
thirty seconds of white text on black — no footage, no audio — then reported fifteen
"unexpected black frame" findings and was cancelled with no summary of the 38 edits it had
already applied.

1. **A run could not obtain media after its first patch landed.** `add_stock`/`add_music`
   are registered `kind: 'analysis'`, so the stage gate withheld them in every execution
   stage and the action-recovery turn — the one that demands an ACT — refused them for not
   being `kind: 'mutate'`. Sourcing is now its own role, and the scoping gates read
   `toolContract().effectClass`, which has always said `mutation`. ADR 0143.
2. **The refusal claimed the download was redundant.** One branch served "you already have
   this" and "not available this turn" with one sentence, and for a call the run had never
   made the sentence was false. The reason is derived from the run's memo now.
3. **Recalling stored evidence armed the lockout that preserves recall.** Every
   `recall_evidence` is `fromCache` by construction, so a turn spent doing what the contract
   asks read as a turn that learned nothing. Recalls are excluded from that question, and the
   trigger — which had no user-visible explanation at all — now has one.
4. **`punch_in` on a text clip applied, validated, reported, and rendered as nothing.**
   The compiler placed text overlays with a bare `with_position("center")`. Text now carries
   its transform; captions, whose motion is the caption style's, refuse the call instead of
   accepting a no-op. ADR 0144.
5. **Nothing noticed the edit had no picture in it.** A `picture_present` Critic check, a
   duration check that says how much of the length is picture or sound, and a review that
   states "every sampled moment is black" once rather than reporting fifteen broken cuts.
6. **`add_text_layer` could not style anything**, and the renderer read `fontSize` in pixels
   while the app authors `fontSizePercent`/`xPercent`/`yPercent`. Both closed: the tool takes
   the authoring vocabulary on both runtimes and the engine resolves it.
7. **`recordEvidence` had no caller.** Every run's `working.evidence` was `[]` while its
   facts cited `[ev_3]`. The handle now travels with the distillation that cites it.
8. **A descriptive music query always found nothing.** The catalogue matches keywords, not
   sentences; one relaxed retry, and the summary names the query that actually hit.
9. **The whole request was stored back as the run's own objective** — three copies plus the
   recovery instruction, persisted and streamed every turn. Bounded excerpts, and recovery
   names the act instead of restating the brief.
10. **A cancelled run gave no account of the edits it had applied.** It does now.
11. **A recalled stock id that this session had forgotten said "unknown item".** It names the
    session boundary and the recovery, which the sourcing-role change makes reachable.

Evidence: ai-sdk 3344, editor-core 918, desktop 469, web-editor 2595, timeline-schema 214,
shared-types 27, mcp-server 135, ui 42, engine 2624, e2e 83 — all green; workspace typecheck
and per-package lint clean, `ruff`/`mypy` clean. Golden corpora regenerated; the tool-surface
deltas are the measurement of gap 1 (+827 tokens in `apply`, +775 on a recovery turn).

Deliberately not addressed: a text overlay's `inAnimation`/`outAnimation` are still
preview-only. The agent cannot set them, so it is reachable only through the Inspector; it is
stated at the top of `render/text_overlay.py` rather than left to be discovered.

**Status snapshot (2026-08-26, run gap analysis):** `[x]` **Ten gaps found by tracing a
captured agent run (`c25cfb56`) against the codebase are closed on
`fix/agent-run-gap-analysis`.** The run spent 3m20s and 19 metered provider searches on a
project it could never write to, proposed two edits with fabricated media paths, had both
refused, recorded both as `succeeded`, and was cancelled by the user.

1. **A run started against a project the app did not have open.** The active-project check
   lived only in the commit path, so it fired minutes and a dozen billable searches after it
   could have. Now a pre-flight in `aiStreamStart`, reading the same
   `decideCommitTarget` as the mid-run race guard so the two cannot drift.
2. **The host's refusal never reached the run** — it was stamped on the outgoing event for
   the UI alone, so the ledger read `succeeded`/`projectRevisionAfter: 1` against a project at
   revision 0, and the briefing then filed the lost work under "ALREADY APPLIED — do not
   repeat". `kernel/commit-ledger.ts` (ADR 0142); the run now _waits_ for each verdict rather
   than sampling for one, because the graph's event queue gives no ordering to sample against.
3. **Cleared tool payloads were unrecoverable.** `compactAgentLog` cleared results behind
   "re-read if needed" while only `measure_color` was ever stored — so a stock search's
   `remoteId`s were gone, and re-reading meant another metered request. Every host-tool
   payload is stored now, and the marker names the handle to recall it with. **This is the
   mechanism behind the fabricated paths**, reproduced identically in both attempts.
4. **`add_asset` accepted any string as a media path** and the validator checked only id and
   folder, so `stock://pexels/20349219` reported `valid: true`. Shape guard at the tool
   boundary (both languages, one shared validator), existence proof at the host.
5. **`add_stock` could not fill the bin.** Download and placement were one act, so the second
   candidate of any comparison collided with the first — the run said twice it was "locking
   the media into the bin first" and no tool did that. An absent position now means the bin.
6. **The completion gate was never installed.** `assessEditCompletion` had one caller,
   `autonomous-edit-runtime.ts`, which no production code ever ran — a green suite for a rail
   that was not there. Folded into the conductor's finalize (plan-completeness only); the
   parallel runtime deleted; the wiring itself now guarded by a test.
7. **The whole prompt was stored five times and replayed once.** `nextAction` was the one
   echo the briefing's filter missed, so "DO THIS NOW" re-sent a ~7,000-token brief every turn
   — under the heading whose job is to name one step, fired exactly when the run had stalled.
8. **"Couldn't apply" showed one hardcoded line for two unrelated causes**, sending the user
   into a retry that could not succeed. The host's `commit.reason` now reaches the screen.
9. **Voiceover and sound effects were silently undeliverable.** No TTS tool, no SFX
   catalogue, and the brief asked for both per scene. Extends the existing `deliverableFile`
   disclosure rather than inventing a second mechanism.
10. **The main-process commit path had no tests.** Gaps 1, 2 and 8 all lived there.
    `decideCommitTarget` and `unresolvableAddedAssets` are extracted and covered.

11. **The bin-gather mode never reached the desktop app.** Gap 5 above landed in
    `editor-core`, the orchestrator and the tool description, but not in `main.ts`, where
    `atSeconds ?? 0` still turned "no position" into "position 0". So it ran the ADR 0140
    occupancy gate against a span nobody asked for, and echoed `atSeconds: 0` back — which
    made the orchestrator's `undefined` branch unreachable on the priority surface. Captured
    run `8e717596` shows the result: one `add_stock` succeeded in 4.4s, the next four failed
    in under 70ms each against the clip it had just placed. Extracted to
    `apps/desktop/electron/ai/stock-host.ts` behind an injected `StockHostIO` and tested
    against the orchestrator's matching rule. ADR 0145.
12. **A refusal named the problem and never the remedy.** "Pick an empty stretch" is
    actionable for someone who can scrub the timeline and useless to an agent that cannot.
    `firstFreePictureStart` joins `picturePlacementConflict` in `picture-occupancy.ts`,
    computed from the same merged spans so a suggestion can never name a moment the predicate
    then refuses; the agent refusal, the host's pre-download refusal and the Stock panel's
    disabled **Add** all name it, and the orchestrator also returns it as data
    (`StockPlacementRefusal`). ADR 0145.

Evidence: ai-sdk 3346, editor-core 925, desktop 477, web-editor 2595, mcp-server 135, engine
2624 — all green; workspace typecheck and per-package lint clean. Three golden corpora
regenerated; every delta inspected and attributable (+77 tokens/turn of tool descriptors, the
acceptance criterion changing from a copy of the request to a pointer, operations gaining
`patchId`, facts gaining the evidence citations they always should have carried, and the
`plan-approval` scenario now reporting the planned step it silently left undone).

Not addressed, and deliberately: whether to BUILD narration or SFX sourcing is a product
decision, not a gap — item 9 is disclosure only.

Not addressed, and deliberately: stock still does not STACK. Run `8e717596`'s operator
expected the AI insert to auto-layer the way the manual drag-and-drop path does (ADR 0032,
`placeAssetPatch`), and that divergence is real — but it is the one ADR 0140 chose on
purpose, because the preview flattens picture layers into one chain while the export
composites them. The Stock panel's one-click **Add** does not auto-layer either, so the AI
and UI stock paths agree today. Lifting the constraint is `SUC-P1`, a compositing project,
and remains a maintainer decision rather than a bug fix.

**Status snapshot (2026-08-25, the question surface):** `[x]` **`ask_user` is answerable and
its answers are readable; a run that ends without settling a step no longer leaves it
spinning.** Reported from a real desktop run.

1. **The question card was prose with no affordance.** Options rendered as a label and a
   description with nothing to click but the words, so a card asking about a 640×360-into-
   1080×1920 mismatch read as three paragraphs. Rebuilt as a decision card: a badged heading,
   full-width choice rows with a radio mark that fills on the way out, hover targets, the
   free-text answer in the same card, and a footer that separates Send from **Dismiss and
   stop** (which is not the quiet twin of Send — it stops the run).
2. **You had to expand two blocks to read back your own answers, and found JSON inside.** A
   settled `ask_user` row is no longer an accordion at all: `AskReceipt` shows the question and
   the answer inline, in the words both were written in. The details/copy affordances that
   served the raw `{ question, answer }` payload are gone from ask rows.
3. **Dismissing left the row spinning forever.** Dismissing STOPS the run, so the card it
   belonged to is never settled by a `tool_result` — it kept its spinner, its elapsed counter
   climbed for minutes, and it kept offering a reply box the dead gate could not receive. Any
   node still marked `running` while no run is in flight now settles as stopped (`staleStatus`,
   plus `AiSidebar`'s `runEnded`, which deliberately does NOT fire for a durable run this
   renderer is one paint away from re-attaching to). The receipt distinguishes answered,
   dismissed, and never-answered, remembering a dismissal the stopped run could not report.
4. **`.ai-ask*` had three owners and they disagreed.** The stale copy in `styles.css` stacked
   each choice `flex-direction: column`, putting the radio mark on its own line above its
   label — the same three-files-one-component failure the notice card had. Deleted;
   `AiSidebar.beautiful.css` owns it.

Evidence: web-editor 2587 tests green (4 new in `EventNode.test.tsx` covering the receipt, the
dismissal memory, and the stale-run freeze), typecheck + lint clean, and the card rendered
against the real stylesheets in light and dark.

**Status snapshot (2026-08-25, tool-surface audit):** `[x]` **An audit of the 85-tool registry
found one contract defect and one unreachable setting; both are fixed on
`fix/tool-contract-and-embeddings-ui`.**

1. **`add_music`/`add_stock` carried a pure-read contract.** Both were missing from
   `TOOL_CONTRACT_DECLARATIONS`, so they fell to the `analysis` kind default and resolved
   identically to `get_frame` — cacheable, parallel, and needing no `write`. Because
   `QUESTION_ROUTE_PERMISSIONS` is `['read','analysis']`, the question route advertised both
   while correctly withholding `trim_clip`/`export_video`: a turn that cannot apply ops could
   still download media and place a clip. `mutates` cannot catch this class (`analysisTool`
   always sets it false), so `analysis`-kind tools are now classified EXHAUSTIVELY in
   `tool-contract.test.ts`, mirroring how `tool-classification.ts` fixed the same drift for run
   memory — a new analysis tool fails CI until someone decides whether it changes project state.
   Verified: question route 34 → 32 descriptors, agent route unchanged at 80.
2. **`nvidiaEmbeddings` was the only live `BrowserAiConfig` field with no UI.** The storage
   field, setter, and request threading all existed; `MediaIntelligenceSettings` rendered only
   the TwelveLabs input, so on-device visual search was reachable only through a server-side env
   var — the real reason `search_visual`/`describe_footage`/`map_footage` read as broken. Added
   the field, and made the backend badge name the backend that will actually run (TwelveLabs
   resolves first) instead of the one most recently typed.

3. **The MCP boundary is now a stated position, not an artifact.** 13 tools are `hostUiOnly`
   and absent from the MCP surface, and the docs gave one reason for it — "no authoritative
   live editor state" — which is true of the `professional_*` controllers but NOT of the four
   sourcing tools, whose real reason is that the provider network and keys live in the Electron
   main process. `docs/api/mcp-server.md` now groups all 13 by their actual reason and says
   which groups could ever be lifted (sourcing: yes, given a keyed egress path outside main;
   `ask_user`: never). Do not promise MCP parity with in-app Agent mode without moving one of
   those rows.
4. **`detect_faces` removed from the docs.** It was described in four places as a registered
   tool awaiting its engine; it is not in the registry at all — the Subject Intelligence pack
   superseded it with `detect_subjects`. `generate_mask` is the only `available: false` tool
   left, and it is not waiting on a model. `docs/architecture/ai-engine.md` had also claimed
   `analyze_silence`/`detect_scenes` were unavailable; both shipped long ago.

Checked and found already correct (no change needed): `search_stock` already reports remaining
provider quota to the model, and `search_music` cannot — Openverse is keyless and anonymous, so
it reports no allowance, only a 429 whose retry-after is already surfaced legibly. Run-memory
scope for `add_music`/`add_stock` was already `timeline_dependent` in `tool-classification.ts`.

Known limitation, unchanged and correctly enforced: `add_stock` REFUSES rather than stacks when
the target span already holds picture, because the preview flattens picture from every track
while the export composites it (ADR 0140). The refusal is the feature — `buildAddStockOps`
returns null with a paired reason sentence, and a test asserts the Stock panel and the tool
cannot disagree. Lifting it is the picture-layer work (SUC-P1), which needs maintainer sign-off
before anyone starts it.

**Status snapshot (2026-08-22, second pass):** `[x]` **Run 2 (`e6d5ba92`) re-tested the fixes
above and exposed a deeper class of gap: the runtime was deciding editorial questions, and the
completion gate could not see coverage.** The run completed, met both measurable criteria (50+
shots, 30.0s) — and delivered the editor's most emphasised requirement on 9 clips of 47.

Confirmed live from that transcript: acceptance criteria recorded and checked, the
"Deterministic self-check" wording, a skip line carrying only its reason, the empty-scene
reading, and the unevidenced-montage caveat — which fired correctly and whose warning the editor
repeated back as their next instruction. Five transitions, no black-frame findings (ADR 0135
holding, pending the verification noted in `run_report.md`).

Fixed in this pass:

1. **`aspect_fill`/`reframe_coverage`** — nothing checked whether picture fills the frame, so a
   vertical cut with 38 letterboxed shots passed. Asked as a consistency question (a MIX of
   reframed and unreframed picture is a defect whatever the sources are), because the project
   does not carry per-asset pixel dimensions.
2. **Crop visibility** — `get_clips` rows gained `cropped`/`graded`. Crop was the one clip
   property with no cheap read, so "which of my 47 clips still need reframing" cost 47 calls,
   which means it was never asked.
3. **Coverage acceptance** — "every clip", "per clip", "across clips" plus a treatment is now a
   criterion, and `treatment_coverage` fails naming the shortfall ("colour grade: 1 of 47").
   Read per LINE so a quantifier cannot reach a treatment in another sentence.
4. **The authority split — ADR 0137.** `propose_edits`'s seven hardcoded rules (a move and a
   hand-tuned score per signal, a reveal-word regex over chapter titles) became
   `read_edit_signals`: measurements in time order, no `kind`, no `score`, no canned `why`, and
   a `from` field saying whether each signal was supplied or measured. The beat grid keeps
   snapping near-misses but now REPORTS a far miss instead of refusing it, unless the run
   declared `hardSync` on `detect_beats`. Facts and guarantees stay in the runtime; judgement
   moved to the agent.
5. **`index_media` withheld from the model** — the contract was asserted in two places and
   enforced in one, so the interactive agent advertised it. One-line filter plus the scope test
   that was actually missing.
6. **Deliverable honesty** — a brief asking for a rendered file now hears, once, that the panel
   cannot render and the Export dialog is where the edits become a file.
7. **Browser context parity** — the browser session now reads the visual status, the cached
   footage map and the session digest the desktop hub already read. Run 2 asked the agent to
   "choose from footage map" while its context carried four section labels in total; the agent
   invented the chapters instead.

Deferred, with reasons in `run_report.md`: the 44-revision gap between turns (GAP-210 — needs
host plumbing on both surfaces for a Medium finding whose main consequence the coverage checks
now catch) and the track-label question (GAP-211 — unresolved whether the UI disagrees).

Evidence: 3167 ai-sdk, 2597 engine, 2435 web-editor tests green; ruff/mypy/eslint/tsc clean.
Tests that encoded the old policies were split across both modes rather than deleted.

**Status snapshot (2026-08-22):** `[x]` **A captured agent run (`run.md`) was traced end to
end against the code; nine of its defects are fixed and two of its apparent defects were
mis-read by the analysis.** One 28-minute run, five turns, zero net edits. The gaps it proved:

1. **Transitions composited over black at every cut.** A transition sits on butt-joined clips,
   so while the incoming clip eases in the outgoing one has already ended — a cross dissolve
   dissolved up from black, a whip pan whipped in over black, in the render and both monitors.
   The run's perceptual reviewer reported exactly this at all seven cuts (frames 90, 195, 300,
   405, 525, 615, 735 = 3.0/6.5/10.0/13.5/17.5/20.5/24.5s) and could never be satisfied,
   because the fault was not in any proposal. A ramp now carries the neighbour's handle
   material (or its held edge frame) underneath. **ADR 0135.**
2. **`crop` masked in place in the monitor and filled the frame in the render.** The editor saw
   a small picture in black while the export was full-bleed, reported it, and the agent wrote
   compensating scale keyframes (3.2×, then 1.78×) which the render applies _on top of_ its own
   fill scale. `preview/crop-fill.ts` now holds one arithmetic for both monitors. **ADR 0135.**
3. **The beat grid vetoed proposals with no cut in them.** `resolveGrid`'s ungrounded rejection
   ran before boundary collection, so once `detect_beats` had run every later proposal was
   rejected while the analyzed asset sat off the timeline — including an eight-call
   `set_clip_crop` step, which is how the vertical reframe the editor asked for never landed.
   Relevance is decided before groundedness now.
4. **The objective was a copy of the request**, so verification could only ask "did anything
   succeed" — a request for "20+ different best moments" was satisfied by eight shots.
   `acceptance.ts` reads the checkable conditions and the Critic gains `shot_count`. **ADR 0136.**
5. **A failed verification was filed with a passing detail** (`passed: false` next to
   "Passed with 1 warning(s)"). One reason, two consumers. **ADR 0136.**
6. **A dropped or truncated step ended the run.** Both land after a 200, where the resilient
   provider cannot see them; one failed a run the UI called retryable, the other published
   "Rebuilding the 30 seconds as a 23-shot" as the run's last word. One in-place retry, keyed
   off the provider's own stop reason. **ADR 0136.**
7. **Unbounded re-steering of an unfixable finding**, and a clean deterministic self-check
   reported while the perceptual review still held one. One attempt per defect class; the
   completion account is amended. **ADR 0136.**
8. **A repeated `get_frame` was refused its own picture.** The memo key carries the revision, so
   a hit proves the frame is current — but the image had been stripped from context a turn
   earlier, and the replay told the model to answer from a picture it no longer had. That is how
   the run produced a confident, wrong reading of its own framing.
9. **Nothing the editor told a run outlived it.** `createSessionContextDigester` had no caller,
   so the editor's answered question ("Full-bleed vertical crop") died with the run that asked
   and the next run rebuilt the montage uncropped. Desktop now reads the session digest per run,
   and an answered `ask_user` writes a durable note.

Also: an empty `detect_scenes` result now carries its own reading (a continuous take is not
guidance on where to cut), the two perceptual gates' thresholds live in one documented table
with a cross-language parity test, the "Skipped: N proposed changes" line carries only the
reason instead of a read tool's raw JSON, and a montage assembled with no content evidence says
so in its own report.

**Two findings the analysis got wrong**, corrected here so they are not re-fixed:
`ContextInput.footageMap` DOES have a producer — `main.ts` wires `footageMapFor` with
`cachedOnly: true`, deliberately, so a cold project simply gets no map block rather than
stalling a run on a billable Pegasus round-trip. And the 24-tool
`autonomous-tools.manifest.json` is not a competing surface for the interactive agent: its own
header states it is the smaller public surface for the autonomous orchestrator, MCP projection
and Python mirror, while the full registry stays the interactive catalog. The measured cost of
that registry is real and unchanged (78 descriptors ≈ 15,710 tokens per request at every stage
except `apply`, which trims to 58 ≈ 12,317) — consolidating it is a maintainer scope decision,
not a bug fix, and was left alone.

Evidence: 3161 ai-sdk, 2597 engine, 2429 web-editor tests green; ruff/mypy/eslint/tsc clean;
per-package coverage green. `pnpm verify` passes every gate except `test:visual`, which fails
two AI-sidebar screenshots that fail identically on a clean `main` (seven panels fail there):
both diffs are character-identical text ghosted ~1px down the panel — a font-metric shift on
this machine, not a content change — and none of the copy changed here appears in either
snapshot. Those baselines have been regenerated twice before (`64e4db1`, `b19438c`);
regenerating them again is a separate call.
Two engine transition tests were rewritten because they encoded the defect (one solid-colour
asset on both sides of a cut cannot tell a working transition from a black flash; another
asserted a centred ramp is _darker_ before the cut, which was only true while it faded to
black).

**Status snapshot (2026-08-21):** `[x]` **Footage understanding showed nothing for new
footage — nothing was ever indexed.** The panel said the clip "is not indexed yet" and pointed
at a media-bin action that does not exist; Rebuild re-asked for a map that could never appear;
no progress showed because nothing was running.

Root cause was one call: `create_index` asked TwelveLabs for Marengo **and** `pegasus1.2`
(`/analyze` used to require a Pegasus model on the index). TwelveLabs sunset `pegasus1.2` for
indexing, so `POST /indexes` — the FIRST call any project's first indexing slice makes —
answers HTTP 400 `parameter_invalid`. The job died there, so the brain had zero visual spans
and zero `tl:video` rows, and every honest surface downstream correctly reported
`not_indexed` forever.

Fixed: indexes carry **Marengo only**, and `pegasus1.5` analyses the **uploaded asset**
directly (`video: {type: "asset_id"}`; it rejects `video_id`). The uploaded asset id is
persisted on the existing `tl:video` row (`sourceAssetId`, no schema change) and recovered
once from the index for older mappings, so footage indexed by an earlier version maps without
a billable re-upload. Pegasus' own JSON mis-escaping is decoded tolerantly with one
schema-in-prompt retry, so a provider formatting bug no longer reads as "no structure".
And unread footage now gets an ACTION: a **Read this footage** button running the same paced
preparation pass an import runs, streaming its progress and naming its failures. ADR 0134.

Evidence: live-API probes established each contract change; engine tests cover the
index-create regression, the `/analyze` request shape, the mis-escape recovery, the single
retry and the legacy id lookup (2584 engine tests green, ruff + mypy clean); panel tests cover
unread → read → map and each honest failure.

**Status snapshot (2026-08-21):** `[x]` **The agent leaked its own run state into the
chat, and into the edit history.** A captured run opened 21 of its replies with harness
bookkeeping — _"I'll continue from the interpret stage."_, _"I'll continue from where the
run left off."_ — and because the run has one text channel, the same sentence was stored as
the patch `reason` and rendered as the proposed edit's Summary and Reason.

Root cause: `buildStateBriefing` hands the model an imperative second-person briefing
("You are at 'interpret'. Continue from here."), and nothing in the contract said which of
that machinery the editor may see. Every rule governed what the model should _do_; none
governed what it may _say about itself_. Not a truncation/retry/cancellation artifact — the
leaking turns were ordinary successful ones.

Fixed at the contract (a privacy clause on the briefing itself, and a NARRATION rule opening
the agent contract) **and** independently at the kernel (`kernel/narration.ts`, filtering the
assistant delta stream in `streamProvider` — the one point every route's model text passes
through). `text` now accumulates what the filter let through, so the string the editor read,
the string stored as the patch reason, and the string the reducer signatures the turn by are
the same string. ADR 0130.

Evidence: 3091 ai-sdk tests green, lint + typecheck clean, `narration.ts` at 100%
line/branch/function coverage. Both new test files mutation-tested — with `isRunChatter`
forced to `false`, all six run-level guards (clean, complete()-only, cancelled mid-sentence,
provider throws, truncated, retried turn) fail. All 15 golden fixtures re-recorded; the
complete diff is token-estimate deltas (+167/request, ~0.9%) with **zero** event, ordering or
behavioural divergence.

**Status snapshot (2026-08-21):** `[x]` **The same run's other two defects: the agent could
not tell its own actions apart, and was told success was failure.** In that capture
`auto_emphasize_captions` ran eight times and **succeeded seven**, yet the run finished
believing emphasis had never landed. Two records were lying, and they compounded:

1. `summarizeOperations` built the tool-result note from the OPERATION, so
   `auto_emphasize_captions` and `set_track_caption_style` — which both emit
   `set_track_caption_style` — logged the identical line "Set track caption style Caption 1"
   (28 times in the capture). That note is the tool result, the agent log, AND the
   `ALREADY APPLIED` row, so the run's memory showed only styling and never emphasis.
   Fixed: when a tool's name is not among the ops it produced, the note reads
   `intent → outcome` ("Emphasising key words in the captions Caption 1 → Set track caption
   style Caption 1"). A runtime rule, not a table — every such tool benefits.
2. A turn refused by the repeated-patch guard was recorded as a `failed` operation, which the
   briefing renders under `FAILED — fix the cause, do not retry unchanged`. That appeared
   **24 times** for emphasis that was correctly on the timeline. The model looked for a cause,
   found none, retried, produced the same patch id, and got the same "failure". Fixed:
   `AgentTurnResult.satisfied` marks the no-op branch, the reducer records `succeeded` with no
   failure reason, and it lands under `ALREADY APPLIED`. Genuine rejections are unchanged.

3. The completion report rendered `${action}: ${detail}` unconditionally, and
   `describeOperation` returns an empty detail for any op without start/end — so the run
   closed with eight rows of `Set track caption style:`, a dangling colon over nothing, and
   no mention of which track. Its "Skipped: 2 proposed changes did not validate" counted the
   already-applied no-ops. Fixed: a shared `operationLine` (action + subject + detail) used by
   both the note and the report, identical lines collapsed to one row with `(×N)`, and
   satisfied turns excluded from the rejection tally.
4. The verify fold records `criterion: objective.description`, and objectives are seeded from
   `userPrompt` — so the run's memory ended with `PASS <the entire request> — All checks
passed.` on a run that called **no effect or transition tool at all**. `buildStateBriefing`
   feeds that straight back to the model under `VERIFIED`: the CLAIMS OF COMPLETION overclaim
   the contract forbids, arriving through the one channel the contract cannot reach.
   `briefing.ts` already suppresses this echo in three other sections; `VERIFIED` was missed.
   Fixed: an echoed criterion renders as `the timeline consistency checks (NOT the request
itself)`; a real criterion is untouched.

ADR 0131. Evidence: `agent-call-note.test.ts` (end-to-end through `streamAgent`),
`kernel/already-satisfied.test.ts` (through the real reducer, 9 cases) and
`orchestrator-stream.test.ts`, every fix mutation-tested; 3111 ai-sdk tests and all workspace
tasks green. Only golden movement is the report gaining its subject
(`- Deleted range: 0s–3s` → `- Deleted range Video 1 · 0s–3s`), which is the fix.

**Status snapshot (2026-08-21):** `[~]` **FRAMEPILOT-95 Phase 2 §7.3 started: property coverage
over generated operation sequences.** `packages/editor-core/src/operation-algebra.property.test.ts`
generates legal operation chains (seeded PRNG, 8 fixed seeds, 8-11 applied ops each, spanning
trim/split/delete_range/ripple_delete/text-overlay) and asserts the algebra's laws:
apply-then-invert is identity on content, every PREFIX inverts independently (localizes a bad
inverse to one step), composition never corrupts structure (checked after every prefix), and a
stale target fails closed.

**Result: no defects found — the algebra is sound.** Recorded plainly; a property suite that
finds nothing is evidence, not a failure. Load-bearing per mutation testing: a stale inverse
state fails 12 of its 25 cases vs 2 of 27 in `patch.test.ts`.

Two flaws were mine, not the engine's, and are worth remembering: (1) `delete_clip` is a TOOL
name, not an operation type — editor-core's delete vocabulary is range-based, and the engine
correctly rejected the unknown op rather than no-op'ing; (2) `applyPatch` advances `revision`,
so apply-then-invert is identity on CONTENT while the revision clock moves forward — an undo
is a new revision, not a rewind. The test asserts both halves separately.

Extended to cover **six of §7.3's seven rows**: added the revision-clock IFF law (`revision`
advances iff the source↔sequence mapping changed per ADR 0076 — the signature it compares
against is written independently of `mappingChanged`, since a test reusing the function under
test proves only that it equals itself), serialization round-trip (equal after JSON round-trip
AND behaviourally identical under the next operation), and input immutability (a
shared-reference leak would let state change with no operation recorded to invert). All three
mutation-tested: always-bump fails 7/49, never-bump fails 16/49, mutating-the-input fails
24/49.

**CORRECTION (same day, found while auditing §7.1).** I earlier recorded that "editor-core has
no revision precondition" and left the staleness row open. **That was wrong.** It came from
grepping for `baseRevision`/`expectedRevision`/`atRevision` and missing the real names:
`EditorCommandBase.timelineRevision` and the `stale_timeline` rejection. Every `EditorCommand`
is revision-bound by construction, and `compileEditorCommand` runs `validateAuthority` **before
every dispatch**, already covered by `professional-commands.test.ts:464`.

The real gap is narrower and more useful than the one I reported: **the guard protects the
COMMAND path only.** Raw `applyPatch` has no revision precondition, and per the §7.2 audit the
web-editor uses exactly that raw path. So a stale AI command is rejected while a stale UI edit
is not. That is a concrete, testable follow-up, and a better lead than "no guard exists".

**§7.2's capability matrix is now audited against code** (not filled in by guess): 12 rows ×
8 columns, sourced from `listEditorCapabilities()` (34 registered capabilities carrying
commandType/tool/compiler/verifier/inverter/operationTypes), `TOOL_REGISTRY` (43 mutating
tools), and a per-surface grep of the web-editor. Preview/export columns are marked `?` — NOT
audited, not guessed.

**The structural finding: the UI does not go through `EditorCommand`; the AI and MCP do.**
`compileEditorCommand` has three non-test consumers — the AI professional-edit tool, capability
discovery, and the evals. No UI file imports it; the web-editor builds raw operations in
`apps/web-editor/src/editor/patch-builders-base.ts`. MCP converges via `TOOL_REGISTRY`.

The shared `validate → apply → revision` authority DOES hold. What is not shared is command
semantics: `roll`, `slip`, `slide`, `insert`, `overwrite`, `lift`, `extract`, `replace`,
`j_cut`, `l_cut`, `switch_angle` exist **only for the AI** — a human editor cannot perform any
of them; there is no shortcut, menu item, or control that reaches them. So Phase 2's real work
is not "converge two implementations of roll", it is "the UI has no roll at all".

Other audited findings: transitions and captions have working UI+AI but **no capability-registry
entry**; motion/colour/audio are registered as `property`, not `command`, so whether §7.1's
contract covers them is unresolved; multicam has **zero** UI components; the mask Inspector
dispatches but `bounds` is **hardcoded** to the centre 60% with no handles or fields, so a user
cannot place a mask (engine ✓, UI operable ✗ — matching the 2026-08-16 audit, which my own
quick grep initially contradicted before I checked the source).

**§7.1 audited, and its most load-bearing gap closed.** `listEditorCapabilities()` IS the
canonical contract and already carried 5 of the 10 required elements (deterministic target,
compilation, validation, apply, invert). Added the sixth: **explicit time domain**.

`editor-core` already encoded this as `FrameDelta<'source'>` vs `FrameDelta<'sequence'>` in the
command interfaces, which is the right place to check it, but a phantom type parameter vanishes
at runtime, so the discovery surface the model actually reads never carried it. Capabilities now
declare `timeDomains`, read off each command's own signature rather than guessed: `slip` is
`['source']`, `slide` is `['sequence']`, `insert`/`overwrite` are `['sequence','source']` (they
position in sequence and trim in source), `lift`/`extract` are `[]`. Property capabilities
(motion/colour/audio) are `[]` — declaring a timebase on a value that has none would invite a
conversion that makes no sense.

This matters specifically because ADR 0076 calls two-timebase confusion the single most
expensive thing to get wrong AND invisible when wrong. `editor-capabilities.test.ts` pins every
row against the command signatures and asserts the full command set is accounted for, so a new
command cannot arrive undeclared. Mutation-tested: declaring slip as `sequence` fails 2 of 10.

**§7.1 preconditions: SHIPPED (later the same day).** I first declined this as needing a
call-graph pass. On re-examination the honest answer was a declared **superset**, which is
accurate and useful without one. `editor-core` now exports `COMMAND_REJECTION_CODES` and
capabilities republish it as `preconditions`, so a UI can grey out a roll and say
`not_adjacent` rather than parsing tool prose. Helper-raised codes are listed for every
command (over-listing is safe for these consumers; under-listing would not be), and
`command-preconditions.audit.test.ts` reads the compiler's source and fails when a command
raises an undeclared code. Mutation-tested. The audit paid for itself immediately: it caught
two errors in my first hand-written table, where a helper defined between two compilers had
its codes attributed to the one above it. §7.1 is now 7 of 10 elements.

Formerly-missing, superseded by the above: the
vocabulary already exists as structured rejection codes from `compileEditorCommand`
(`not_adjacent`, `clip_too_short`, `insufficient_source_handle`, `locked_track`, …), which is
exactly what a UI needs to grey a command out and say why. I did NOT ship the field: those
codes are only partly derivable per command. Seven compilers raise theirs inline, but
`compileInsert` and `compileOverwrite` raise none directly — theirs come from shared helpers
(`trackForCommand`, `assertLocations`, `ensureHandle`, `compilePatch`), so declaring `[]` for
those two would assert "no preconditions", which is false. Doing it right needs a call-graph
pass, or better, moving each command's codes into a declared table the compiler reads FROM, so
contract and enforcement cannot diverge. Left undone rather than shipped half-correct.
**§7.1 human-readable description: SHIPPED.** Every capability carries one sentence naming the
mechanism rather than the label, since that is what distinguishes the confusable pairs (slip
vs slide, lift vs extract). Written from each compiler's verified behaviour, not from the
command name. §7.1 is now **8 of 10**. Remaining: replay semantics, and the diff/receipt link
is still convention (`describeOperation` produces it; the capability does not reference it).

Also missing: **human-readable description** (lives on the AI tool, so UI/MCP cannot render a
capability without parsing tool prose), **replay semantics**, and the diff/receipt link is by
convention (`describeOperation` produces it; the capability does not reference it).

Phase 2 is NOT complete.

**Status snapshot (2026-08-21):** `[x]` **FRAMEPILOT-95 Phase 1 follow-up #2 closed as WON'T
DO: the single-shot `edit` route stays (maintainer decision, ADR 0133).** The roadmap's
"1 mutating AI runtime" criterion was literally false while `edit` existed. The criterion was
what was wrong, not the code: `edit` has no loop, no conductor, no durable checkpointing, and
no authority the agent lacks — it makes one model call and goes through the SAME
`assembleEdit` validate/diff path. It is a proposal surface over the one runtime, not a
parallel implementation of it.

Converging it would have meant deleting `variations` (a shipped browser capability, removed
to satisfy a sentence in a plan) or rebuilding it on a turn-bounded agent run — which risks
reintroducing fabricated cost numbers, since `editVariations` deliberately uses `complete()`
because a stream cannot carry real token usage on its terminal chunk. Neither buys the user
anything.

§4 now reads "1 mutating AI RUNTIME … explicitly not one mutating entry point"; the exit
criterion and benchmark table are updated to match. Recorded in ADR 0133 specifically so a
later agent does not "finish" this by deleting a feature. Reopens if `edit` ever grows its own
retry/checkpointing/validation authority. No code changed.

**Status snapshot (2026-08-21):** `[x]` **FRAMEPILOT-95 Phase 1 follow-up closed: the beat
grid has a caller.** `kernel/beat-grid/beat-alignment.ts` — a complete, tested editorial
guarantee — had **zero callers** since ADR 0126 retired the planned-edit driver. The agent
could call `detect_beats`, receive 300 exact onsets, and place cuts anywhere, with nothing
checking one against the other.

Wired at `Orchestrator#applyAgentTurn` (both turn loops + the repair pass), exactly where the
module's own header said to. The raw payload is threaded per run via a
`HostCallContext.beatEvidence` box, not held on the Orchestrator (concurrent runs). It could
NOT come from the evidence store: analysis results are never stored there — only reads and
`measure_color` are — which is recorded in ADR 0132 because it is the first thing a later
reader will ask.

**The gate is the agent's own decision**, which is the Phase C property: the rule engages only
when the run elected `detect_beats`. No beat-sync mode, flag, or classifier exists, and a run
that never analyzed the music is provably untouched (asserted by test). Runtime owns execution
and safety; the model owns editorial strategy.

Added `beatGridFor()` — a narrow export of the semantic index's existing `deriveBeats` — so
music placed on an EARLIER turn resolves, which the module alone could not do. Narrow on
purpose: the full `SemanticTimelineIndex` would compute scenes/silences/music/chapters every
turn to read one array.

Evidence: `beat-grid-wiring.test.ts` drives real `streamAgent` runs — near-misses snapped,
far-off cuts rejected naming the nearest onset and never reaching the timeline, no-beats run
untouched. Mutation-tested (unwiring fails 2 of 3, third correctly unaffected). 3114 ai-sdk
tests green. Limitation in ADR 0132: governs add_clip/trim_clip/split_clip picture boundaries,
not move_clip/ripple assembly.

**Status snapshot (2026-08-21):** `[~]` **FRAMEPILOT-95 Phase E — time-to-first-visible-edit
is now measurable; the number is NOT yet measured.** Added `timeToFirstEditMs` to the existing
Phase-0 harness (`agent-run-quality.ts`) — ms from the run's first event to the first
`timeline_action`/`diff`, i.e. the first instant the editor sees the timeline move. Distinct
from `wallClockMs`: a run can finish fast and still feel broken if nothing moves for ninety
seconds. Absent (never zero) when the run produced no visible edit — the captured run's exact
shape, where a zero would report the worst run as the fastest. Percentiles join the existing
top-line score via `summarizeAgentOutcomeRuns`. Derived from events the harness already
captures, so a real-media run reports it with no new instrumentation.

The measuring rig now accepts REAL MEDIA. `eval/foundation-real-eval.ts` drove every scenario
against `makeProject()` — a few seconds of synthetic fixture — so its latency numbers could
never have supported a footage claim (goal.md: "Do not use tiny fixtures alone to support a
long-form performance claim"). It now loads a real project from `FRAMEPILOT_EVAL_PROJECT`,
parsed through the canonical `parseProject` so a stale/malformed file fails loudly instead of
silently measuring the wrong thing. Every artifact and job summary is stamped
`media: 'fixture' | 'real-project'`, and a fixture run prints "these latency figures do not
support any claim about real footage" — so a fixture number can never be mistaken later for a
real one. `timeToFirstEditMs` p50/p95 is now a row in the job summary.

So measurement is one command once media + keys exist:
`FRAMEPILOT_EVAL_PROJECT=/path/to/real.fp.json GOOGLE_API_KEY=… pnpm eval:agent:foundation:real`
(env var mirrored into `.env.example` + `turbo.json` globalEnv per CLAUDE.md §2).

**No latency, cost, or editorial-quality number is claimed.** Per the maintainer's decision,
measurement waits on real desktop-scale media and a `TWELVELABS_API_KEY`; a scripted provider
cannot produce either (the same reason the roadmap's Phase 1 latency condition was waived).
`plan/FRAMEPILOT-95-CONVERGENCE-ROADMAP.md` Phases 2-11 remain not started.

Known gap left open deliberately: the repeated-patch guard keys on operation content alone,
so returning the timeline to an earlier state (style S → T → S) is still refused as
already-applied though it is a real change. Not the cause of this failure; fixing it means
comparing against the working project rather than a hash set.

Correction to a premise carried in the request that prompted this work: there is **no**
hardcoded beat-sync conditional or mode flag to remove. The classifier routes only
`chitchat | question | edit` (ADR 0126); beat sync is already a tool the agent elects. The
real open item is the reverse — `kernel/beat-grid/beat-alignment.ts` has **no callers** and
is unwired, tracked as the Phase 1 follow-up in
`plan/FRAMEPILOT-95-CONVERGENCE-ROADMAP.md`.

**Status snapshot (2026-08-20):** `[x]` **Fix: two tool schemas broke the native Claude
Messages API.**

Calling the real Claude Messages API through the `openai-compatible` provider against the
`trial/` auth2api proxy (which forwards the OpenAI-shaped request into a real Anthropic
call) failed with `400: tools.23.custom.input_schema: input_schema does not support
oneOf, allOf, or anyOf at the top level`. Two advertised tool schemas — `map_time`
(`tool-input-contract.ts`) and `professional_audio` (`domain-tools/professional-audio.ts`)
— put a top-level `oneOf`/`anyOf` directly under `parameters`, which Anthropic's real API
rejects outright. Both are now flat object schemas: `map_time` documents its
sourceTime/sequenceTime exclusivity in prose (enforced at runtime by the unchanged
`assertMapTime`), and `professional_audio` merges its six intent variants into one
property bag with an `intent` enum (enforced at runtime by the unchanged
`AudioObjectiveSchema.parse`). Added a standing regression test
(`tool-registry.test.ts`) asserting no tool ever advertises `oneOf`/`anyOf`/`allOf` at the
top level. Regenerated every fixture the token-estimate shift touched (five
`langchain-anthropic-sessions` sessions, ten `golden-sessions`, the `streamAgent-golden`
snapshot, `ts_tool_registry.json`).

Evidence: ai-sdk test suite green; rebuilt `ai-sdk` dist confirms `toolDescriptors()`
carries zero top-level `oneOf`/`anyOf`/`allOf` across all tools.

**Status snapshot (2026-08-20):** `[x]` **Third stalled agent run — caption restyle
("can you use differnt caption style and emphasize the captions as well", deepseek-v4-pro, two
runs, 11 calls, $0.48, zero mutations).** Same failure family as the two montage runs below and
again not an orchestration-architecture gap: the run read the answer, could not keep it, and
could not ask for it back. Five defects, all fixed with `file:line` evidence:

1. **`recall_evidence` could not match a keyword query.** `evidence-store.ts#recall` tested
   `part.includes(wholeQuery)` — one literal substring — so `captionStyle track layer_caption_4
style` could only match if that exact 45-character string sat inside a single record. Every
   queried recall in both runs returned "No part of ev_N matches" against payloads that plainly
   contained the terms. Queries are now tokenised and scored (`rank`), with a whole-phrase hit
   ranked above scattered term hits. This mattered most on the ACTION RECOVERY turn, where
   recall is the ONLY retrieval tool left in scope.
2. **No way past the recall budget.** An unqueried recall returned `slice(0, 4000)`, so the tail
   of any larger payload was unreachable by any argument — the run recalled the caption catalog
   three times and got the identical head, cut mid-template, each time. `recall_evidence` now
   takes `offset` and every truncated answer names the offset to resume from (`page`).
   `recordsOf` also stopped requiring exactly ONE array property: two record lists sent a
   payload down the single-line JSON path, which covered both reads a caption run needs
   (`discover_caption_styles`, `get_mapped_transcript`).
3. **The digest dropped the field the request named.** `timelineDigest` rendered track
   id/type/flags/clips and never `captionStyle`, so the distilled fact was "5 tracks, 87 clips"
   while the payload held `templateId: headline` plus the accent already applied. Two turns
   later the raw payload had aged out of the rolling log window and the run went hunting for
   what it had already been told. `get_timeline` now carries the committed caption style, and
   `get_clip`, `get_mapped_transcript`, `get_timeline_summary` and `discover_caption_styles`
   have record-bounded digests instead of the blind 1200-char `previewJson` default.
4. **The template catalog was unreachable by construction.** 51 templates exist; `limit` was
   capped at 45 and defaulted to 20, so no call could return the catalog and `headline` — the
   style actually applied — sat past the cut. `set_track_caption_style` rejects an id the model
   was never shown, so the run could neither name what it had nor choose a deliberate
   alternative. Ceiling and default are now the catalog's own size on both sides of the
   TS↔Python contract.
5. **"contine" became the objective.** `onCommand` seeded outcome/acceptance/decision from the
   raw prompt, so the second turn's objective, success criterion, committed decision and the
   criterion verification checked were all the literal word "contine" — hence
   `VERIFICATION_INCONCLUSIVE`. `kernel/continuation.ts` resolves a bare nudge (typo-tolerant)
   to the request underneath it from `input.history`, while `objective.request` keeps what the
   editor actually typed; a message carrying its own content is never rewritten.

Evidence: 3,030 ai-sdk tests and 2,581 engine tests green; every touched file at 100% line and
branch coverage for the new code (`kernel/continuation.ts`, `kernel/evidence-store.ts`,
`kernel/working-state.ts`, `kernel/conductor.ts`, `domain-tools/captions.ts` all 100%;
`orchestrator.ts` branch 95.12 → 96.44). Ten golden corpora and one snapshot regenerated
(`objective.provisional`, tool-definition token estimates, and pre-existing unregenerated drift
in the `load_skill` unknown-skill finding — no event, operation or status changed). See
`docs/adr/0128-retrieval-the-run-can-actually-use.md`; ADR 0127 amended where this closes half
of an item it recorded as open.

**Status snapshot (2026-08-20):** `[x]` **AI panel alignment/whitespace + one on/off control.**
The notice card (errors, warnings, notices) was laid out by three stylesheets at once and they
disagreed: `AiSidebar.beautiful.css`'s `border: 0` silenced the tone stripe `styles.css` set, so
a failed run looked informational; `.ai-notice-body` was a flex ROW, which made the disclosed
`<pre>` detail a third COLUMN beside the message; a `margin-top` for the old column layout
knocked the action buttons out of line; and an info notice (no icon) started 20px left of every
warning in the thread. A two-column grid in `AiSidebar.polish.css` now owns the whole card, and
`tests/e2e/specs/ai-notice-layout.spec.ts` asserts the boxes — all three levels share a message
column at x=963, the detail is full-width beneath the actions, and the stripe is an inset shadow
that follows the 9px radius. Also: `.ai-markdown` styled only `code`/`pre`, so assistant lists
took the browser's 40px indent and 13px paragraph margins in a 300px panel; and
`.ai-plan-steps, .ai-plan-list` in `beautiful.css` matched no markup (the class is `.ai-plan`),
so the plan list never got its intended flex layout. Controls: "Keep inside safe area" became a
`Switch` (an immediate preference), caption row selection became the `Checkbox` primitive, and
the global `input[type='checkbox'] { accent-color }` rule is gone — it only ever themed a native
control that should not exist. The decision rule is now a table in `DESIGN_SYSTEM.md`.
Orchestration: `stage-policy.ts#planningExhausted` deleted — a caller-less duplicate of
`conductor.ts#researchBudgetSpent` whose docstring claimed a durable stage-level closure the
product never had.

**Measured, not fixed:** the agent ships **78 tool schemas ≈ 15.7k tokens on every turn** —
~90% of the observed 102k-token run. The three caption tools alone are 12.5k chars (20% of the
block), and `set_caption_style`/`set_track_caption_style` are near-duplicates at 8.4k combined.
Reducing this is roadmap Phase 4 §9.1 (dynamic exposure by project capability) and §9.2 wants
the telemetry before the cut; gating caption tools on "project has captions" would withhold them
from a run about to add captions, so it needs the eval evidence rather than a guess.

**Status snapshot (2026-08-19):** `[x]` **Agent read-fidelity + capability-honesty repair.**
A real montage-refinement run ("more precise cuts, at least 45 clips, don't keep the clips from
the starting offset") stalled without producing a patch. Root cause is not orchestration
architecture: every timeline read that carries **source in/out** — `get_clips`, `get_clip`,
`get_timeline_map`, `map_time` — had no entry in `summarizeReadResult`'s digest table and fell
through to the blind 1200-char `previewJson` default, so the model received ~4 of 42 records
with a bare `…` and no "N more" tail. It could not obtain the `sourceStart` it was asked to
vary. Compounding it: `summarizeVisualStatus` told a text-only run to "look at a specific
moment with `get_frame`" while `agentTools` had withheld every vision descriptor, and two
skill manifests advertised `index_media`, which is `IMPLICIT_ONLY` and never model-selectable.
Fixed: record-bounded digests for `get_clips`/`get_timeline_map`/`map_time` (source in/out
included), record-aware `recall_evidence` for list payloads, `summarizeVisualStatus` gated on
`Orchestrator#canSeeFrames()`, `validateSkillTools` rejecting implicit-only/unavailable tools,
and `trim_clip`/`get_timeline_map` descriptions that state their limits. Five golden corpora
and one snapshot regenerated (token estimates only). See
`docs/adr/0127-a-read-the-model-cannot-finish-reading.md`.

**Second run, same request (2026-08-19, deepseek-v4-pro, 6 calls, $0.98, 13m14s, cancelled):**
four further defects, all fixed. (1) Every in-process read reported its own descriptor as its
summary, so `distil` recorded "Reading the timeline → Reading the timeline" — the run's memory
was a list of verbs; reads now carry a `finding` (the digest head line). (2) `isSemanticLoop`
had been dead in production: the Conductor's `stageAdvanced` was an object comparison against a
`state.working` the fact fold had already replaced, so it read true whenever a fact was
recorded, and the detector only ever fired because degenerate facts deduplicated into a no-op —
it now compares the stage. (3) `agentTools('action-recovery')` withheld `recall_evidence`, the
one tool its own instruction names, so the model inferred asset durations from clip-id
millisecond suffixes and placed 46 clips against guesses. (4) The briefing printed the raw
request five times under five headings; the echoes are suppressed and `defaultActionFor` uses
its per-stage instruction. Five golden corpora + one snapshot regenerated (fact statements,
nextAction text, token estimates — no event, operation or status changed).

Deliberately NOT fixed here, each needing its own reviewed slice — all four are recorded in
ADR 0127 with `file:line`:

- [~] **The interpretation slot holds an echo.** `conductor.ts` pre-fills the run objective
  with the raw prompt at construction and `setObjective` is idempotent, so no turn can
  ever write a real interpretation. The briefing no longer RENDERS the echo four times,
  but the run's derived reading (montage length vs music bed, clip-count arithmetic,
  visual search unavailable) is still never durable. Needs a seam for the model to write
  an interpretation once — the remaining half of the 391-second thinking block.
  **Half-fixed (2026-08-20, caption-restyle run below):** the seed is now recorded as
  `objective.provisional` and `setObjective` lets the FIRST real interpretation replace a
  placeholder while still protecting an interpretation from being rewritten — so the slot
  is no longer permanently occupied. What remains is the model-facing seam itself: no tool
  or turn hook calls `setObjective`, so nothing yet writes the interpretation the slot is
  now open for. Keep this item until that caller exists.
  **Still open after the caption run (2026-08-20, ADR 0129):** re-examined and confirmed
  to be a REPORTING defect, not the cause of that failure — the run failed honestly on
  `no traceable project mutation`, and the echoed criterion made the verdict vague rather
  than wrong. Priority stays below correctness work for that reason.
- [ ] **The decision-recording seam is unwired.** `addDecision`/`commitDecision`/
      `reviseDecision`/`recordObjective`/`setBlocker` have no production callers.
- [ ] **`stage-policy.ts#planningExhausted` is dead code** duplicating
      `conductor.ts#researchBudgetSpent`; the durable stage-level planning closure its
      docstring promises does not exist.
- [ ] **No agent-usable in-place `sourceStart` change.** `professional_edit`'s `slip` needs a
      live selection plus the clip's asset in the source monitor; delete + re-`add_clip` is
      the only path an autonomous run has, and only the tool description now says so.

**Fourth run, "enhance the captions" (2026-08-20, deepseek-v4-pro, 9 calls, $0.64, 6m43s,
failed with zero mutations):** `[x]` fixed — and the first of the four whose cause was NOT
retrieval. The model had every fact it needed and correctly declined to edit, because the
acceptance test it was given was unsatisfiable. `verify_captions` returned 68 issues across 40
cues and **none of them was real**:

1. `checkCueBoundaries` filtered `map.spans`, which `buildTimelineMap` fills from every video
   AND audio clip, so it flagged **picture** cuts. The generator disagrees and says so in its
   own docstring: `deriveCaptionCues` segments per `MappedRun` (grouped on the AUDIO clipId)
   and calls runs "what guarantees no cue crosses a cut". So the canonical generator's output
   was rejected by the canonical verifier on every project whose picture is cut more finely
   than its audio — every montage, every B-roll edit, every multicam. Here it was
   unsatisfiable, not merely strict: 46 shots averaging 0.43s under continuous narration
   leaves nowhere to put a cue, and single words fail too (`heart,` 3.84–4.37s across a cut at
   4.209s). The rule's own message — "its words were never spoken together" — is true of a
   speech break and false of a picture cut. Fixed: the rule tests speech runs, the code is
   `caption_spans_speech_break`, and `get_mapped_transcript` now returns and explains the run
   bounds.
2. `caption_stale` compared `derivedFromRevision !== map.revision` — a change-detector for the
   whole project, not a staleness test. 65 revisions of colour and effects marked all 40 cues
   stale while `checkCueSync` passed on all 40 and `speechCoverage` was 1. Fixed: staleness is
   measured against the words that currently play across the cue (count, text, drift), by
   midpoint ownership so it agrees with `speechCoverage`.
3. Sixteen read tools had **no digest arm** and fell to `previewJson`, so — because `distil`
   keeps a digest's first line as the run's fact — the run's memory of its own verification was
   `{"ok":false,"issues":[{"code":"caption_spans_cut","clipId":"cap` cut mid-string. Digests
   added for `verify_captions`, `verify_transitions`, `list_edit_boundaries`, `analyze_silence`,
   `detect_scenes`, `discover_effects`, `discover_transitions`; the remaining nine are an
   explicit allowlist with a reason each, asserted against the registry both ways, so a new
   read tool now fails CI until somebody decides.
4. **ADR 0128 §3 was half done.** It put the caption style in the `get_timeline` digest so the
   answer would survive the log window, but on the per-track line — and `distil` keeps only
   the head, so the fact still said `5 tracks, 87 clips: layer_caption_4(40), …`. The style now
   rides in the head, with a test that goes through `distil` itself.
5. **Reachable is not affordable.** `get_mapped_transcript` returned `MappedTranscript`
   verbatim and `runs[].words` repeats every word already in `words[]` — 81 words in 27,647
   characters, seven pages at the 4,000-char recall budget. The run spent six of its nine turns
   paging a transcript it had already been given. Runs now carry bounds + count (13,885 chars,
   −49.8%) and `EVIDENCE_RECALL_CHARS` is 16,000.

`verify.ts` at 100% line and branch; `orchestrator.ts` branch 96.44% → 96.61%. Ten golden
corpora and one snapshot regenerated (token estimates only — the two rewritten tool
descriptions are longer; no event, operation or status changed). See
`docs/adr/0129-one-definition-of-a-cut.md`.

Examined and deliberately NOT changed, with the reason recorded so a later agent does not
"fix" it back: `analyze` is still left only by attempting a mutation, and `recall_evidence`
still survives the action-recovery turn. Withholding it was already tried and was worse — a run
built 46 clips on durations inferred from clip-id suffixes because the bin it had read twice
was unreachable (ADR 0127). A recall produces no `callFact`, so a recall-only recovery turn is
correctly scored as no progress and the convergence guard closes the run two turns later. That
two-turn tail is the price of the recovery turn being survivable.

**Status snapshot (2026-08-18):** `[x]` **FramePilot 9.5 Phase 1 — runtime convergence.**
FramePilot now has ONE mutating AI execution runtime (ADR 0126). The `planned_edit` route and
everything that served only it — `streamPlannedEdit`, the intent parser, the planner, the plan
compiler, the task graph, the graph executor, the scheduler, the recipe leaves, the edit
proposer, their prompts, and the `planned-edit` session mode across web-editor/desktop/IPC —
are deleted. Analysis-dependent edits (beat sync, scene-driven assembly) are ordinary agent
work: the agent acquires evidence through `detect_beats`/`detect_scenes`/`analyze_silence` and
mutates through the same schema-validated tool boundary as every other edit.

The deletion was gated on a parity harness that ran the same goal through both routes with the
same deterministic provider and host executor
(`docs/architecture/FRAMEPILOT-95-ROUTE-PARITY-EVIDENCE.md`). It found no unique capability, no
model-call saving (3 vs 3 on the happy path, and `planned_edit` costing MORE on failure paths),
and one safety defect unique to the planner path: Planner-authored `host_tool` arguments reached
the host analysis engine with no schema check. Two dimensions — editorial outcome and wall-clock
latency — could not be measured without a real provider and are recorded as **explicit
maintainer waivers**, not passes.

Two open follow-ups, both tracked in the roadmap rather than claimed as done. (1) The
single-shot `edit` route is still a second mutating entry point — a proposal surface, not a
runtime (no loop, no conductor, no durable checkpointing). (2) **Beat-grid boundary
enforcement is unwired**: `beat-alignment.ts` snapped near-miss `add_clip` boundaries onto
detected onsets and rejected off-grid ones, its only caller was the planner path, and the
agent does not enforce it. Found during self-review, not by the parity harness — whose
beat-sync row scripts perfectly on-beat clips and so never exercised off-grid rejection. The
module is retained and documented; wiring it into `applyAgentTurn` is roadmap PR 5.

**Status snapshot (2026-08-17):** `[~]` FramePilot 9.5 Foundation (`plan/FRAMEPILOT-95-CONVERGENCE-ROADMAP.md`
Phase 0, tracked in that doc and `docs/quality/FRAMEPILOT-95-FOUNDATION-BASELINE.md` rather than
here as its own task list) — added the **measuring infrastructure** for the two still-open
Phase-0 "evidence exit gate" rows that need a real provider: `pnpm eval:agent:foundation:real`
drives Tier B/C/D agent-outcome scenarios through a real Google Gemini call and the existing
fail-closed `agent-run-quality.ts` grader, wired as a manual `workflow_dispatch`-only GitHub
Actions job (`.github/workflows/foundation-real-eval.yml`) so it never runs on a normal push/PR
and never spends API budget without a maintainer choosing to. **Not yet run against a real key**,
and the two evidence-exit-gate checkboxes in `FRAMEPILOT-95-FOUNDATION-BASELINE.md` stay
unchecked — this PR closes the capability to measure, not the measurement itself. Tier A/E, the
1000+ clip performance gate, full-media render evidence and human/editorial scoring remain
explicitly out of scope.

**Status snapshot (2026-08-16):** **Recipes are removed end to end** (ADR 0125). The
deterministic route — seven fixed templates, `compileRecipe`, `recipe-executor`,
`streamRecipe`, the legacy keyword `router.ts`, saved workflows and the "Save as recipe"
shelf, plus the `recipe` mode in the IPC contract, the durable run protocol and the
editor-run lifecycle — is gone. Execution was never the hard part; the DECISION was. A
template can only do the request it was written for, so something had to judge whether
this request is that request, and a partial match ("add an intro WITH KEYFRAMES") ran the
template, did none of the real work, and reported "Instant · no AI needed" over a request
that was never read. ADR 0055 already replaced the keyword router for exactly this, and
the classifier made the call better but not sound. `recipe-leaves.ts` stays — despite its
name it is the shared deterministic leaf registry the surviving planner path defaults to,
and the shared `verify` leaf is what makes planner/agent verification parity a literal
same-function claim. Two UI defects fixed alongside: the timeline's track-header controls
were drawn ~12px past their 152px column and clipped under the lanes (the hit-target pass
enlarged the controls without widening the gutter — now 176px, measured, not guessed), and
the Export popover's header had no styling at all because every `.settings-head` rule is
scoped to `.settings-dialog`.

**Status snapshot (2026-08-16):** Subject intelligence is now wired end to end on the routes
creators actually use. `get_frame` had been built for agent mode only (ADR 0096): the read-only
**question** route — where "how many people are on screen at 13.3s?" lands — advertised the tool,
rendered the frame for real, and threw the image away, threading only the tool notes into the next
turn. So every visual question paid for a full composited render (up to ~40s cold) and was answered
from a payload that claimed an attachment the model never received; it refused questions it had the
evidence to answer, and elsewhere described frames it had not seen. Frames now reach the model on
both routes, are attached once rather than re-billed every later turn of a growing transcript, and a
memo-served replay states plainly that no picture is attached instead of forwarding the "attached as
an image" note behind an empty hand. Three adjacent dishonesties went with it: inspection commands
("look into the frame") were classified as _edits_, so a correctly answered question ended as a red
`failed` run under ADR 0081's no-mutation rule; the visual-search/footage-map/status messages told
the model to call `index_media`, which is implicit lifecycle work withheld from every model-facing
scope; and the status line claimed the model "cannot see" without an embeddings key, when
`get_frame` sees any moment independently of the index. `ContextInput.visualStatus` had existed with
no host filling it since the visual index landed — the desktop hub now reads it once per run, fail-
soft, so a run knows its own coverage before it answers. See ADR 0096 § Amendment (2026-08-16).

**Status snapshot (2026-08-15):** AI edits now reach the timeline the moment they validate
(**Instant Apply**, ADR 0122, [`INSTANT-APPLY.md`](./INSTANT-APPLY.md)). Perceptual review used to
stage every diff behind a 30s–4min render batch and desktop refused to commit anything not stamped
`verified`, so even "Auto" apply mode was not auto. The root cause was that review could _write_ —
its bounded repair called back into `streamEdit`, making the run's second writer and forcing every
turn to wait for the review of the turn before it. Review is now a pure reader: it emits findings
that reach the agent through the existing steering queue, the turn loop is the only writer, and a
review runs pipelined alongside the next turn at ~0 wall-clock cost. A finding whose region a later
turn rewrote is dropped, and only a finding actually delivered to the agent can be marked resolved.
There is no manual apply path: Accept/Reject, "Apply all", the keep-a-subset preview and the
apply-mode dropdown are gone, a planned step now carries its own edit as that step's outcome
instead of a second card, and grouped Undo — surfaced as **Undo run** while the run is still the
top of the stack — is the safety net and the new negative learning signal.

Instant Apply's follow-through is **review admission control** (ADR 0123): detaching review also
removed the ordering that had incidentally limited how many reviews could run at once, so a
seventeen-turn run over UHD media held seventeen full frame batches concurrently and exhausted the
machine. Reviews now run one at a time and a review whose region a later turn rewrote is never
started — the same predicate that already discarded its finding at drain, moved ahead of the render
— so cost tracks _surviving regions_ rather than turns. The engine half stopped retaining every
sampled frame at project resolution as `float64` (~199 MB/frame at UHD): frames are reduced on
decode, only comparison frames stay resident, and the ceiling is now a byte budget rather than a
frame count. Adjacent leak fixes: readers abandoned by a compile that raises, decoded `VideoFrame`s
dropped on rejected/superseded decodes, the preview `AudioContext`, the whole-undo-stack fold the
history panel ran on every edit while closed, and per-frame-batch rebuilds of review cards. See
`docs/guides/performance-budgets.md` § "Agent-run heap budgets".

The last term was **decode**, which sits upstream of every byte budget above and so survived all of
it (ADR 0124). Review built its preset from `project.resolution` and the compiler opened every
source on the camera master, so a batch decoded, composited and measured 2160x3840 frames in order
to produce means, ratios, percentiles and an 8x9 hash — none of which can tell UHD from a quarter of
it. Review now measures at `REVIEW_MAX_DIMENSION` (960 long edge) and no source is decoded larger
than the frame it is composited into; `/render/frame` does the same, so asking for a 512px still no
longer renders a UHD one first. Measured on an 8-clip 2160x3840 sequence: **273ms → 38ms** per
sampled frame and **781 MB → 176 MB** peak for one batch. The accepted trade is that `min`/`max` no
longer see a one-pixel excursion; `renderSettings` records the exact size measured. Exports are
untouched and still read masters. Concurrent _compiles_ are now bounded in the composition cache
(`MAX_CONCURRENT_BUILDS = 1`) rather than per-route, closing the same hole on `/render/frame` and
the MCP server that ADR 0123 had closed only for `/review/temporal-evidence`.

Professional Editor Control Plane V1 is the active delivery
initiative. P0 is implemented, P1's unified temporal gate and bounded repair are operating, and P2
now has timeline, motion, evidence-bound color-correction, manual mask-tracking, and selected-audio
mixing contracts:
authoritative source/sequence edits preserve linked sync; selected-property animation compiles from
clip frames; explicit bounded
shot corrections merge into one stable correction node without disturbing creative looks, and
reference matching consumes revision-bound measured tonal distributions instead of model-authored
values, adds its derived delta to any grade already present in that measurement, and exposes a
provider-compatible flat tool schema with strict conditional validation. The
tracking controller resolves an existing bounded mask instead of model-authored coordinates,
compiles its correction keyframes into one canonical manual tracker, and adds bounded jitter and
inside-frame review; automatic CV tracking remains truthfully unavailable. The audio controller
resolves clip and sidechain targets from live selection, compiles gain/normalization/frame-fade and
ducking settings without model-authored IDs, preserves omitted canonical mix state, and requests
beginning/middle/end mix evidence for audio-only and embedded-video audio changes. Multicam is now
schema-backed and executable (schema v18, ADR 0112): project-scoped `angleGroups` record which
cameras filmed the same moment and how far apart they started rolling, `switch_angle` cuts at the
playhead to the same instant from another lens rather than the same timestamp, membership is derived
from the media a clip plays instead of stored per clip, sound is left untouched, and an unsynced
camera fails closed naming the offset it needs — nothing is inferred from file names or folders.
Professional audio is complete: EQ, compression, and a gain automation lane extend the one
canonical `audio_gain` effect in a stated chain order (mute → normalize → EQ → compressor → fader),
where a lane supersedes the static level rather than multiplying with it and authoring both is
refused naming the fix (ADR 0113). Colour is complete: shot grouping expands one shot into every
clip cut from the same recording — a fact about the footage, where a similarity threshold would
regroup the moment a grade lands — and skin preservation is measured, holding a match's white
balance back until skin warmth stays inside 8% and refusing when the qualifier finds too little
skin to read. The bounded vision-review contract is now part of the shared production editor-run
gate: typed motion/crop/mask/tracking/transition operations declare bounded semantic objectives,
the real unsaved working project supplies composited frames, deterministic failures remain
authoritative, and provider/model/prompt/pack/consent lineage is durable. Cloud media cannot leave
the machine without a run-scoped consent receipt. Desktop activation still awaits the on-demand
Subject Intelligence worker in C4, so C3 remains in progress rather than claiming bundled sight.
C4 now has a frozen isolated-worker protocol for point/region/planar tracking, subject detection,
and segmentation: revision-bound host-resolved media handles go in; bounded frame-indexed
confidence/occlusion, detections, masks, progress, and typed failures come out. The first real
worker now exists: `workers/tracking-lite/` is a separately packaged artifact — never a base-app
dependency — implementing Lucas–Kanade point flow, CSRT region tracking whose confidence is a
measured appearance similarity rather than a boolean cast, and homography planar tracking anchored
to the requested quad. Occlusion freezes the last known box and a genuinely lost target fails
`target_lost`; the worker never extrapolates a trajectory it did not observe. Platform builds, exact
locks/licenses/SBOM, desktop invocation, decoded-media pixel proof, and tracked consumers remain
open.

**Status snapshot (2026-08-23):** `[x]` **Agent-side desktop invocation of Tracking Lite is
wired end to end on localhost.** The agent's `track_subject_automatically` tool now reaches the
real pack worker through a dedicated host executor: registry (`analysis` kind, transcribe-style
host-backed mutation contract — serial, never cached), orchestrator post-processing that turns
the validated measurement into the same reversible `track_object` patch as the manual path
(probe → validate → apply, provenance `${packId}@${version}` recorded on the op), and a desktop
executor composing into the single `HostToolExecutor` slot alongside the sidecar executor. The
controller seam it consumes is the previously-unwired `resolveAutomaticTrackingObjective`, so
geometry still comes only from a mask the editor drew. Because no signed catalog exists yet,
dev machines seed the store with `framepilot-pack register-local <input.json> <store-root>
<output.json>` — gated behind `FRAMEPILOT_DEV_PACK_REGISTRATION=1`, running the exact isolated
health check a signed install would run, staging a content-digested copy under the canonical
layout, and recording an acquisition receipt that names itself dev. Still open: per-platform
runtime/signing/catalog publication (C1/C4), renderer UI trigger + install-approval dialog for
agent-proposed packs, Subject Intelligence host service (detect/segment tools remain honest
refusals).

**Status snapshot (2026-08-23, second pass):** `[x]` **Subject Intelligence closed end to end on
localhost, and the editor got its own path in.** The desktop tracking authority generalized into a
capability→pack media-intelligence authority (Tracking Lite for geometric tracking; Subject
Intelligence for detection and segmentation, with `FRAMEPILOT_CAPABILITY_PACK_ROOT` provisioned to
the installed model directory through the worker client's audited `FRAMEPILOT_`-prefixed
`extraEnvironment` channel). Three consumer surfaces now share it: the agent's
`track_subject_automatically` (now including `subject="silhouette"` — segmentation inside the drawn
mask, converted host-side to measured region samples feeding the identical reversible patch), the
new read-only `detect_subjects` evidence tool (frame-indexed face/person/object boxes; honest empty
results; never geometry an edit can claim — it supersedes `detect_faces`, which is gone from both
registries), and the Inspector's Mask tab Measure-and-follow actions over the `capabilityPackTrack`
IPC with progress, cancellation, and checked apply through normal desktop persistence. A
`pack_missing` answer anywhere now surfaces the exact signed install proposal inline (Inspector
flow and AI tool card), with approval matching enforced byte-for-byte client-side as well as
host-side. Automatic subject tracking flipped to a registered, executable professional eval row
(measured-samples fixture asserting pack provenance and in-frame keyframes) — scorecard 34/34
registered, 0 unsupported. Still open: per-platform runtime/signing/catalog publication (C1/C6);
free segmentation prompts without a drawn mask need a bitmap-mask timeline representation.
P1.2 is closed: all ten tool families now own their specs in
`packages/ai-sdk/src/domain-tools/`, taking `tool-registry.ts` from 2,591 lines to 431, with the
generated parity fixture byte-identical at every step. P3 now derives a
33-row professional eval registration manifest from that capability surface, preserves unsupported
reasons, and has a shared deterministic outcome evaluator for validation, exact undo, save/reload,
host transport, and temporal-review planning. A one-shot Node-to-Python release gate now renders
the applied revision through production acquisition and has passed all 33 rows. CI now runs on pull
requests and `main`, blocks on functional/visual E2E and the desktop build, performs a real validated
export, and requires that rendered 33-row scorecard; the release-equivalent local aggregate is
`pnpm verify` and the shorter development loop is `pnpm verify:core`. Property-specific
negative controls and intent-variant coverage remain P3 work; metadata motion paths and generic
black/flash checks are not claimed as pixel proof of every semantic. Browser edit, recipe,
planned-edit, agent, and auto routes now persist through the shared durable run authority, and
reload recovery never emits a patch command. Browser proposal decisions are durable and
idempotent; desktop exact patch retries return the already-committed full project without a second
write or renderer apply. A deterministic planned-edit fixture now produces and accepts a real
proposal, browser and desktop terminal outcomes agree, and repeated review/commit delivery is
exactly-once. Unified execution durability C2 is closed. The
six professional tool families now also have explicit activity-card labels and icons; the
registry-to-sidebar drift test covers the complete internal and autonomous surfaces. The
contract spine remains:
live interaction context → deterministic target resolution → professional editor commands →
compiled reversible patches → technical/perceptual verification. Work is tracked in
[`PROFESSIONAL-EDITOR-CONTROL-PLANE.md`](PROFESSIONAL-EDITOR-CONTROL-PLANE.md); the existing
patch engine, frame-time helpers, LangGraph runtime, and render validation remain the foundations,
not parallel implementations. The editor presentation-system audit is closed (PR #145) —
canonical design tokens, shared `Switch`/`SegmentedControl` primitives, 24px hit targets on
precision controls, and the caption font picker moved off a native dropdown onto the existing
portaled `Select`; see the completed entry below. FramePilot can now be pointed at any OpenAI-compatible
server (ADR 0108), and LangChain provider failures are typed rather than uniformly retried
— see the completed entry below. The end-to-end performance audit is closed — all 13 findings
(P0 media import + patch validation, P1 WAL/snap/preview-cadence/project-IPC/waveform, P2
history/temporal-index/signatures/replay/fingerprints, P3 provider chunks) are shipped with
regression coverage; details in the completed entry below. Phase L — the LangChain/LangGraph migration of the AI layer —
is **structurally complete and operationally unstarted**. The agent loop now runs on a LangGraph
`StateGraph` and the bespoke kernel driver is deleted (ADR 0102/0103), proven byte-identical
against a nine-session golden corpus; but no phase's "metrics within budget" DoD item is
verified, because M0.1 has never been run against a real provider, and LangChain still serves
zero traffic. Details and the next three actions are in Phase L below.

**[~] Active 2026-08-12 — Professional Editor Control Plane (P0–P3).** Build the agent as an
operator of a professional editor state machine, with measurable end-to-end capability rather
than additional prompt-only behavior. P0 adds `EditorInteractionContext`, deterministic target
resolution, a frame-aware `EditorCommand`/EditIR boundary, and compilers for roll/slip/slide/
insert/overwrite/ripple/replace/lift/extract/J-cut/L-cut/camera-switch. P1 converges execution, capabilities,
domain tool ownership, and temporal/perceptual review. P2 adds professional domain controllers;

**2026-08-13 closure decision:** the remaining original P0–P3 scope now follows
[`PROFESSIONAL-EDITOR-P0-P3-CLOSURE.md`](PROFESSIONAL-EDITOR-P0-P3-CLOSURE.md). Apple Silicon
macOS and Windows x64 are the first complete desktop targets. FramePilot is local-first hybrid:
the deterministic editor/render stack stays bundled, while speech, tracking, segmentation, local
vision, and later heavyweight intelligence ship as explicitly approved, immutable, signed
Capability Packs. Projects pin exact versions and never silently download, upgrade, or evict them
(ADR 0114). P0–P3 is not complete until browser durability, production semantic vision review,
automatic tracking and its consumers, pixel-grounded negative-control evals, and clean-machine
release proofs are closed.
P3 proves each operation through resolve → compile → apply → invert → verify → persist evals.
No item is complete until browser and desktop contracts agree where applicable and focused tests
pass. See [`plan/PROFESSIONAL-EDITOR-CONTROL-PLANE.md`](PROFESSIONAL-EDITOR-CONTROL-PLANE.md).

**[x] Completed 2026-08-14 — `/code-review high` findings on `codex/professional-editor-control-plane` fixed.**
An 8-angle multi-agent review (temperature-retry bypass, plan-driver duplicate traversal,
identity-key duplication, audio-controller batch, orchestrator cancellation gap, and three
composition-cache concurrency findings) surfaced 11 findings after verification (10 confirmed, 1
plausible); 1 candidate (composition-cache retire exception propagation) was refuted — `close_clip_tree`
already guards every teardown against exactly that failure. All 11 are fixed with regression tests:
`clearExistingCaptions` now only clears clips it stamped itself instead of the whole caption/overlay
track's extent (silent data loss on a shared overlay track); `streamEditorRun`'s temporal-review-failed
exit now checks `signal?.aborted` like every sibling exit instead of reporting a cancelled run as
`failed` and releasing its unreviewed diffs; `CompositionCache` gained a `pinned` refcount so eviction
waits for an in-flight checkout instead of racing it for the entry lock, plus `SingleFlight` reuse
(already used by `twelvelabs_cache.py`) so concurrent misses on the same key coalesce into one
`build()`; `brain_visual_index_route`'s three-phase read→process→write now runs under a per-project
lock, and `sweep_interrupted_jobs_once` under the same class of lock `_embedder_cache` already had;
the OpenAI-compatible temperature-retry now throws a retryable `ProviderError` instead of a second
internal `super.complete()` call, so `resilient-provider.ts` stays the single retry authority (its own
telemetry and connect-timeout budget now see the retry); `plan-driver.ts`'s `collectAnalysisBag`/
`collectEvidenceGaps` share one `analysisTaskNodes` traversal instead of two copy-pasted filters;
`MAX_IDENTITY_KEY_CHARS`/`KEY_DIGEST_CHARS` moved to `stable-key.ts` as the one source three
hand-derived sub-budgets (orchestrator, effect-runtime, desktop `main.ts`) now import instead of
copying `256`; `ParsedAudioObjective` is now actually typed onto the parsed objective in
`domain-tools/professional-audio.ts` instead of sitting unreferenced, and `CompressObjectiveSchema`
references `AudioDynamicsInputSchema` directly instead of rebuilding an equivalent schema from its
`.shape` (which would have silently dropped any object-level refinement added to it later).
**Verification:** `packages/ai-sdk` full suite 3175/3176 passing (1 pre-existing skip); engine
2554/2555 passing (1 pre-existing skip); desktop `tsc -p tsconfig.node.json` clean; `ruff`/`mypy` clean
on touched engine files; `eslint`/`prettier` clean on touched TS files. Each fix's regression test was
confirmed to fail against the pre-fix code before the fix was restored.

**[x] Completed 2026-08-14 — code-review ship-blockers on `codex/professional-editor-control-plane`
fixed.** A 10-slice review (6 completed, 4 cut off mid-flight: Python render engine, and three
ai-sdk slices including `temporal-review.ts`, plus the workers slice — those remain unreviewed and
are tracked as follow-up via `/code-review high` scoped to `packages/ai-sdk/src` and
`engine/python`) reported 30 findings; the 5 ship-blockers are fixed: `main.ts`'s patch-commit
handler called `parseProject(committed.project)` to reconcile Capability Packs, but
`project-command-service.ts`'s renderer-transport facade replaces `committed.project` with a
compact `ProjectPatchTransport` envelope (not a full `Project`) on every ordinary same-revision
commit, so that parse always threw _after_ the write, recovery snapshot, and WAL entry had already
succeeded — the primary edit path for both users and the AI reported failure on every successful
save; fixed by capturing the real committed `Project` from the `write` callback closure instead of
trusting the facade's return value. `worker-client.ts`'s `child.stdin.write` had no `'error'`
listener, so a worker that exited before reading stdin turned `EPIPE` into an uncaught exception in
the Electron main process; now caught and reported as a normal worker failure.
`sidecar/manager.ts#stop()` killed the old process without detaching its `onExit` listener, so on
the first `stop()`+`start()` sequence this PR introduced (pack install, storage relocation), the
dying process's delayed exit event could mark the _newly started_ sidecar `'failed'`, leaving
render/export/transcription dead until an app restart; both `onExit`/`onError` now check they still
belong to the current process before mutating state. `executable-verifier.ts`'s Windows
Authenticode check spawned bare `powershell.exe` with a wholesale-replaced `env` that dropped
`PATH`, so the spawn itself failed `ENOENT` and was misclassified as `executable_untrusted` —
every Windows pack install was quarantined regardless of signing; `runBoundedCommand` now merges
caller-supplied env onto OS process-launch essentials (`PATH`, `SystemRoot`, etc.), matching the
sibling `safeRuntimeEnvironment()` in `worker-client.ts` and fixing `worker-health.ts`'s call site
too. `.github/workflows/release.yml`'s macOS signing and update-feed-publish steps each gated their
`if:` on a variable defined only in that same step's own `env:` block — GitHub Actions does not
expose a step's own `env:` to its `if:` — so both conditions always evaluated false and both steps
silently no-opped (unsigned macOS builds, existing installs never seeing updates); the two
variables (`MAC_CERT_P12`, `DIST_BUCKET`) are now hoisted to job-level `env:`.
**Verification:** `capability-packs` and `desktop` `tsc -b`/`tsc -p tsconfig.node.json` clean; full
workspace `pnpm -w typecheck` clean; targeted vitest suites for `sidecar/manager`,
`projects/project-command-service{,.transport}`, `worker-client`, `worker-health`, and
`executable-verifier` all green; `release.yml` re-parsed as valid YAML after the edit.
**Not yet closed:** the remaining 25 findings from this review (keyframe lanes, the durability lane,
two wedged capability-pack dialogs, `decidePatch` targeting the wrong run, SBOM/workspace guards,
and the four never-reviewed slices) are still open.

**Previous snapshot:** Completed 2026-08-07: a bloated project no longer kills the desktop app.
`project_my_new.fp.json` was 403 MB, of which `history` was 383.74 MB and real content 0.6 MB.
`readProjectFile` succeeded, but the parsed graph then went through `observe()`
(`serializeProject` → a 168 MB canonical string, retained in `ProjectCommandService.versions`)
and the structured clone of the IPC open reply — which is what exhausted the V8 old space and
aborted the Electron main process ~10s after open. `readProjectFile` now refuses to parse the
history of a file over `MAX_PARSED_PROJECT_BYTES` (64 MiB, matching the AI WAL quarantine),
dropping it with a scanner that skips the array without parsing it; content is untouched.
The MCP `saveProject` path — the one caller passing no limits to `toPersistedHistory`, whose
default is unbounded — now applies `DEFAULT_DURABLE_HISTORY_LIMITS` like every other save path.
Measured on the real file: canonical 168,493,218 → 670,825 bytes (251×), open 2.2s, 434 caption
clips and 786 transcript segments preserved. Verification: timeline-schema 195, mcp-server 120,
editor-core 617 tests passed; repo-wide typecheck and lint green (15/15 turbo tasks each).

**[x] Completed 2026-08-10 — UI system audit closed (editor presentation-system findings).** An
end-to-end UI/UX audit found the editor's interaction architecture (virtualization, bounded
scrolling, reduced motion, keyboard-aware overlays, responsive rails) was stronger than its
presentation architecture, which had accumulated inconsistent typography, hit targets, tokens,
and component ownership across several generations of styling.
**Shipped:** `packages/ui/src/tokens.css` made the canonical token source with `DESIGN_SYSTEM.md`
rewritten as its semantic/ownership contract; shared sans/weight, pill-radius, control-height,
24px hit-target, density, and semantic motion tokens; a new `editor-foundation.css` layer for
cross-surface ergonomics instead of more feature-specific overrides; Timeline precision/keyframe
controls, Inspector resets, and Settings switches raised to at least 24px targets; reusable
`Switch` and `SegmentedControl` primitives added to `@framepilot/ui`, with Settings migrated off
its duplicated implementations; Button loading state can no longer be defeated by
`disabled={false}`; Caption font selection moved from a native OS dropdown to the existing
portaled, keyboard-aware `Select`. No timeline/project schema, render, AI orchestration, or IPC
changes. Two lower-level maintainability items — extracting historical feature blocks still
resident in `apps/web-editor/src/styles.css`, and removing the Caption sidebar's scoped `:has()`
adapter — are recorded as open residual debt requiring a broader visual-regression pass, not
silently marked done.
**Verification:** PR #145's GitHub Actions could not run (account out of Actions minutes; all
jobs terminated in ~5s without executing). Verified instead in a mounted checkout against the PR
head: `pnpm typecheck` 15/15 turbo tasks green, `pnpm lint` clean, `pnpm license:scan` clean,
`web-editor`/`@framepilot/ui` tests 2356/2356 passing. One real regression was caught and fixed
in that pass — `CaptionEditor.test.tsx`'s font-picker assertions still assumed native `<select>`
semantics after the picker moved to the portaled `Select`; updated to match the interaction
pattern in `CaptionWorkspace.test.tsx`. See `plan/UI-SYSTEM-AUDIT-CLOSURE.md` and
`docs/reports/ui-system-audit-closure.md`.

**[x] Completed 2026-08-09 — a provider for any OpenAI-compatible server (ADR 0108).**
The roster named services but had no way to say "a server I run, at this address", so a
self-hosted gateway (vLLM/LM Studio/llama.cpp/LiteLLM) or a local proxy had to borrow
another provider's single base-URL slot. Users borrowed Ollama's, because it is the only
one whose Server URL field the Settings UI exposes — and that path had silently broken:
ADR 0105 replaced the hand-written `providers/ollama.ts` (which POSTed
`<baseUrl>/chat/completions` with a Bearer key) with LangChain's `ChatOllama`, which speaks
Ollama's own protocol at `<baseUrl>/api/chat` and sends no key. The 404's HTML error page
then arrived in the chat sidebar as the failure message.
**Shipped:** (1) `openai-compatible` provider — `ChatOpenAI` with the host's URL and an
optional key, **no default endpoint**, failing with a non-retryable `bad_request` when the
URL is unset rather than falling back to another service; readiness in Settings is gated on
the URL, not a key. (2) `classifyLangChainError` at the provider seam — the LangChain
adapters never classified their failures, so _every_ provider error fell through to
`retry.ts`'s catch-all as retryable `network`, and a 401 or 404 burned the full retry budget
before surfacing; statuses now map through the same `kindForStatus` the ASR paths use, and
HTML error bodies are reduced to the reason inside them. Aborts stay aborts. (3) Ollama's
configured key travels as an `Authorization: Bearer` header again, for an authenticating
reverse proxy. (4) `trial/README.md` stopped documenting a file ADR 0105 deleted.
**2026-08-13 verification follow-up:** the release aggregate caught a commented-out sampling
forwarder shared by OpenRouter, NVIDIA, and custom OpenAI-compatible servers. Explicit
temperature now reaches all three adapters again, omission still preserves provider defaults,
and the seven-provider contract matrix plus the AI SDK coverage suite are green.
**Verification:** full `pnpm verify` green (16/16 turbo tasks) including all browser E2E;
ai-sdk 2,877 tests at its 100% coverage gate; `test_config.py`'s TS↔Python roster parity
test taught to skip `//` comments (prose about an entry contains apostrophes, which its
quote scanner read as provider names).

**[x] Completed 2026-08-08 — end-to-end performance audit closed (13 findings, P0→P3).**
An external end-to-end audit of the editor's critical paths named 13 scale multipliers, all of
the same four shapes: _bytes crossing a boundary where a path would do_, _whole-project scans
when one track changed_, _filesystem durability work at token frequency_, and _display/pointer-
frequency work that still scales with project size_. All 13 are now closed.
**P0 —** desktop media import streams in bounded `MEDIA_IMPORT_CHUNK_BYTES` slices instead of
materialising the whole `File` in renderer RAM and cloning it through IPC; the patch validator
(`validation-scope.ts`) derives each operation's mutation footprint and validates overlap/
transition/speed only on the touched tracks, replacing the per-operation whole-timeline sort.
**P1 —** the durable AI WAL checkpoints at recovery-relevant boundaries rather than
open→write→fsync→close per streamed event; snap edges and roll junctions are cached per
timeline/track identity and searched, not rebuilt and scanned, per pointer sample; the DOM
monitor moved to `useFramePlayhead` so a 120 Hz display cannot commit four times per 30 fps
project frame; routine authoritative commits travel as patch deltas reconstructed locally
(full snapshots reserved for external edits/recovery); browser waveform fallback is bounded
and in-flight-deduped. **P2 —** live history keeps compact grouped entries and collapses each
group **once** at serialization; the temporal index tiers long spans instead of duplicating
them into every 5s bucket; WebCodecs change detection uses semantic identity tokens rather
than `JSON.stringify` over EDL/effect/overlay payloads; durable replay pages by sequence
offset; persisted project fingerprints are cached instead of re-serialized per write.
**P3 —** each hosted provider gets its own dynamic chunk.
Verification: full `pnpm verify` green — 16/16 turbo tasks (web-editor 2,345, ai-sdk 2,848,
editor-core 702, desktop 264, mcp-server 120), 15/15 coverage tasks at their thresholds
(editor-core and ai-sdk at 100%), plus 2,437 Python engine tests.

**[x] Completed 2026-08-07 — `invertPatch` is no longer O(n²) in clips (ADR 0106).**
Every lossy op inverted to a `restore_clips` snapshot of its **whole track**
(`operations.ts` `restoreFor`), so one "Generate 434 captions" patch stored 877 snapshots
carrying 192,307 clips — 115.5 MB of inverse against 0.25 MB of forward ops. Worse, a single
entry over the 4 MiB durable budget is dropped **entirely** by `toPersistedHistory`, so the
biggest edit was precisely the one that silently lost its undo. `collapseClipSnapshots`
(`patch.ts`) now keeps exactly ONE snapshot per track — the pre-patch state, appended last —
and drops every inverse op writing only that track's clips, which the restored clips already
carry. Track-level state (`captionStyle`, flags, effect layers, layer order) is NOT covered by
`restore_clips` and is always kept. Conservative by construction: an unresolvable clip, a
track the patch adds/removes, a straddling cross-track `move_clip`, or an unrecognised op type
returns `null` and the caller keeps the original inverse byte-for-byte — it can shrink an
inverse, never change what it does. Measured: 443-cue track / 1,311 ops → **39.37 MB → 0.05 MB
(737×)**, undo exact; replayed over the real project history **174.2 MB → 0.5 MB (327×)**.
Each of those four refusals has its own test asserting an exact undo, holding editor-core at the
100% gate. Verification: full `pnpm verify` green (16/16 turbo tasks; editor-core 627, web-editor 2,318,
ai-sdk 2,747, desktop 253, mcp-server 120, timeline-schema 195) plus 2,405 Python engine tests.

**[ ] Follow-up (deferred, no longer urgent): lazy/on-demand history load.** Analysis showed
`history` was 99%+ of every project file (384/370/261/90/71 MB against 0.1–0.6 MB of content),
which argued for not parsing it on open at all. With ADR 0106 the same history is ~0.5 MB, so
eager loading is no longer a measured bottleneck and the machinery (a `readProjectHistory` on
the side, merge-on-save so a lazily-empty history cannot clobber the durable suffix) would add
risk for little gain. Revisit only if a profile shows open cost dominated by history again.
Startup itself is already lean: `app.whenReady` does only `projectCommands.restore()` (a small
revision registry) before showing the window; the sidecar, update check and bin warmup are all
fire-and-forget.

Completed 2026-08-07: the sidecar no longer dies at boot on a
non-legacy AI provider. `AIProvider` in `engine/python/framepilot_engine/config.py` was a
hand-maintained mirror of the TS roster that had never been updated past
`anthropic|nvidia|mock`, so `FRAMEPILOT_AI_PROVIDER=deepseek` raised `ValueError` inside
`serve()` before uvicorn bound a port — taking render, captions and analysis down with it, and
leaving the desktop shell to cascade into a main-process OOM. The enum now mirrors
`PROVIDER_NAMES` exactly, an unrecognised value degrades to the default with a warning instead
of being fatal (nothing in the engine reads this field), and a source-parity test asserts the
two rosters against `packages/ai-sdk/src/providers/types.ts` so they cannot drift again.
`.env.example` also stopped advertising the removed `github`/`github-copilot` providers.
Verification: 2,405 Python engine tests passed (0 failed), engine ruff/mypy clean, and the
desktop app was run end to end — sidecar reaches `/health` 200 and main-process RSS stays flat
at ~120 MB where it previously hit the 3.5 GB V8 heap ceiling and aborted.

Completed 2026-08-04: the model can now SEE the edit, caption-heavy
timelines are responsive, and AI usage is reported honestly. (1) New `get_frame` tool renders one
composited frame through the export compiler (`engine/python/render/frame_grab.py`,
`POST /render/frame`, which takes the run's INLINE working copy) and attaches it to the next request
as real image content across Anthropic/OpenAI-compatible/Gemini wire formats; gated on a
conservative `supportsVision` allowlist, shown once then dropped, never in the text action log
(ADR 0096). The caption-design skill and agent contract now require looking before claiming a visual
result. (2) Timeline lane render no longer re-derives the whole project's cut structure per junction
per interaction — a caption lane of ~200 butt-joined cues cost ~199 full-timeline walks on every
scroll/zoom/selection/drag frame; `buildTransitionBoundaryIndex` derives it once and non-media lanes
are skipped entirely, with a regression test that fails at 199 on the old shape. Clip hover moved off
`filter: brightness()` (which defeated `content-visibility` and re-rasterized every clip's
filmstrip/waveform) onto an overlay pseudo-element. (3) OpenAI-compatible providers now send
`stream_options: {include_usage: true}`, so a streamed run stops settling at zero tokens; a run that
made model calls but got no usage report reads "usage not reported by provider" instead of
"Instant · no AI needed". (4) Tool cards name their subject (`describeToolCall` subject resolver) —
"Reading the short form pacing playbook", not four identical "Load skill" rows. Full `pnpm verify`
passed (16/16 turbo tasks) plus 2,253 Python engine tests with one intentional skip.
Completed 2026-08-03: remaining large-project edit-path lag fixed.
Continuous caption controls now preview locally and commit once per gesture; WebCodecs caption
playback uses the temporal index instead of scanning the full cue lane per frame; renderer autosave
and host-side AI commits keep a newest contiguous durable undo suffix bounded to 100 steps / about
4 MiB while the open session retains full undo. A captured-shape 5 MiB legacy-history regression
test proves compaction happens before an agent commit. Full `pnpm verify` passed (web-editor 2,306,
all 75 browser E2E tests, engine 2,237 with one intentional skip); website production build passed.
Completed 2026-08-03: feature-length preview CPU regression fixed.
Unproxied originals now use Chromium's streaming media path instead of eagerly fetching,
demuxing, and decoding the entire source through WebCodecs; proxy-backed compatible media keeps
the compositing path. Segment lookup is logarithmic, captions/overlays/effects use bounded
five-second temporal buckets, and paused preview/timeline animation loops stop after one paint.
Regression coverage includes a two-hour, 7,200-cue timeline. Repository-wide `pnpm verify` passed
(including 75 browser E2E tests and 2,237 Python engine tests); website typecheck and production
build also passed. Completed 2026-08-03: caption and live-agent interaction latency is bounded.
The caption editor virtualizes a 7,200-cue track to fewer than 50 mounted rows; host-owned agent
commits reconcile into the existing store without remounting the workspace; streamed events commit
at no more than 20 Hz, append once per batch, defer Markdown parsing until settled, and memoize
historical rows. Focused tests passed 137/137, caption + AI browser workflows passed 15/15, and the
repository-wide `pnpm verify` plus website typecheck/production build passed (including all 75
browser E2E tests and 2,237 Python engine tests; one intentional engine skip). Completed 2026-08-03:
durable AI runs no longer reread/reparse their growing WAL for every streamed event. One validated
in-memory index makes append O(1), terminal indexes are evicted, 64 MiB legacy WALs quarantine
before parsing, and initial AI requests carry zero undo-history bytes while the host retains the
authoritative stack. The two reported Vite Fast Refresh invalidations were also removed by moving
pure helpers out of component modules. Full `pnpm verify` passed (web-editor 2,305, all 75 browser
E2E, engine 2,237 with one intentional skip); website typecheck/build passed. Completed 2026-08-03: lyric-video caption creation and verification now fail
closed on full-song fallback blocks. The low-level cue tool rejects ranges longer than 10 seconds
or denser than 12 mapped words; verification counts only real caption clips, rejects dense or
provenance-free cues and empty sets over retained speech, and visual-quality claims require preview
evidence. Focused verification: 164 AI SDK tests and 98 Python AI-tool tests passed; AI SDK and
Python typecheck/lint, generated-skill parity, website typecheck/production build, formatting and
diff hygiene passed (repository-wide verification intentionally excluded at the creator's request).
Completed 2026-08-02: the agent can no longer report an empty media bin for a
project full of media. A model that fills an optional filter with `""` (`list_assets
{"kind":"video","folderId":""}`) was taken literally, matched nothing, and drove the agent to ask
for footage that was already imported. Blank optional selectors now mean "not provided" across
every AI tool in both the TS and Python registries (padded values are trimmed; invalid input is
still rejected), and `list_assets` states what the bin holds when a _filter_ — not the project —
came back empty. Focused verification: 108 TS registry tests and the full 2,236-test Python engine
suite passed; engine lint/typecheck and ai-sdk lint/typecheck/build passed. Pre-existing red left
untouched: the `streamAgent` frozen golden snapshot already failed on this working tree before the
change (uncommitted caption tools grew the tool-definition budget).
Completed 2026-08-02: AI-safe caption composition is now fully registered.
The agent and MCP can discover the bundled font/template system, submit transcript-grounded semantic
anchors through `auto_emphasize_captions`, and set track-wide or per-cue font, x/y placement, scale,
rotation, width, alignment, spacing, background, animation and safe-area behavior through the same
validated/reversible operations as the manual editor. Focused verification: 345 AI registry,
skill, Python mirror and MCP tests passed; touched TypeScript/Python typecheck and lint plus diff
hygiene passed (repository-wide verification intentionally excluded at the creator's request).
**Last updated:** 2026-08-07

Completed 2026-08-02: creative captions now include 22 bundled OFL families
across sans, display, serif, mono and handwritten groups, with one canonical catalog generating
matching preview/export font contracts; templates use the wider palette and creators can apply a
font track-wide or per cue. Auto Emphasis now uses the provider selected in Settings, validates and
constrains its response to transcript words, feeds AI-selected anchors into generation, and labels
the deterministic offline fallback honestly. Focused verification: 118 caption/font/AI/schema/render
tests passed, including the export golden; touched TypeScript/Python typecheck and lint, font-license
audit, website typecheck/production build, and diff hygiene passed (repository-wide verification
intentionally excluded at the creator's request). Completed 2026-08-02: intelligent caption revamp — deterministic semantic
emphasis now shapes cue grouping and visual anchors; captions support reversible text, merge/split,
free placement, width, alignment, line height, safe-area and rotation edits directly from the
preview; six reference-led production templates ship with preview/export parity. Focused
verification: 778 tests passed across editor-core, timeline-schema, web-editor, ai-sdk and Python
caption/render suites; touched TypeScript and Python typecheck/lint passed, including a new export
golden (repository-wide verification intentionally excluded at the creator's request). Also in progress:
program-monitor selection parity — timeline-selected
text objects must surface professional white on-canvas controls, single-click selects the
background picture, and double-click selects the topmost text object under the pointer.
Completed 2026-08-02: TwelveLabs audio-only transcription now uses its
typed asset-upload → indexed-asset workflow instead of the legacy video-only task endpoint;
MP3 keeps `audio/mpeg`, both paced states are durable, old task ids remain resumable, and retry
starts a fresh upload after terminal failure. Focused verification: 46 TwelveLabs tests passed.
Completed 2026-08-02: caption libraries now hold readable previews at
rest, page 12 then 8 in a responsive four-column-first grid, share Effects/Transitions filter
chrome, and keep timing/per-cue styling behind compact disclosures; keyword emphasis now has a
real accent treatment in preview and export; import and manual transcription share one durable
in-flight/error state across both transcript surfaces; redundant library labels are removed and
the app bar is 48px. Focused verification: 87 tests passed across the seven touched regression
files (repository-wide verification intentionally deferred at the creator's request). Completed
2026-08-01: professional transcription/captioning overhaul —
Local ASR + TwelveLabs provider parity, leading-silence/timestamp accuracy, caption-ready
normalization, and a responsive Effects-grade caption browser with truthful long-running
states; verified by `pnpm verify` (2,274 editor, 75 e2e, and 2,219 Python tests). Completed
2026-08-01: the run thread's thinking is real again. Three
independent causes, all found in real desktop conversation logs: (1) reasoning is opt-in on
every wire format and we never asked, so every step settled as an unopenable "Thought for Ns"
— requests whose thinking is displayed now carry `reasoning_effort`, a model that refuses it
is learned and retried without it, and the shared SSE parser reads the `thinking` /
`reasoning_details` spellings it used to drop; (2) a host auto-commit remounts the editor
mid-run, and the conversation log lived only in component state, so everything appended inside
the 400 ms autosave debounce was lost — including the `reasoning done` event, which is what
stranded "Thinking…" rows in the middle of a thread — the store now survives a remount and the
teardown writes what the debounce still owed; (3) the reduced view now enforces that only the
LAST reasoning node may be live, so no dropped event can ever strand a shimmer again; (4) a
reasoning node was scoped to the TURN, not to the model call that produced it, so the question
route's tool loop (think → call tools → think again) landed both blocks on `${turnId}:reasoning`
and the second REPLACED the first — at the first one's position, above the tool cards it
actually followed. `streamAssistant` now derives the node's scope from the assistant segment it
streams into, so one model call owns exactly one thinking block by construction and no future
multi-call route can regress it, and the fold FORKS rather than merges when any producer reuses
an id that already carries a settled block. The composer's activity row is now the FramePilot
mark breathing beside a shimmering label, replacing three competing animations and a redundant
ellipsis.
Completed 2026-07-30: the program monitor now has one WebCodecs
product path. The obsolete preview-engine preference and legacy fallback are removed,
the scrubber occupies a dedicated full-width row above centered controls, and failed
sources remain timed gaps with an in-monitor error so transport and editing never
collapse to time zero (see `plan/PREVIEW-WEBCODECS-COMPOSITOR.md` P6).
Completed 2026-07-30
(`feat/effects-system-v13`): effects are now
first-class timeline LAYERS (schema v13, ADR 0088), end to end. Schema v13 (`effect` track
type, `Track.effectLayers`, v12→v13 migration, Pydantic mirror); a 72-entry pure-data catalog
on a 41-value closed `EffectRenderKind` enum with a per-kind param vocabulary; six reversible
editor-core operations with catalog-backed validation at 100% coverage; 41 numpy render
passes plus the composited-stack (adjustment-layer) stage that did not previously exist in
`compile_timeline`; a WebGL2 post-process chain in the preview with 41 GLSL twins and 350
structural parity tests; the Effects library (category rail, search, favourites, recents,
popular/recommended, per-effect thumbnails that animate on hover by running the real shader);
a short-height timeline effect lane with move/trim/duplicate/stack/bypass/delete; Inspector
controls generated entirely from the catalog's param descriptors; and seven AI tools (TS +
Python registries, auto-synced to MCP) proven to produce timelines deep-equal to the manual
path. 12 e2e tests walk discover → apply → adjust → edit → save/reopen → delete in a real
browser. **Remaining, tracked below: a golden-media parity test with a real GL context (the
one thing the structural parity tests cannot substitute for, since CI has no GPU) and perf
measurement of the WebGL stage against desktop-scale media.**

Completed 2026-07-30: the residual high-refresh preview shimmer is
closed: production canvas presentation stays GPU-backed, unchanged 24/30/60 fps source
frames remain resident instead of being repainted at 120 Hz, semantic React UI updates at
project-frame cadence, and the playhead moves imperatively on physical pixel boundaries.
The real-Chrome guard reduced 513 display ticks to 130 source draws with zero fractional
playhead positions, missing/wrong/black frames, or backward clock steps. Completed
2026-07-30: preview playback now keeps one continuous
project-time clock across audible clips, silent video, images, and gaps; rejects stale
frames from the wrong segment; uses the editor transport as the single playback authority;
isolates the canvas from per-frame React renders; and moves the timeline playhead with a
compositor transform. The uploaded flicker case and equivalent mixed 30/60 fps B-frame
footage now produce zero wrong-segment or sampled black frames and a monotonic playhead in
real Chrome. Completed 2026-07-30: an agent cannot stop on a partial batch while
committed plan work remains; it gets one bounded mutation-only continuation, and final
success now requires passing deterministic acceptance checks as well as a reconciled plan
and traceable edits. Per-step thought state is isolated, live activity moved beside the
composer, AI/Inspector/Transcript switching preserves the active chat/run, the context
figure stays bound to the primary request for a user turn, and `glm-5v-turbo` resolves its
200K/131,072 models.dev limits with slash-insensitive matching. Completed 2026-07-30: an AI provider that drops a request after it has begun responding (an in-stream SSE error frame) is now classified, retried and — if it still cannot be answered — reported honestly, instead of reaching the creator as a content-free reply the run read as "Done — no further edits." on an untouched timeline; a run that ends `failed` now always states that nothing was applied, and a failed run no longer carries an "Instant · no AI needed" cost chip. Completed 2026-07-28: the beat-grid rule now holds only interior picture
cuts to detected onsets — snapping near-misses, exempting the sequence head/tail and the music
bed, covering trims and splits, and refusing an unresolvable grid instead of silently passing —
and structured proposals reserve reply room sized to the edit instead of truncating at the
provider's 2,048-token conversational default. This closes the live "cut on every drum hit"
run that failed as `off-grid: 30`, then as invalid JSON, and before that produced a uniformly
spaced montage. Completed 2026-07-28: multi-stage planned edits now project validated
ancestor assemblies into later proposal context, close every mutation lifecycle with final
combined assembly and verification, recover bounded schema-valid provider wrappers, and
preserve a valid earlier edit with a visible warning when later polish exhausts retries.
This closes the live 12/12 montage run that lost its final polish step after assembly.
Completed 2026-07-28: planned-edit proposals are grounded with
explicit asset/track identity namespaces and project-semantic validation before patch
assembly, closing the live failure where track ids were accepted as `assetId` values until
the run had already advanced to apply. Completed 2026-07-28: empty planned mutation proposals
receive bounded feedback-guided corrections and then fail before patch assembly/verification; the
actual scheduler task checklist is now the default-collapsed header accordion shown in
planned montage runs. Completed 2026-07-28: planned-edit leaf inputs now derive from the
validated task graph, so patch assembly cannot lose an already-declared upstream result;
the active plan is now a header-docked, recent-first accessible accordion. Functionally
implemented 2026-07-28: the durable AI run causal chain now
execution cannot reach apply/verify without a persisted objective and committed plan,
mutating operations are traceable and idempotent, integrity loss pauses into deterministic
recovery instead of warning-and-continuing, and the UI exposes actionable diagnostics.
Dedicated new regression tests are explicitly deferred at the creator's request, so this
work remains `[~]` until that test round. Fixed 2026-07-27: the agent's run memory was being switched off by two
hand-maintained tool allowlists that had drifted from the 62-tool registry — `detect_beats`
was missing from both, so a beat-synced montage recorded no fact about the beat map and lost
the payload to the first cut, then re-detected the beat after every subsequent one. Tool
classification is now one registry-wide table with a two-way parity test, and the run-stable
prompt head (contract + plan + pinned playbooks) finally sits ahead of the mutating project
block with its own cache breakpoint. ADR 0079. Completed 2026-07-27: the AI sidebar shows live per-request context
occupancy immediately left of Send/Stop; model-tier routing has been removed end to end,
and every request stays on one active provider with resilient planner fallback, strict
cancellation continuity, adaptive Ollama compatibility, and bounded long-video context. Fixed
2026-07-26: `list_assets` now consumes a submit-time snapshot
of the live editor bin, and beat-synchronization commands route through the analysis-backed
planned-edit path with non-uniform placement/reversibility coverage.
Project-scoped AI conversation persistence and responsive
editor-panel/monitor layout fixes are in progress as of 2026-07-25. AI run lifecycle
reliability is now hardened: renderer teardown detaches without cancelling durable work,
all terminal paths emit a durable terminal event with explicit provenance, and stream
snapshots are checkpointed instead of rewritten for every token. Fixed 2026-07-26: the
sidebar's re-attach effect depended on the `running` state it set, so React tore the
recovery down one render after it subscribed and the once-only guard refused to retry —
a detached durable run kept editing in the background with no attached UI and an inert
Stop. Desktop auto-commit also remounted the editor without restoring the active
conversation, visibly replacing the live run with an empty new chat. Recovery now selects
the durable run's owning conversation, stays attached, releases its retry guard on teardown,
and retains cancellation authority so Stop always reaches it. A foundational
orchestration review completed on 2026-07-23 and
found split execution authority plus desktop workspace/control drift; the proposed
durable-runtime consolidation is defined in
`plan/ORCHESTRATION-FOUNDATION-INITIATIVE.md`. T0 transcription recovery and
foundation phases F0–F3 are functionally implemented: provider-backed transcription
cannot clear a transcript with empty output; durable runs, the unified Effect Runtime,
restart-safe project revisions, conflict-aware commits, explicit auto-commit policy,
workspace synchronization, and run-grouped Undo are wired end to end. Dedicated
conformance/concurrency/replay tests remain deliberately deferred to the next test
round, so the initiative checklist stays `[~]` rather than overstating Definition of
Done. Existing delivery history follows. Phase 0
(Scaffold) — ✅ fully green: structure complete with
canonical `.agents/` agent assets + harness adapters, and the TS6310 `tsc -b --noEmit`
defect is fixed (composite library packages type-check via `tsc -b`); `pnpm verify`
green from a cold cache. Phase 1 (timeline + patch engine) — ✅ done: TS
`editor-core`/`timeline-schema` plus the Python mirror, and schema-sync is now closed
with a cross-language JSON Schema guard (Zod-exported `project.schema.json` + TS drift
test + Python Pydantic parity test). Phase 2 (deterministic render) — ✅
**feature-complete**: a project can be loaded, compiled (Timeline→MoviePy), rendered
(preview/final) through a resumable background **queue** with timeout/cancellation,
auto-validated, and driven via CLI **and** FastAPI sidecar; media layer does
proxy/waveform/thumbnail generation. Phase 3.1 (Electron shell) — ✅ complete: secure
typed IPC + preload bridge, hardened `BrowserWindow`, sidecar lifecycle state machine,
project open/save/recent + crash recovery, and an auto-update channel scaffold. Phase
3 (Desktop Shell & Editor UI) — ✅ **fully complete** (3.1 shell + 3.2 editor UI + 3.3
captions, **including caption burn-in render-wiring** — the Python engine now burns
captions into a render deterministically from the transcript via `render/captions.py` +
`compile_timeline(burn_captions=…)`, threaded through RenderOptions/service/CLI with a
caption-timing golden; see ADR 0011, no schema change):
the renderer is a pure-logic core (selectors/patch-builders/store/project/bridge/captions
all at 100% coverage) with thin React components, and every manual edit is routed through
validate→apply→record. Phase 4 (AI Layer) — ✅ **complete** (4.1 infra + 4.2 modes + 4.3
Review UX): a multi-provider client (Anthropic/NVIDIA via `fetch`, no SDK; deterministic
`mock` default), a schema-validated **tool registry** (Zod TS + Pydantic Python mirror, JSON
Schema derived from the schema so it can't drift), context builder, memory store over the
existing `aiMemory` field (no migration), and an **orchestrator** that is the sole patch
assembler (chat/plan/edit/autocomplete; `agent`/`review` are Phase 7 stubs). The web editor
gained an **AI panel** with a what/why/before-after diff + Apply/Reject wired through the
same validate→apply→record store path (so Undo works). Analysis tools
(`analyze_silence`/`detect_scenes`/`detect_faces`/`generate_mask`) were registered but
`available:false` until their engine lands (build order, not faked). See ADR 0012.
**Superseded (2026-07-15, B7.5):** `analyze_silence`/`detect_scenes` (and since then
`detect_beats`/`transcribe`, plus the brain-backed `search_media`/`find_similar`/
`session_context`) are **`available:true`** — their engines landed in Phase 8 and the
Project Brain sub-plan. `extract_frames` and `commit_vision` were subsequently removed
end to end (2026-07-19): they advertised a protocol the in-app model could not perform.
`detect_faces`/`generate_mask` remain `available:false`: still CV-dependency-gated
(CLAUDE.md §5).
**Test totals:** 268 engine tests (incl. AI tools) + TS suites (desktop 30, web-editor 164,
editor-core 64, timeline-schema 23, ai-sdk 57, ui 2, shared-types 3); `pnpm verify` green.
**Pro editor UI (2026-06-22):** the web editor was reorganized into a three-column NLE
workspace (left library rail: Media/Effects/Overlays/Captions · center stage: program
monitor/toolbar/timeline · right rail: AI/Inspector/Transcript), with raw-footage **import +
asset handling** (Media bin → schema-validated `Asset`, drag-drop or "Add" placement as an
undoable `add_clip` patch; per-asset **delete** that lifts the asset's clips then drops the
bin entry) and Effects/Overlays authoring panels — all routed through the existing
validate→apply→record store. The program monitor now **plays** (the `<video>` clock follows
the playhead/transport instead of freezing on one frame), and a full **keyboard-shortcut**
layer (Premiere/Resolve conventions: Space/J/K/L, Backspace/Delete ± ripple, S/⌘K split,
←/→ nudge, Home/End, M, zoom, ⌘Z/⌘⇧Z/⌘Y) builds typed patches through the same store. See
ADR 0013. Non-blocking follow-ups under Phase 8:
IPC bridge type duplication and renderer media/CSP hardening (Phase 3 security review), the
renderer→engine export IPC channel (would pass the UI burn-in toggle and enable a real
preview render from the AI Review UX), a **desktop import path** using the engine
`inspect-media` probe + sandbox-resolved on-disk paths (the browser path uses session-scoped
object URLs), and **syncing the store's edited timeline back into the saved `Project`**.
**Premium UI/UX pass (2026-06-23):** a UI/UX-only refinement of the web editor toward a
flagship NLE feel (see Phase 3.4 + ADR 0014) — refined design tokens + `lucide-react`
icons + frame-accurate `formatTimecode`; timeline **direct manipulation** (drag-move,
edge-trim, razor split, snapping, draggable playhead/click-to-seek, adaptive ruler,
zoom-to-fit/selection); a single typed **shortcut registry** driving the handler + a
searchable `?` help overlay; program monitor frame-step/loop/letterbox + 9:16 safe-area
guide; resizable/collapsible rails; drag-to-scrub inspector; clip context menu; toasts.
No engine/schema/validation change — every gesture is one validated reversible patch
through `useEditor`. web-editor: 248 tests, coverage ~98%. Real waveforms/thumbnails are
flagged as a deferred `Asset`/bridge contract change (Phase 8), skeletons until then.
**MCP server (2026-06-24):** a new `@framepilot/mcp-server` package (Phase 4.4) exposes
the canonical tool registry to external AI agents over the Model Context Protocol.
Tools are auto-derived from `TOOL_REGISTRY` (parity-tested), edits run through the
shared `assembleEdit` → validate → `commitPatch` → atomic-save path, paths are
sandboxed, and rendering delegates to the Python sidecar. New `mcp-engineer` subagent +
ADR 0015. mcp-server: 35 tests, 100% coverage on the editing-safety core. **Transport
moved stdio → Streamable HTTP on 2026-06-25** (loopback `127.0.0.1:19789/mcp`, ADR 0019;
clients attach by URL).
**Autosave + export + folder surfacing (2026-06-25):** three Phase 8 editor-shell
follow-ups closed (see ADR 0016). The `useEditor` store's edited timeline is now
lifted into the saved `Project` (Save/AI see the real edit state); a **debounced
autosave** writes path-less projects to the default projects folder on desktop and
to `localStorage` (with reload-restore) in the browser; the projects **folder is
surfaced** (clickable status path + File-menu reveal); and a new **export** path
(`framepilot:render:export` IPC → sidecar) drives a real, auto-validated video render
from an Export dialog (preset + caption burn-in), saving first since the engine
renders from disk. Four sandboxed IPC channels added (approved per CLAUDE.md §5); no
schema change. web-editor: 304 tests; desktop: 44 tests; `pnpm typecheck`/`lint`
green (the pre-existing `preload.cts` `require()` lint error is unrelated).
**Phase 5 started (2026-06-25):** first slice of Professional Motion is the
**keyframe evaluation engine** — a pure, deterministic easing + interpolation core
mirrored in TS (`packages/editor-core/src/keyframes.ts`) and Python
(`engine/python/.../effects/keyframes.py`): six easing curves, a property-agnostic
`evaluateKeyframes(keyframes, property, time)`, and a `punchInKeyframes` generator.
No schema change (pure behavior over the existing `Keyframe` shape); both engines
at 100% coverage. Also closed a latent contract bug — the Python `Easing` enum was
underscored and could never match the hyphenated schema/AI-tool easing names. See
ADR 0017.
**Phase 5 largely complete (2026-06-25, ADR 0018):** five further slices landed on
top of the keyframe engine, all no-dependency and at 100% coverage on the touched
core modules. (A) **Render wiring** — `effects/transform.py` + compiler apply
scale/x/y/rotation keyframes as MoviePy time-varying functions and static audio
gain; opacity is evaluated but its render is deferred to Phase 6 (reported, not
dropped). (B) **AI `punch_in` tool** (TS + Python mirror, parity-tested, surfaced
over MCP) via the shared generator. (C) **Keyframe editor UI** — Inspector punch-in

- add-keyframe controls through validate→apply→record. (D) **Masking** — `add_mask`
  carries geometry + effect keyframes in free-form params (no migration); pure
  `render/masks.py` rasterizer (rect/ellipse/polygon, feather, opacity, invert);
  static + animated (mask-keyframe) compositing; Inspector mask panel. (E)
  **Arbitrary-object tracking seam** — `track_object` generalized to any picked
  region; pluggable `effects/tracking.py` with a deterministic `ManualTracker` and a
  `get_tracker` that raises for automatic engines (real CV detection/segmentation is
  **dependency-gated**, CLAUDE.md §5 — the user deferred that choice). A tracked box
  drives the existing animated mask/transform render via `boxes_to_keyframes`.
  **Remaining for Phase 5 (gated on a CV dependency the user must approve):**
  automatic object/face detection, confidence/re-track, and AI subject segmentation
  (`detect_faces`/`generate_mask` stay `available:false`). **Test totals after Phase
  5:** engine 343 tests; web-editor 315; editor-core 92; ai-sdk 62; mcp-server 35.
  `pnpm verify` green except the pre-existing unrelated `preload.cts` lint error.
  **Phase 6 started (2026-06-26, ADR 0020) — checkpoint 1/3: Color.** Color now
  renders deterministically. A pure `engine/python/.../render/color.py` applies a
  parametric grade (exposure/contrast/saturation/temperature/tint/shadows/highlights —
  signed offsets, fixed order, numpy, 100% cov) to each frame via MoviePy
  `image_transform`; the compiler wires a clip's `color_grade` effect in before the
  letterbox/transform and mask. `apply_color_grade` is now **idempotent by effect id**
  (replace-in-place, mirrored TS `operations.ts` + Python `operations.py`) so an
  interactive grade or re-applied preset never stacks compounding effects. UI: an
  Inspector **Color** panel (7 controls + Apply/Reset, one reversible patch via
  `setColorGradePatch`) and an **approximate** live program-monitor preview
  (`colorGradeCssFilter`, CSS filter) with a **before/after compare** toggle — the
  exact result is the Python render (render-vs-preview rule). A pure `.cube` 3D-LUT
  parser + trilinear applier ship and are tested; LUT **file** import wiring is the one
  deferred sub-item (sandboxed-path decision, CLAUDE.md §5). No schema change, no new
  dependency.
  **Phase 6 checkpoints 2–3 complete (2026-06-26, ADR 0021): Sound + Transitions.**
  _Sound:_ pure `audio/mixing.py` (fade/normalize/duck/gain) composes into one
  per-clip time-varying gain; `adjust_audio` extended (optional fade/mute/normalize/
  duck — no new op, no schema change); a deterministic ffmpeg **master bus**
  (`audio/filters.py`: de-noise `afftdn`, loudness `loudnorm` presets, `alimiter`)
  runs as a post-encode pass threaded through RenderOptions → sidecar `/render` →
  CLI → export IPC/bridge → Export dialog; Inspector **Audio** panel. _Transitions:_
  pure `render/transitions.py` eases the incoming clip in (fade/cross-dissolve via
  opacity, push/zoom via geometry, blur); the compiler combines geometric mask ×
  opacity × transition fade into one alpha and sets composite `bg_color` so partial
  alpha blends — which also **closes the Phase 5 opacity-render deferral** (opacity
  now composites; `unsupported_animated_properties` is empty). EffectsPanel adds
  Blur. **Gated/deferred (no new dep):** advanced sound (EQ/compression/buses/
  auto-SFX) and advanced transitions (beat detection, rhythm/motion-match, whoosh-
  sync) — need a richer master spec or a dep like `librosa` (CLAUDE.md §5); advanced
  color (curves/scopes/shot-match) not started; LUT file-import still pending its
  sandbox decision. No schema change, no new dependency in any Phase 6 checkpoint.
  **Test totals after Phase 6:** engine 397 tests; web-editor 330; desktop 44;
  editor-core 94; ai-sdk 62; mcp-server 41. `pnpm verify`-level checks green
  (production code mypy-clean; ruff at pre-existing baseline; the only remaining
  mypy notes are the pre-existing pydantic-alias pattern in test files).
  **Phase 7 complete (2026-06-26, ADR 0022) — full agent mode & the Critic.** The
  orchestrator's two remaining modes shipped on top of the existing engine, with **no
  schema change, no migration, and no new dependency**. **Agent mode** (`agent()`) is a
  bounded multi-step tool-calling loop: each turn's mutating calls become a validated,
  reversible patch applied to a working copy (read tools fed back, render/export calls
  logged not run); it stops on no-progress or a step cap and returns a reviewable
  `AgentRun` (step log + a combined one-patch edit + a self-check), never auto-applied —
  the human approves, and the single combined patch makes Apply **one-click-revertible**.
  The **Critic** (`critic.ts#critique`, pure/deterministic, 100% cov) runs all 8 PRD §8.6
  checks; black-frame/audio-clipping checks consume the existing `validate_render` result
  when a preview render ran, else `skipped` (no faked capability). `review()` wraps the
  Critic (no model call). **Style presets** seed the existing `aiMemory` preferences (no
  schema change). The web AI panel's **Agent** mode is live (preset selector, run, self-
  check badges, step log, Apply-all/Reject) — running locally via the offline mock
  provider; a real-provider IPC path is a Phase 8 follow-up. **Test totals after Phase 7:**
  ai-sdk 95 tests; web-editor 333; engine/editor-core/mcp-server unchanged.
  **Phase 8 driven end-to-end (2026-06-26) — production hardening nearly complete.**
  Shipped: the single-source renderer↔desktop **IPC contract** (`@framepilot/shared-types`,
  ADR 0023); **100% core coverage** (fixed a real `operations.ts` branch gap); a **full
  browser E2E suite** — 20 deterministic offline Playwright specs (load/new, transport,
  transcript+captions, the mock-AI propose→review→apply→undo loop, pointer-driven
  timeline gestures, export boundary) + a **6-shot visual-regression** suite with
  committed baselines; the **license gate**; a **security audit** with every CRITICAL/HIGH
  finding fixed + tested — Electron IPC path **sandbox** (1.1), Python sidecar route
  sandbox (1.2), TS sandbox unified into `@framepilot/shared-types/safety` (1.4), renderer
  **CSP** + sandboxed **`fp-media://`** scheme replacing `file://` (3.2), ADR 0025; the
  **project schema v2** (`Asset.media` + v1→v2 migration + Pydantic parity, ADR 0024)
  with an engine `/asset-media` **peaks** producer and the timeline drawing **real
  waveforms** from them; **performance budgets** + a complexity guard; **opt-in
  local-first telemetry**; and the **signing + auto-update scaffold** (electron-builder +
  `electron-updater`). Remaining Phase-8 slices: the desktop media-import IPC/UX that
  feeds engine peaks onto assets (engine + consume done; needs a real-path channel),
  thumbnails, the v1.0.0 checklist ticked at release, and the audit's post-v1 hardening
  backlog (security runbook). **Totals after Phase 8:** desktop 65, web-editor 338,
  editor-core 96, shared-types 13, mcp-server 41, ai-sdk 95; engine 412; e2e 20 + 6
  visual. **Phase 9** collects all deferred/dependency-gated work.

**Media-bin folders + AI asset management (2026-06-26, ADR 0026).** The patch engine was
generalized to **project scope**: a new `ProjectOperation` family (assets + folders)
flows through the same validate→apply→record→undo pipeline as timeline ops, in one shared
history. Shipped: **schema v3** (`Project.folders` tree + `Asset.folderId`; additive
v2→v3 migration + Pydantic parity); project-scoped `applyProjectPatch`/`invertProjectPatch`/
`commitProjectPatch`/`diffProject` + validator checks (duplicate/missing refs, folder
cycles, `asset_in_use`) at 100% editor-core coverage; two new tools **`add_asset`** and
**`manage_assets`** (TS + Python mirror; `manage_assets` takes a semantic plan or
`by-kind`); the **agent loop** applies turns at project scope so one run can "manage my
assets and edit the video"; the MCP session commits project-scoped patches and
**sandbox-checks `add_asset` paths**; and the web editor's **media bin** gained a nested
folder tree (create/rename/delete, drag-to-fold, empty-folder state) with OS-like motion,
all undoable. **Totals:** editor-core 141, ai-sdk 108, mcp-server 44, web-editor 343;
engine 417. **Last updated:** 2026-06-26

**MCP active-project + default folder (2026-06-26, ADR 0027).** Two fixes so an external
agent edits the _right_ project: (1) the MCP server's projects sandbox now **defaults to
`~/Documents/FramePilot Projects`** (the app's folder) instead of requiring
`FRAMEPILOT_PROJECTS_ROOT` — a shared `@framepilot/shared-types/projects-root` resolver
keeps app + server in lock-step. (2) The desktop app writes a `.framepilot-active.json`
pointer naming the GUI's open project; `open_project` with no path — and any tool when
nothing is open yet — **auto-targets that project** (`openActiveProject`/`ensureOpenProject`,
sandbox-checked). **Totals:** mcp-server 47, shared-types 19, desktop tests +5 (active-project
store); editor-core/ai-sdk/web-editor unchanged. **Last updated:** 2026-06-26

**Live project-file sync + virtualized media bin (2026-06-28, ADR 0030).** Two Phase 8
follow-ups closed. (1) **Real-time end-to-end project-file sync:** the desktop app now
reflects external edits to the open `project.fp.json` **live** — the motivating case is
an AI agent editing it through the MCP server while the GUI has it open. A new tested
`ProjectFileWatcher` (`apps/desktop/electron/projects/project-watcher.ts`) owns dedup
(canonical-serialization self-write suppression via `markSelfWrite`) + debounce (100%
line/stmt/func cov, 10 tests); `main.ts` watches the open file's **directory** (robust
across atomic-rename saves), validates on change, and pushes to the renderer over a new
push IPC channel `framepilot:project:changed` carrying a `ProjectChangedEvent`. The
shared `FramePilotBridge` (shared-types) gained `onProjectChanged(listener)→unsubscribe`
(implemented in `preload.cts`); `serializeProject` is re-exported on
`@framepilot/timeline-schema/file`. The renderer's `onProjectChanged` helper validates
with `safeParseProject` (malformed external writes dropped, invariant 3); `App.tsx`
**auto-reloads** (on-disk file is the source of truth) by bumping a remount nonce on the
`Editor` key + suppressing the autosave echo. No schema change; one new push IPC channel
(approved). (2) **Virtualized media bin:** `MediaBin` flattens its folder tree and windows
it with `@tanstack/react-virtual` (new web-editor runtime dep, MIT, license scan clean,
approved per CLAUDE.md §5); `AssetThumb` memoized; `useAssetThumbnail` video-frame capture
concurrency-gated (max 4). All `aria` hooks preserved; no schema/validation change.
**Totals:** shared-types 19, web-editor 376 (+bridge `onProjectChanged`, App live-reload,
large-list bin tests), desktop 98 (+10 watcher tests), timeline-schema 27 — all green;
`pnpm typecheck` green, `pnpm lint` at its known baseline (pre-existing `preload.cts`
`require()` error only). The two pre-existing e2e failures (New-project dialog drift; AI
Chat button) are unrelated and fail identically on a clean tree. **Last updated:** 2026-06-28

**AI orchestration clarity, full tool coverage & model picker (2026-07-01, ADR 0033
amendment; see `plan/AI-SIDEBAR.md` follow-up).** Closed the gap between "the sidebar
streams" and "the stream is legible + capable". (1) **Real specific progress:** the agent
loop's hardcoded "Step N: analyzing the timeline"/"Agent progress" is replaced by
reasoning/plan/progress/tool-title/timeline-action text **derived from the real tool
calls + args + resolved clip/track/asset names** — new pure `projectNames`
(`packages/ai-sdk/src/names.ts`, 100% cov) + `describeToolCall` + extended
`describeOperation(op, names?)`; `emit.progress` gained an optional stable `key` so one
bar updates in place. CoT is still never surfaced. (2) **Full tool coverage:**
`set_track_flags` (mute/lock/hide) registered in the TS registry **and** mirrored across
the Python engine — Pydantic args + handler **and a new `SetTrackFlags` operation
(apply/invert/validator)** so engine/editor semantics match and it round-trips; surfaced
over MCP; toolMeta mapped. No schema change (v4 `Track` already has the flags). (3)
**Desktop model/provider picker:** read-only `ai:providers` IPC (`{name,label,model,
ready}`; the API key never crosses the bridge) + an allowlist-validated optional
`provider` on `AiStreamRequest` threaded to `AiStreamHub.orchestratorFor(provider)`; a
header model selector + Cursor-style empty state in `AiSidebar`. **Totals:** ai-sdk 182
(+names/describe/progress), engine 441 (+set_track_flags op/handler/parity), mcp-server 61,
desktop 126 (+provider), shared-types 19, web-editor 594 — all green; `pnpm typecheck`
green; ruff/mypy clean on touched engine files. **Last updated:** 2026-07-01

**Performance hardening + MCP safety-at-scale (Phase 12, 2026-07-03; ADR 0034).** Driven
by a two-front audit (`docs/reports/2026-07-02-*`); two new subagents
(`performance-optimizer`, `performance-monitor`). **Frontend runtime perf** — killed the
per-seek re-render storm behind the reported lag: playhead-free panels (Media bin,
Effects, Overlays, AI sidebar, toasts) are memoised on a key excluding `playhead` so a
60fps seek reuses them (stable `getPlayhead()` keeps their handlers correct); wheel/pinch
zoom coalesces to one `setZoom` per frame; the clip-drag ghost uses a leading-edge rAF
throttle (was rebuilding all lanes per pointer sample); the minimap is `React.memo`+cached;
ruler ticks/duration memoised. Deterministic render-count guard (`Editor.perf.test.tsx`).
Deferred (higher-risk): imperative playhead marker to stop `TimelineView`/`Toolbar`
re-rendering at all (Slice 1b), and a fully-separate drag-ghost overlay. **MCP server** —
(M1) fixed the reported filesystem-bypass: top-level MCP `instructions` steer the client
to the tools + `stateView` no longer leaks the absolute project path (returns
`projectId`/`projectName`); (M2) hardened the transport for scale — Host+Origin checks
(403), body cap (413) + malformed-JSON 400, session cap (503), optional bearer auth
(off by default via `FRAMEPILOT_MCP_TOKEN`, else 401), `save_project` lost-update
`conflict` guard, and active-pointer sandbox (closes the ADR 0027 last-writer-wins +
no-sandbox-gate limitations). **Totals:** web-editor 613, mcp-server 80, ai-sdk 185 — all
green (typecheck+lint); no schema change, no new dependency. **Last updated:** 2026-07-03

**Marketing website + Freemius licensing (Phase 14, 2026-07-03; ADR 0036).** Made
FramePilot a sellable, downloadable, **100%-paid** product. (1) **`apps/website`** —
a statically-exported Next.js App Router marketing site reusing the app's dark design
tokens: a conversion landing page (announcement bar → hero with a CSS editor mockup →
integrations → feature bento → how-it-works → demo → pricing preview → FAQ → CTA),
`/pricing` (**subscription — $25/mo or $199/yr**, Monthly/Annual toggle + **Freemius
checkout overlay** with `billing_cycle`), a full **`/docs` site** (authored
`content/docs/*.mdx` rendered at build time, grouped sidebar + scroll-spy TOC +
prev/next), a markdown `/blog` (SEO seed posts + JSON-LD + sitemap/robots/RSS),
`/download` (OS-detected → latest GitHub Release), `/thank-you`, legal. Fully keyboard-
navigable (skip link, ⌘K palette, accessible FAQ); offline **OG/icon generator**
(`scripts/generate-og.ts`); prices pulled **live from Freemius** (monthly+annual) at
build with a typed fallback (never hand-faked; savings % computed). (2) **Electron
license gate** (`apps/desktop/electron/license/`) — device-`uid` activation against the
public Freemius activate/validate endpoints, daily revalidation with a **7-day
offline-grace** window; pure `license-gate` decision core; store mirrors `AiConfigStore`
(key/token stay in main, only a masked `LicenseStatus` crosses the bridge); three IPC
channels; AI/render/export handlers refuse when unlicensed (defense-in-depth);
enforcement is **off unless a product id is configured** (dev/tests unaffected).
Renderer `LicenseGate` wraps `<App/>` and shows a dedicated **renew** screen for a
lapsed subscription (masked key + end date + renew CTA). **No project-schema change, no
new dependency.**

**Subscription + "Cursor for video" repositioning + dependency-free 3D (2026-07-03).**
Pivoted pricing from a one-time $49 lifetime license to a **$25/mo · $199/yr
subscription** (Monthly/Annual toggle, honest computed savings, `billing_cycle`
checkout, subscription-aware desktop gate). Repositioned the site around Cursor's
agent-for-you framing — tagline **"Your editing agent for stunning video"**, delegation
hero copy, agent/hand-off section headings, regenerated OG (no fabricated
testimonials). Added a **dependency-free 3D/premium layer**: ambient aurora `<canvas>`,
perspective **tilt** on the product shot, pointer **spotlight** cards, scroll **reveal**
— all `prefers-reduced-motion`-aware. Built the **full docs site** (lib/docs.ts +
markdown TOC extractor + 8 authored pages).
**Totals:** desktop 161, web-editor 621 (+renew test), website 12 (billing-cycle/savings
math); `pnpm typecheck`/`lint`/`test` green; website `next build` green (26 routes).
**Last updated:** 2026-07-03

**Non-gated plan cleanup (2026-07-04).** Closed the three remaining plan items that
needed no gating decision (no new dependency, no schema change). (1) **AI analysis tools
`analyze_silence` + `detect_scenes` shipped** — a new non-mutating **`analysis`** tool
kind runs in the engine via the existing ffmpeg toolchain (`silencedetect` / scene score),
following the render-validation design (injectable log-runner + pure 100%-testable parser,
subprocess bounded by `FRAMEPILOT_ASSET_MEDIA_TIMEOUT_SECONDS`); new sidecar routes
`/analyze-silence` + `/detect-scenes`, an MCP `AnalysisClient` (validate→save→sidecar), and
TS/Pydantic arg parity (guard green). Both flipped `available:true` (`detect_faces`/
`generate_mask` stay CV-gated). (2) **`/asset-media` derivation is now time-bounded** —
`FRAMEPILOT_ASSET_MEDIA_TIMEOUT_SECONDS` (default 60s) threaded into probe/waveform/
thumbnail derivation; probe timeout → 422, waveform/thumbnail degrade to `null` so import
never hangs. (3) **Phase 3.4 Part 6 (app chrome)** confirmed complete — the slim topbar +
live Settings dialog were already implemented; verification closed a persisted-setting→
observed-behavior test gap. **Everything else remaining is either gated on a dependency/
policy decision the user must make (CV / librosa / LUT-path / richer audio spec — Phase 9.0)
or a large multi-phase roadmap (Phase 13 R0–R5, Phase 11 sidebar remainder, timeline-revamp
M4–M7).** **Totals after this pass:** engine 473, ai-sdk 306, mcp-server 91, web-editor 624;
`pnpm verify` green (exit 0). **Note:** add `FRAMEPILOT_ASSET_MEDIA_TIMEOUT_SECONDS=60` to
`.env.example` (that file is outside the tool path-sandbox — needs a manual add).
**Last updated:** 2026-07-04

**Website: customer changelog, premium redesign & link cleanup (2026-07-04).** (1) Added a
customer-facing **`/changelog`** to `apps/website` — authored MDX in
`content/changelog/*.mdx` behind a typed loader (`src/lib/changelog.ts`, tags limited to
New/Improved/Fixed, +3-test spec), rendered through the existing remark→rehype pipeline as a
clean date/version timeline; wired into the footer, ⌘K menu, and sitemap. (2) Introduced a
**`changelog-maintainer`** subagent + skill (`.agents/skills/changelog-maintainer/`,
`.agents/agents/{claude,codex}`, opencode config; `.claude/agents` picks it up via the
existing symlink) that **translates** shipped user-visible changes into plain-language,
benefit-first entries and never leaks engineering detail or repo links — the customer-facing
counterpart to the engineer-facing root `CHANGELOG.md` (owned by `docs-maintainer`). (3)
**Premium redesign, gradient-free** — removed every decorative gradient (aurora canvas,
accent glows, gradient headline/shimmer, grid overlay, spotlight-glow cards, gradient
hairlines/connectors) for a cleaner cursor.com-like look built on solid surfaces + hairline
borders; deleted the now-unused `AuroraCanvas`/`TiltCard`/`useSpotlight` helpers. (4) Removed
all **GitHub/repo links** from the UI (footer, ⌘K, download/docs pages; downloads still
resolve to the release feed), removed the **duplicate header Pricing button**, and linked the
author credit to **rojanacharya.com**. `pnpm typecheck`/`lint`/`test`/`build` green (website
15 tests). **Last updated:** 2026-07-04

**[x] Payments fix + license anti-crack (2026-07-05; ADR 0037).** Two production
defects fixed. (1) **Pricing CTAs were dead:** `openCheckout` only opened the Freemius
overlay when `NEXT_PUBLIC_FREEMIUS_*` were inlined at build, else it silently reloaded
`/pricing`. Root cause — `turbo.json` didn't declare those vars, so Turbo pruned them
from `next build`'s env and they inlined empty. Fixed by declaring them in `globalEnv`
(verified: product id + plan ids inline into the built bundle) and making
`openCheckout` **throw** on misconfig/overlay-failure so `BuyButton` shows a visible
error instead of a dead click. (2) **License was forgeable:** plaintext `license.json`
let anyone hand-write `{isValid:true}`. Now `safeStorage`-encrypted via an injectable
`LicenseCrypto` on `LicenseStore` (wired in `main.ts`); tampered/undecryptable records
**fail closed**, and when encryption is available a plaintext record is never trusted
valid (forces online re-verify → blocks forgery + migrates genuine records). Honest
threat model documented (asar-repack still bypassable). Desktop 175 tests (+3:
round-trip/migration/tamper), website 15; typecheck+lint green both. **Last updated:**
2026-07-05

**AI sidebar reliability + UX polish (2026-07-05).** Fixed the frequent agent-edit
failure and reworked the sidebar's activity surface. (1) **Tool-arg type coercion** —
providers that serialise numbers as JSON strings (`{"start":"5"}`, common on NVIDIA/
OpenAI-compatible models) were failing `add_clip`/`trim_clip`/… ~9/10 with `expected
number, received string`. The tool registry now coerces string-encoded numbers and
`"true"`/`"false"` booleans at the untrusted boundary while still advertising
`number`/`boolean` in the JSON Schema and rejecting genuinely bad input. (2) **Real
streamed reasoning (#2)** — `streamAgent` streams the model's OWN rationale into the
"Thinking…" panel (shimmer while arriving) instead of hardcoded lines; a new
`StreamSink` routes streamed text to assistant/reasoning/silent. (3) **No fake
percentages (#5)** — removed the agent progress bar (`agentProgress`/`AGENT_PROGRESS_KEY`
gone); the header shows a spinner ONLY while running (#7). (4) **Clearer cards** — tool
status is an icon+tooltip (#10) with a concise summary, a **View details** modal, and a
**Copy** button (#9); failed plan steps reveal the error on hover of the cross (#4, new
`PlanStep.detail`). (5) **Composer** — auto-grow textarea keeping +/send visible (#6),
nicer pulsing stop button (#8). ai-sdk 330 tests (100% cov on events/orchestrator/
registry), web-editor 628; typecheck+lint green on both touched packages; ai-sdk dist
rebuilt (web-editor/desktop consume it). **Last updated:** 2026-07-05

**Customer changelog: "A clearer, more reliable AI panel" (2026-07-05, v1.1.1).** Added
`apps/website/content/changelog/2026-07-05-clearer-ai-panel.mdx` translating the AI sidebar
reliability + UX work above into plain-language, benefit-first entries for creators — AI
edits apply reliably now (Fixed), plus streamed thinking, honest progress, per-step status
with details/copy, and a smoother composer (Improved). No engineering detail or links; tags
match sections; website `pnpm build` green and `/changelog` renders it. **Last updated:**
2026-07-05

**AI sidebar round 2 — reliability + accordion cards (2026-07-05).** Follow-up from live
testing. (1) **Valid edits stopped being lost to junk args** — a new `sanitizeToolArgs`
strips top-level keys a model invents (e.g. `manage_assets({ action, projectId })`) on the
AI path before validation; the registry schema stays strict (its tests unchanged).
(2) **Plan-step status corrected** — read-only/no-op turns are `completed` (check), not
`failed` (cross); only a genuinely failed tool or rejected edit is a cross (this is why
tool cards showed checks while plan rows wrongly showed crosses). (3) **Terminal-state
robustness** — `streamAgent` wraps its body in try/catch/finally so a thrown provider
error still emits an error notice, marks reasoning done, and emits a terminal `failed`
status; the header spinner + "Thinking…" shimmer can no longer get stuck. (4) **Tool cards
are accordions** with a SHORT card summary + FULL result in the details popup
(`toolResult` now carries `summary` + full `data`); reasoning no longer duplicates the
plan checklist and an empty reasoning row is hidden. ai-sdk 335 tests (100% cov on
events/orchestrator/registry), web-editor 631; typecheck+lint green; mcp-server 91 green;
ai-sdk dist rebuilt. **Last updated:** 2026-07-05

**[x] Reasoning-model output hygiene (chat renders raw `<think>` as plain text).**
Reasoning models (DeepSeek-R1 et al. via GitHub Models/Groq/OpenRouter/NVIDIA) emit
chain-of-thought either inline as `<think>…</think>` in `content` or in a separate
`reasoning_content`/`reasoning` delta field. The shared OpenAI-compatible parsers
(`parseOpenAiSse`/`parseOpenAiCompletion`) read only `delta.content`, so the rationale
bleeds into the assistant message and renders as an unformatted wall (react-markdown
drops the unknown `<think>` tag, flattening everything). Fix at the provider layer: a
new `reasoning-delta` `ProviderChunk`, a stateful `ReasoningTagSplitter` that strips
inline `<think>` blocks (tags may span stream chunks) and captures the reasoning-field
deltas, plus Anthropic `thinking_delta`. `streamAssistant` routes reasoning-deltas into
the existing `reasoning`/`reasoning_delta` events (already rendered by the collapsible
`Reasoning` node), so assistant text stays clean markdown. No schema/dep change.
**Done:** `providers/reasoning.ts` (new, 100% cov) + `types.ts`/`nvidia.ts`/`github.ts`/
`anthropic.ts` parsers + `orchestrator.streamAssistant` (chat/edit capture reasoning;
plan/agent keep their own reasoning node). ai-sdk 917 tests green (+26), lint+typecheck
clean, dist rebuilt. Rebuilding dist surfaced a pre-existing registry↔UI drift
(`list_assets` had no `toolMeta` entry) — mapping added; web-editor AI tests 56 green.

**Production-hardening pass: orchestration honesty, playback perf, project index
(2026-07-05).** A root-cause pass over the AI apply path, the playback pipeline, and
startup. (1) **Silent-success fixed (the "edit didn't actually apply" bug):** the AI
sidebar's Accept/Apply-all committed via fire-and-forget `applyPatch` and reported
"Applied" (and recorded positive `aiMemory` learning) even when the store's validator
refused the patch (timeline changed since the run started). New
`useEditor.applyPatchChecked` re-validates against the CURRENT state; the diff card
gains an explicit `failed` decision ("Couldn't apply — the timeline changed"), batches
stop at the first non-landing edit, and no learning is recorded on failure. (2)
**Per-call recovery in `streamEdit`:** one malformed tool call no longer discards the
other valid calls (warnings + partial diff; `failed` only when ALL calls were
rejected). Read tools get the same `sanitizeToolArgs` junk-key tolerance as mutating
tools (a padded `get_timeline({projectId})` no longer fails the inspection).
(3) **Playback re-render storm killed (closes the deferred Slice 1b differently):**
the rAF playback loop dispatched `seek` into the reducer per frame, re-rendering
Editor + PreviewPlayer + Inspector + Transcript + CaptionEditor at 60Hz. New
`useEditor.seekTransient` advances ONLY the playhead clock; `setPlaying(false)`
commits the clock into the reducer; PreviewPlayer/PreviewAudioMixer/TranscriptView/
CaptionEditor subscribe via `usePlayhead`, and shortcuts read `getPlayhead()` (split/
nudge/paste act at the LIVE position during playback). Playhead handle gains a large
invisible hit area + a compositor-layer hint. (4) **Local project index**
(`packages/ai-sdk/src/project-index.ts`, 100% cov): Cursor-style entity/structural/
relationship/text queries, WeakMap-memoized per immutable project snapshot with
per-track sub-index reuse (incremental by construction; deletions can't leave stale
entries); `projectNames` + the context builder now read from it. Follow-up (registry
change — needs the Python mirror + MCP parity, CLAUDE.md §5): expose a
`query_project` read tool over the index so a model asks targeted questions instead
of dumping `get_timeline`. (5) **Startup:** an inline critical style paints the dark
canvas before the bundle loads (no white flash); the license check shows a branded
splash (reduced-motion aware); Home-screen recents capped at the latest 5.
Also repaired the 3 pre-existing e2e failures in `ai-edit-review-apply-undo.spec.ts`
(the sidebar's mode selector became a dropdown menu in the sidebar rework; the spec
still clicked role=tab) — e2e is 20/20 again. **Totals:** ai-sdk 346 tests (100% cov
incl. the new index), web-editor 640, e2e 20; full `pnpm verify` green.
**Last updated:** 2026-07-05

**AI sidebar: Apply mode + empty-run honesty + overflow (2026-07-06).** Three fixes to
the AI orchestration surface reported from a live Agent run. (1) **Empty-run with no
card, root-caused:** in `streamAgent` a tool call whose operation the validator later
rejected (e.g. a `trim_clip` that overlaps its neighbour) still emitted a
`timeline_action` "Trimmed clip …" row at call time, yet the op never entered
`cumulativeOps` — so a run could show a wall of activity and end with an empty combined
diff, which the view reducer suppresses (0-op diffs render no card). Reproduced with a
scripted overlap trim. Fix: `timeline_action` cards are now emitted **after** the turn
validates and applies (only for ops that landed), and a run that applies nothing but
attempted work emits an explicit warning naming the validator's reason instead of
ending silently. (2) **Apply mode (Manual/Auto):** a new dropdown beside the mode
selector — Manual (default, review cards) vs Auto (apply each valid edit the instant it
streams in, still via `applyPatchChecked`, still Undo-reversible). Persisted to
localStorage (UI pref, no schema change); per-option `?` help tooltips + an ⓘ info icon
beside the dropdown. The auto-apply effect guards against StrictMode double-apply (ref
of handled node ids) and decides every pending node so it can't loop. (3) **Overflow:**
`.ai-event` cards wrap long unbroken strings (provider error JSON, asset ids) via
`overflow-wrap: anywhere` + `min-width: 0`; the notice text column and tool name shrink
correctly and review buttons wrap in a narrow sidebar. **Totals:** ai-sdk 386 tests,
web-editor 723 (2 new sidebar tests + 1 new orchestrator test); typecheck + lint green;
production build green.
**Last updated:** 2026-07-06

**Customer changelog: "Let the AI edit hands-free — or keep every change on approval"
(2026-07-06, v1.1.2).** Added
`apps/website/content/changelog/2026-07-06-ai-apply-mode.mdx` translating the Apply mode
work above into plain-language, benefit-first copy for creators — a new Manual/Auto Apply
mode control (New), plus honest empty-run results and tidy long error messages (Fixed). No
engineering detail or links; tags match sections; website `pnpm build` green and
`/changelog` renders it. **Last updated:** 2026-07-06

**Preview focus, dropdown stacking & tooltip overflow (2026-07-06).** UI/UX round from
live screenshots. (1) **Text overlays are now editable from the preview:** clicking an
overlay used to fall through the full-frame `.preview-select-hit` (z 2) and reselect the
background clip; `.preview-overlays` now sits above it (z 4) with the overlay text a
keyboard-operable control that selects THAT clip → its on-canvas move/resize/edit box.
(2) **`Select` popover portaled:** the orientation menu rendered behind the preview and
ran off-screen because `.preview-stage`/`.preview-frame` use `container-type: size`
(→ `contain: layout`, a stacking context that trapped the absolutely-positioned menu).
The popover is now portaled to `document.body` with fixed, viewport-clamped coords that
auto-flip up/down (z 350, above modals), fixing it everywhere including inside dialogs;
outside-click also excludes the portaled list. Trigger height aligned to the transport
buttons (2.1rem). (3) **Tooltip overflow:** `white-space: nowrap` let long help/info text
run off the viewport; it now wraps at a capped width and the bubble is clamped
horizontally on-screen. **Totals:** web-editor 724 (1 new preview-selection test);
typecheck + lint + production build green.
**Last updated:** 2026-07-06

**Customer changelog: "A few rough edges in the editor, smoothed out" (2026-07-06,
v1.1.3).** Added `apps/website/content/changelog/2026-07-06-editor-fixes.mdx` translating
the preview-focus / dropdown-stacking / tooltip-overflow round above into plain-language,
benefit-first copy for creators — click a text overlay on the preview to move/resize/edit
it, the canvas-shape menu opens in view and aligned with the playback buttons, and long
tooltips wrap and stay on screen (all Fixed). Distinct slug from the same-day `ai-apply-mode`
entry; no engineering detail or links; tags match sections. **Last updated:** 2026-07-06

**Phase 16 shipped: agent-native editor UX (2026-07-06, ADR 0041).** The full
`plan/AGENT-NATIVE-UX.md` sub-plan landed end to end. **T (truthful execution):**
`HostToolExecutor` seam + async `runAgentCall` — analysis/action calls are AWAITED
between the tool card's `running` and terminal events, results feed the model's next
turn, no executor ⇒ honest failure (never a fabricated ✅); new `cancelled` ToolStatus
(Stop aborts the in-flight HTTP); per-run analysis dedup; `createSidecarExecutor`
wired into desktop main (`net.fetch`), browser (opt-in `VITE_FRAMEPILOT_PYTHON_API_URL`),
and mcp-server (analysis-client + `/detect-beats` route); analysis routes accept the
agent's in-memory project INLINE (media paths still sandbox-checked, traversal-tested).
**T6:** numpy-only `detect_beats` (ffmpeg PCM → energy-flux onsets → adaptive peaks →
median-interval BPM with octave folding), 13 synthetic-click-track tests. **U:**
mid-run model text streams into per-turn assistant segments interleaved with tool
cards; planFirst plans emit immediately as a pending todo ledger whose steps flip
running (intent as detail) → completed/failed; "Thought for Ns" from real event
timestamps; markdown completion report on applying runs; tool cards gained an args
line + live elapsed. **P:** decoded-bitmap LRU (`bitmapCache.ts`), ONE canvas per clip
filmstrip (ADR 0040 clamps), 120ms zoom-settle freeze; perf gate
`ClipFilmstrip.perf.test.tsx`. **B:** 24px collapsed rails, splitter hidden while
collapsed, toggle-armed collapse animation. **Totals:** ai-sdk 419 (100% cov),
web-editor 746, desktop 179, mcp-server 92, engine 497; typecheck/lint green
everywhere. **Last updated:** 2026-07-06

**AI sidebar: editor-first polish + per-change review popup (2026-07-12; see
`plan/AI-SIDEBAR.md` follow-up).** Three UX asks targeting _video editors_. (1)
**Streaming feel:** the stream smart-auto-scrolls while a message streams (a
`ResizeObserver` follows the growing node — fixes single-message streams that
didn't stick), pauses when the reviewer scrolls up, re-arms at the bottom; the
"thinking" accordion auto-collapses when reasoning completes (until the user
toggles it by hand). (2) **De-programmered UI:** no raw JSON/ids/`ms`/arg dumps —
runtimes read "instant"/"2s", the tool details popup is a plain-language recap,
diff wording speaks edits ("Suggested edit"/"changes"/"Can't apply this edit")
with premium decision pills. (3) **Per-operation review popup**
(`DiffPreviewModal.tsx`): "Show preview" → a **Review changes** dialog listing every
change in plain language + `m:ss` timecode with a Keep/Remove toggle; the right
stage is the real `AiReviewPlayer` (HTML-video) previewing exactly the kept subset
**seeked to the selected change** (never 0:00; new `startAt` prop, live re-seek);
"Jump to timeline" reveals + seeks the real playhead. **Invariant-safe subset
apply:** a kept subset re-assembles a brand-new _validated_ patch via `assembleEdit`
and applies atomically through `applyPatchChecked` — never half-applied; an
unstandable subset fails validation honestly. **Totals:** web-editor 1051 (new
`DiffPreviewModal.test.tsx` + rewritten `EventNode`/`AiSidebar` specs); typecheck +
lint clean. No schema change; `validate→apply→record` untouched.

**Media intelligence closure — `[~]` IN PROGRESS (2026-08-28; see
`plan/media-intelligence-closure/`).** A 61-photo project reported `0/61 assets
prepared · 0%` with a "running" badge and never produced a footage map. Diagnosed
against the user's own brain databases, not a synthetic repro: **still photos were
dispatched to TwelveLabs, whose index is a video/audio index**, and the resulting
`404 resource_not_exists` broke the hosted slice _without advancing the job cursor_,
so every retry re-hit photo #1 forever while the job journalled itself `running`.
`[x]` **Phase 1 (preparation correctness) shipped** — stills route to the on-device
embedder (maintainer decision, per-asset capability routing), a refused asset advances
the cursor, a run of refusals stops the slice and marks the job `failed`, coverage is
the union of both backends, the footage map merges both arms, and the Settings panel
derives its badge from the job rather than from coverage. 6 new engine regression tests
(fail before / pass after); engine suite 2635 green. `[ ]` Phases 2–5 open: the
auto-injected footage map carries **asset seconds under a timeline label** (largest
remaining correctness gap), ≈98% of measured preparation wall clock is serialized
network wait, multiple NVIDIA keys are failover rather than throughput, and per-asset
outcomes are never persisted (one project holds 55 assets, ~100 `done` jobs and zero
index rows).

**Media Intelligence plan authored (2026-07-18; see
`plan/MEDIA-INTELLIGENCE.md`) — `[x]` COMPLETE (2026-07-18).** Sub-plan (phases MI0–MI7) giving the
orchestrator visual understanding on top of the completed Project Brain (B0–B7):
adaptive scene-aware frame sampling (≤1 vector/sec, dHash dedupe, contiguous
spans), NVIDIA `llama-nemotron-embed-vl-1b-v2` cross-modal embeddings with a
comma-separated multi-key failover ring, per-scene VLM captions via the existing
provider registry, `sqlite-vec` KNN inside `brain.sqlite` (honest brute-force
fallback), RRF fusion search over visual + caption + transcript recall, new
`search_visual`/`describe_footage`/`index_media` tools + context grounding, and
a Settings → AI → Embeddings subtab (plain-text keys per explicit user
requirement). Ask-before items: `sqlite-vec` dependency + packaging, brain
migration, three ADRs.

**TwelveLabs optional understanding backend — `[x]` COMPLETE (2026-07-20; see
ADR 0070).** Added TwelveLabs (twelvelabs.io) as an alternate media-understanding
backend behind the **same `/brain/visual/*` routes**, selected by a
`TWELVELABS_API_KEY` (request body → host config slot → engine env). When a key
resolves, index/search/status delegate to TwelveLabs' hosted Marengo index
(visual + audio + speech); otherwise the built-in NVIDIA-embed pipeline runs
unchanged. TwelveLabs clips map onto the existing `EvidencePacket` contract
(`backend: "twelvelabs"`); the asset↔video mapping reuses existing brain tables
(no migration); whisper still owns captions/transcript (no caption regression);
`describe_footage` is honestly unsupported on this backend. New:
`engine/.../brain/twelvelabs.py` (thin `httpx` REST client — no new dependency) +
`twelvelabs_index.py` (paced upload/poll + clip→packet mapping), route branches in
`service.py`, `twelveLabsKey` plumbing in ai-sdk + shared-types, and a TwelveLabs
key slot in the desktop config and web-editor Settings. 39 new engine tests + host
tests; env added to `.env.example`/`turbo.json`.

**AI Footage Intelligence — End-to-End plan authored (2026-07-21; see
[`plan/AI-FOOTAGE-INTELLIGENCE-E2E.md`](./AI-FOOTAGE-INTELLIGENCE-E2E.md)) —
`[ ]` NOT STARTED, awaiting review.** Sub-plan (phases FI0–FI6) closing the gap
between _"footage is indexed"_ and _"the AI edits like a pro."_ Root cause: on the
TwelveLabs backend the orchestrator is **blind on unfamiliar/hours-long footage** —
`describe_footage` returns unsupported (`service.py:2682-2688`), the TwelveLabs
client has no generative understanding (`twelvelabs.py` is index+search+transcription
only), and no time-ordered footage map ever reaches context. Fix, end to end:
adopt **TwelveLabs Pegasus** (`analyze`/`summarize` → chapters/highlights/summary,
user-approved 2026-07-21) behind a new `FootageMap` contract;
make `describe_footage` work on TwelveLabs via the cached map; feed a compact,
**chapter-segmented** digest into `context-builder`; add a **deterministic grounded
proposer** that turns the map + transcript + silence + scene cuts into cited
zoom/reframe/b-roll/pacing candidates the model chooses from; and surface
understanding + proposed-edit previews in the UI. Built-in backend reaches parity
(map derived from local spans/captions); honest degradation on every new gate. No
`project.fp.json` schema change, no new package dependency. **Execution scope:
implementation-only — no tests, changelogs, ADRs, or docs written; the one retained
obligation is proper scoped logging (AGENTS.md §7, no `console.log`/`print`).**

**Media Intelligence Substrate plan authored (2026-07-14; see
`plan/ORCHESTRATION_ENHANCEMENT_PLAN.md`).** New `[ ]` sub-plan (phases B0–B7)
for a davinci-resolve-mcp-style substrate: sidecar-owned per-project
`brain.sqlite` (derived + rebuildable, provenance-tracked; `project.fp.json`
stays canonical), persisted/cached analysis with new loudness/black/freeze
analyzers and depth tiers, transcript/marker FTS + `search_media`, dep-gated
local embeddings + `find_similar`, host-LLM vision protocol
(`extract_frames`→`commit_vision`), durable chunked analysis jobs + caps +
`recoveryFor()` wiring, and markdown memory tiers + cross-project soul +
`session_context`. Audit also found Phase 4 prose stale (`analyze_silence`/
`detect_scenes` are now `available:true` in the registry) — reconciliation is
task B7.5. **Last updated:** 2026-07-18

**[x] Asset reads no longer ship render data to the model (2026-07-27).** `list_assets`
and `get_project_state` returned each stored `Asset` verbatim, including `Asset.media` —
proxy path, thumbnail paths, and `peaks` (one float per waveform bucket: hundreds per
minute of media, tens of thousands for a real bin). It is render data the model cannot
reason with, and it consumed the whole downstream budget — the evidence store's preview
(`EVIDENCE_PREVIEW_CHARS`) and `recall_evidence` answer (`EVIDENCE_RECALL_CHARS`) were
spent on waveform floats from the first asset, hiding the asset ids those reads exist to
deliver, and the same numbers filled the UI result popup. Fixed at the source with a
model-facing projection (`packages/ai-sdk/src/model-view.ts`, mirrored by `_model_asset`
in `engine/python/.../ai_tools/handlers.py`), so every consumer — log digest, evidence
preview, recall, popup — is bounded by one strip. No schema change: the stored project
keeps its media. Tests: TS tool-registry + Python `test_ai_tools` (peaks provably absent
from both results); ai-sdk 2017 green, engine 1419 green, typecheck/lint clean, ai-sdk
dist rebuilt. **Last updated:** 2026-07-27

**[x] A failing analysis no longer terminates a planned edit, and a rejected request no
longer floods the run (2026-07-27).** Reported from a real beat-synced run over silent
stock footage: the run ended at "The planned edit could not complete", and the step's
result was a wall of waveform floats. Four distinct defects, fixed at their own layers.
(1) `detect_beats` on media with no audio raised, so "this clip has no beats" was reported
as a fault; it is now an empty RESULT with a `reason` on `/detect-beats` and an
`UNAVAILABLE` entry on unified `/analyze` (the loudness precedent), settled by the executor
as `warning` — a status `runGraph` does not treat as terminal — with no `data`, so nothing
empty is folded into the Semantic Index. An id-less call also prefers an `audio` asset now.
(2) `recoverHostToolFailure` gated `route_around` on the failed task having NO dependants,
which is backwards for analysis: the analyses a plan builds on are exactly the ones
something depends on. Analysis-kind host tools now route around (dropping the failed task's
`data`, which held the error text); mutating/action host tools keep `fail_subgraph`.
(3) A compiled plan's `host_tool` args were dispatched UNVALIDATED (only the agent loop runs
the registry schema), so a `describe_footage` step with no `assetId` reached the sidecar,
which rejected it with a FastAPI validation error whose `input` field is the whole request
body — the inlined project, every asset's `peaks` included — landing in context, the
evidence store and the tool card. `missingRequiredArgs` now asserts the precondition before
dispatch. (4) Defence in depth on the same payload: engine error bodies are reduced to
`loc: msg` (never `input`) and capped at 400 chars; the project is stripped of `asset.media`
before it goes on the wire at all (the engine re-derives from `asset.path` and never reads
it); and the UI folds any long step output behind one measured line, capped at 200 rendered
lines. (5) The root cause of (3): `toolCapabilities` advertised only name/kind/mutates/
description to the Planner, so it authored every step's `args` without ever being shown the
tools' parameter names — `search_visual` with no `query`, `describe_footage` with no
`assetId`. Capabilities now carry `requiredArgs`/`optionalArgs` derived from each tool's
advertised JSON Schema, and `PLANNER_SYSTEM_PROMPT` states the obligation and where to get
the values. (6) A failed planned edit emitted one fixed sentence while the driver already
held the reason; `PlannedEditRunResult.failure` now carries the first failing task's
id/label/reason (a `model` task emits no `tool_result` to read it off) and the orchestrator
renders "The planned edit stopped at "<step>": <reason>". Tests: engine `/detect-beats` +
`/analyze` beats-unavailable + audio-preference;
ai-sdk sidecar settle/strip/error-bound, `missingRequiredArgs`, plan-driver route-around
(both the analysis and the strict non-analysis case), capability arg names, first-failure
reporting; web-editor fold. ai-sdk 2034 green, engine 1421 green, web-editor 1347 green,
workspace typecheck/lint clean, dist rebuilt.
**Last updated:** 2026-07-27

---

## Phase 0 — Project Scaffold & Foundation (current)

- [x] Repository skeleton (monorepo dirs per PRD §12)
- [x] Root tooling: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`
- [x] Python engine packaging: root `pyproject.toml`, `engine/python` package layout
- [x] Lint/format/typecheck config (prettier, eslint, ruff, mypy)
- [x] `.env.example` with multi-provider AI config (Anthropic, NVIDIA, mock)
- [x] Agent instruction files: `AGENTS.md`, `CLAUDE.md`, `.codex/AGENTS.md`, `.opencode/AGENTS.md`
- [x] Agent skills under `.agents/skills` (timeline-editing, render-debugging, e2e-testing, ai-safety, media-pipeline, security-hardening, correctness-verification, plan-keeper, docs-maintainer)
- [x] Harness adapters for `.cursor/rules`, `.claude/agents`, `.claude/commands`, `.codex/agents`, and `.opencode/agent.json`
- [x] `.claude/` settings and PRD §22 command set
- [x] Canonical `.agents/` layout for shared skills, rules, commands, and subagents, with harness folders referencing it
- [x] `lead-prompt-engineer` subagent (2026-07-12): owns all prompt surfaces — system contract + context builder (`packages/ai-sdk/src/context-builder.ts`), tool-registry language (TS + Python mirror + MCP parity), orchestrator mode instructions, and model-layer UI copy — enforcing model/UI/customer audience separation for a video-editor audience (canonical `.agents/agents/claude/` + codex TOML + opencode entry; `CLAUDE.md` §8 roster updated, incl. previously missing perf subagents)
- [x] `docs/` tree + documentation-maintenance rule
- [x] `plan/PLAN.md` + plan-maintenance rule
- [x] CI/CD quality gates (`.github/workflows/ci.yml`)
  ```
  — HARDENED (2026-08-13). Replaced the manual-only workflow and disabled/optional placeholders:
  PRs and main pushes now require TS/Python coverage, lint/typecheck, license review, functional
  E2E, macOS visual regression against committed baselines, a production desktop build, a real
  MoviePy/FFmpeg export whose validation report must pass, and all 33 Node→Python professional
  operation evidence cases. `pnpm verify` mirrors these release gates; `verify:core` retains the
  short edit loop. The “first CI run green” task below remains open until GitHub reports the run.
  ```
- [x] E2E harness (Playwright) scaffold
- [x] Governance: `README.md`, `LICENSE` (MIT), `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`
- [x] Git repository initialized (`main` branch)
- [x] `pnpm install` + `uv sync` verified green on a clean machine
  ```
  — verified green this session: `pnpm verify` runs all TS + 220 engine tests.
  ```
- [!] First CI run green. A manual run on commit `b851e0a` reached all seven real jobs, but GitHub
  refused every runner before checkout because account payments/spending limits need attention
  (run `31708941303`); no code or test step executed remotely. Local release-equivalent gates
  are recorded in the active control-plane plan. Restore Actions billing, then rerun CI on the
  branch before merge.
- [x] Fix repo-wide `typecheck` script: `tsc -b --noEmit` fails TS6310 ("referenced
  ```
  project may not disable emit"). RESOLVED — the 5 composite library packages
  (`shared-types`, `timeline-schema`, `editor-core`, `ai-sdk`, `ui`) now run
  `typecheck` as `tsc -b` (a build IS the type-check for project references) instead
  of `tsc -b --noEmit`; `--noEmit` was being forced onto referenced composite
  projects, which "may not disable emit" (TS6310). `pnpm verify` is now green from a
  cold cache.
  ```

---

## Phase 1 — Timeline Schema & Patch Engine (the foundation)

> Build this before any AI. Every edit becomes a typed, validated, reversible operation.

### 1.1 Timeline schema (`packages/timeline-schema`, `packages/shared-types`)

- [x] Define `Project`, `Timeline`, `Track`, `Clip`, `Effect`, `Keyframe` types (PRD §11)
- [x] Zod (TS) + Pydantic (PY) schemas kept in sync via shared JSON Schema
  ```
  — JSON Schema is now exported from the Zod source of truth via
  `buildProjectJsonSchema()` (uses `zod/v4`'s native `z.toJSONSchema`, no new
  dependency), committed at `packages/timeline-schema/schema/project.schema.json`
  (regenerate with `pnpm --filter @framepilot/timeline-schema schema:generate`). A TS
  drift test (`src/json-schema.test.ts`) asserts regenerated == committed; a Python
  parity test (`engine/python/tests/test_schema_parity.py`) asserts the Pydantic model
  field-name sets equal the JSON Schema property sets. This guard caught and fixed 3
  real drifts in the Python mirror: transcript field `text`→`word`, missing
  `Keyframe.id`, and untyped `assets`→a typed `Asset` model.
  ```
- [x] Schema versioning + migration framework (no breaking change without migration)
  ```
  — `migrations.ts`: `schemaVersion` envelope + ordered forward migrations.
  ```
- [x] `project.fp.json` file format reader/writer (atomic writes)
  ```
  — `serialization.ts` (pure) + `project-file.ts` (Node, temp-file+rename), `./file` subpath.
  ```
- [x] Golden schema fixtures + round-trip tests
  ```
  — `src/__fixtures__/demo.project.fp.json` + serialize/IO round-trip tests.
  ```

### 1.2 Typed timeline operations (`packages/editor-core`)

- [x] Operation type union: `trim_clip`, `split_clip`, `delete_range`, `move_clip`, `ripple_delete`, `add_clip`, `add_text_overlay`, `add_caption_layer`, `add_keyframes`, `apply_color_grade`, `adjust_audio`, `add_transition`, `add_mask`, `track_object`, `set_track_flags` (schema v4 track lock/hide/mute, ADR 0031) (+ internal `restore_clips` inverse primitive)
- [x] Each operation: pure `apply(timeline, op) -> timeline` (immutable)
- [x] Each operation: `invert(timeline, op) -> op[]` for undo (reversibility) — see ADR 0006
- [x] Ripple + overlap handling (subtract-range, gap-close); overlap is a validator check. (Snapping is a UI concern, deferred to Phase 3.2.)
- [x] 100% unit coverage on every operation + its inverse

### 1.3 Patch engine

- [x] `Patch` envelope (`patchId`, `createdBy`, `reason`, `operations[]`) per PRD §8.4
- [x] Patch lifecycle states defined (`PatchStatus`: proposed → validated → previewed → applied → reverted/failed)
- [x] Apply patch transactionally (all-or-nothing) — `applyPatch` + `PatchError`
- [x] Compute timeline **diff** (before/after) for review UI — `diffTimeline`
- [x] Undo/redo stack backed by inverse operations — `history.ts` (`commitPatch`/`undo`/`redo`)
- [x] Patch history persisted in project file — `toPersistedHistory`/`fromPersistedHistory`

### 1.4 Patch validator (PRD §8.5)

- [x] Validate: references exist, no negative duration, valid layer order, no missing asset, supported effect, no broken audio link, no overlap error, engine supports op, op is reversible
- [x] Typed validation errors with actionable messages
- [x] 100% coverage on validator

**Deliverable:** A patch can be proposed, validated, applied, diffed, and reverted — fully tested, no AI. ✅ **Met (TS engine).**

> **Follow-up slice (Phase 1, Python mirror): ✅ done.** `apply`/`invert` ported to
> `engine/python/.../timeline/operations.py` (mirrors TS `operations.ts`; 15 ops +
> `restore_clips`, apply→invert round-trip tested) and `validate_patch` to
> `validation/patch_validation.py` (mirrors `validator.ts`), plus `ProjectFile`
> atomic IO. 100% coverage. Engine + editor share one operation/validation semantics.

---

## Phase 2 — Deterministic Render & Media Pipeline (`engine/python`)

### 2.1 Media inspection & import

- [x] `inspect-media` (ffprobe wrapper): duration, fps, resolution, streams
  ```
  — `media/probe.py` (`inspect_media` + `MediaInfo`/`StreamInfo`), 100% cov.
  ```
- [x] Proxy generation (low-res preview media) — `media/derive.py` `generate_proxy`, 100% cov.
- [x] Waveform extraction — `media/waveform.py` (`extract_waveform` + pure `compute_peaks`), 100% cov.
- [x] Frame extraction / thumbnails — `media/derive.py` (`extract_frame`/`generate_thumbnails`), 100% cov.
- [x] Asset indexer + safe path resolution (sandbox to project dir)
  ```
  — `media/assets.py` (`index_assets`/`AssetIndex`, via `safety.resolve_within`), 100% cov.
  ```

### 2.2 Render engine (MoviePy + FFmpeg)

- [x] Timeline → MoviePy composition compiler (deterministic)
  ```
  — `render/compiler.py`: pure timeline math (`timeline_duration`,
  `expected_render`, `unsupported_track_types`) + `compile_timeline` (video+audio,
  letterbox-fit; **caption burn-in via `burn_captions`** from Phase 3.3).
  Overlay/effects deferred to Phases 5/6 (reported, not silently dropped). 100% cov.
  ```
- [x] Render job lifecycle: queued → preparing_assets → rendering_frames → encoding → validating_output → completed/failed
  ```
  — `render/pipeline.py` `render()` drives every state; always validates before COMPLETED.
  ```
- [x] Background job queue (resumable / retryable, with timeout + cancellation)
  ```
  — `render/queue.py` `RenderQueue`: thread-backed submit/get/list, cancel
  (queued + running), retry + auto-retry, and a multiprocessing executor that
  enforces timeout/cancellation by terminating the encode process. 100% cov.
  ```
- [x] `render_preview` (fast, low-res) and `export_video` (final)
- [x] Export presets (9:16 Reels, 1:1, 16:9 LinkedIn, custom) — `render/presets.py`.
- [x] Deterministic composition teardown (no leaked ffmpeg readers) — fixed 2026-08-13
  ```
  — `render/resources.py` `close_clip_tree`: MoviePy's `CompositeVideoClip.close()`
  releases only its own bg/audio, so every frame grab leaked ONE ffmpeg reader per
  source clip. In the long-lived sidecar they accumulated (measured in the field:
  128 stalled processes / 51 GB → system OOM). All four `compile_timeline` callers
  (`frame_grab`, `pipeline`, `temporal_evidence` ×2) now close the whole tree.
  Regression test counts real live child processes, not mock calls.
  ```

### 2.3 Render validation (PRD §9.4) — automatic check on every render

- [x] File exists, non-zero bytes
- [x] Duration matches expected timeline duration (tolerance)
- [x] Video stream present; audio stream present if expected
- [x] Black-frame detection (ffmpeg `blackdetect`; fails on ≈fully-black render)
- [x] Audio-clipping detection (ffmpeg `volumedetect` peak dBFS)
- [x] Golden media tests (frame-hash tolerance) — `validation/golden.py`
  ```
  (perceptual aHash + Hamming) with a committed fixture
  (`tests/fixtures/golden/reels_testsrc2.json`); `test_render_golden.py`
  renders a deterministic source and asserts frames within tolerance.
  Caption-timing golden added with Phase 3.3 burn-in
  (`test_burned_captions_appear_only_during_their_range`): asserts captions
  change the lower frame region only during their range.
  ```

> 2.3 done in `validation/render_validation.py` (`validate_render` + injectable
> probe/log-runner, pure log parsers), 100% coverage.

### 2.4 Python sidecar service

- [x] FastAPI local API (`FRAMEPILOT_PYTHON_API_URL`)
  ```
  — `service.py`: `/health`, `/render`, `/render/preview`, `/validate-render`,
  `/inspect-media` delegate to the engine; load errors → typed HTTP codes. 100% cov.
  ```
- [x] CLI: `framepilot render|validate-render|inspect-media` (+ `serve`) — `cli.py`, JSON output, 100% cov.
- [x] IPC contract with desktop shell (typed) — pydantic request/response models per route.

**Deliverable:** User can edit a clip and export a validated rendered video (via API/CLI). ✅ **Met.**

> **Phase-1 Python mirror (done as part of this work):** `ProjectFile.load`/`save`
> (atomic temp-file+fsync+rename, `schemaVersion` envelope), the full
> `apply`/`invert` operation set (`timeline/operations.py`, mirrors TS
> `editor-core`), and `validate_patch` (`validation/patch_validation.py`, mirrors
> TS `validator.ts`) — all at 100% coverage with apply→invert round-trip tests.
> The engine and editor now share one operation + validation semantics.
>
> **Phase 2 is feature-complete.** Caption rendering + its caption-timing golden
> landed with Phase 3.3 (`burn_captions`). Remaining work is later-phase: the
> compiler's overlay/effect/transition rendering (Phases 5 / 6).

---

## Phase 3 — Desktop Shell & Editor UI (`apps/desktop`, `apps/web-editor`, `packages/ui`)

### 3.1 Electron shell

- [x] Main/preload/renderer processes; secure IPC (contextIsolation, no nodeIntegration)
  ```
  — typed IPC contract (`apps/desktop/electron/ipc/contract.ts`), preload bridge
  exposing `window.framepilot`, hardened `BrowserWindow`
  (contextIsolation/no nodeIntegration/sandbox).
  ```
- [x] Python sidecar lifecycle management (spawn/health/shutdown)
  ```
  — `electron/sidecar/manager.ts` `SidecarManager`, a fully unit-tested state machine
  (stopped→starting→ready/failed) with injected spawn/probe/sleep.
  ```
- [x] Project open/save/recent; crash recovery from last valid state
  ```
  — `electron/projects/recent-files.ts` (`RecentFilesStore`) +
  `electron/projects/recovery.ts` (`RecoveryStore`); save validates via `parseProject`
  before writing (invariant 3) and snapshots the validated project for recovery.
  ```
- [x] Auto-update channel scaffold
  ```
  — `electron/updater/channel.ts` (channel resolution + provider seam; no updater
  dependency added yet).
  ```

> Desktop package now has vitest wired (30 tests, 100% coverage on the logic modules:
> contract/manager/recent-files/recovery/updater channel). `main.ts`/`preload.ts` are
> thin Electron glue excluded from coverage.

### 3.2 Editor core UI

- [x] Project create / import video
  ```
  — `editor/project.ts` (`newProject`, `newProjectFromVideo`, schema-validated via
  `parseProject`); New/Open/Save wired in `App.tsx`. Raw-footage import landed with
  the pro editor UI (2026-06-22): the left **Media bin** (`MediaBin` + `import.ts`)
  imports video/audio/image files — duration probed from an `HTMLMediaElement` over a
  session-scoped object URL — appends a schema-validated `Asset` (`addAsset`), and
  places it on a track via "Add" or drag-drop as an undoable `add_clip` patch
  (`addClipPatch`). Each bin item also has a **remove** control (`removeAsset` +
  `removeAssetClipsPatch`): it lift-deletes the asset's timeline clips as one undoable
  patch, then drops the bin entry, so deleting media never strands a clip on a missing
  source. A desktop import path (engine `inspect-media` + on-disk paths) is a Phase 8
  follow-up. See ADR 0013.
  ```
- [x] Creating a project persists it immediately (discovered, 2026-08-26)
  ```
  — Autosave only ran on a *change*, so a named-but-unedited project was never written
  and appeared in no recents list until the first import or timeline edit. `App.tsx`
  now saves the project as part of creating it (`persistCreated` → `saveProjectDefault`
  / localStorage), interactive creation takes a unique id (`uniqueProjectId`) so two
  projects sharing a name no longer share a file, and the desktop save path refreshes
  the recents entry so a rename shows up there. Covered by App tests, project.test.ts
  and an e2e that returns Home right after creating.
  ```
- [x] Professional NLE layout (discovered, 2026-06-22; **revamped 2026-07-01**)
  ```
  — `components/Editor.tsx` composes a Premiere/Resolve/Cursor-style workspace: a top
  menu bar + bottom status bar (`App.tsx`), a left library rail
  (Media/Effects/Overlays/Captions), a center stage (program monitor/toolbar/timeline),
  and a right AI/inspector rail (AI/Inspector/Transcript). `EffectsPanel` (color-grade +
  transition presets) and `OverlaysPanel` (text overlays) are new authoring panels; the
  AI mode selector is a segmented control. All edits route through the same
  validate→apply→record store. See ADR 0013.
  ```
  ```
  2026-07-01 layout revamp: moved from a 3-column grid (timeline nested in the center
  column) to a Premiere-style TOP region (assets rail · program monitor · inspector/AI
  rail) over a FULL-WIDTH timeline dock (`.editor-workspace` flex column + `.timeline-dock`).
  Dock height persists (localStorage). 605 web-editor tests green.
  ```
- [x] Preview player (HTML video + canvas overlays, proxy media)
  ```
  — `components/PreviewPlayer.tsx` driven by the pure `clipsActiveAt` selector; HTML
  `<video>` + overlay text (render-vs-preview rule honored). The element's transport is
  wired to a shared `playing` flag (`store.ts#setPlaying`); during playback the element
  is the **master clock** (the loop reads its `currentTime` and derives the playhead, so
  picture and playhead never fight), and `currentTime` is only written when paused
  (scrub, mapping clip `sourceStart` + offset) or on a source discontinuity — it plays
  smoothly instead of freezing on a frame or flickering from per-frame re-seeks.
  ```
- [x] Timeline UI: multi-track video/audio/caption/overlay
  ```
  — `components/TimelineView.tsx` (positioned clips via `secondsToPx`, ruler/scrubber,
  playhead, markers).
  ```
- [x] Trim / split / delete / move / ripple delete / snapping / zoom / markers
  ```
  — pure `editor/patch-builders.ts` (trim/split/delete/ripple/move/adjustAudio) +
  `editor/selectors.ts` (`snap`/`snapTargets`, zoom px↔s); toolbar + store actions
  (`seek`/`setZoom`/`toggleMarker`/`selectClip`).
  ```
- [x] Keyboard shortcuts (Premiere/Resolve conventions) (discovered, 2026-06-22)
  ```
  — `editor/useShortcuts.ts` installs one global keydown listener (skipped while a text
  field/contenteditable is focused): Space/J/K/L transport, Backspace/Delete lift-delete
  with Shift = ripple, S or ⌘K split at the playhead, ←/→ one-frame nudge (Shift = 1s),
  Home/End, M marker, =/- zoom, ⌘Z/⌘⇧Z/⌘Y undo-redo. Every editing shortcut builds a
  typed patch and routes through the same validate→apply→record store as the toolbar;
  toolbar/transport buttons advertise their accelerators via `title` hints.
  ```
- [x] Undo/redo wired to patch engine
  ```
  — pure editor store (`apps/web-editor/src/editor/store.ts`) routes every edit through
  validate→apply→record using `@framepilot/editor-core`
  (`validatePatch`/`commitPatch`/`undo`/`redo`); React `useEditor` hook + a live
  multi-track timeline view with working undo/redo in `App.tsx`. Store at 100% coverage.
  ```
- [x] Inspector panels: transform, effects, audio
  ```
  — `components/Inspector.tsx` (audio gain fully wired via `adjust_audio`;
  transform/effects read-outs).
  ```
- [x] Media-bin folders + AI asset management (discovered, 2026-06-26, ADR 0026)
  ```
  — schema v3 (`Project.folders` + `Asset.folderId`, additive v2→v3 migration + Pydantic
  parity); project-scoped patch engine in `editor-core` (`project-operations.ts` +
  `applyProjectPatch`/`invertProjectPatch`/`commitProjectPatch`/`diffProject`, validator
  folder-cycle/asset-in-use checks) at 100% coverage; `add_asset` + `manage_assets` tools
  (TS + Python mirror); orchestrator agent applies turns at project scope; MCP session
  commits project-scoped patches + sandboxes `add_asset` paths; `components/MediaBin.tsx`
  nested folder tree (create/rename/delete, drag-to-fold, empty state) + OS-like motion in
  `styles.css`, all undoable through the store. Patch-builders gain the bin builders.
  ```
- [x] Wire renderer project create/import to the desktop bridge
  ```
  (`window.framepilot.openProject`/`saveProject`) (discovered)
  — `editor/bridge.ts` (`getBridge`/`openProject`/`saveProject` with graceful
  non-Electron fallback; schema-validates opened projects).
  ```

### 3.3 Captions & transcript UI

- [x] **TwelveLabs audio-asset transcription repair (2026-08-02).** Replace the
      legacy video-only `/tasks` upload used for every media kind with TwelveLabs'
      asset-upload → indexed-asset workflow, so MP3/WAV/FLAC transcription is handled
      as audio while preserving paced polling, durable mappings, and explicit-provider
      failure semantics. Completed with 46 focused provider/index regressions; docs,
      changelog, ADR, and plan reconciled.

- [x] **Caption library clarity + shared transcription progress (2026-08-02).** Keep
      caption template previews readable at rest, share the Effects/Transitions filter
      language, page the responsive four-column library (12 initially, then 8), make
      keyword emphasis visibly affect preview and export, remove redundant panel helper
      labels, compact the app header, and surface import-triggered transcription as the
      same honest in-flight job in both transcript surfaces. Completed with 87 focused
      tests across the seven touched regression files; docs, changelog, and plan reconciled.

- [x] **Professional transcription + captioning overhaul (2026-08-01).** Make Local ASR
      robust to leading silence and long-media drift; expose TwelveLabs as a first-class ASR
      provider using the existing media-understanding key/index; normalize both providers to
      the same validated word contract and caption segmentation; rebuild the caption browser
      with All/search, representative previews, keyboard/touch/responsive behavior, and
      truthful progress/error/retry states. Provider, exact 0.930 s leading-silence timing,
      UI, and 1280/768/390 px e2e coverage are included; docs, ADR, changelogs, and this plan
      were updated after `pnpm verify` passed on 2026-08-01.

- [x] Transcript view synced to playhead
  ```
  — `components/TranscriptView.tsx` + `editor/captions.ts#activeWordIndex`
  (click-to-seek).
  ```
- [x] Caption track editor, word-level timestamps
  ```
  — `components/CaptionEditor.tsx` + `captions.ts#groupWordsIntoLines`/
  `generateCaptionsPatch` (maps transcript → `add_caption_layer` clips).
  ```
- [x] Caption styling + templates + keyword highlight
  ```
  — `captions.ts` (`CAPTION_TEMPLATES`, `getTemplate`, `parseKeywords`,
  `highlightKeywords`); note these are preview-time settings (no schema field
  persists them yet — deferred to a future schema migration, no schema change made).
  ```
- [x] Caption burn-in toggle

  ```
  — CaptionEditor burn-in toggle (preview-time) + render-wiring both done. The
  Python engine burns captions into the output when requested: a pure
  `render/captions.py` reconstructs caption text from the transcript by
  time-range overlap and rasterizes it with Pillow's bundled font (deterministic,
  no new dependency, no system font); `compile_timeline(..., burn_captions=…)`
  composites the overlays, and the flag is threaded through RenderOptions →
  render/preview/export, the sidecar `/render` + `/render/preview` routes, and the
  CLI `--burn-captions`. A caption-timing golden asserts captions appear only
  during their range. No schema change (caption style/template persistence stays
  deferred to a future migration). The renderer→engine export IPC channel that
  would pass the UI toggle is a separate Phase 8 surface (not added here). See
  ADR 0011. (engine modules at 100% coverage; 232 engine tests.)
  ```

- [x] Template-based caption system (clipvo-style, 45 templates) — replaces the
      3-preset styling end-to-end. Schema v10 (`templateId` + display/emphasis/
      entrance/accent vocabulary, first data-transforming migration presetId→
      templateId), canonical catalog in `timeline-schema/src/caption-templates.ts`
      exported to JSON for the Python engine, data-driven Pillow interpreter,
      DOM/CSS `CaptionOverlay` preview + animated gallery, AI tool/recipe updates.
      See `plan/caption-templates.md` for the phased sub-plan.

- [x] **Professional caption system (schema v11, ADR 0071)** — closes the three
      gaps the template work left: captions could be generated and deleted but
      not _edited_, segmentation was blind to what was being said, and three
      implementations of "which words does this cue contain" disagreed. - **Schema v11** (additive, no data transformed): `Clip.captionCue`
      (`text` + own `words`), `Track.captionStyle` (the set-wide look), and
      `CaptionStyle.accent.keywords` (the list `mode: 'keywords'` always needed).
      Absent ⇒ exactly the v10 behavior, so v10 projects render byte-identically. - **One segmenter** in `editor-core/src/captions/segment.ts`, shared by the
      panel and the AI recipe: scored break points (sentence → clause → pause,
      penalising stranded function words), reading-speed ceiling, minimum hold,
      gap bridging, explicit line layout, three presets. 100% coverage. - **One cue reader** (`captions/cue.ts`): overlap is the single derivation
      rule; `alignCueWords` maps display tokens to timings positionally so an
      edited word keeps its karaoke beat. - **Reversible ops**: `set_caption_cue`, `set_track_caption_style`. - **Panel rebuild**: inline-editable cues, split/merge/delete, track-wide
      restyle, pre-commit cue preview; removed a dead burn-in checkbox. - **Engine parity**: compiler reads cues + track style, renders author line
      breaks and keyword accents; existing goldens unchanged. - 9 caption e2e tests in chromium, incl. an edited cue rendering in the
      program monitor.

**Deliverable:** Full manual editor — import, edit, caption, preview, export.

### 3.4 Premium / minimal UI-UX pass (PROMPT.md) — [~] in progress

> UI/UX-only refinement of `apps/web-editor` toward a flagship NLE feel
> (Premiere/Resolve/CapCut precision, Linear/Things restraint). No engine, schema,
> or validation change — every gesture still flows through `useEditor` →
> validate→apply→record. Working on branch `feat/premium-editor-ui`.

- [x] **Dependency (flagged per CLAUDE.md §5):** added `lucide-react` (ISC, MIT-compatible,
      tree-shakeable monoline icons) to `apps/web-editor`. `pnpm license:scan` ✅ green; no
      denylisted licenses. Centralised in `src/components/icons.tsx`; emoji removed from rail
      tabs / transport / toolbar. **Motion stays CSS + rAF only — no animation dependency added.**
- [x] Part 1 — Foundation: refined design tokens (4px spacing scale, radii, elevation,
      motion tokens `--dur*/--ease*`, track-type hues, z-scale) + global
      `prefers-reduced-motion` guard in `styles.css`; `formatTimecode(seconds, fps) → HH:MM:SS:FF`
      added to `selectors.ts` (pure, unit-tested) and adopted in the program monitor; icon set
      swapped in.
- [x] Part 2 — Timeline interactions: pure geometry helpers added to `selectors.ts`
      (`rulerTicks` adaptive frames→seconds→minutes, `clampTrimStart/End`, `tracksCompatible`,
      `zoomToFit`/`zoomToClip` — unit-tested) and wired into a rewritten `TimelineView`:
      pointer **drag-move** (`moveClipPatch`, cross-track when compatible) + **edge-trim**
      (`trimClipPatch`, source-aware clamp) + **razor split** (`splitClipPatch`) with magnetic
      **snapping** (`snap`/`snapTargets`, Alt disables, snap-guide line), **draggable playhead /
      click-to-seek** on the ruler, adaptive frame-accurate ruler, and zoom-to-fit/selection
      (also a `framepilot:zoom` window event for keyboard). One validated patch per gesture;
      drag/ghost/guide state is ephemeral-local (invariant 5). Audio clips show a waveform
      skeleton pending engine peak plumbing (Part 5). 9 interaction tests; coverage up to 97.7%.
- [x] Part 3 — Keyboard: `editor/shortcuts.ts` typed **shortcut registry**
      (`{id,keys,when,group,label,run}`) is the single source of truth; `useShortcuts.ts`
      refactored from a switch into a thin chord-matching handler over it (Tab clip-nav is
      focus-scoped so global a11y Tab is preserved; pauses while help is open). Full map:
      transport (Space/J/K/L, ←/→ frame, Shift+←/→ second, Home/End), editing (S/⌘K split,
      Del/⌘ ripple, ⌘D duplicate, ⌘C/⌘X/⌘V copy/cut/paste as patches, [ ] trim-to-playhead,
      , . frame-nudge), selection/nav (Tab/⇧Tab, ↑/↓ track, Esc), markers (M, ⇧M/⌥M jump),
      view (=/- zoom, ⇧Z fit, ⇧F selection), history (⌘Z/⌘⇧Z/⌘Y). New real ops:
      `duplicateClipPatch`/`pasteClipPatch` (add_clip) and pure nav selectors
      (`orderedClips`/`adjacentClipId`/`clipOnAdjacentTrack`/`adjacentMarker`). A searchable,
      grouped **`?` help overlay** (`ShortcutHelp.tsx`) renders from the registry with
      platform-correct glyphs (⌘ on macOS). 40+ new tests; coverage 98%.
- [x] Part 4 — Monitor/panels/motion: program monitor gained frame-step buttons, a loop
      toggle, aspect-ratio **letterboxing**, and a toggleable **9:16 safe-area guide**;
      **resizable + collapsible rails** (`useRailLayout`, persisted to localStorage, view-only);
      **drag-to-scrub** number field (`ScrubNumber`, used for inspector gain); **clip context
      menu** (`ClipContextMenu` — split/duplicate/delete/ripple as patches); **toasts**
      (`Toasts`/`useToasts`) replacing the inline issue list — rejected edits raise an error
      toast, committed edits a success toast with inline **Undo**; audio waveform skeletons.
      All motion is CSS/transform + `prefers-reduced-motion`-gated. Coverage 98%.
- [x] Part 6 — App chrome (topbar / settings / footer): replace the bulky top menu bar
      with a **slim unified topbar** (brand, inline project name + draft state, a File menu
      for New/Open/Save instead of a raw path input, and Shortcuts + Settings buttons); add a
      real **Settings dialog** (Display & timecode, Editing defaults, Playback & monitor,
      embedded Keyboard shortcuts) persisted to `localStorage` and wired into live behavior
      (timecode-vs-seconds readouts, UI density, snapping default, default overlay duration,
      loop/safe-area defaults, reduced-motion override — view-only, invariant 5); polish the
      status-bar footer. No engine/schema/validation change.
- [x] Part 5 — Data/tests/docs: waveform/thumbnail data **flagged, not silently added** —
      the `Asset` schema carries no peaks/thumbnail handle, so surfacing engine data is a
      schema + bridge contract change (migration + tests + doc, invariant 4); deferred to
      Phase 8 below, skeletons rendered until then (no browser-side media compute). Added
      interaction/unit tests across all parts (web-editor 248 tests, coverage 98%); authored
      **ADR 0014**; updated `CHANGELOG.md`. (A timeline drag→trim→split→undo/redo→seek **e2e**
      in `tests/e2e` is the one remaining DoD item — added under Phase 8 to land with the
      desktop harness.)
- [x] Part 7 — **Notion-style dark design-system retoken** (`UI_REVAMP/`, 2026-06-26):
      presentation-only pass to a calm, layered Notion-grade palette. Retuned `:root` to the
      canonical spec tokens (warm `#191919` surfaces, single `#2383e2` accent, opacity-based
      text tiers, low-opacity-white borders, semantic + `--clip-*` + `--playhead` tokens) with
      **legacy names aliased** so one change cascaded through all 402 `var()` usages; swept
      **every hardcoded hex** out of `styles.css` into tokens. Clips → flat muted per-type fills
  - brighter borders (no gradients); selection → accent **outline + glow** (not a fill);
    playhead → conventional red; topbar logo de-gradiented; save chip → quiet dot + text
    (spinner on "Saving…"). Built the **`Button` variant system** in CSS (`[data-variant]`
    primary/secondary/ghost with full hover/active/focus-visible/disabled states — the
    primitive emitted `data-variant` but nothing styled it) at low specificity so scoped
    rules still win. Retired the redundant "Playhead" scrubber row to **`sr-only`** (kept as
    the deterministic-seek + a11y + test hook; the ruler scrubs, the transport shows the one
    authoritative `current / total`). **Eliminated every emoji-as-icon** (media bin asset
    kinds + folder/add/rename/delete/remove, AI self-check badges + summary, topbar brand) →
    `lucide-react` via `icons.tsx` (Part D mapping); designed program-monitor empty state.
    No engine/schema/logic/IPC/shortcut change; all hooks preserved. `UI_AUDIT.md` +
    `DESIGN_SYSTEM.md` authored. web-editor 346 + ui 2 tests green, typecheck + `vite build`
    green. **Deferred (need non-presentation work, documented in `UI_AUDIT.md`):** per-track
    mute/solo/lock/hide controls (Track schema has no such fields → schema v4 migration) and
    video clip filmstrip thumbnails (render-engine frame extraction). See ADR 0028.
- [x] Part 7b — **Component-by-component polish pass** (`UI_REVAMP/SIGN_OFF.md`, 2026-06-26):
      follow-up sweep against the exhaustive revamp checklist, presentation-only. Segmented
      controls (Settings + AI modes) de-blocked to a raised surface (pulled back accent overuse);
      `Button` primitive extended (danger/icon variants, sm/md, width-preserving `loading`);
      AI action full-width + skeleton loading + per-mode idle hints (new `.skeleton` primitive);
      Inspector sections made collapsible (`<details>`); Transcript shows timestamped seek lines;
      unified native `<select>`/checkbox/text-input baselines (+ Firefox scrollbars); swept stale
      hardcoded color fallbacks (tokens are now the sole source of truth); **clean clip names**
      on the timeline (`assetDisplayName` selector, +tooltip); **track headers de-boxed** to
      per-type Lucide glyphs + hairline. New unit/component tests; web-editor **350** + ui 4 green,
      typecheck + lint + `vite build` green. Residual deferrals (track controls, video filmstrips,
      transcript search, Razor/fit relocation, Electron titlebar) catalogued in `SIGN_OFF.md`.
- [x] Part 8 — **Near-black + blue-accent reference clone** (2026-07-18): presentation-only pass
      re-tokening `packages/ui/src/tokens.css` to a near-black surface ramp (`--bg-app`/`--bg-canvas`
      down to `#0a0a0b`/`#000`) and a blue accent (`#3b82f6`, both themes) in place of the Part 7
      Notion palette's warm surfaces/orange accent — playhead, selection, snap toggle, Export
      button, and active rail icon all follow. Structural additions to match a CapCut-style
      reference layout: topbar theme toggle + "Send feedback" link (logo now doubles as the File
      menu trigger); left rail's active tab renders as a filled accent chip; Assets panel header
      simplified to a title + labelled Import button; PreviewPlayer transport gained a real
      **Fit zoom dropdown** (scales `.preview-frame`, stage scrolls past 100%) and a **fullscreen**
      button (Fullscreen API on the stage element); Inspector's empty state gained an icon badge +
      "It's empty here" heading (was bare text); Toolbar gained a **Duplicate** clip button
      (`duplicateClipsPatch`, already existed via context-menu/⌘D, now also a toolbar icon); the
      timeline's **snap toggle and all zoom controls moved out of Toolbar into a new
      `.timeline-scenebar` row** in `TimelineView` (a "Main scene" label + snap/zoom-to-fit/zoom
      slider/zoom in-out, fixed above the ruler, not scrolling with it). No engine/schema/IPC
      change; every existing shortcut/menu/panel still works. web-editor 1144 + ui tests green,
      typecheck + lint green; e2e smoke green (pre-existing, unrelated AI-mode-picker test in
      `visual.spec.ts` — "Edit" tab — was already stale before this pass). `CHANGELOG.md` updated.

---

## Phase 4 — AI Layer (`packages/ai-sdk`, `engine/python/ai_tools`)

### 4.1 AI infrastructure

- [x] Multi-provider client (Anthropic, NVIDIA NIM, mock) with unified interface
  ```
  — `packages/ai-sdk/providers`: one `AiProvider` interface; Anthropic (Messages
  API) + NVIDIA NIM (OpenAI-compatible) call the HTTP APIs directly via an
  injected `fetch` (NO SDK dependency, unit-tested offline); deterministic `mock`
  is the default. Providers return tool calls, never patches. See ADR 0012.
  ```
  - [x] Added OpenAI-compatible providers over the same shared adapter: OpenRouter,
        GitHub Models/Copilot, Ollama, and **Groq** (`GROQ_API_KEY`, default
        `llama-3.3-70b-versatile`), plus Google (Gemini Developer API) over the native Gemini
        REST endpoint via raw `fetch` (no SDK, `GOOGLE_API_KEY`, default `gemini-2.5-flash`).
        Each is registered in `PROVIDER_NAMES`, the desktop/web config stores, and Settings → AI.
  - [x] Added **Vercel AI Gateway** (`vercel-gateway`, `AI_GATEWAY_API_KEY`, default
        `anthropic/claude-sonnet-4.6`) over the same OpenAI-compatible adapter as OpenRouter —
        one key fronting 100+ upstream models, registered in `PROVIDER_NAMES`, the engine
        roster, both config stores, and Settings → AI (2026-08-19).
- [x] Tool Registry — AI may ONLY edit via registered, schema-validated tools (PRD §8.3)
  ```
  — `tool-registry.ts` + Python `ai_tools/registry.py`+`handlers.py`+`dispatch.py`
  mirror: each tool has a Zod/Pydantic schema that BOTH validates (strict) and is
  the source the advertised JSON Schema is derived from (no drift). Mutating tools
  return typed reversible `Operation`s; analysis tools (`analyze_silence`,
  `detect_scenes`, `detect_faces`, `generate_mask`) are registered `available:false`
  (engine TBD, not faked — build order). 100% coverage both languages.
  ```
- [x] Context Builder (transcript, timeline, clip metadata, selection, platform)
  ```
  — `context-builder.ts`: deterministic `[system, context]` messages (timeline
  summary, transcript, selection, platform, memory summary). 100% cov.
  ```
- [x] Memory Store (project memory: style, pacing, accepted/rejected edits)
  ```
  — `memory-store.ts`: typed read/write over the EXISTING `Project.aiMemory` field
  (no schema change, no migration); records accepted/rejected edits + preferences,
  parsed defensively. 100% cov.
  ```
- [x] AI Orchestrator with modes: chat, plan, edit, agent, autocomplete, review
  ```
  — `orchestrator.ts`: chat/plan/edit/autocomplete implemented; it is the SOLE
  patch assembler (validates each tool call's args → runs handler → assembles Patch
  → validatePatch → diff). `agent`/`review` are explicit Phase 7 stubs.
  ```
- [x] Every AI tool returns a **patch**, never a raw mutation
  ```
  — enforced structurally: providers return only tool calls; the orchestrator
  builds the patch. Unknown/unavailable/invalid-arg tool calls are rejected.
  ```

### 4.2 AI modes

- [x] Chat (Q&A over transcript/timeline)
- [x] Plan mode (structured plan, no mutation, no render) — offers read-only tools only.
- [x] Edit mode (Cmd+K → small reviewable patch with Apply/Edit/Preview/Reject)
  ```
  — `Orchestrator.edit` returns `{ patch, validation, diff, text }`; the web AI
  panel renders Apply/Reject (Edit-the-prompt = re-run; Preview = the timeline diff,
  see 4.3 note).
  ```
- [x] Autocomplete (next-best-edit suggestions on triggers)
  ```
  — `Orchestrator.autocomplete` returns one small validated patch per tool call.
  (UI trigger wiring — playhead-stop/selection — is a later UX hook.)
  ```

### 4.3 Review UX

- [x] Timeline diff UI (what/why/before-after/undo)
  ```
  — `apps/web-editor` AI rail panel + `Proposal` card: WHY (rationale), WHAT
  (diff summary / op count), validity + problems; Apply commits via the store so
  toolbar Undo reverts it.
  ```
- [x] Apply / reject patch flow with preview render
  ```
  — Apply routes through the store's validate→apply→record path; Reject records a
  learning signal to `aiMemory`. "Preview" here is the before/after TIMELINE diff;
  a rendered media preview needs the renderer→engine export IPC channel, which is
  the deferred Phase 8 surface (see §8 "Renderer→engine export IPC channel").
  ```

**Deliverable:** User asks AI for an edit plan, reviews diff, applies, exports. ✅
**Met** (chat/plan/edit/autocomplete + Review UX). Agent mode + Critic are Phase 7.

> **Discovered (Phase 5+ unblocks these tools):** `analyze_silence`,
> `detect_scenes`, `detect_faces`, `generate_mask` are registered but
> `available:false` until their engine lands; flip the flag + add handlers when the
> corresponding compositing/analysis work is built. A media **preview render** in the
> web Review UX is gated on the Phase 8 renderer→engine export IPC channel.
> **Resolved (2026-07-15, B7.5):** `analyze_silence`/`detect_scenes` are live
> (`available:true`, Phase 8 §8.6); `detect_faces`/`generate_mask` stay gated.

### 4.4 MCP server — external agent access (`packages/mcp-server`) (discovered, 2026-06-24)

> Exposes the canonical tool registry to external AI agents (Claude Desktop, Claude
> Code, any MCP client) over the Model Context Protocol. Built on the Phase 4 tool
> registry + Phase 1 patch engine; honors all five invariants. Transport: **Streamable
> HTTP** on loopback `http://127.0.0.1:19789/mcp` (ADR 0019), originally stdio (ADR 0015).

- [x] New TS package `@framepilot/mcp-server` (`@modelcontextprotocol/sdk`, MIT;
      `pnpm license:scan` green). `bin: framepilot-mcp`.
- [x] **Streamable HTTP transport (2026-06-25, ADR 0019):** `src/http.ts` serves over
      loopback `127.0.0.1:19789/mcp` (overridable via `FRAMEPILOT_MCP_HOST/PORT/PATH`),
      wired to Node's built-in `http` (no new dependency), with DNS-rebinding protection
      (`allowedHosts`). Replaced stdio. Clients attach by URL (`{ "type": "http", "url": … }`).
- [x] **Auto-sync tool surface:** `buildMcpTools()` derives MCP tools from
      `TOOL_REGISTRY` (available only; unavailable tools omitted, not faked), reusing the
      registry's JSON Schema — guarded by a parity test so the surfaces can't drift.
- [x] **Session tools:** `open_project`/`save_project`/`undo`/`redo`/`get_patch_history`.
- [x] **`EditorSession`** enforces the invariants: tool → typed `Operation[]` →
      `assembleEdit` → `validatePatch` → `commitPatch` (reversible) → atomic
      `writeProjectFile`. A patch that fails validation is returned, not applied.
- [x] **Shared assembler:** extracted `assembleEdit` (+ `patchIdFor`) from the
      orchestrator into `@framepilot/ai-sdk` so the orchestrator and MCP host use one path.
- [x] **Path sandbox:** `resolveWithin` (TS mirror of `framepilot_engine.safety
.resolve_within`) sandboxes all paths to `FRAMEPILOT_PROJECTS_ROOT`.
- [x] **Render delegation:** `render_preview`/`export_video` POST to the Python sidecar
      (`FRAMEPILOT_PYTHON_API_URL`) — no MoviePy in the MCP process.
- [x] Tests: safety/session/tools/dispatch/render-client at **100% coverage** (35 tests).
- [x] New `mcp-engineer` subagent (canonical `.agents/agents/claude` + codex/opencode
      adapters); docs: guide + API doc + ADR 0015 + CHANGELOG + README index.
- [ ] Integration/e2e: drive the server through a real MCP client over HTTP (lands with
      the Playwright/desktop harness, alongside the other deferred e2e in Phase 8). A manual
      smoke test already covers initialize → tools/list and the Host-header rejection.

---

## Phase 5 — Professional Motion, Tracking & Masking (PRD §6.3–6.6)

> **Build order within the phase:** keyframe **evaluation engine** (pure math,
> done) → render wiring (compiler evaluates transform keyframes per frame) →
> keyframe editor UI + AI keyframe tools → tracking → masking. The schema already
> carries `Keyframe`/`Effect` and the `add_keyframes`/`add_mask`/`track_object`
> ops exist (Phase 1); Phase 5 makes them _mean_ something.

- [x] Keyframe engine: position, scale, rotation, opacity, crop, blur, audio volume
  ```
  — Evaluation core DONE (2026-06-25, ADR 0017): pure `evaluateKeyframes` mirrored
  TS/Python, 100% cov. RENDER WIRING DONE (2026-06-25, ADR 0018): a pure
  `effects/transform.py` resolves a clip's transform from keyframes; the compiler
  applies scale/x/y/rotation as MoviePy time-varying functions and static audio
  gain (`adjust_audio`) in the mixer. `opacity` is evaluated but its render lands
  with Phase 6 fades/transitions (reported by `unsupported_animated_properties`,
  not silently dropped). crop/blur as transform props are future work. 100% cov;
  punch-in/rotation/audio-gain integration tests.
  ```
- [x] Easing: linear, ease-in, ease-out, ease-in-out, hold, bezier
  ```
  — DONE (2026-06-25, ADR 0017): six curves with fixed 0→0/1→1 endpoints,
  clamping, and unknown-name → linear fallback. Segment a→b is eased by a's curve
  ("easing into the next keyframe"); `hold` holds then snaps at t==1. Per-keyframe
  bezier control handles are a future schema addition (Keyframe has no control
  points yet); `bezier` is the smoothstep cubic for now. Also fixed a contract bug:
  the Python `Easing` enum was underscored (`ease_in`) and could never match the
  hyphenated schema/AI-tool names — now canonical.
  ```
- [x] Keyframe editor UI + AI-generated keyframes
  ```
  — DONE (2026-06-25, ADR 0018). UI: the Inspector "Transform & motion" panel adds
  a one-click punch-in (from/to scale + easing) and a manual add-keyframe form
  (property/value/easing at the playhead), all routed through validate→apply→record
  (`punchInPatch`/`addKeyframePatch`). AI: a `punch_in` tool (TS + Python mirror,
  parity-tested, surfaced over MCP) emits `add_keyframes` via the shared generator;
  `add_keyframes` already existed.
  ```
- [x] Zoom / punch-in animation
  ```
  — DONE (2026-06-25): pure `punchInKeyframes` generator (editor-core) → renders
  via the transform wiring (ADR 0018) → exposed in the UI (Inspector) and as the
  AI `punch_in` tool. Full vertical slice.
  ```
- [~] Object tracking: face + bounding box, confidence score, manual correction, re-track
  ```
  — SEAM DONE (2026-06-25, ADR 0018): `track_object` generalized to arbitrary
  objects (`target:'object'` + a picked `region` + `engine` + per-frame bbox
  keyframes, stored on the effect; no schema change). A pure pluggable
  `effects/tracking.py` provides `ObjectTracker`, a deterministic `ManualTracker`
  (hold / interpolate corrections — the "manual correction" path), `get_tracker`
  (raises `TrackerUnavailableError` for any automatic engine), `tracked_box_at`,
  and `boxes_to_keyframes` (a track → animated mask/transform keyframes, so it
  composites through the existing render). REMAINING (dependency-gated, CLAUDE.md
  §5): automatic detection + confidence + re-track need a CV engine (OpenCV/SAM 2);
  the user deferred that dependency decision, so auto engines stay unavailable.
  ```
- [x] Masking: rectangle/ellipse/polygon, feather, opacity, mask keyframes
  ```
  — DONE (2026-06-25, ADR 0018): `add_mask` carries geometry (bounds/points/
  feather/opacity/invert) + effect keyframes in the free-form `Effect.params` (no
  schema migration). A pure `render/masks.py` rasterizes rect/ellipse/polygon with
  feather (Pillow Gaussian) + opacity + invert; the compiler attaches it as a
  clip mask, static or **time-varying** (mask keyframes animate via the keyframe
  engine). UI: an Inspector "Mask" panel (shape/feather/opacity). 100% cov +
  static & animated render tests.
  ```
- [~] AI subject mask + text-behind-object pipeline (deterministic layer order)
  ```
  — Composable foundation in place: a tracked object → `boxes_to_keyframes` →
  animated mask gives "isolate/hide a subject", and the deterministic track→mask/
  overlay layering is defined. REMAINING (dependency-gated): a real *subject* mask
  (semantic segmentation) needs a model (e.g. SAM 2) — pending the deferred CV
  dependency decision (CLAUDE.md §5). `generate_mask` AI tool stays available:false.
  ```
- [~] Tracked text / callouts / blur-tracked-object
  ```
  — Mechanism DONE: a track's bbox keyframes drive an animated mask (blur/hide the
  object) or transform keyframes (a callout that sticks to it) through the existing
  render — `boxes_to_keyframes` is the bridge. REMAINING: dedicated UI/AI affordances
  and (for real auto-tracking) the gated CV engine.
  ```

---

## Phase 6 — Color, Sound & Transitions (PRD §6.7–6.9)

> **Build order within the phase (deterministic render first, then UI, then AI):**
> color → sound → transitions, each as a reviewable checkpoint. New dependencies
> are **gated** like Phase 5's CV deps: everything achievable with the existing
> numpy/Pillow/ffmpeg toolchain is built; genuinely dep-gated items (beat
> detection → librosa, ML noise reduction, shot matching) stay `available:false`.

- [x] Color: exposure, contrast, saturation, temperature, tint, shadows, highlights, LUT import, before/after
  ```
  — DONE (2026-06-26, ADR 0020). Color renders deterministically: pure
  `render/color.py` parametric grade (the 7 axes, signed offsets, fixed order,
  numpy, 100% cov) applied per frame by the compiler via `image_transform`;
  `apply_color_grade` is now idempotent by effect id (replace-in-place, TS +
  Python mirror). UI: Inspector **Color** panel (7 controls + Apply/Reset, one
  reversible patch via `setColorGradePatch`) + an **approximate** live monitor
  preview (`colorGradeCssFilter`) with a **before/after compare** toggle (exact
  result is the render — render-vs-preview rule). A pure `.cube` LUT parser +
  trilinear applier ship and are tested. No schema change, no new dependency.
  engine 362 tests; web-editor 322; editor-core 93.
  DEFERRED (tracked below): LUT **file** import wiring (sandboxed-path decision,
  CLAUDE.md §5); color **keyframes** are advanced-color work.
  ```
- [ ] LUT **file** import: wire `render/color.parse_cube_lut`/`apply_lut` into the
      compiler for a `lut` effect that references a `.cube` on disk. Deferred from the
      color slice — it reads a file outside the asset sandbox, so it needs a sandboxed
      LUT-path decision first (CLAUDE.md §5). The pure parser/applier already exist and
      are tested. (discovered, Phase 6 color / ADR 0020)
- [ ] Advanced color: curves, color match, skin-tone protection, scopes, shot matching
      (deferred Phase 6 advanced — needs a richer color model/UI; not started)
- [x] Sound: volume, fades, music, ducking, voice normalization, noise reduction, mute/split
  ```
  — DONE (2026-06-26, ADR 0021). Pure `audio/mixing.py` (fade/normalize/duck/gain,
  100% cov) composed into one per-clip time-varying gain by the compiler. The
  `adjust_audio` op (TS + Python mirror) carries optional fade in/out, mute,
  normalize, duck-under-track (no new op, no schema change). Noise reduction +
  voice normalization (and a limiter/loudness master) run as a deterministic
  ffmpeg master-bus pass (`audio/filters.py`) wired through RenderOptions →
  sidecar/CLI/export. Music = an audio-track import (existing). Split = existing
  splitClip. UI: Inspector **Audio** panel. engine 397 tests; web-editor 330.
  ```
- [~] Advanced sound: EQ, compression, limiter, loudness presets, buses, auto-SFX
  ```
  — PARTIAL (updated 2026-07-11, H1.4 second half): **limiter** (`alimiter`) +
  **loudness presets** (`loudnorm` social/podcast/broadcast) shipped 2026-06-26
  (ADR 0021); **single-band EQ** (`equalizer`, named presets `flat`/`warm`/
  `bright`/`voice-clarity`, each a fixed 3-band recipe) and **single-band
  dynamics compression** (`acompressor`, named preset `voice`, commonly-cited
  broadcast/podcast voice-compression defaults) now also ship as master-bus
  ffmpeg options, in creator-language preset form (no raw dB/ratio/attack/
  release knobs exposed) — no new dependency or schema change was needed, so
  this closes without waiting on the 9.0 "richer audio master spec" gate.
  Engine: `RenderOptions.eq`/`RenderOptions.compression` → `audio/filters.py`
  `build_master_filter` (chain order de-noise → EQ → compression → loudness →
  limiter; see that module's docstring for the ordering rationale). UI: Export
  dialog gained an EQ preset select + a compression checkbox (small, low-risk
  addition to the existing denoise/loudness/limiter toggle block — same slot,
  same pattern, threaded through the existing `ExportRequest` → sidecar
  `/render` contract, no new IPC method). DEFERRED (still gated, per 9.0/9.2):
  **multiband** compression, audio **buses**, and **auto-SFX** — those need a
  richer master spec (schema) and/or a new dependency, unlike single-band
  EQ/compression which fit the existing preset+ffmpeg-filter pattern.
  ```
- [x] Transitions: cut, fade, cross-dissolve, push, zoom, blur, whoosh sync
  ```
  — DONE except whoosh-sync (2026-06-26, ADR 0021). Pure `render/transitions.py`
  eases the incoming clip in over its duration: fade/cross-dissolve (opacity),
  push/zoom (geometry), blur (decaying Gaussian). The compiler combines geometric
  mask × opacity × transition fade into one alpha mask + `bg_color` so partial
  alpha blends; **opacity now renders** (closes the Phase 5 deferral). cut = no-op.
  UI: EffectsPanel adds Blur. WHOOSH-SYNC (audio-synced) is deferred with advanced
  transitions below. engine: transition + opacity render tests; 100% cov on the
  pure module.
  ```
- [ ] Advanced transitions: beat detection, rhythm/motion-matched suggestions
      (deferred Phase 6 advanced — gated on a beat-detection dependency, e.g. `librosa`,
      CLAUDE.md §5; not started)
- [x] Transitions in the live preview + wipe/slide kinds — sub-plan
      **`plan/TRANSITIONS-PREVIEW-AND-KINDS.md`** — DONE (2026-07-17, ADR 0061).
      Both preview paths now apply the transition envelope: the WebCodecs
      canvas engine (globalAlpha / scale / offset / ctx.filter blur /
      destination-out wipe band in `drawSource`) and the DOM pool player
      (opacity / transform / filter / `mask-image` on the visible slot), both
      driven by the pure TS mirror `preview/transition-envelope.ts` whose
      constants are pinned against `render/transitions.py`. New `wipe`
      (soft left→right alpha reveal) and `slide` (enter from below) kinds
      across op unions, engine envelope + compiler mask, ai-sdk/MCP tool
      enums, picker, and the cut-and-transition-grammar skill. No schema
      change. 100% cov on `render/transitions.py`; both suites green.
- [x] Advanced transition system — sub-plan
      **`plan/ADVANCED-TRANSITION-SYSTEM.md`** — DONE (2026-08-01, ADR 0091,
      branch `feat/advanced-transition-system`). Turned the seven kinds into a 77-entry
      browsable library on a closed set of render kinds (GLSL pass + numpy twin
      each, the ADR 0088 pairing rule), plus the discovery/adjustment workflow:
      transitions panel with animated hover previews, drag-to-cut, edit-point
      popover, alignment, duration presets, audio pairing, favourites/recents/
      presets, recommendations, bulk apply. 29 render kinds, each a GLSL pass with
      a numpy twin and a parity test; alignment via a second `transition_out`
      effect on the outgoing clip; audio pairing (incl. equal-power fades);
      `discover_transitions` for the AI. No schema change (transition params stay
      free-form) and the seven legacy kinds keep their exact render path, so every
      existing project renders identically.

### Effect layers — schema v13, ADR 0088 (branch `feat/effects-system-v13`)

Effects become first-class timeline LAYERS that restyle everything composited beneath
them, rather than properties of one clip. 72 catalog entries across all 20 promised
families, on 41 closed-enum render kinds. Build order was engine-first on purpose: the
render-kind enum and the operation surface are what every later piece keys off, so
getting them wrong would have meant redoing the shaders and the AI tools.

- [x] Schema v13 — `effect` track type, `Track.effectLayers` (optional, not defaulted;
      see ADR 0088 for the 216-error blast radius that drove it), `EffectLayer`,
      v12→v13 migration, JSON-schema regen, Pydantic mirror, engine `SCHEMA_VERSION`
      bump. `effectLayersOf()` is the sanctioned accessor.
- [x] Effect catalog + param vocabulary — pure data in `timeline-schema`, generated to
      `schema/effect-catalog.json` and copied into the engine, drift-guarded both sides.
      Renderers dispatch on `kind`, never on a catalog id (the ADR 0069 contract).
- [x] `editor-core` operations — six primitives with lossless inverses, catalog-backed
      validation, 100% stmt/branch/func on `operations.ts` + `validator.ts`. Fixed a
      pre-existing bug where `remove_layer`'s inverse dropped `effectLayers`.
- [x] Python render — 41 numpy passes + the composited-stack stage in `compile_timeline`
      (the stage that did not previously exist). 402 tests parametrized over every kind.
- [x] Preview — WebGL2 post-process chain + 41 GLSL twins, 350 structural parity tests.
      Lazy, failure-tolerant, placed so the just-stabilized presentation path is untouched.
- [x] AI + MCP — seven tools in both registries (MCP auto-syncs), manual/AI parity proven
      by deep-equal timeline comparison. Costs ~868 prompt tokens.
- [x] ADR 0088, CHANGELOG, plan snapshot.
- [x] **Effects panel UI** — category rail (5 shelves + all 20 families with live counts),
      search across labels/tags/descriptions, favourites, recently used, popular/
      recommended, a thumbnail per effect that ANIMATES on hover by running that effect's
      real shader over a synthetic base, drag-to-timeline source, and empty states
      differentiated by cause. Colour grades and transitions moved OUT (they are per-clip
      operations; `transition-catalog.ts` extracts the constants two other components need).
      Favourites/recents are user state in `localStorage`, not project state.
- [x] **Timeline effect lane** — pinned to 26px vs 56px media (an effect layer has no
      filmstrip or waveform, and being visibly shorter is what makes the lane read as "not
      footage"); drop target for library drags; move/trim/duplicate/stack/bypass/delete.
      `EffectLayerChip` has its own gestures rather than reusing `TimelineClip`, whose
      machinery is all source in/out, ripple, roll and neighbour collisions — none of which
      apply, and overlap is a FEATURE here. One patch per gesture, committed on release.
- [x] **Inspector controls** — zero per-effect code: every control is generated from the
      catalog's param descriptors, so adding a kind never means writing a panel and a slider
      cannot offer a value the validator would reject. Sliders preview continuously, commit
      on release.
- [x] **e2e** — 12 Playwright tests covering discover → hover preview → apply → adjust →
      trim → move → duplicate → bypass → stack → save/reopen → delete, with undo at each
      step. Caught the bug that `visibleTracks` excluded effect lanes entirely, so an
      applied effect rendered nothing on the timeline.
- [ ] **Golden-media parity test with a real GL context** — the one thing the 350 structural
      parity tests cannot substitute for, since CI has no GPU. Would render the same frame
      through the numpy passes and the GLSL passes and compare within a tolerance.
- [ ] **Perf measurement** — profile the WebGL stage against desktop-scale media before the
      subsystem is considered settled (CLAUDE.md: desktop is priority #1).

---

## Phase 7 — Full Agent Mode & Critic (PRD §7.4, §8.6) — ✅ done (ADR 0022)

- [x] Multi-step autonomous edit (plan → approve → execute → verify)
  ```
  — DONE (2026-06-26, ADR 0022). `Orchestrator.agent()` runs a bounded tool-calling
  loop: each turn's mutating calls become a validated, reversible patch applied to a
  WORKING copy (read tools fed back, action/render calls logged not run). Stops when
  the model stops calling tools, on no-progress (invalid or repeated edit), or at a
  step cap (default 8). Returns a reviewable `AgentRun` (NOT auto-applied — the human
  approves; invariant 4). The orchestrator stays the sole patch assembler. 100% cov.
  ```
- [x] Plan Generator + tool-calling execution loop
  ```
  — DONE. The loop is the execution engine; `plan` mode (Phase 4) is the no-mutation
  planner. Per-turn context rebuilds from the working project + an agent instruction
  + the running action log so a real model sees evolving state. A bad tool call
  (unknown/unavailable/invalid-args/validator-reject) is recovered + fed back, not
  thrown, so one bad call never aborts the run.
  ```
- [x] Critic / Review Agent (request match, duration target, caption alignment, safe-area, audio clipping, black frames, missing assets, export settings)
  ```
  — DONE. Pure, deterministic `critic.ts#critique()` runs all 8 PRD §8.6 checks
  (pass/warn/fail/skipped); `ok` is false only on a fail. Pixel/sample checks
  (black frames, audio clipping) consume the existing `validate_render` result when a
  preview render ran, else report `skipped` (no faked capability). `review` mode wraps
  it (no model call). 100% cov.
  ```
- [x] Auto preview render + self-check + one-click revert
  ```
  — DONE (self-check + one-click revert). The agent's combined edit is ONE reversible
  patch, so Apply → a single Undo reverts the whole run. The self-check is the Critic
  report on the run's result. AUTO preview render *inside the web Review UX* is gated
  on the renderer→engine preview channel (Phase 8) — the Critic already consumes a
  render-validation result when supplied, so the wiring is the only missing piece.
  ```
- [x] Project memory learning from accepted/rejected edits
  ```
  — DONE. Agent runs read memory via the context builder (rejected edits are surfaced
  and avoided); Apply/Reject record the combined patch via recordAccepted/recordRejected.
  No new store (uses the existing `aiMemory` field).
  ```
- [x] Style presets
  ```
  — DONE. `style-presets.ts`: Clean SaaS demo / High-energy Reel / Talking-head
  explainer. `applyStylePreset` seeds the existing ProjectMemory preferences + export
  platform (no schema change) and pre-fills the agent goal. Surfaced as a selector in
  the web AI panel's Agent mode. 100% cov.
  ```

> **Web editor:** the AI panel's **Agent** mode is live — style-preset selector,
> **Run agent**, and an agent-run review (goal, self-check badges, collapsible step
> log, combined edit with **Apply all**/**Reject**) through the same
> validate→apply→record store. Agent runs **locally via the offline mock provider**;
> a real-provider IPC path is a Phase 8 follow-up (deliberately not added — avoids
> broadening the desktop IPC surface). **Test totals after Phase 7:** ai-sdk 95 tests
> (critic + style-presets + agent/review); web-editor 333.

> **Discovered (Phase 8 follow-ups, ADR 0022):**
>
> - Drive **agent mode over IPC with a real provider** (mirror the chat/plan/edit channels).
> - Wire an **auto preview render** into the web agent Review UX (gated on the
>   renderer→engine preview channel; the Critic already consumes its result).
> - **Semantic request-match** (LLM judge) — the deterministic heuristic ships now.

**North Star:** "Make this a professional 45-second product demo for Reels and LinkedIn"
→ plan → diff → captions → cuts → zooms → overlays → audio mix → preview → validate → approve export.

---

## Phase 8 — Production Hardening & Release — [~] nearly complete

> **2026-06-26 — driven end-to-end.** Phase 8 turned the feature-complete engine +
> editor + AI layer into a near-shippable v1. **Done:** the single-source IPC contract
> (ADR 0023); 100% core-module coverage (fixed a real branch gap); a **full E2E suite**
> (20 Playwright specs incl. timeline-interaction) + **visual regression** baselines;
> the license gate; a **security audit** with all CRITICAL/HIGH findings fixed +
> tested — Electron IPC path sandbox (1.1), Python sidecar route sandbox (1.2), TS
> sandbox unified into `@framepilot/shared-types/safety` (1.4), renderer **CSP** +
> sandboxed **`fp-media://`** scheme replacing `file://` (3.2) — see ADR 0025; the
> **schema v2** `Asset.media` + migration + parity (ADR 0024) with the engine
> `/asset-media` peaks producer and the timeline drawing **real waveforms**;
> **performance budgets** (+ complexity guard); **opt-in local-first telemetry**; and
> the **signing + auto-update scaffold** (electron-builder + electron-updater).
> **Remaining:** the desktop media-import IPC/UX that feeds the engine peaks onto
> assets (engine + consume sides done; needs a real-path channel — `[~]` above),
> thumbnails, the v1.0.0 checklist ticked at the actual release, and the audit's
> post-v1 hardening backlog (in the security runbook). Dependency-gated / advanced
> work is in **Phase 9** below, not dropped.

- [x] 100% coverage on core deterministic modules (timeline ops, patch validator, AI tool schemas, render validation)
  ```
  — DONE (2026-06-26). The 100% threshold is enforced in each core package's
  vitest config; a coverage run revealed + fixed a real gap (an uncovered
  `operations.ts` adjust_audio `fadeOutSeconds` branch — added a test). editor-core
  now 100% statements/branches/functions/lines; ai-sdk + mcp-server + engine
  render-validation already at 100%. A non-flaky apply-path complexity guard
  (`editor-core/performance.test.ts`) backs the interaction-latency budget.
  ```
- [x] Full E2E suite (PRD §16.1 flows) green in CI
  ```
  — DONE (2026-06-26). Enabled the Playwright `webServer` (Vite dev bound to the
  IPv4 loopback `--host 127.0.0.1`, `reuseExistingServer` off in CI) and replaced the
  placeholder smoke `test.fixme` with real specs under `tests/e2e/specs/` against the
  in-browser web build (offline **mock** AI provider; no Electron, no Python engine,
  no network). Browser-reachable §16.1 flows covered: load/new project, transport
  (Space/J/K/L, Home/End), transcript view + Generate captions, AI propose→review
  diff→apply→undo + reject + chat, and the preview engine + export desktop-only
  boundary. Each asserts the real outcome (clip count, pixel geometry as a faithful
  `secondsToPx` proxy for start/duration, the exact diff summary, caption-clip count,
  playhead readout) and that undo reverts it. `pnpm test:e2e` = **20 functional tests
  green**; CI `e2e` job already installs chromium + runs it. Real export/render + output
  validation stay **out of scope for browser e2e** (desktop-only: Electron + Python
  MoviePy engine; covered by the engine golden-media/validation tests) — documented in
  `specs/preview-export-validate.spec.ts`. Files: `tests/e2e/playwright.config.ts`,
  `tests/e2e/specs/{helpers.ts,smoke,project-and-transport,timeline-interaction,
  transcript-and-captions,ai-edit-review-apply-undo,preview-export-validate}.spec.ts`.
  ```
- [x] Visual regression tests (timeline, captions, masks, color, keyframes)
  ```
  — DONE (2026-06-26). `tests/e2e/specs/visual.spec.ts` screenshots the key
  browser-reachable surfaces — timeline, captions panel, color panel, transform/
  keyframe panel, mask panel, AI panel — via `toHaveScreenshot()`. Pinned 1280x800
  viewport + `reducedMotion: 'reduce'` (the app honours `prefers-reduced-motion`) +
  a per-pixel `maxDiffPixelRatio` tolerance keep frames stable. Panels are screenshot
  individually so the `<video>` program monitor (no real media in-browser) never
  flakes the suite. macOS baselines committed under
  `specs/visual.spec.ts-snapshots/*-chromium-darwin.png`; **7 visual tests green**. Re-enabling
  the gate on 2026-08-13 also migrated stale selectors to Inspector category tabs and the AI mode
  menu, refreshed reviewed goldens, and fixed overlapping virtualized caption-row actions exposed
  by the functional suite.
  Baselines are environment-sensitive (font AA differs macOS↔Linux) so they are tagged
  `@visual` and split out of the CI smoke gate: `pnpm test:e2e` excludes them. The blocking
  `e2e-visual` job now runs on macOS against the committed macOS goldens and never updates
  snapshots. Regenerate an intentional change locally with
  `pnpm --filter @framepilot/e2e test:visual:update`.
  ```
- [x] License scan gate; dependency review
  ```
  — DONE: `pnpm license:scan` runs in CI (license-scan job) and passes (no
  denylisted licenses across the dependency tree, incl. the approved
  `electron-updater`). Hardening backlog (recorded in the security runbook):
  SPDX-expression-aware logic + a `pnpm audit` supply-chain gate.
  ```
- [x] Security audit (path traversal, agent sandbox, IPC) per `docs/runbooks`
  ```
  — Phase 8 audit run (2026-06-26). RESOLVED: 1.1 Electron IPC sandbox
  (`ipc/sandbox.ts#sandboxProjectPath`), 1.2 sidecar route sandboxing
  (`service.py`), 1.3 symlink-tail rejection, 1.4 TS sandbox unification into
  `@framepilot/shared-types/safety` (MCP re-exports), 3.2 renderer CSP + `fp-media://`
  scheme. See ADR 0025 and the security-hardening runbook audit record. Native
  open/save dialog item DONE (2026-07-10): export's Save As
  (`framepilot:export:save-as`) shows a main-process `dialog.showSaveDialog` and
  copies the sandboxed render there instead of the renderer supplying a
  destination path directly (`apps/desktop/electron/render/export-save.ts`).
  Backlog still open: Windows/UNC tests, Zod-validate AiRequest/ExportRequest at
  the IPC boundary, redact provider error bodies, agent token/wall-clock budget,
  SPDX + `pnpm audit` gate, `renders/`/`exports/` gitignore, TS↔Python sandbox
  golden vectors.
  ```
- [x] Eliminate renderer↔desktop IPC bridge type duplication: `apps/web-editor/src/editor/bridge.ts` re-declared the `FramePilotBridge` contract from `apps/desktop/electron/ipc/contract.ts` with no compile-time cross-check (drift risk). (discovered, Phase 3 security review)
  ```
  — DONE (2026-06-26, ADR 0023). The IPC data shapes were hoisted into
  `@framepilot/shared-types` (`src/ipc.ts`) — a leaf package both apps depend on
  (the dependency direction is desktop→web-editor, so the shapes can't live in
  desktop). Desktop `ipc/contract.ts` keeps the channel-name registry and
  **re-exports** the shapes (its 5 importers + the CJS preload unchanged); the
  renderer `bridge.ts` consumes them and aliases `RendererBridge = FramePilotBridge`.
  Drift is now a **compile error**. Type-only relocation — no behavior/schema/runtime
  -dep change. shared-types 6 tests (compile-time guards); desktop 44 + web-editor 333
  green; both apps typecheck + lint clean (the pre-existing `preload.cts` `require()`
  lint error is unrelated).
  ```
- [x] Renderer media/CSP hardening: add a Content-Security-Policy and migrate the preview player from raw `file://` media URLs (`components/PreviewPlayer.tsx`) to a sandboxed custom protocol resolved in the Electron main process. (discovered, Phase 3 security review)
  ```
  — DONE (2026-06-26, ADR 0025, audit finding 3.2). A strict CSP is served on every
  renderer response (`onHeadersReceived` + `buildCsp`), and clip media now flows
  through a privileged `fp-media://` scheme (`security/media-protocol.ts`) whose handler
  resolves each request through `resolveWithin` before streaming — `file://` is no
  longer used. Pure helpers unit-tested; Electron glue in `main.ts`.
  ```
- [x] Renderer→engine export IPC channel: add a render/export IPC channel + bridge method so the desktop UI can drive a real export (and pass the CaptionEditor burn-in toggle as `burn_captions`). The engine already honors the flag via the sidecar `/render` route and CLI; only the renderer→main→sidecar wiring is missing. Broadens the IPC surface — design + security-review first. (discovered, Phase 3.3 caption burn-in)
  ```
  — DONE (2026-06-25, ADR 0016). New `framepilot:render:export` IPC channel +
  `exportVideo` bridge method; the main process delegates to the sidecar via a pure,
  unit-tested `render/export-client.ts` (decides success by `RenderJob.state`, not the
  HTTP code). A web-editor **Export dialog** (preset + caption burn-in) saves first
  (the engine renders from disk) then exports and can reveal the output; browser builds
  explain export is desktop-only. Render stays in Python (render-vs-preview rule).
  ```
- [~] Desktop media import path: the web Media bin (`apps/web-editor/src/editor/import.ts`) probes duration from an `HTMLMediaElement` over a session-scoped object URL (does not survive reload, not a real path). Add a desktop import that runs the engine probe and stores sandbox-resolved on-disk paths. (discovered, Phase 3.2 pro editor UI)
  ```
  — ENGINE SIDE DONE (2026-06-26): the sandboxed sidecar `POST /asset-media` route
  probes a real on-disk path and returns `{durationSeconds, kind, peaks, peaksPerSecond}`
  (the produce side of the waveform item above), tested. REMAINING: the desktop IPC
  channel + bridge method (`importAsset`, mirroring the export channel) and the
  web-editor UX that obtains a real on-disk path (Electron `webUtils.getPathForFile`
  on drop, or a main-process native open dialog) and calls it — the documented
  out-of-sandbox-open follow-up from ADR 0025. The consume side (timeline waveforms)
  already renders once peaks land on the asset.
  ```
- [x] Persist edited timeline on Save: the `useEditor` store's edited timeline is not synced back into the app-level `Project` that `App.tsx` saves via the bridge, so Save persists the unedited timeline. Lift the store timeline (or add an `onTimelineChange`) so Save writes the current edit state. (discovered, Phase 3.2 pro editor UI)
  ```
  — DONE (2026-06-25, ADR 0016). `Editor` lifts `editor.state.timeline` into the
  app-level `Project` via `onProjectChange` in an effect keyed only on the timeline
  ref (fires once per committed edit/undo/redo, no loop). Save + the AI context now
  see the edited timeline. Also added **debounced autosave** (2s; default projects
  folder for path-less projects, `localStorage` in the browser) + **folder surfacing**
  (`project:reveal`/`project:dir` IPC, clickable status path, File-menu reveal).
  ```
- [~] Surface engine waveform/thumbnail data to the timeline (premium UI pass follow-up):
  the `Asset` schema (`packages/timeline-schema`) carries no peaks/thumbnail/proxy handle,
  so the timeline renders a waveform **skeleton** today. Add a peaks/thumbnail handle to
  `Asset` (+ migration + Pydantic parity + tests) and plumb the engine's existing
  peak/thumbnail output through the bridge as **read-only data** the renderer consumes
  (never browser-side media compute). Schema/contract change — propose + approve first
  (invariant 4). (discovered, premium UI pass / ADR 0014)
  ```
  — MOSTLY DONE (2026-06-26, ADR 0024). (1) SCHEMA: `SCHEMA_VERSION` 1 → 2 (TS +
  Python); optional read-only `AssetMedia` (`proxyPath`/`peaks`/`peaksPerSecond`/
  `thumbnailPaths`) on `Asset`; v1 → v2 (additive) migration; JSON Schema regenerated
  + Pydantic mirror + parity test. (2) ENGINE PRODUCE: a sandboxed sidecar
  `POST /asset-media` route (`service.py`) probes duration/kind + derives waveform
  **peaks** via `extract_waveform` (tested; image/silent → no peaks, not an error).
  (3) RENDERER CONSUME: the timeline now draws a **real waveform** from
  `Asset.media.peaks` (pure `selectors.ts#clipPeaks`/`waveformPoints`, unit-tested),
  falling back to the skeleton when absent. REMAINING (with the desktop-import item
  below): the desktop import IPC/bridge call that stores the engine peaks onto the
  asset, and **thumbnail** generation (peaks shipped; thumbnails deferred).
  ```
- [x] Live project-file sync (real-time end-to-end): the desktop app read the open
      `project.fp.json` only once on open, and the preload bridge was request/response only,
      so an external editor — notably an **AI agent editing via the MCP server while the GUI
      is open** (ADR 0027) — never appeared live. (discovered, Phase 8 / MCP active-project)
  ```
  — DONE (2026-06-28, ADR 0030). A new tested, IO-injected `ProjectFileWatcher`
  (`apps/desktop/electron/projects/project-watcher.ts`) owns dedup + debounce:
  self-write suppression dedups on the **canonical serialization** (`serializeProject`,
  re-exported on `@framepilot/timeline-schema/file`) via `markSelfWrite(path, project)`
  called by both save handlers; 100% line/stmt/func cov, 10 tests. `main.ts` watches the
  open file's **directory** (filtered to the name — robust across atomic-rename saves),
  validates on change, and pushes over a new **push** IPC channel
  `framepilot:project:changed` carrying a `ProjectChangedEvent { path, project }`. The
  shared `FramePilotBridge` (shared-types) gained `onProjectChanged(listener)→unsubscribe`
  (implemented in `preload.cts`, wrapping `ipcRenderer.on` so the renderer never sees the
  privileged event). The renderer `onProjectChanged` helper (`editor/bridge.ts`) validates
  with `safeParseProject` (malformed external write dropped, invariant 3); `App.tsx`
  **auto-reloads** (on-disk file is the source of truth) by bumping a remount nonce folded
  into the `Editor` key + suppressing the autosave echo. No schema change; one new push IPC
  channel (approved per CLAUDE.md §5). shared-types 19, web-editor 376 (+bridge/App
  live-reload tests), desktop 98 (+10 watcher tests), timeline-schema 27 green.
  ```
- [x] Virtualize the media bin: `MediaBin` rendered its whole asset/folder tree with
      `.map()` (no windowing/row memoization) and `useAssetThumbnail` decoded every video at
      once, so large libraries were janky. (discovered, Phase 8 / premium UI follow-up)
  ```
  — DONE (2026-06-28, ADR 0030). `MediaBin` flattens the visible folder tree (honouring
  collapse state) into one ordered row list and windows it with **`@tanstack/react-virtual`**
  (new `apps/web-editor` runtime dependency, MIT; `pnpm license:scan` clean, approved per
  CLAUDE.md §5) — only rows in view mount; `AssetThumb` is `memo`-ised and
  `useAssetThumbnail` runs video-frame captures through a concurrency gate (max 4). A
  large-list virtualization test added; all `aria` hooks preserved. No schema/validation
  change. web-editor 376 green.
  ```
- [x] Timeline interaction **e2e** (`tests/e2e`): drag a clip → trim an edge → split →
      undo/redo → seek, asserting one validated patch per gesture. Pointer-driven, so it lands
      with the Playwright/desktop harness rather than jsdom. (discovered, premium UI pass)
  ```
  — DONE (2026-06-26). `tests/e2e/specs/timeline-interaction.spec.ts` drives the
  shipping pointer-gesture code path with real Playwright mouse moves (not jsdom
  fakes): select → split-at-playhead (S) → drag-trim a right edge → drag-move →
  delete → undo/redo → ruler click-to-seek → zoom. Each asserts the observable
  outcome (clip count, the clip's `left`/`width` px geometry, the playhead readout)
  and that undo reverts / redo re-applies it. Part of the §16.1 suite above.
  ```
- [x] Performance budgets (preview latency, render throughput)
  ```
  — DONE (2026-06-26). `docs/guides/performance-budgets.md` defines the interaction
  (< 16 ms edit/re-render, < 33 ms scrub) and render (≥ 1× realtime preview, ≥ 0.3×
  export) budgets, how each is measured, and enforcement. Backed by a non-flaky
  apply-path complexity guard (`editor-core/performance.test.ts`, 10k applies over a
  1k-clip timeline under a generous ceiling) and the engine's per-state render timing.
  ```
- [x] Crash/telemetry (opt-in, local-first)
  ```
  — DONE (2026-06-26). `apps/desktop/electron/telemetry/telemetry.ts`: a `LocalTelemetry`
  that is **opt-in** (off unless `FRAMEPILOT_TELEMETRY=1`) and **local-first** (appends
  JSON lines to `telemetry.log` under userData; NEVER makes a network request). Crash
  records carry only error name/message/stack (`describeCrash`). Wired in `main.ts` to
  `uncaughtException`/`unhandledRejection`/`render-process-gone`. Pure + injectable;
  6 unit tests.
  ```
- [x] Signed desktop builds (macOS/Windows/Linux), auto-update
  ```
  — SCAFFOLDED (2026-06-26). `electron-builder.yml` completed with mac (hardenedRuntime
  + notarize), win (nsis), linux (AppImage/deb) targets, signing via the standard
  `CSC_LINK`/`CSC_KEY_PASSWORD`/Apple-notarytool env, and a `generic` update-feed
  `publish` block. Auto-update wired via the approved `electron-updater` dep behind the
  existing `UpdateProvider` seam (`updater/auto-updater.ts`, injectable, 3 tests);
  `main.ts` checks the feed on startup in packaged builds only. Actually **signing
  requires external certs** (Apple Developer ID + Windows cert) supplied as CI secrets —
  listed in the v1.0.0 release checklist; the config is complete and ready for them.
  ```
- [x] Desktop packaging completeness — bundle renderer + Python engine into installers
  ```
  — DONE (2026-07-17, ADR 0062). The electron-builder scaffold shipped an app that
  could not run: no step produced `renderer/**`, the sidecar spawn hardcoded `uv run`
  against the repo's `engine/python`, and `entitlements.mac.plist` was missing.
  Now: (a) web-editor builds with Vite `base:'./'` and `scripts/copy-renderer.mjs`
  stages it into `renderer/`; (b) the engine freezes into a self-contained PyInstaller
  onedir (`engine/python/framepilot-engine.spec` + `packaging/pyinstaller_entry.py`,
  new build-only `package` extra; output under `apps/desktop/engine-build`, staged to
  `engine-dist/`, shipped via `extraResources` → `Resources/engine/`; imageio-ffmpeg's
  ffmpeg rides its PyInstaller hook, `copy_metadata` for imageio/moviepy — a bare
  freeze fails a real render on importlib.metadata); (c) pure, 100%-covered
  `sidecar/spawn.ts` `resolveSidecarCommand()` picks env-override → bundled → dev-uv;
  (d) entitlements + `pnpm desktop:dist` / `dist:unpacked` chains. VERIFIED on the
  packaged .app: bundled engine spawned from Resources, /health in ~5s, frozen-binary
  render of a real project passes validation; `pnpm verify` + desktop coverage green.
  Follow-ups: bundle a static `ffprobe` (imageio-ffmpeg ships ffmpeg only; clean
  machines need PATH/`FRAMEPILOT_FFPROBE`); afterSign hook to deep-sign
  `Resources/engine/` Mach-O files for notarization (electron-builder skips
  extraResources); per-OS/arch CI builders for the PyInstaller step.
  ```
- [x] Production packaging completion — bundled ffprobe, engine deep-sign, release CI
  ```
  — DONE (2026-07-17, ADR 0063). Closes ADR 0062's follow-ups; a clean machine needs
  NOTHING preinstalled. (a) `@ffprobe-installer` ffprobe staged into the engine bundle;
  `resolveSidecarCommand` returns env additions (`FRAMEPILOT_FFPROBE`, plus
  `FRAMEPILOT_WHISPER_CLI` when a whisper-cli is staged; injected fileExists keeps it
  pure; user env never overridden; 11 tests, 100% cov). (b) `scripts/sign-engine.mjs`
  deep-signs engine Mach-Os at STAGING time under CSC_NAME (batched codesign, hardened
  runtime; ad-hoc-verified: 280 files, serve+render still pass). (c) tag-triggered
  `release.yml` matrix (mac arm64/x64, win, linux) → draft GitHub Release.
  (d) VERIFIED locally end-to-end: signed .app (`codesign --verify --strict --deep`
  ok), dmg+zip+blockmaps+`stable-mac.yml` built, app launched FROM the mounted dmg
  (sidecar healthy ~9s, bundled ffprobe env delivered), clean-PATH render passes with
  validation. Hard-won fixes encoded: `mac.signIgnore: Resources/engine/` (codesign
  rejects PyInstaller's Python.framework as a bundle — broke any build with a keychain
  identity present), `verbatimSymlinks` staging (Node fs.cp rewrote PyInstaller's
  relative symlinks to absolute build paths), `PYTHON_PATH` for dmg-builder on
  python3-only Macs. Deferred to Phase 9: bundling whisper-cli (needs per-platform
  whisper.cpp builds in CI; spawn env already auto-adopts it when staged); real
  Developer ID notarization run (secrets not yet provisioned; checklist gates on it).
  ```
- [x] Onboarding docs + sample projects
  ```
  — DONE (2026-06-26). Added `docs/guides/onboarding.md` (zero→first-export for new
  contributors *and* end-users: prereqs incl. Python 3.13/`uv run`, install,
  monorepo tour, the patch/tool/render-vs-preview mental model, first-export
  walkthrough), two schema-valid samples under `examples/`
  (`hello-world.fp.json`, `product-demo-short.fp.json`) + `examples/README.md`,
  indexed in `docs/README.md`. Docs/CHANGELOG only — no code/schema change.
  ```
- [~] v1.0.0 release checklist (`.agents/skills/.../release-readiness`)
  ```
  — Checklist authored (2026-06-26): `docs/guides/release-checklist-v1.md` — a
  concrete, tickable v1 gate (CI gates, 100% core coverage, security sign-off,
  signed/notarized builds w/ Apple Developer ID + Windows cert as CI secrets,
  auto-update, CHANGELOG/version, sample open, docs), linked from
  `docs/runbooks/release.md`. Remains `[~]`: the gate itself is run/ticked at the
  actual v1.0.0 release once the remaining Phase 8 items above are green.
  ```

---

## Phase 9 — Advanced Capabilities & Deferred Items (post-v1 / dependency-gated)

> **Why this phase exists.** Phases 1–7 are feature-complete and Phase 8 hardens them
> into v1.0.0. Phase 9 collects everything that was deliberately **deferred** along the
> way — work that is genuinely gated on a new dependency the user must approve
> (CLAUDE.md §5), a schema migration, or a richer spec, plus the AI **real-provider**
> integration follow-ups. Nothing here is faked today: gated AI tools stay
> `available:false` and gated render features are reported, not silently dropped. Each
> item names its blocker so it can be unblocked deliberately, not by accident. Build
> order still holds: land the dependency/decision first, then engine → UI → AI.

### 9.0 Gating decisions the user must make first (CLAUDE.md §5)

> These unblock most of the rest of Phase 9. Each needs an explicit approve +
> `pnpm license:scan` before any code lands.

- [ ] **Computer-vision dependency** (e.g. OpenCV and/or SAM 2): unblocks automatic
      object/face detection, confidence/re-track, and AI subject segmentation. License +
      model-weight footprint + offline-determinism must be reviewed.
- [ ] **Audio-analysis dependency** (e.g. `librosa`): unblocks beat detection and
      rhythm/motion-matched transitions + whoosh-sync.
- [ ] **Sandboxed LUT-path policy**: lets a `.cube` file outside the asset sandbox be
      referenced safely — unblocks LUT **file** import (the parser/applier already exist).
- [ ] **Richer audio master spec** (schema or config): unblocks advanced sound
      (multiband compression, buses, auto-SFX) beyond the shipped limiter, loudness
      presets, single-band EQ, and single-band compression.

### 9.1 Advanced motion, tracking & masking (CV-gated) — from Phase 5

- [ ] Automatic object + face detection with confidence score and re-track (the
      deterministic `ManualTracker` seam + `boxes_to_keyframes` bridge already exist;
      `get_tracker` raises for automatic engines). Flip `detect_faces` → available + add
      its handler. **Blocked on 9.0 CV dependency.**
- [ ] AI subject mask via semantic segmentation (text-behind-object). Flip
      `generate_mask` → available + add its handler; composites through the existing
      animated-mask render. **Blocked on 9.0 CV dependency.**
- [ ] Dedicated tracked-text / callout / blur-tracked-object UI + AI affordances on top
      of the existing track→mask/transform mechanism. (UI is buildable now; real
      auto-tracking is **blocked on 9.0 CV dependency**.)

### 9.2 Advanced color, sound & transitions — from Phase 6

- [ ] LUT **file** import: wire `render/color.parse_cube_lut` / `apply_lut` into the
      compiler for a `lut` effect referencing a `.cube` on disk. **Blocked on 9.0 LUT-path
      policy** (parser/applier already shipped + tested).
- [ ] Advanced color: curves, color match, skin-tone protection, scopes, shot matching
      (needs a richer color model + UI; color **keyframes** belong here too).
- [ ] Advanced sound: multiband compression, buses, auto-SFX. **Blocked on 9.0
      audio master spec / dependency** (limiter, loudness presets, single-band EQ,
      and single-band compression already ship — H1.4 second half, 2026-07-11).
- [ ] Advanced transitions: beat detection, rhythm/motion-matched suggestions, and
      whoosh-sync (audio-synced). **Blocked on 9.0 audio-analysis dependency.**
- [x] Analysis tools `analyze_silence` + `detect_scenes` — achievable with the existing
      ffmpeg toolchain (`silencedetect` / scene score), so these can be **pulled forward**
      into Phase 8 if prioritized; flip `available:false` → true + add handlers.
      DONE (2026-07-04, no new dependency, no schema change): a new non-mutating **`analysis`**
      tool kind (engine-executed via ffmpeg, never fabricated in-process). `analyze_silence`
      runs `silencedetect=noise=<dB>:d=<min>` → paired `{start,end,duration}` ranges;
      `detect_scenes` runs `select='gt(scene,<threshold>)',showinfo` → sorted `{time}` cuts.
      Both follow the `render_validation` design (injectable log-runner + pure 100%-testable
      parser, subprocess bounded by `FRAMEPILOT_ASSET_MEDIA_TIMEOUT_SECONDS`). New sidecar
      routes `/analyze-silence` + `/detect-scenes`; MCP delegates via a new `AnalysisClient`
      (validate→save→sidecar); TS registry mirrors the Pydantic args (parity guard green);
      both flipped `available:true` and auto-surface over MCP. `detect_faces`/`generate_mask`
      stay `available:false` (CV-gated). engine 473 tests; ai-sdk 306; mcp-server 91; full
      `pnpm test`/`typecheck`/`lint` green; docs (ai-tools/mcp-server/python-engine-api) updated.

### 9.3 AI real-provider integration & deep wiring — from Phase 4 / 7 follow-ups

- [ ] Drive **agent mode over IPC with a real provider** (mirror the existing
      chat/plan/edit desktop IPC channels). Today the web AI panel's Agent mode runs via
      the offline mock provider. Broadens the IPC surface — design + security-review first.
- [ ] Wire an **auto preview render** into the web Review UX (Edit + Agent modes) so the
      Critic and the reviewer see real rendered frames. **Blocked on the renderer→engine
      preview channel** (the export channel from ADR 0016 is the pattern; the Critic already
      consumes a `validate_render` result when supplied).
- [ ] **Semantic request-match** for the Critic (LLM-judge) to complement the shipped
      deterministic heuristic.

### 9.4 Remaining editor UI/UX polish — from Phase 3.4

- [~] **Professional program-monitor selection (reported bug, 2026-08-02):** mirror timeline
  text-object selection into the WebCodecs preview, use standard white selection chrome,
  and resolve preview interaction as single-click background / double-click object with
  focused integration coverage.
- [x] Finish Phase 3.4 **Part 6** (app chrome): slim unified topbar, real Settings
      dialog (display/timecode, editing defaults, playback/monitor, embedded shortcuts)
      persisted to `localStorage` and wired to live behavior, polished status-bar footer.
      DONE (2026-07-04): the feature was already implemented (slim `Topbar` + File menu,
      multi-section `SettingsDialog`, localStorage `useSettings` store wired to live
      timecode/density/snapping/overlay-duration/loop/safe-area/reduced-motion behavior,
      toast footer); verification closed the one test gap — persisted-setting→observed-
      behavior direction now covered on the program monitor. web-editor 624 tests green,
      typecheck + lint clean. View-only (invariant 5); no engine/schema/validation change.
- [x] **Topbar header redesign (H12-followup, 2026-07-12):** click/F2-to-rename
      project title; the status DOT-only save indicator replaced with a labelled
      dot+word (`Saved`/`Unsaved`/`Saving…`/`Couldn't save`, detail on hover); the
      transient "Saved to …"/"Opened …" title-overlay retired — non-error IO events
      now log via the shared logger, save failures surface through the status
      indicator. Scoped down from a fuller brief (no project switcher, no split
      Export-button render-progress, no presence/share — single-user desktop app;
      a `⌘K` command palette already existed elsewhere in the editor). web-editor
      1086 tests green, typecheck + lint clean. View-only (invariant 5).
- [x] **Timeline tooltip INFO lines (2026-07-12):** every `TimelineView`/`Toolbar`
      tooltip now pairs its terminology with a plain-language "what this actually
      does" line (`Tooltip.tsx`'s new `TooltipInfo`), e.g. Ripple delete now
      explains it shifts later clips back to close the gap, Solo track clarifies
      it's preview-only. View-only; no engine/schema change.

### 9.5 Timeline UX + CapCut parity — Phase 1 (ADR 0031, 2026-06-28)

- [x] Fix image-clip **playback freeze** — preview mounts stills as `<img>`, clock
      advances on the wall clock through the image's duration.
- [x] **Drag-drop places a clip at the cursor** (lane-relative + snap; incompatible
      drop routes to the asset's natural lane).
- [x] **Cmd/Ctrl + scroll zoom** around the cursor (non-passive wheel listener).
- [x] **CapCut audio waveform** — filled mirrored polygon body.
- [x] **Functional track lock/hide/mute** — schema **v4** track flags + reversible
      `set_track_flags` op; honored in preview + render (`compiler.py`); `v3 → v4`
      additive migration.
- [x] **Playhead polish** — grabbable head + live time bubble + crisper line.

- [x] **Phase 2 — type-agnostic layers + render order (ADR 0032).** Generic layers (any
      clip kind on any layer); adding a different kind or overlapping same-kind clips
      auto-creates a new layer at **index 0** (visual front); render composites so **index 0
      is on top**. Tracked milestone-by-milestone (multi-agent handoff) in
      **`plan/PHASE2-type-agnostic-layers.md`**. **All milestones M1–M7 done:** layer ops
      (`add_layer`/`remove_layer`/`move_layer` + lossless inverses), derived `clipKind`, preview
  - compiler routing by kind with index-0-front order (stills via `ImageClip`), validator
    relaxation (TS + Python), auto-layering on drop/add, generic content-derived layer UI
    (icons/labels/colours + z-order chevrons), and a z-order-aware AI surface. `Track.type`
    retained as an _advisory_ role (no schema-shape change, SCHEMA*VERSION stays 4), clip kind
    is \_derived*. Unit suites green (editor-core 153, web-editor 393, ai-sdk 108, engine 428).

- [x] **Export schema-version desync fixed (root cause).** The Python engine's
      `SCHEMA_VERSION` was left at 3 while TS/Pydantic shipped v4, so the render engine
      rejected every freshly-saved project on export ("schemaVersion 4, but this engine
      supports up to 3"). Bumped the engine constant to 4 and added
      `test_schema_version_matches_ts` (reads the TS constant from source) so the two can
      never silently drift again — the field-name parity tests did not catch it.
- [x] **Timeline playback smoothness** — track lanes memoised so a per-frame `seek` no
      longer rebuilds the whole clip tree (gesture handlers stabilised, playhead read via
      ref). Web-editor suite green (395).
- [x] **Preview cut stalls + prepare-on-play (2026-07-05)** — the 2-slot double buffer
      became a pooled player: `PREVIEW_POOL_SIZE` persistent `<video>` slots, each pre-loading
      AND pre-seeking one upcoming clip (`nextPool` pure reducer + `upcomingVideoClips`
      lookahead). Same-asset trims — which the front/back design deliberately skipped and
      therefore stalled ~100-200 ms on an in-file seek at every cut — now warm in their own
      slot, and a warm-slot alignment effect re-seeks a slot whose clip changed without a src
      change. Readiness is **tracked per slot** (`readySlots`: which clip each element has a
      decoded, seeked frame for, from `loadeddata`/`seeked`), and everything visual gates on
      it: the **visible slot lags the front slot** until the new front has a paintable frame
      (holding the departed clip's last frame for the bridge — a held frame reads as seamless,
      a not-yet-painted element reads as a black flicker), and `nextPool` protects the
      visible slot from warm-recycling mid-bridge (active-clip loads override, so a bridge can
      never deadlock). Pressing play runs through a **prepare gate**: the transport holds
      (with a "Preparing preview…" status) until the WHOLE pipeline — front + every warmed
      slot — reports decoded frames, capped at 2.5 s so play can never hang. Media-pipeline paths stay
      e2e/manual-verified (`v8 ignore` in jsdom); pool/lookahead reducers unit-tested.
      **Remaining (Phase 8):** wire engine proxy media (`Asset.proxyPath` bridge contract
      change) into `mediaSrc` so preview decodes low-res proxies instead of full-res source.
- [x] **Long AI runs no longer die with "The operation was aborted" (2026-07-05).**
      Four root causes fixed: (1) the SDK idle watchdog's self-abort leaked a raw
      `AbortError` from the SSE reader — `ResilientProvider.openStream` now converts it to
      the typed retryable `timeoutError('idle', ms)` (same error as the `withConnectTimeout`
      race, so both outcomes match); (2) `DEFAULT_TIMEOUTS` raised to 60s connect / 180s
      idle for extended-thinking turns; (3) the desktop hub cap raised 10 → 30 min
      (`AI_STREAM_TIMEOUT_MS`) and a cap-fired run now pushes an explanatory
      `timeoutMessage()` error (rendered by the sidebar via a new run-level-failure catch)
      instead of a silent "cancelled"; (4) `AiProvider.complete()` takes an optional
      `AbortSignal`, threaded through fetch + retry and into `generateAgentPlan` /
      `attemptRepair`, so Stop cancels the agent's plan/repair calls (an abort there settles
      the run as `cancelled`, not `failed`). ai-sdk 354 tests / 100% coverage; desktop
      ai-stream 29; web-editor AiSidebar 10.

- [~] **Phase 3 — full CapCut/Premiere/DaVinci timeline revamp** — UI/UX-led parity pass:
  clip anatomy v2 (filmstrip + waveform + header), multi-select/marquee, interactive
  on-cut transitions, fade/automation handles, edit modes (insert/ripple/slip/slide),
  effect browser drag-onto-clip, and honest **"coming soon — requires X"** surfaces for
  every dependency/schema-gated feature. Full spec + feature matrix + milestones (M1–M7)
  in **`plan/TIMELINE-REVAMP.md`**. **M1 (clip anatomy v2) DONE (2026-06-30)** —
  filmstrip picture layer + waveform band on video + header strip + adaptive density,
  **plus real thumbnail previews** wired end-to-end (engine `/asset-media` produces
  thumbnails → sandboxed desktop `importAsset` IPC → renderer via `fp-media://`),
  security-reviewed SAFE TO SHIP. shared-types 19 / desktop 104 / web-editor 426 / engine
  435 green. **M2 (navigation & selection) DONE (2026-06-30)** — multi-select/marquee,
  batch move/delete, insert/overwrite + ripple modes, track resize/collapse/solo,
  minimap, playhead-follow auto-scroll, vertical virtualization (all view/session state,
  no schema). **M3 (transitions UX) DONE (2026-06-30)** — `transition_overlap` validator + idempotent `add_transition` (TS+Python parity), interactive on-cut pill
  (drag-resize, double-click/drop-to-add, clamped to validator), Inspector transition
  section, draggable browser tiles, coming-soon beat-synced control; web-editor 525 green.
  **M4 (fades, automation, keyframe direct-manip) next.** M4–M7 + the schema/dependency
  decisions in that doc's §9 remain.
- [~] **Phase 3.5 — preview / inspector / keyframe / transition revamp** — the four
  surfaces the timeline revamp deliberately left alone: the program monitor (density,
  toolbar, transport, scrub bar, canvas direct manipulation), a context-aware inspector
  rebuilt around a section registry with property-level keyframe affordances, keyframes
  as first-class timeline objects (diamonds, per-property lanes, drag/select/ease, an
  optional graph editor), and the transition authoring workflow end to end. Full spec,
  diagnosis, schema decisions, and phases 1–14 in
  **`plan/PREVIEW-INSPECTOR-KEYFRAME-TRANSITION-REVAMP.md`** (created 2026-07-31).
  Carries **two schema bumps**: v14 speed curves / reverse / freeze (ADR 0089, extends
  ADR 0046's named extension path) and v15 keyframe bezier handles (ADR 0090); rich
  transition params ride the existing free-form `Effect.params` with no migration.
  **Phase 1 (preview workspace density) DONE (2026-07-31)** — a `--monitor-row-h: 28px`
  / `--monitor-btn-size: 24px` density contract at `:root` shared by all three monitors
  (program, source, WebCodecs); one full-bleed chrome band above the picture and one
  below, stage inset moved off `.preview` onto the `container-type: size` stage so it
  comes out of the frame's own budget. ~121px of fixed chrome → 64px; web-editor 1779
  green, tsc/eslint clean. **Phase 2 (transport + scrub bar) DONE (2026-07-31)** —
  new `PreviewScrubBar` (pointer-accurate, Shift fine-scrub that re-anchors
  mid-gesture, cut ticks, Alt-invert snapping, full keyboard) + `PreviewTransport`
  (prev/next edit point, loop moved out of the view controls, real monitor
  volume/mute via a new master `GainNode` in `AudioMasterClock`), over two new
  100%-covered pure modules `preview/scrub.ts` and `editor/edit-points.ts`;
  web-editor 1851 green. **Three findings recorded in the sub-plan:** (1) the
  sub-plan's §1 file inventory was stale — the program monitor is
  `WebCodecsPreviewPlayer`, not `PreviewPlayer`, whose transport renders nowhere;
  (2) prev/next edit point could NOT use `listEditBoundaries` (abutting-only, so it
  skips both edges of every gap); (3) jsdom has no `PointerEvent`, so pointer-gesture
  tests were passing with every event property `undefined` — now polyfilled in
  `test-setup.ts`, which Phase 3 depends on. Monitor playback **speed** is
  deliberately deferred to 10c, behind ADR 0089's audio-pitch decision.
  **Phase 3 IN PROGRESS** — **3-1 (preview/render transform parity) DONE
  (2026-07-31)**: the export has rendered `rotation`/`opacity` keyframes since Phase
  5 but the canvas compositor only read `scale`/`x`/`y`, so a rotated clip exported
  rotated and previewed flat (the render-vs-preview rule inverted, in the worse
  direction). New 100%-covered `preview/picture-transform.ts` owns the parity
  arithmetic — notably the **negated rotation sign** (MoviePy `rotated()` is
  anticlockwise-positive, canvas `rotate()` clockwise-positive) — and the compositor
  routes through it; web-editor 1863 green. Sign + order come from code reading, not
  pixel verification: a Playwright rotation-parity pixel spec is recorded as a
  follow-up. **3-2 (the manipulation itself) DONE (2026-07-31)** — select-hit +
  transform box ported onto the real monitor (it had NONE: the affordance left the
  product when WebCodecs became the sole engine), plus a rotation handle with a live
  degree readout, per-axis snapping to centre/thirds/edges with alignment guides
  (new 100%-covered `preview/snapping.ts`), Shift-constrain, Alt-invert snapping, and
  reset. Live drag previews via `withBaseTransform` on the existing
  `applyCompositing` path, so a drag never reloads a decoder. New
  `WebCodecsPreviewPlayer.transform.test.tsx` — nothing unit-tested this monitor
  before, so the affordance could vanish again unnoticed; web-editor 1918 green.
  Two named features re-scoped: **anchor point** needs Python render support
  (`evaluate_clip_transform` has no anchor) and is **split out as 3-3 with its own
  ADR**; **aspect lock** has nothing to lock (the engine's scale is uniform by
  design), replaced by Reset. **Phase 4 (inspector architecture) DONE (2026-07-31)** —
  the 1,049-line inspector is now a 385-line shell over 13 modules: a data-driven
  section registry (`{id,title,label,order,defaultOpen,appliesTo}` + sorted
  `visibleSections`), a pure selection model, per-section collapse persisted in
  `EditorSettings.inspectorSections` (fixing the `<details open>` bug where a
  collapse was undone by the next selection change), mixed-value reads for
  multi-select, and one `clipProperties` model behind copy/paste/apply-to-selected/
  reset-all — each producing exactly ONE patch. **Bug fixed:** the property builders
  never compare against the clip's current value, so "reset all" on a default clip
  produced a no-op patch that still consumed an undo step. Save-as-preset deferred to
  Phase 11 (where presets live). web-editor 1960 green.
  **Phase 5a (`remove_keyframes`) DONE (2026-07-31)** — Phase 5 was **blocked**: the
  engine had no operation that could delete a keyframe (`add_keyframes.replace` only
  swaps same-property-same-time), which blocked Phases 5, 6, 7 and 12. Maintainer
  sign-off for widening the operation vocabulary was given, and `RemoveKeyframesOp` +
  its Python mirror landed with apply, exact invert (via the established
  `restore_clips` pre-state pattern) and both validators' registration. **No schema
  change**, so no migration and no version bump. Keyframes are matched by
  **property + time, not `id`** — ids come from whichever producer built them and are
  not a stable UI handle — sharing `add_keyframes`' ±1ms epsilon so a set-then-clear on
  one diamond cannot leave a stray keyframe a millisecond away. Deliberately **not**
  exposed as an AI tool (that widens the agent's permission surface, a separate
  decision). editor-core 520 green, engine 114 green.
  **Phase 5 (property-level keyframes in the inspector) DONE (2026-07-31)** — and a
  third diagnosis correction: F5 assumed a scale field existed to put a diamond next
  to. **There was none** — the whole inspector had nowhere to see or set scale,
  position, rotation or opacity, so the fields had to be built first. The rule the
  phase turns on, decided in one place (`keyframe-state.ts::willCreateKeyframe`): a
  **non-animated** property has a base value and editing it moves time 0 (the playhead
  is irrelevant, or scrubbing then nudging would silently animate the clip); an
  **animated** property has a curve and editing it writes a keyframe at the playhead —
  and the row says `+kf` _before_ the commit. `ANIMATABLE_PROPERTIES` is asserted equal
  to `evaluate_clip_transform`'s set, because a diamond on a property the render
  ignores animates the preview and not the export. web-editor 2017 green.
  **Phase 6 (timeline keyframe lanes) DONE (2026-07-31)** — keyframes are objects, not
  decoration: per-property lanes with real markers, drag/select/multi-select/delete, all
  arithmetic in a pure `timeline/keyframe-lanes.ts` (28 cases). Selection and expansion
  are **view** state (expanding a clip is not an edit), held as **keys not references**
  because the timeline is rebuilt on every patch. The lane height had to be added in
  **both** the virtualizer's `rowSize` and the rendered height or every track below an
  expanded one draws in the wrong place. **Two real bugs found by tests:** a group drag
  moved only one keyframe (pointer-down collapsed the selection; the collapse is now
  deferred to pointer-up and only if the gesture was a click), and snapping could
  destroy a keyframe by pulling it onto a sibling in another lane at the same time.
  web-editor 2066 green.
  **Phase 7 (easing + graph editor) DONE (2026-07-31) — schema v14, ADR 0089.**
  `bezier` was never a bezier — a hardcoded smoothstep with no control points. It has
  them now, two-sided (`a.handles.out` + `b.handles.in`, the CSS convention), which is
  why `evaluateKeyframes` could no longer route through `interpolate` (it only ever saw
  the earlier keyframe's easing). **Absent handles still mean smoothstep**, so v13→v14
  is a no-op in fact and not just in the data. The solver is **fixed-iteration in both
  languages on purpose** (8 Newton-Raphson, 20 bisection fallback): a
  convergence-tested loop runs a different number of times in the two languages the
  moment their rounding differs by one ulp, and then preview and export disagree about
  motion feel. Numeric parity is a committed 88-case fixture asserted to 1e-12 in both
  suites — schema-shape parity cannot catch this. **Numbering correction:** handles took
  v14/ADR 0089 and speed ramps move to v15/ADR 0090, because both are assigned by
  landing order. Whole monorepo green.
  **Phase 8 (transitions on the timeline) DONE (2026-07-31)** — `TransitionPill` retired
  for `timeline/TransitionBlock.tsx` over a pure `timeline/transition-blocks.ts`. The
  block **says what it is** (kind + duration, in the accessible name at every density),
  reports its length **while** you drag rather than after, and survives zoom: layout
  resolves the **whole track at once**, because a minimum hit target makes adjacent
  blocks overlap even when the transitions do not overlap in time, and colliding blocks
  meet at the midpoint between their cuts so a click always lands on exactly one.
  Ineligible cuts now **surface `transitionEligibility`'s reason** instead of silently
  omitting the affordance. New `addTransitionToAllCutsPatch` applies a kind to every
  eligible cut as **one** undo step, skipping cuts that already have a transition.
  Alignment and reverse are deferred to **Phase 9**, where their render support lands —
  §4.3's rule is that preview and render move together. web-editor 2101 green.
  **Phase 9 (transition params + inspector + preview) DONE (2026-07-31)** —
  `direction`/`intensity`/`softness`/`easing` in **both** engines, riding the
  free-form `Effect.params` with **no schema change and no migration**. The rule the
  phase turns on: **every default reproduces the pre-Phase-9 render exactly**, pinned
  against the old constants in both suites. **Deviation from §4.3:** `easing` defaults
  to `linear`, not `ease-in-out` — adopting a curve would silently re-time every
  transition in every existing project. **Bug found, and it was the crux:**
  `applyAddTransition` rebuilds the params bag from scratch, so a kind swap or a
  duration resize would have discarded the new params the moment they shipped — fixed
  without widening the op vocabulary (swap became `set_effect_params`; resize carries
  the extras in the _same_ patch, since two patches would make undo look like data
  loss). Reset **clears** rather than writes defaults. Which controls render is a
  table asserted against the envelope's own direction map, not conditions in JSX.
  **Registry rule changed:** the Transition section now appears whenever the _primary_
  clip has one — gating it to a single clip made apply-to-selected-cuts unreachable.
  **Two correctness fixes found by tests:** `wipeAlpha` was a float-epsilon short of
  opaque at `p = 1` for some softness values, and `offsetAt` emitted `-0`.
  **Alignment is NOT implementable as a param** (it is about clip overlap — a timing
  op with its own ADR); `color`/dip-to-color belongs to the sibling kinds plan;
  reverse needs an out-envelope in the compiler. web-editor 2149 green, engine 1934
  green, ruff/mypy clean.
  **Phase 10a + 10b (speed curves, freeze, reverse) DONE (2026-07-31) — schema v15,
  ADR 0090.** `speed` widened from `.positive()` to any finite number (0 = freeze,
  <0 = reverse) and clips gained an optional `speedRamp`: playback rate as a function
  of **source** time (anchored there, not in timeline time, because timeline time is
  the _integral_ of the rate — a timeline-anchored point would move whenever an
  earlier one changed). ADR 0046's invariant generalised to its integral form, and
  the constant case falling out **exactly** is asserted, not assumed. New
  `speed-curve.ts` + `speed_curve.py` parity pair, fixed-step Simpson (128
  intervals/segment) and 60 bisection steps in both languages for ADR 0089's reason —
  an adaptive rule diverges between languages and then preview and export disagree
  about _how long a clip is_; 252-case fixture asserted to 1e-9 in both suites.
  **ADR 0046's known limitation is CLOSED** — the program's single biggest risk:
  `trim_clip`/`split_clip`/`delete_range`/`ripple_delete` all route through one
  speed-aware `truncateClip`, so an ordinary trim of a 2x clip is no longer rejected,
  and a split of a ramped clip lands on the right frame instead of the linear
  midpoint. Ramps ship without a flag as a result. **Scope line decided, not left as
  a gap:** ramp rates are strictly positive — freeze and reverse are the _constant_
  cases, because a rate crossing zero makes the timeline↔source mapping
  non-invertible. Render: `time_transform` for ramps and freezes, `TimeMirror` +
  `MultiplySpeed(|speed|)` for reverse; **audio is reported, not silently wrong** —
  freeze renders silent (a held sample is a DC offset) and ramped audio pitch-shifts,
  with the two honest fixes named in the ADR and deferred to 10c/10d where a control
  can expose the trade-off. **Phase 10c (speed
  section UI) DONE (2026-07-31)** — presets, rate, a **Reverse** toggle and **Freeze
  frame**, plus duration-driven speed (type the length you want, the rate follows,
  preserving reverse). The rule the panel turns on: **the resulting duration is shown
  BEFORE the commit** (`aria-live`, since the number changing IS the feedback), and it
  is computed by the engine's own `clipTimelineDuration` rather than re-derived — a
  panel promising a duration the validator disagrees with is what let ADR 0046's
  limitation stay invisible. Direction and magnitude are separate controls, not one
  signed number. A ramped clip gets a readout plus "Remove ramp" instead of rate
  controls that would misreport it. Ripple toggle deferred (ADR 0046's
  ripple-vs-isolated decision — a separate op, not a checkbox); pitch-preservation
  toggle deferred (ADR 0090 records that neither route is implemented, so the control
  would claim a capability the render lacks). **10d (visual ramp editor) remains.**
  editor-core 556, timeline-schema 153, engine 1951, web-editor 2162 green.
  **Timeline selection fixes (reported bug, DONE 2026-07-31)** — two defects the
  revamp's heterogeneous lane heights exposed. (1) **Marquee row mapping:**
  `clipsIntersectingRect` took a single `rowHeight` and the view passed
  `olHeight / rowCount` — an _average_, wrong the moment an effect lane (20px), a
  collapsed lane, or an expanded keyframe strip sits among 56px media lanes. Proved
  in a real browser: with one effect lane present, a band drawn over the audio lane
  alone selected the two video clips as well; stack a few such rows and the skew
  grows until the band selects nothing. The selector now takes explicit
  `LaneRowBand[]`, built from the SAME `rowSize` the virtualizer lays rows out with
  (bands include the row gap so no dead pixels remain), and a new
  `effectLayersIntersectingRect` means a band across an effect lane finally catches
  its layers — select-all and the marquee now agree about what is on the timeline.
  (2) **Select-all then Delete:** ⌘A selects clips _and_ effect layers, but
  `edit.delete` handled layers "first, and exclusively" and returned, so Delete after
  a select-all spared every clip. Both are deleted now, merged into ONE patch (layer
  ops first — they are lane-local, while a ripple shifts what the clip ops resolved
  against) so a single undo restores everything. To keep Delete unsurprising, a plain
  click on a clip clears the layer selection and vice versa; an empty-lane click
  clears both. Regression cover at all three levels: selector unit tests (including a
  mixed-height case), a `useShortcuts` select-all→Delete→undo test, and three
  real-geometry Playwright tests — the bug was invisible in jsdom, where every lane
  is the same height. web-editor 2166 green, e2e chromium green (bar the
  pre-existing, environment-sensitive `visual.spec` baselines).
  **Timeline lane-height reflow + full Add-track menu (reported bug, DONE
  2026-07-31)** — the sibling of the marquee defect above, and the same root cause
  seen from the layout side. (1) **Rows never re-measured.** TanStack Virtual
  memoises `getMeasurements` on `count` + its own size cache; **`estimateSize` is
  not one of those dependencies**, and nothing here calls `measureElement`. So the
  heights were frozen at whatever the first render computed: collapsing a lane,
  reordering the stack, or expanding a keyframe strip changed `rowSize` and the
  virtualizer ignored it — the dead bands and overlapping lanes in the report. Fixed
  with a `laneVirtualizer.measure()` gated on a **signature of the actual row
  heights**, not on the deps: `visibleTracks` churns far more often than the geometry
  does and `measure()` forces a render, and the signature never reads the playhead so
  playback still costs nothing. (2) **Columns 3px out of step:** `.track`/`.track-head`
  carried `margin: 3px 0` from the pre-virtualizer flow layout, but both columns are
  now `position: absolute; top: 0` — where a top margin shifts one column, a bottom
  margin collapses, and the header's inline `margin: 0` cancelled it on the other
  column only. Replaced by an explicit `TRACK_ROW_INSET` on both. (3) A header row
  now spans its lane's **full** band including expanded keyframe lanes (as bottom
  padding, so the glyph stays centred on the clip body) instead of stopping short.
  (4) **Add track** offered only Video/Audio though `TrackType` has five members —
  an `effect` adjustment lane was unreachable from the UI entirely; all five ship
  with their header glyphs off one `ADD_TRACK_KINDS` table. Regression cover asserts
  the row offsets _move_, and was verified to fail against the unfixed component.
  web-editor 2172 green, tsc/eslint clean.
  **Track header context menu (reported gap, DONE 2026-07-31)** — new
  `TrackContextMenu.tsx`, the track-scope sibling of `ClipContextMenu` (right-clicking
  a _lane_ opens the clip menu, which says nothing about lanes). It closes a real
  hole: **`removeLayerPatch` had no caller anywhere in the app**, so a track could be
  created and reordered but never deleted. Menu is Add track above / Add track below
  / Delete track. Indices resolve against `timeline.tracks`, **not** the view's
  filtered `visibleTracks`, or an insert lands in the wrong z-order slot whenever a
  lane is filtered out; the menu returns `null` if its track disappeared between the
  right-click and the render (undo, or an AI patch) rather than showing actions that
  all resolve to `null`. Delete needs no confirmation because `remove_layer` inverts
  to an `add_layer` carrying the clips — asserted by an undo-restores-the-clips test,
  since a lossy invert would silently restore an empty lane. web-editor 2176 green.
  - [x] **Security follow-up (discovered, asset-media review 2026-06-30):** add an ffmpeg
        timeout to `/asset-media` thumbnail derivation (mirror `FRAMEPILOT_RENDER_TIMEOUT_SECONDS`)
        so a crafted/looping media file can't hang derivation. Non-blocking (loopback-only,
        path sandbox-checked first); `thumbnails` is already clamped `le=20`.
        DONE (2026-07-04): new env `FRAMEPILOT_ASSET_MEDIA_TIMEOUT_SECONDS` (default 60s,
        tighter than the 900s render ceiling) threaded through the `/asset-media` route into
        `inspect_media`/`extract_waveform`/`generate_thumbnails`; probe timeout → 422,
        waveform/thumbnail timeout degrades to `null` so import never blocks. `config.py`/
        `media/derive.py`/`service.py` at 100% cov; engine 449 tests, ruff/mypy clean; docs
        `configuration.md` updated. NOTE: add `FRAMEPILOT_ASSET_MEDIA_TIMEOUT_SECONDS=60` to
        `.env.example` (that file is outside the agent path-sandbox — pending a manual add).

---

## Phase 11 — Cursor-Class AI Sidebar (`apps/web-editor`, `packages/ai-sdk`, `apps/desktop`)

> **Full execution detail lives in [`plan/AI-SIDEBAR.md`](./AI-SIDEBAR.md)** — read it
> before any work. Upgrades the single-shot right-rail `AiPanel` into a streaming,
> persistent, interruptible, Cursor-class AI workspace. Core idea: **everything the AI
> does becomes a typed, append-only `AiEvent` that streams into a conversation and
> updates _in place_ by `id`**; the UI is a pure function of an ordered event log.
> Hard constraints unchanged: **no `project.fp.json` schema change** (conversations are
> a separate store), AI edits **only** through the validated tool→patch→`validate→apply→
record` path, render-vs-preview holds, and no new dependency/IPC channel/persisted
> store without §9 approval in the sub-plan. Ten independently-shippable milestones.

- [x] **M0** — Spike, decisions & ADR (event model, persistence location, streaming IPC); resolve the §9 approvals — ADR 0033 merged 2026-06-30
- [x] **M1** — Streaming engine in `packages/ai-sdk` (`AiEvent` union + reducer; `AiProvider.stream()`; `Orchestrator.stream*` with `AbortSignal`; deterministic mock stream) — done 2026-06-30, 100% cov
- [x] **M2** — Conversation store + persistence (IndexedDB browser / desktop JSON files; restore-instant; per-conversation UI state) — done 2026-06-30; `conversations:*` IPC added
- [x] **M3** — `AiSession` transport facade + streaming AI IPC push channel (+ security-reviewer gate on abort/scoping) — done 2026-06-30; `framepilot:ai:stream-*` channels
- [x] **M4** — Sidebar shell + virtualized event renderers (per-type cards, progressive markdown, status colors, auto-scroll/jump, a11y, animations) — done 2026-06-30; uses react-markdown (MIT, license-scanned)
- [x] **M5** — Tool-call activity cards + clickable file/clip/track reference chips + timeline-action cards — done 2026-06-30
- [x] **M6** — Diff review (accept/reject/batch/undo/jump) + live progress + interruptibility (stop/retry) — done 2026-06-30; Preview + Resume honestly gated (engine preview / no run-checkpoint yet)
- [x] **M7** — Conversation list/history (date groups, pin/favorite/rename/duplicate/delete/export) + instant global search — done 2026-06-30
- [x] **M8** — Composer power features (slash commands, attachments, quick actions, removable context panel; **no voice** — dropped) — done 2026-06-30
- [x] **M9** — Performance (reducer perf-budget test), accessibility (region/tablist/aria-live/roles), Playwright e2e rewritten for the streaming sidebar + visual baselines, user guide + ADR finalize + CHANGELOG; retired the legacy `AiPanel` — done 2026-07-01

> **Phase 11 ✅ complete (2026-07-01).** Shipped as part of a Cursor-class UI pass:
> retuned design tokens to a Cursor/Linear palette (ADR 0028 amendment), reskinned the
> sidebar to a Cursor-identical look, and revamped the editor into a Premiere-style
> layout — a top region (assets · preview · inspector/AI) over a **full-width timeline
> dock** (`Editor.tsx`). See [`plan/AI-SIDEBAR.md`](./AI-SIDEBAR.md).

- [x] **Context manifest — "the number that moves is not lost memory"** (2026-07-27,
      ADR 0080; `providers/model-capabilities.ts`, `kernel/context/{manifest,invariants}.ts`,
      `context-builder.ts`, `orchestrator.ts`, `ContextWindowIndicator.tsx`,
      `ContextDebugger.tsx`). Root-cause fix for "the context resets and the agent forgets".
      Three real defects, all fixed: (1) the reported capacity was one hardcoded `190_000`
      for every provider and model — now resolved from the selected model (exact id →
      longest prefix → per-provider floor, with an unknown id labelled `assumed` rather than
      guessed), exposed via a new `AiProvider.modelId`; (2) `context_usage` carried one
      unattributed number — every request now emits a **context manifest**: per-section costs
      including the omitted ones, the compaction event, the durable run memory that outlives
      the request, and the four token figures kept distinct (limit · reserved output ·
      estimated vs provider-reported input · remaining), with tool schemas counted and any
      payload the tier account misses shown as its own row; (3) a turn could go out with no
      objective or next action, leaving the model to compensate by re-exploring the whole
      project — **pre-request invariants** now repair what state implies (the creator's own
      request, the stage's outstanding objective) deterministically and surface what they
      cannot, refusing to invent a plan. UI: the ring became a keyboard-reachable meter +
      panel that names what the request contained, what compaction removed and when, and
      states plainly that project memory and committed decisions survive; distinct
      "Preparing context"/"Generating" phases, nothing animated when idle; a dev-only
      inspector diffs the two most recent requests. `kernel/context/continuity.test.ts` is
      the regression suite (long session · applied edit · reload · model switch · forced
      compaction · long montage). No schema, IPC, or render-path change.
      **Amended same day:** the creator-facing surface is now the figure `17K/1M` plus a
      hover/focus tooltip (figures · room left vs the reply reservation · compaction only
      when it happened · the memory reassurance). The click-opened ledger of every section,
      memory row and model id was correct but wrong for a writing surface — the manifest
      still carries all of it for the dev inspector and the guide. ADR 0080 amended.

- [x] **Beat detection on silent footage reports the fact, not an ffmpeg dump**
      (2026-07-27, `analysis/beats.py`, `media/ffmpeg.py`, `service.py`, both tool
      registries). `/detect-beats` on a clip with no audio track surfaced ffmpeg's raw
      stream dump + "Output file does not contain any stream" as a 422, so the model
      retried the same asset. A failed decode is now classified — probe on the failure path
      only, never string-matching version-specific stderr — into `NoAudioStreamError` with
      a sentence naming the file and the fix; genuine decode failures pass through
      unchanged. Also fixed a latent 500: the route logged `bpm` with `%.1f`, which throws
      when too few beats make the tempo underivable. Both tool descriptions now say beat
      detection needs an audio-bearing asset. The unified `/analyze` pass already skipped
      silent assets.

- [x] **Activity-stream redesign — "the run thread"** (2026-07-27, `EventNode.tsx` +
      the `.ai-event*` block of `styles.css`). Every activity row (reasoning · tool · plan ·
      timeline action · progress) now hangs off **one continuous spine** with a status bead
      per step, instead of two disconnected rails and a stack of unrelated rows. Per row: one
      leading glyph (tool icon ⇄ chevron on hover) instead of three; hover/focus-revealed
      details+copy actions; `tabular-nums` on every runtime. Only exceptional tool states
      spend a glyph — `completed` is a quiet dot, so a long run scans for the one thing that
      went wrong. The proposed-edit card is the single heavy surface: state-coloured leading
      edge, Accept the only filled button in the stream, and **A / R / P shortcuts** while
      focus is inside it (hinted with `<kbd>`, scoped to the card so they never collide with
      the timeline's own single-key bindings). Notices dropped their full tinted background
      for a 2px tone rule; reference chips render their `data-kind`; progress is a hairline
      sweep, not a 6px filled track. No behaviour, schema, or business logic changed —
      presentation only; all 1310 web-editor tests green.

---

## Discovered (2026-07-25) — agent researched forever, never edited — [x] done

**Symptom (reported run):** "cut this ~6-min video to ~1 min with captions, animations
and transitions" spent eight turns re-reading the transcript, re-mapping footage,
re-analysing silence and re-proposing edits, then finished having applied **nothing** —
with no warning that the timeline was untouched.

**Root cause — four gaps in existing machinery, not missing architecture.** The staged
Conductor, novelty ledger, read memo, stall guard and action recovery were all present
and working; this request fell through them:

1. `callNoveltyKey` coarsened _analysis_ args but kept **full args for reads**, so
   `get_transcript` at a new `start`/`end` window looked novel every turn and reset the
   stall streak. Reproduced against the reducer: 8 turns, `stallStreak` stuck at 0.
2. The diminishing-returns guard needs sub-120-token turns; these carried minutes of
   reasoning, so it was structurally unreachable.
3. Nothing bounded research — the 300-step resource ceiling was the only rail left.
4. The empty-run notice required `rejectedOpCount > 0`, so a run that never _attempted_
   an edit finalized **silently**.

**Fix (ADR 0074):** split `callMemoKey` (exact args — correctness) from `callNoveltyKey`
(drops window args — progress accounting); added `RESEARCH_BUDGET_TURNS = 8`, which
forces an action-only turn via ADR 0068's existing recovery mechanism and is refunded by
any edit attempt; made the empty-run notice fire on zero-attempt runs, gated on a guard
having stopped the run (`modelDeclaredDone`) and on ops not being lost to the per-turn
cap (`attemptedAnyEdit`); reworded the recovery prompt, which had asserted a cause that
is false for the budget trigger.

**Verification:** 1738 ai-sdk tests green (13 new, incl. the reported sequence as a
regression test); full monorepo `pnpm test` 16/16 and `pnpm typecheck` green. One golden
snapshot changed — `spin-guard`, a guard-stopped zero-edit run, which now warns; no
applied-edit scenario changed. Parity harness caught (and I fixed) an over-broad first
cut that had suppressed the rejection notice.

**Not done — outcome verification.** The run is now guaranteed to _act_ and to _report
honestly_, but `verify` still checks that applied ops are valid, not that the user's
requested outcome was achieved (target duration reached, captions present, transitions
present). Deriving checkable goals from a free-text request is a separate piece of work.

---

## Discovered (2026-07-02) — agent reliability, tool sync, sidebar minimalization

**Agent loop fix (done):** agent mode aborted after a no-op `manage_assets` when the
bin was already organized ("0 operations → no changes"). A zero-op turn no longer halts
the run (it continues to the real edit); the loop stops only on a genuine dead end or on
_spinning_ (a repeated no-progress tool-call signature). No-op mutations now surface as
"…— nothing to change". Also fixed a concurrent atomic-write `ENOENT` in the desktop
conversation store (pid-only temp path → pid + counter). Tool-arg rejections already
surface field-level detail (prior slice).

**Tool sync (verified, no drift):** the registry (`@framepilot/ai-sdk` `TOOL_REGISTRY`,
28 tools) is the single source; MCP auto-derives (`buildMcpTools`, parity test), the
orchestrator consumes it directly, and the web UI `toolMeta` is exhaustive (guarded by
test). 24 available + 4 gated. No action needed beyond keeping the guards green.

**Sidebar minimalization (done):** header restructured — mode dropdown + overflow (⋯)
menu, idle status hidden, model collapsed into overflow with a not-ready dot. See
CHANGELOG. All 613 web-editor tests green.

**Requested next — wire up the 4 gated analysis tools (staged, NOT started):** the user
asked to make `analyze_silence` / `detect_scenes` / `detect_faces` / `generate_mask`
real. Two blockers before code:

1. **New async media-analysis path is required.** Today every tool handler (TS `read`/
   `buildOps` and Python) is a _pure function of project JSON_ — it may not touch media,
   fs, or network. Analysis tools must read media, so they need a new sidecar/IPC
   "analyze" route + an async tool-execution path in the orchestrator (the current read
   path is synchronous). This is a cross-cutting architectural addition.
2. **Dependencies (CLAUDE.md §5 — needs approval + `pnpm license:scan`).**
   - `analyze_silence`: feasible with existing `imageio-ffmpeg` + `numpy` (audio RMS →
     silent ranges). No new dep. **Best first slice.**
   - `detect_scenes`: feasible with ffmpeg + numpy (frame-diff), or `PySceneDetect`
     (new dep, BSD-3). Doable without new deps.
   - `detect_faces`: needs a face model (`mediapipe` / `opencv` / `onnxruntime`) — new
     heavy dep. **Approval required.**
   - `generate_mask`: needs segmentation (`rembg` / SAM / onnx) — new heavy dep +
     model weights. **Approval required.**
     Suggested order once approved: (1) `analyze_silence` end-to-end as the vertical slice
     that builds the async analysis path, (2) `detect_scenes`, (3) `detect_faces`,
     (4) `generate_mask`. Each flips `available:true` in **both** registries, adds
     handler + tests, and keeps Zod↔Pydantic parity.

## Phase 12 — Performance hardening + MCP safety-at-scale (2026-07-02)

> Driven by a two-front audit (frontend runtime perf + MCP server). User priority:
> **extreme runtime performance without hindering any feature**, and an MCP server that
> is safe to run at scale. No schema change, no invariant change — all UI perf work is
> view/session-state only (invariant 5); all edits still flow validate→apply→record.
> New subagents: `performance-optimizer`, `performance-monitor`. Full findings archived
> in `docs/reports/` (perf-audit + mcp-audit).

### 12.1 Frontend runtime performance (`apps/web-editor`)

Root cause: the transient playhead lives in the monolithic `useEditor` reducer, and
`useEditor` returns a fresh `editor` object every render that is prop-drilled into all
panels — so every `seek` (60fps playback / per-pointermove scrub) re-renders the whole
editor subtree. Only `ClipFilmstrip`/`AssetThumb` are memoized today.

- [x] **Caption + live-agent interaction latency (2026-08-03).** Profile caption editing
      and streamed agent runs, eliminate whole-list/whole-project work from high-frequency
      updates, add render/event-frequency regression coverage, and verify the affected browser
      workflows without weakening live progress or caption-preview fidelity. Caption cues now
      virtualize to a bounded viewport (<50 mounted rows at 7,200 cues), same-project host commits
      reconcile without remounting the editor/sidebar, and stream delivery is lossless at a capped
      20 Hz with single-allocation batches, settled-only Markdown, and memoized historical rows.
      ADR 0095 and performance budgets document the contract. Focused tests: 137/137; focused E2E:
      15/15; full `pnpm verify`: green, including all 75 E2E and 2,237 engine tests (one intentional
      skip); website typecheck/build and diff hygiene: green.

- [x] **Film-scale CPU regression investigation (2026-08-03).** Profile the current
      editor after the WebCodecs/effects/captions work, isolate any idle/playback/edit
      hot loops that escaped the existing seek/render-window guards, ship measured
      fixes with regression coverage, and update the performance budgets and changelog.

- [x] **Large-project edit-path latency follow-up (2026-08-03).** Reproduced the remaining
      multi-clip/caption lag under realistic history and continuous-control pressure. Caption
      controls now create one patch per gesture, caption playback lookup is temporally indexed,
      and renderer/desktop persistence bounds the newest contiguous undo suffix before autosave or
      agent grouping. The live session retains full undo. Regression coverage includes many slider
      changes producing one patch, count/byte suffix correctness, and a 5 MiB legacy agent-history
      commit. Full `pnpm verify` and website production build pass. **Last updated:** 2026-08-03

- [x] **Slice 1 — Stop playhead-free panels re-rendering on every seek (P0, safe subset).**
      DONE 2026-07-03 (attempt 2). Kept `playhead` in `EditorState` (no store-shape change —
      the lesson from attempt 1) and added a stable ref-backed `getPlayhead()` to `useEditor`.
      `Editor.tsx` now builds a `nonPlayheadKey` that changes on ANY state slice **except**
      `playhead`, and memoises the five playhead-free panels on it — **MediaBin** (the reported
      "asset lag"), **EffectsPanel**, **OverlaysPanel**, **AiSidebar**, **Toasts** — so a pure
      seek (60fps playback / per-pointermove scrub) reuses their elements and React skips those
      subtrees. `MediaBin`/`OverlaysPanel` "…at playhead" handlers read `getPlayhead()` so the
      memoised closure never uses a stale playhead. Live-from-playhead components
      (`PreviewPlayer`/`Toolbar`/`TimelineView`/`Inspector`/`TranscriptView`/`CaptionEditor`)
      intentionally still update on seek. Deterministic render-count guard added
      (`Editor.perf.test.tsx`): a seek does NOT re-render MediaBin/Toasts while the live timecode
      DOES change. web-editor **613 tests** + typecheck + lint green. No schema/engine/invariant
      change.
  > **Attempt 1 (2026-07-03) reverted — incomplete.** `playhead`/`seek` were removed from
  > `EditorState` into a new `playhead-store.ts` but the ~10 consumers weren't migrated,
  > breaking the build. Lesson applied above: keep the store shape, memoise the readers.
- [x] **Slice 1b — Stop TimelineView + Toolbar re-rendering on seek.** DONE 2026-07-03.
      Added a **playhead clock** (`editor/playhead-clock.ts`) — a tiny external store that
      `useEditor.seek` mirrors (seek is the sole `playhead` mutator, so no divergence) — plus a
      `usePlayhead(editor)` hook (`useSyncExternalStore`) and a `subscribePlayhead`. The live
      playhead nodes were extracted into subscribing subcomponents (`PlayheadMarker`,
      `PlayheadScrubber`, `RulerBar` with memoised tick children), so a seek re-renders only
      those tiny nodes. `Toolbar` reads the playhead via `getPlayhead()` in its handlers.
      `TimelineView` + `Toolbar` are then memoised in `Editor.tsx` on `nonPlayheadKey`, so
      neither re-renders on a seek (verified: `Editor.perf.test.tsx` now asserts MediaBin,
      Toasts, Toolbar **and** TimelineView don't re-render on a seek while the live timecode
      does). `useSettings` (context) / `useTrackLayout` (own state) still re-render them on
      their own changes. `PreviewPlayer` intentionally stays live (it recomputes the active
      clip per frame). web-editor 613 green, typecheck + lint clean.
- [x] **Slice 2 (drag ghost) — per-clip memoisation.** DONE 2026-07-03. Extracted the clip
      block into a `React.memo` `<TimelineClip>`. The `trackLanes` memo still rebuilds on a
      ghost change, but now only the ONE dragged clip (changed `isGhost`/`start`/`end`) actually
      re-renders — every other clip on every layer bails on identical props. This is the
      behavior-preserving way to get the "a drag doesn't rebuild all clips/layers" win (directly
      targets the reported multi-layer drag lag) without the higher-risk fully-separate-overlay
      rewrite (which needs cross-track vertical positioning + clip-anatomy duplication). Combined
      with Slice 3's leading-edge ghost throttle, a drag now re-renders ~one clip per frame.
      web-editor 613 green.
- [ ] **Slice 2 — Stable `actions` + memoize panels (P0 tail / P2).** Pass the stable
      `actions` object (not the per-render `editor` wrapper) down; expose `state` via selector
      hooks; `React.memo` the large panels (MediaBin, TimelineView, PreviewPlayer, EffectsPanel,
      AiSidebar, Inspector, TranscriptView, TimelineMinimap, EventNode) so the existing/added
      memoization actually holds.
- [x] **Slice 3 — rAF-batch zoom + throttle the drag ghost (P1).** DONE 2026-07-03.
      Wheel/pinch zoom now coalesces a burst into ONE `setZoom` per animation frame (was one
      store update — hence one whole-Editor re-render + lane rebuild — per wheel event); the
      cursor anchor is preserved. The drag ghost uses a **leading-edge rAF throttle**: the first
      pointermove of a frame renders immediately (so single moves and the interaction tests
      observe the ghost synchronously) and further moves coalesce to one flush per frame, capping
      the `trackLanes` rebuilds a high-Hz trackpad drag triggers; `latestGhostRef` keeps the
      pointer-up commit frame-accurate. web-editor 613 tests green (incl. the mid-drag snap-guide
      assertion). Deferred (higher-risk, needs clip-anatomy refactor): rendering the ghost as a
      fully separate overlay so `trackLanes` no longer depends on `ghost` at all.
- [x] **Slice 4 — Minimap memo + cleanups.** DONE 2026-07-03. `React.memo(TimelineMinimap)`
  - its `minimapGeometry` memoised (was re-walking every clip on each seek-driven parent
    render); `rulerTicks` + `duration` memoised out of the per-seek render path in
    `TimelineView`; `ClipWaveform` gets a module-level `EMPTY_MARKERS` const so an omitted
    `markers` prop stops re-firing the repaint effect. web-editor 613 green, typecheck + lint
    clean. (`useDeferredValue` for the Inspector readout — optional micro-opt — not needed.)
- [x] **Budgets + guards (`performance-monitor`).** DONE 2026-07-03. Added a
      **Re-render scoping budgets (the 60 fps invariant)** section to
      `docs/guides/performance-budgets.md` codifying the per-seek re-render rules and pointing
      at each enforcement (the `Editor.perf.test.tsx` render-count guard, the `trackLanes`/
      minimap memos, the rAF-batched zoom, the leading-edge drag throttle). The deterministic
      guard (`Editor.perf.test.tsx`) is the non-flaky CI regression check for the headline
      invariant (a seek must not re-render playhead-free panels). Follow-up (optional): a
      dedicated worst-case multi-layer fixture render-count benchmark.
- [x] **Preview: pre-roll the on-deck clip so cuts don't hitch (2026-07-09).** Reported: the
      program monitor "sticks for a few ms" on every clip switch, visible even when clips are
      far apart — so a warm-up (fetch/decode) miss, which the element pool already solves, was
      ruled out. Root cause: the pool pre-loads and pre-seeks each upcoming clip but leaves its
      `<video>` **paused** at the in-point; at the cut the swapped-in element's `play()` takes
      1–3 frames to spin its decoder back up, painting a **static** frame while the playhead
      moves on (the clock's own comment already noted "takes a frame or two to actually start").
      Fix (targeted, keeps the whole pool architecture): the master clock now **pre-rolls** the
      immediate on-deck slot — a lead (`PREVIEW_PREROLL_LEAD_SECONDS = 0.15s`) before the cut it
      seeks that element back by the lead and starts it playing muted/off-screen, so it plays
      _up to_ its in-point and arrives at the cut **already progressing**; the swap lands on a
      moving picture with no freeze, no skipped/repeated frames, no playhead jump. Pure helpers
      `prerollLead` / `prerollSeekTarget` / `shouldPreroll` in `selectors.ts` (unit-tested); the
      DOM wiring lives in the clock + a guard so the warm-alignment reseek leaves a pre-rolling
      slot alone (e2e-verified like the rest of the media pipeline). A clip whose source starts
      at 0 (untrimmed) has nothing to seek back into → lead 0 → not pre-rolled; that residual is
      what a future decode-ahead (WebCodecs) compositor would close (see
      `plan/PREVIEW-WEBCODECS-COMPOSITOR.md`). web-editor selectors + monitor suites green,
      typecheck + lint clean.
- [x] **Preview/playhead stability regression (2026-07-30).** The uploaded recording
      reproduces periodic black canvas frames and a non-monotonic shared playhead while
      playing a montage. Fixed the discontinuous audio-only project clock, stale
      wrong-segment presentation, competing transport state, per-frame canvas-owner React
      renders, and layout-driven playhead positioning. Real-footage reproduction and the
      portable P7 browser guard now show zero wrong-segment/black presentations and a
      monotonic playhead. Full `pnpm verify` passes (41 E2E; 1,421 engine tests); details are
      tracked under P4 in `plan/PREVIEW-WEBCODECS-COMPOSITOR.md`.
- [x] **Residual preview cadence/playhead shimmer (2026-07-30).** Live acceptance after
      the root clock fix still sees a minor flicker. Measure and close redundant canvas
      presentation, live-playhead React work, and subpixel line shimmer under the P4
      follow-up in `plan/PREVIEW-WEBCODECS-COMPOSITOR.md`. Closed by restoring Chromium's
      GPU canvas path, reusing resident source pixels between media frames, frame-quantizing
      semantic React subscribers, and imperatively aligning the marker to device pixels.
      Real Chrome: 513 ticks / 130 draws / 394 reuses, zero fractional positions and zero
      missing, wrong-segment, sampled-black, or backward samples. All 12 compositor E2E
      scenarios and full `pnpm verify` pass (web editor 1,364; standard E2E 41; engine 1,421).

### 12.2 MCP server — steer agents to tools + harden at scale (`packages/mcp-server`)

Root cause of "agent edits the file directly": no MCP `instructions` steer the client, and
the server leaks the absolute `project.fp.json` path + full project JSON (every media path).

- [x] **Slice M1 — Steer external agents onto the tools (fixes the reported bug).** Added a
      top-level MCP `instructions` string (edits MUST go through the reversible/validated tools;
      do NOT read/write `project.fp.json` or media directly). `stateView` now returns
      `{projectId, projectName, canUndo, canRedo, historyLength}` — no absolute path leaked;
      tightened `get_project_state` (TS registry + Python mirror) + session-tool descriptions.
      mcp-server 67 tests green, 100% safety-core coverage, parity guard intact; engine 443
      green. Done 2026-07-02.
- [x] **Slice M2 — Harden for scale.** DONE 2026-07-03 (attempt 2, as 4 sub-slices; ADR 0034).
      **M2a** `allowedOrigins` (Host **and** Origin checked → 403 on cross-origin). **M2b**
      request-body cap (`readJsonBody` rejects oversize with **413** before buffering) +
      malformed JSON → **400** (was 500). **M2c** concurrent-session cap (**503** past
      `FRAMEPILOT_MCP_MAX_SESSIONS`, default 64) + OPTIONAL bearer auth (off by default; if
      `FRAMEPILOT_MCP_TOKEN` set, `Authorization: Bearer` required, constant-time compare, else
      **401**). **M2d** `save_project` lost-update guard (byte-baseline re-read/compare → typed
      `conflict` error instead of clobbering; baseline advances; deleted file recreated) +
      active-pointer sandbox (`openActiveProject` now runs `resolveWithin`, closing the
      no-sandbox-gate bypass → `unsafe_path` on escape). New env: `FRAMEPILOT_MCP_TOKEN`,
      `FRAMEPILOT_MCP_MAX_BODY_BYTES`, `FRAMEPILOT_MCP_MAX_SESSIONS` (all backward-compatible
      defaults). mcp-server **80 tests** green, 100% safety-core coverage, typecheck + lint
      clean; no schema change, no new dependency, `resolveWithin`/editing path untouched.
      Follow-up: have the desktop app mint + pass the bearer token to a bundled client (env
      surface exists; app wiring not done). **Attempt 1 (http.ts-only) was reverted** for
      regressing existing tests; the sub-slice approach fixed test expectations in-step.

## Phase 13 — Reliable Agent Orchestration (`packages/ai-sdk`, `apps/desktop`, `apps/web-editor`, `packages/mcp-server`)

> **Full plan in `plan/AGENT-ORCHESTRATION-RELIABILITY.md`** (mirrors the Phase 11
> sub-plan convention). Hardening + coherence pass over the _existing_ AI layer
> (chat/plan/edit/agent modes, context management, and every AI-driven action) —
> not greenfield. Closes verified gaps: no provider retry/backoff/`Retry-After`, no
> SDK-level timeouts, **no conversation history reaches the model** (single-shot
> `buildContext`), un-budgeted context, an unbounded agent-loop prompt, no
> resume/auto-repair, agent-on-mock in-app, and no reliability eval harness/tracing.
> All invariants hold (no `project.fp.json` schema change; validate→apply→record;
> render-vs-preview; one policy across browser/desktop/MCP). **Status: `[ ]` planned.**

- [ ] **R0** — Contracts (`ProviderError`/`RetryPolicy`/`ContextBudget`/`TurnTrace`/
      `Checkpoint`) + `TurnTracer` seam + deterministic eval harness scaffold + ADR 0035
- [ ] **R1** — Resilient transport: typed errors, retry+backoff+`Retry-After`,
      connect+idle timeouts, usage capture, `ResilientProvider` decorator wired into
      all three surfaces; optional provider fallback (§7 A5)
- [ ] **R2** — Context management: conversation-history threading, token-budgeted
      tiered builder, selection-scoped slice, agent-loop compaction, prompt-caching seam
- [ ] **R3** — Agent robustness: failure budgets + escalation, checkpoint + true
      Resume, bounded Critic-driven auto-repair, plan ledger; in-loop preview render (§7 A2)
- [ ] **R4** — Real-provider agent end-to-end (close Phase 9.3) + one-policy
      cross-surface audit + uniform error surfacing
- [ ] **R5** — Observability (trace surfacing), full eval matrix + budget guards in CI,
      conversation-record versioning, guardrails (ops caps, preview-before-apply, leak
      checks), docs/ADR/CHANGELOG

## Phase 14 — Marketing Website & Freemius Licensing (`apps/website`, `apps/desktop`) — ✅ done (2026-07-03, ADR 0036)

> Make FramePilot sellable/downloadable and enforce a paid license. Static Next.js
> site + Freemius checkout for the buy flow; a greenfield Electron license gate for
> enforcement. No project-schema change, no new desktop dependency.

### 14.1 Marketing website (`apps/website`, new workspace app)

- [x] Scaffold: Next.js 15 App Router (`output: export`), Tailwind v4 themed with the
      app's dark tokens (ported from `DESIGN_SYSTEM.md`), Geist font, ESLint/vitest.
- [x] Landing page sections (announcement bar, nav, hero + CSS editor mockup, integrations,
      feature bento, how-it-works, demo video facade, pricing preview, FAQ, final CTA, footer).
- [x] `/pricing` — typed pricing config + **build-time live Freemius price fetch**
      (`scripts/fetch-pricing.ts` → `pricing.generated.ts`, typed fallback), **subscription
      $25/mo · $199/yr with a Monthly/Annual toggle** (`BillingToggle`, honest computed
      savings), `lib/freemius.ts` checkout overlay with `billing_cycle`, `/thank-you`.
- [x] Markdown `/blog` (+ `[slug]`): `lib/blog.ts` + remark/rehype pipeline (gfm, slug,
      autolink, pretty-code), **SEO keyword-researched** seed posts, `lib/seo.ts` metadata +
      JSON-LD, `sitemap.xml`/`robots.txt`/`rss.xml`.
- [x] **Full `/docs` site**: `lib/docs.ts` (frontmatter-driven category/order nav) + 8
      authored `content/docs/*.mdx` pages, `markdown.ts#extractToc`, `DocsSidebar` +
      scroll-spy `TocRail` + prev/next; sitemap includes docs.
- [x] **Cursor-style repositioning + dependency-free 3D**: tagline "Your editing agent for
      stunning video", delegation hero + agent section headings; `AuroraCanvas`, `TiltCard`,
      `SpotlightCard`, `Reveal` islands (all reduced-motion-aware). No new deps.
- [x] **OG + icons** generator (`scripts/generate-og.ts`, resvg, offline) → og.png (new
      positioning copy), favicons, PWA icons, `favicon.ico`, `site.webmanifest`; per-page metadata.
- [x] `/download` (OS-detected → latest GitHub Release), legal pages, custom 404.
- [x] Full keyboard nav (skip link, ⌘K command palette, accessible FAQ), reduced-motion,
      responsive; `next build` static export green (26 routes); unit tests (pricing/seo/blog).

### 14.2 Electron license gate (`apps/desktop/electron/license/`)

- [x] Pure decision core `license-gate.ts` (expiry, offline grace, key masking) — tested.
- [x] `license-store.ts` (plaintext `license.json` in userData, device uid; mirrors
      `AiConfigStore`; only a masked status leaves main) — tested.
- [x] `freemius-client.ts` (public activate/validate endpoints, injectable `net.fetch`) — tested.
- [x] `license-service.ts` (activation, stale revalidation, offline-grace vs authoritative
      invalid, enforcement-off-when-unconfigured / dev-bypass) — tested.
- [x] IPC: `framepilot:license:{status,activate,deactivate}` in contract + preload +
      `shared-types` `FramePilotBridge`; handlers in `main.ts`; AI/render/export handlers
      guarded when unlicensed (defense-in-depth).
- [x] Renderer `LicenseGate` wraps `<App/>` (bypass without a bridge; activation card;
      subscription-aware **renew** state with masked key + end date + renew CTA) — tested
      (+renew test); web-editor suite green (621).
- [x] Docs: ADR 0036 (subscription + docs + 3D), `docs/guides/website-and-licensing.md`
      (subscription pricing, Freemius monthly+annual setup, docs-site authoring), website README.

## Phase 15 — Production Hardening & UX Refinement (all apps + packages)

> **Full plan in `plan/PRODUCTION-HARDENING.md`** (sub-plan convention). A
> comprehensive release-candidate polish pass: AI streaming latency (H1),
> sidebar interactions (H2), preview flicker (H3), preview transform handles
> (H4), project orientation (H5), timeline zoom/thumbnails (H6), timeline UI
> (H7), playback isolation (H8), orchestration audit (H9), local project index
> (H10), GitHub providers (H11), header/layout/startup polish (H12–H16, H20),
> feature audit (H17), website redesign (H18), motion system (H19), docs (H21),
> performance validation (H22). **Status: `[x]` complete (2026-07-06, ADR 0038);
> final report in `reports/production-hardening-report.md`.**

### Phase 15 follow-up — film-scale timeline zoom/thumbnail performance (2026-07-06)

- [x] **Canvas backing-store clamp (the "zoom in and never recovers" bug).** A
      zoomed-in clip sized its `ClipWaveform` / `FilmstripPlaceholderCanvas`
      backing store to the clip's full pixel width (100k+ px — beyond the ~32k
      browser per-dimension canvas limit), pinning hundreds of MB per clip until
      restart. Backing stores now clamp at 8192 device px and CSS-stretch.
- [x] **Horizontal render windowing.** Pure `laneRenderWindow` /
      `spanInRenderWindow` (selectors, unit-tested): clips, transition pills,
      cut affordances and ruler ticks mount only within the visible slice plus a
      quantized overscan buffer (≥1 viewport each side; identity changes only on
      bucket crossings so lanes don't rebuild per scrolled px). `null` window
      (unmeasured viewport / jsdom) mounts everything; the drag-ghost clip
      always mounts. Filmstrip frame `<div>`s keyed by slot index for DOM reuse.
- [x] **`showTimelineThumbnails` setting** (default on; Settings → Editing with
      a memory hint). Gates the filmstrip picture layer only; when on, sliver
      clips still draw ≥1 frame (the 24px picture cutoff no longer applies to
      the filmstrip). View state, never a patch (invariant 5).
- [x] Tests: web-editor 734 green (+`TimelineView.thumbnails.test.tsx`,
      selectors window tests, settings merge); typecheck + lint clean.

## Phase 16 — Agent-Native Editor UX (`packages/ai-sdk`, `apps/web-editor`, `apps/desktop`, `engine/python`)

> **Full plan in [`plan/AGENT-NATIVE-UX.md`](./AGENT-NATIVE-UX.md)** (sub-plan
> convention; builds on Phase 13's reliability work — read both). Root-caused from a
> live agent session (2026-07-06): the app's agent loop **never executes
> analysis/action tools** — `runAgentCall` fabricates instant `completed` for
> `analyze_silence`/`detect_scenes` ("runs on the host" with no host wired), so the
> model loops re-requesting analysis, edits blind, and the UI shows checkmarks for
> work that never ran. Also: no `detect_beats` capability, mid-run assistant prose
> buried in the reasoning accordion, the planFirst plan never surfaced as a live todo
> ledger, and thumbnail zoom lag. **Status: `[x]` — shipped 2026-07-06 (ADR 0041);
> P4 sprite-sheet deferred pending measurements, P0 fps-budget capture is a manual
> follow-up for performance-monitor.**

- [x] **T — Truthful tool execution (P0):** async `HostToolExecutor` seam; awaited
      analysis through the shared `createSidecarExecutor` (desktop main via
      `net.fetch`, browser via `VITE_FRAMEPILOT_PYTHON_API_URL`, mcp-server
      analysis-client extended); inline-project analysis routes (sandbox preserved);
      real running→done/failed/`cancelled` lifecycle; in-run dedup;
      `detect_beats` end to end (numpy energy-flux engine route → registry tool →
      `/detect-beats`) — done 2026-07-06
- [x] **U — Cursor-grade sidebar:** interleaved assistant segments (markdown), live
      todo ledger from the planFirst plan (pending → running w/ intent detail →
      done), "Thought for Ns" + completion report, tool-card args line + live
      elapsed, status-truthfulness audit — done 2026-07-06
- [x] **P — Thumbnail zoom performance to the root:** decoded-bitmap LRU
      (`bitmapCache.ts`, evictions close bitmaps), single-canvas filmstrip redrawn
      on quantized buckets + 120ms zoom-settle freeze, perf regression gates
      (`ClipFilmstrip.perf.test.tsx`) — done 2026-07-06; P4 sprite-sheet deferred
- [x] **B — Chrome polish:** collapsed rail strip 40→24px + whole-strip expand
      affordance; collapse/expand animation (armed per toggle, never during drags,
      reduced-motion honoured); splitter hidden while collapsed — done 2026-07-06

## Phase K — Orchestration Kernel (first-principles redesign) — `[~]` in progress

> **Integration roadmap: [`plan/AGENT-NATIVE-COMPLETION-PLAN.md`](./AGENT-NATIVE-COMPLETION-PLAN.md)**
> (2026-07-08). An audit found the K3–K5 kernel modules (DAG scheduler, proposers, plan
> compiler, semantic index, cost meter, replay, recovery) are **built + unit-tested but have
> 0 live callers** — the only live path is the degenerate-DAG Conductor wrapping the original
> agent loop. That plan is the end-to-end roadmap (P0–P10) to integrate them into a working,
> top-notch agent-native editor: recipe spine first (P1), then parallel planner, semantic
> retrieval, cross-surface parity, economics, perceived-latency UX, and hardening.

> **Full architecture in [`plan/AI-ORCHESTRATION-REDESIGN.md`](./AI-ORCHESTRATION-REDESIGN.md)**
> (RFC → graduates to an ADR on adoption). A from-scratch rethink that demotes the LLM
> from controller to advisor: replace the monolithic `orchestrator.ts` streaming loop
> with a four-plane kernel — pure **Conductor** reducer (control) · **Effect Runtime**
> (execution) · **proposers** (decision) · Project doc + Semantic Index + Event-Log WAL
> (data). Strangler-fig migration (K0→K6): the kernel wraps the existing loop as one
> effect, then peels responsibilities out phase by phase, each green on `pnpm verify`
> and preserving every invariant (no schema change; AI emits patches only;
> render-vs-preview; one policy across surfaces). **Status: K0 in progress.**

- [x] **K0.1** `Command`/`EffectDescription` types + `SessionGateway` seam in
      `packages/ai-sdk/src/kernel/`; today's streaming loop wrapped as one
      behavior-preserving `AgentEffect` (parity-tested). — done 2026-07-07
- [x] **K0.2** Promote `events.ts` to the kernel WAL (`task_started`/`task_finished`/
      `effect_progress`, additive; folded into view-level `tasks`, not `nodes`; reducer
      back to 100%) — done 2026-07-07
- [x] **K0.3** `EffectRuntime` w/ `HostToolEffect` + `ModelEffect` handlers; idempotency
      keys + dedup generalized from the per-run `hostCache` (success-only memo, honest
      no-executor failure, concurrent-dup sharing) — done 2026-07-07. **Phase K0 complete.**
- [x] **K1.1** `Conductor` pure reducer (`onCommand`/`onEffectResult` → `{state,effects,
events}`) reproducing the agent-loop control flow with a degenerate linear DAG;
      execution left to `run_turn`/`run_verify`/`finalize` effects; 100% table-tested —
      done 2026-07-07
- [x] **K1.2** Conductor event-stream parity harness (+ planFirst/resume/autoRepair) —
      **done 2026-07-07.** (b) split-emitter seq foundation: `createTurnEmitter(startSeq)` + `seq()` share ONE monotonic one-off sequence between reducer (structural events)
      and handlers (fine events). (c) real `agentConductorHandlers`
      (draftPlan/resume/runTurn/runVerify/finalize) reuse the shared turn mechanics
      (streamAssistant/executeToolCalls/applyAgentTurn/attemptRepair/critique/assembleEdit),
      seed at `state.seq`, return `endSeq`; the reducer owns the plan ledger (planSteps +
      ledgerLength), emits terminal plan + per-op `timeline_action` on the fold from
      `result.describedActions`, splits mid-turn tool-cancel from turn-boundary abort, and
      folds `draft_plan`/`resume`/repair ops. **Parity harness** (`src/kernel/parity.test.ts`)
      drives streamAgent vs runConductor byte-for-byte over 16 scenarios (all 10 named +
      cancel/plan/resume variants) — green. `streamAgent` untouched; no schema/dep change.
      `conductor.ts`/`driver.ts`/`events.ts`/`orchestrator.ts` all **100%**; 506 ai-sdk
      tests green (typecheck+lint+build clean).
- [x] **K1.3** Cut `streamAgent` over to the Conductor & delete the old loop — **done
      2026-07-07** (signed off, CLAUDE.md §5). `streamAgent` now compiles the run into a
      Conductor `Command` + execution handlers (`agentRun`) and delegates to `runConductor`,
      wrapped in a throw-settling generator reproducing the old loop's catch/finally
      (retryable error card + partial diff + terminal reasoning/status). The ~398-line
      monolithic loop is deleted; its turn mechanics survive only in the shared methods the
      handlers reuse. Byte-identical behavior is frozen by `streamAgent-golden.test.ts` (a
      full `AiEvent[]` snapshot captured from the OLD loop under a fixed clock — ts + ids, no
      normalization — before cutover), which the Conductor-backed `streamAgent` reproduces
      exactly. The run's throw-time seq reads through one shared reader over the active
      handler's emitter (replacing the per-handler `seqAtThrow` arrows). 507 ai-sdk tests
      green; `orchestrator.ts`/`conductor.ts`/`driver.ts`/`events.ts` all **100%**;
      typecheck/lint/build + web-editor typecheck clean; dist rebuilt; no schema/dep change.
      See ADR 0042. `agentConductorHandlers` kept as the public kernel seam for K6.1.
- [~] **K2–K6** Semantic Index & structured context · Planner/DAG/Scheduler · recipe-first
  router · memory/recovery/replay · surfaces & scale _(K6.1 Electron IPC needs sign-off)_.
  **K2.1 done 2026-07-07** — `SemanticTimelineIndex` pure derivation
  (`ai-sdk/src/kernel/semantic-index.ts`, 100%): ProjectDoc-readable slices populated,
  analysis-fed slices typed-but-honestly-empty until K3. **K2.2 done 2026-07-07** —
  `context-builder` assembles the timeline (bounded to 12 clips/layer) + transcript
  (focus-windowed) tiers as index-slice retrievals, not whole-doc dumps; prompt-caching
  already shipped (R2 B5). **Phase K2 complete.**
  **K3 done 2026-07-07** — `PlanCompiler` + Task DAG (K3.1), `Scheduler` (K3.2),
  schema-validated proposers + model-tier routing (K3.3), montage-parallelism golden
  test (K3.4). Model-tier routing is a real settings seam: `resolveTierRouting()`
  (`kernel/proposers/types.ts`) layers per-tier `FRAMEPILOT_TIER_{SMALL,MID,LARGE}_
{PROVIDER,MODEL}` env overrides over the built-in defaults (the same env-as-settings
  pattern as `resolveProviderConfig`), with independent per-field fallback and an
  `isProviderName` guard so a typo can't crash the AI path; 637 ai-sdk tests green, 100%.
  **K4.1 done 2026-07-07** — deterministic `CommandRouter` (`kernel/router.ts`, 100%):
  `routeCommand` classifies a command into `recipe | chat | direct_edit | plan` with
  **zero model calls** (keyword topic+action signature + selection state), returning a
  reasoned decision the Conductor dispatches (recipe→`compileRecipe`, plan→Planner). A
  known verb beats a question form ("can you add captions?" → recipe); topic-only
  mentions ("is there silence here?") stay `chat`; only existing recipes match, so an
  unimplemented verb falls through to `plan`. 654 ai-sdk tests green, 100%.
  **K4.2 done 2026-07-07** — four more slash-commands promoted to zero-model recipes in
  `plan-compiler.ts` (100%): `improve_pacing` (parallel silence+pacing analyses fan into
  synth→patch→verify), `add_hook` (find→restructure→patch→verify), `punch_in`
  (synth-keyframes→patch→verify), `export_reels` (render→validate, a `render`-resource
  DAG with **no** patch node). Each gained a `routeCommand` signature (topic+action +
  param extraction: pacing aggressiveness, punch zoom `1.5x`, export preset 9:16/1:1/16:9);
  `punch_in` is ordered before `improve_pacing` so "punch in the slow parts" claims the
  dedicated recipe. Six recipes total; still zero tokens, not yet dispatched through the
  Conductor (that's K5/K6).
  **K4.3 done 2026-07-07** — cost meter (§19): a pure `kernel/cost-meter.ts` (100%) prices
  each model call by its `ModelTier` (per-Mtok input/output table, `DEFAULT_TIER_PRICING`
  with the large≈15×small ratio that makes tier routing a real lever) and folds a run's
  spend into an immutable `CostLedger` (tokens/USD/calls, overall + per tier, plus
  `tierUsdShare`). The **Scheduler** now enforces the dollar axis: `Budget.maxUsd` +
  `SchedulerState.usdSpent`, accrued through `onTaskCompleted({tokens,usd})` — the driver
  prices via the meter, the scheduler stops dispatching at the cap (in-flight drains). The
  price table is a settings arg, not a constant. Pricing stays pure/replayable; live
  dispatch wiring is K5/K6. 686 ai-sdk tests green, 100% on the touched modules.
  **Tier-routing settings UI done 2026-07-07** — model-tier routing is now configurable in
  **Settings → AI → Model tiers** (not env-only). `resolveTierRouting(overrides, defaults)`
  layers an in-app override **above** the env layer (`settings > env > compiled-in`);
  `AiConfig.tierRouting`/`AiConfigUpdate.tierRouting` thread a per-tier provider+model
  through both stores (browser localStorage + desktop `ai-config.json`, minimal-override
  persistence) and `useAiConfig.setTier`; a `TierRow` (provider Select + model input) per
  tier. Persisted + projected today; consumed at dispatch in K5/K6. See ADR 0043.
  **K5.1 done 2026-07-08** — memory split into scopes (redesign §16.1). Task scope = the
  scheduler's ephemeral task-results; run scope = the `events.ts` AiEvent WAL; project
  scope = the kept `memory-store.ts`. New pure, persistence-agnostic stores
  `user-memory.ts` (cross-project editorial defaults; model-tier defaults stay in
  `AiConfig.tierRouting`, not duplicated) and `workflow-memory.ts` (saved parameterized
  recipes — a `SavedWorkflow` _is_ a `RecipeRequest` that replays through `compileRecipe`,
  the seam K5.2 fills). `scoped-memory.ts` layers project **over** user (project wins per
  field); `context-builder` threads the effective editorial memory via a new optional
  `ContextInput.userMemory`. All three modules 100% (19 tests); 706 ai-sdk green; no
  schema change.
  **K5.1b/K5.2/K5.3/K6.1/K6.2/K6.3 done 2026-07-08 — Phases K5 & K6 complete; the
  redesign RFC is graduated to ADR 0044.** K5.1b: user/workflow memory persist in the
  renderer's localStorage (one store for web + desktop, no secrets ⇒ no new IPC) with a
  **Settings → Memory** panel; the browser session threads `userMemory` into context.
  K5.2: `captureWorkflow` + `matchSavedWorkflow` — a saved run routes future matching
  commands to its recipe with **zero tokens** (router consults `savedWorkflows` first).
  K5.3: pure `recovery.ts` (per-failure saga policy), `event-log.ts` (WAL
  snapshot/compaction), `replay.ts` (record + **zero-provider replay**). K6.1: the
  kernel already runs in Electron main (Conductor-backed since K1.3); the hardened
  `aiStreamStart` seam was **extended additively** to thread `userMemory` (sanitised in
  main — security-reviewed), not rip-and-replaced. K6.2: `tool-scope.ts` — capability/
  permission/cost metadata + **scoped descriptors** with a 100+/600-tool scale test
  proving a flat per-turn prompt. K6.3: ADR 0044 (kernel graduated), ai-sidebar guide +
  CHANGELOG + website changelog + this plan reconciled. Every new kernel module 100%;
  742 ai-sdk / 760 web-editor / 187 desktop tests green; no project-schema change.
  **Deferred (build-order, honestly not faked):** live dispatch of the router→recipe/plan
  DAG through the Conductor needs the recipe leaf-executors (`synth_ripple_deletes`,
  `analyze_silence`, …), which are gated on their Python engines landing; desktop
  main-process threading of the remaining context scopes rides the same seam next.

  > **Reconciled against the code 2026-08-06 (for the LangChain plan's §11.4 gate).** Three
  > things above are no longer true, and Phase K's `[~]` is now mostly stale bookkeeping
  > rather than open kernel engineering:
  >
  > 1. **The deferral is closed.** Recipe leaf-executors landed (`kernel/recipe-leaves.ts`,
  >    `recipe-executor.ts`) and `Orchestrator.streamRecipe` drives the compiled DAG live
  >    through `executeRecipe` with `RECIPE_LEAVES`. `export_reels` is routed to the Export
  >    dialog honestly rather than faked, as the guardrail requires.
  > 2. **Model-tier routing was removed, deliberately.** `95ec01c` (2026-07-27) collapsed
  >    tier-based dispatch to one host-selected provider: "small/mid/large remain cost and
  >    telemetry classes only and no longer select providers, models, credentials, or base
  >    URLs." `resolveTierRouting`, `AiConfig.tierRouting` and **Settings → AI → Model tiers**
  >    no longer exist anywhere in the repo. The K4.3 / tier-routing-UI entries above, and the
  >    part of **ADR 0043** describing that UI, are superseded — they describe a surface a
  >    reader will not find.
  > 3. **The remaining context scope is threaded where it needs to be.** `userMemory` reaches
  >    desktop through the hardened `aiStreamStart` seam; `savedWorkflows` is consulted in the
  >    renderer (`AiSidebar.tsx` → `routeCommand`), which serves browser and desktop alike, so
  >    K5.2's "get cheaper as taught" loop is live on both.
  >
  > **What Phase K's `[~]` still represents** is the separate product roadmap in
  > `AGENT-NATIVE-COMPLETION-PLAN.md` — **48 open items**, of which 19 are the P12 sidebar/UX
  > track and 9 are explicitly deferred appendices. None of it changes `conductor.ts`,
  > `working-state.ts` or `loop-detector.ts`, which is what §11.4 actually cares about: those
  > three have been stable since 2026-07-30, and the only edit since was M0.3's Zod import
  > change. **The M3 gate is a maintainer call, but the "moving target" it guards against is
  > not currently moving.**

### Provider roster follow-up — `vertex` provider (discovered task, 2026-07-09)

- [x] **Added `vertex` (Google Cloud Vertex AI via `gcloud` OAuth) alongside `google`.**
      A separate provider (`packages/ai-sdk/src/providers/vertex.ts`) that calls Gemini's
      _native_ `generateContent`/`streamGenerateContent` API — not the OpenAI-compatible
      shape `google` uses — authenticated with a short-lived `gcloud auth print-access-token`
      access token (`apiKey`) against a full, user-pasted endpoint URL (`baseUrl`, required,
      no default: it encodes project/location/model, so there is no separate model field).
      Threaded through `ProviderName`/`AiProviderName`, both `resolveProviderConfig`/
      `createProvider`, the desktop `AiConfigStore` and web `aiConfigStorage` (with a
      `ready` special case requiring BOTH the token and the URL), `ai-stream.ts`/`main.ts`,
      the browser `ai.ts` provider builder, and `SettingsDialog.tsx` (custom "Access token"/
      "Endpoint URL" labels + hint, no Model field for this provider). Unit-tested
      (`vertex.test.ts`, request/response mapping + SSE streaming + error classification,
      100%); `pnpm verify` green except the pre-existing ffmpeg-8.x `test_service.py`
      baseline-red (unrelated, no Python touched). Docs: `docs/guides/ai-providers.md`,
      `CHANGELOG.md`.
      **Superseded the same day — see the next entry.**

### `google`/`vertex` reworked onto the official `@google/genai` SDK + ADC (2026-07-09)

- [x] **`google` and `vertex` now use `@google/genai`, the one approved exception to this
      package's "no vendor SDK" rule** (user-approved, scoped to exactly these two files).
      Confirmed the shipped SDK's real TS types before writing code (no guessing): constructor
      shapes (`new GoogleGenAI({ apiKey })` vs. `new GoogleGenAI({ vertexai: true, project,
location })`), the `models.generateContent`/`generateContentStream` call shape (`model`
      top-level, `contents`, `config.systemInstruction`/`temperature`/`tools`/`abortSignal`),
      response reading (`response.text`/`response.functionCalls` getters,
      `usageMetadata.promptTokenCount`/`candidatesTokenCount`), and the thrown-error shape
      (`ApiError extends Error { status: number }`). New shared module
      `packages/ai-sdk/src/providers/google-genai-shared.ts` holds the request/response
      mapping + streaming + error classification (`classifyGenAiError`) common to both
      providers, seamed behind a minimal `GenAiClient` interface (not `Pick<GoogleGenAI,
'models'>` — a real SDK class has private members that would block a fake test double)
      so tests inject a fake `models.generateContent`/`generateContentStream`, no `fetch`
      mocking, no network. `google.ts` keeps its user-pasted `apiKey` (unchanged UX);
      `vertex.ts` **fully replaced** the old pasted-URL + `gcloud` access-token design — it now
      reads **only the model** from `ProviderConfig` and relies entirely on OS-level
      Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS` read by the SDK's own
      `google-auth-library`, `GOOGLE_CLOUD_PROJECT`/`GOOGLE_CLOUD_LOCATION` read explicitly and
      passed to `vertexai: true`). The user's `GOOGLE_GENAI_USE_ENTERPRISE` env var is
      documented but not depended on in code (confirmed the SDK does read it as an alternative
      Vertex-mode selector, but this app always passes `vertexai: true` explicitly rather than
      guessing behavior from an unconfirmed flag). Threaded through: `index.ts`'s
      `resolveProviderConfig('vertex')` (now just an optional `GOOGLE_VERTEX_MODEL`, no
      key/URL env vars); desktop `AiConfigStore` (`vertex` added to `KEYLESS_PROVIDERS`,
      always `ready: true`, `applyUpdate` never writes a key/URL for it); desktop `main.ts`
      (dropped the now-unused `electronFetch` arg from both constructors — they no longer take
      `FetchLike`); web `aiConfigStorage.ts` (`vertex` moved from `BASE_URL_PROVIDERS` to
      `KEYLESS_PROVIDERS`, new `NO_KEY_FIELD_PROVIDERS` distinguishing "no key field at all"
      from Ollama's "optional key field"); `ai.ts`'s browser provider builder (mirrors the
      Ollama keyless-construction pattern); `SettingsDialog.tsx` (removed the `isVertex`
      branching entirely — Vertex now renders only a Model field + an informational,
      non-editable hint naming the four env vars). Rewrote `google.test.ts`/`vertex.test.ts`
      from scratch against the new SDK seam (100% coverage on all three new/changed provider
      files: `google.ts`, `vertex.ts`, `google-genai-shared.ts`); updated `providers.test.ts`,
      `ai-config.test.ts`, `aiConfigStorage.test.ts`, `SettingsDialog.test.tsx` accordingly.
      **License scan:** `@google/genai@2.10.0` is Apache-2.0; its full dependency tree
      (`google-auth-library`, `gaxios`, `gcp-metadata`, `gtoken`, `jws`/`jwa`, `protobufjs` +
      `@protobufjs/*`, `p-retry`, `ws`, …) is Apache-2.0/MIT/BSD-3-Clause/ISC — no denylisted
      license. Noted (not fixed, out of scope): the repo's `scripts/license-scan.mjs` walks
      only the root's flat `node_modules`, so it doesn't actually reach into the pnpm
      `.pnpm` store or a workspace package's own `node_modules` (a pre-existing gap, not
      introduced here) — verified the dependency tree by hand instead and confirmed clean.
      All affected suites green: ai-sdk 894 tests (100% cov on the three touched files;
      three small pre-existing coverage gaps — `anthropic.ts`/`nvidia.ts` branch coverage,
      `ollama.ts` — predate this change and are unrelated), desktop 192, web-editor 783;
      typecheck + lint clean on ai-sdk/desktop/web-editor; ai-sdk dist rebuilt. Docs:
      `docs/guides/ai-providers.md` rewritten for both sections; `CHANGELOG.md`.
      **Superseded — see the next entry (both `@google/genai` and `vertex` removed).**

### Removed `vertex` provider + `@google/genai`; `google` back to raw `fetch` (2026-07-09)

- [x] **Dropped the `vertex` provider entirely and removed the `@google/genai` dependency;
      `google` now reaches Gemini through the native REST API URL via raw `fetch`, like every
      other provider.** Reverses the two preceding 2026-07-09 entries. `google.ts` is now
      self-contained: it POSTs to `…/v1beta/models/<model>:generateContent` (and
      `:streamGenerateContent?alt=sse`) with the key in the `x-goog-api-key` header, maps the
      Gemini-native `contents`/`functionDeclarations` request + `candidates`/`functionCall`/
      `usageMetadata` response (tool-call ids synthesized `call_N`, as before), and streams via
      the shared `iterateSseData`/`parseJsonObject` seam — `fetch` injected for offline tests.
      Deleted `vertex.ts`, `vertex.test.ts`, `google-genai-shared.ts`,
      `google-genai-shared.test.ts`; removed `@google/genai` from `packages/ai-sdk/package.json`
      and regenerated the lockfile. Threaded the removal through: `PROVIDER_NAMES`
      (`types.ts`) and `AiProviderName` (`shared-types/ipc.ts`); `index.ts`
      (dropped the `vertex` case + `GOOGLE_VERTEX_MODEL`); desktop `main.ts` (Google now takes
      `electronFetch`) and `ai-stream.ts`; desktop `AiConfigStore` and web `aiConfigStorage.ts`
      (removed `vertex` from every roster/meta + the whole `NO_KEY_FIELD_PROVIDERS` concept —
      `google` is a normal keyed provider again); browser `ai.ts` builder; `SettingsDialog.tsx`
      (Google renders the standard key + model fields, no env-var hint). Rewrote `google.test.ts`
      against a fake `fetch` (100% coverage on `google.ts`); updated `providers.test.ts`,
      `ai-config.test.ts`, `aiConfigStorage.test.ts`, `SettingsDialog.test.tsx`. Suites green:
      ai-sdk 891, plus the touched web-editor/desktop AI suites; typecheck clean on
      ai-sdk/desktop/web-editor; ai-sdk dist rebuilt. Docs: `docs/guides/ai-providers.md`,
      `CHANGELOG.md`.

- [x] **Agent no longer hallucinates asset ids (read-result digest, 2026-07-10).** Root
      cause: the base agent context never lists the media bin, so the ONLY channel by which
      the model learns asset ids is the fed-back note of a read tool (`list_assets` /
      `get_project_state`) — and that note was `previewJson(value)`, a blind 240-char slice of
      the result JSON. For any project past a couple of clips the ids were sliced off, so the
      model "saw" `list_assets` succeed but with no usable ids and fabricated plausible
      sequential ones (`asset_img_9723`…) that the validator then rejected as unknown assets
      (the reported bug). Fix in `orchestrator.ts`: `summarizeReadResult(toolName, value)`
      replaces the char-slice for reads — it keeps EVERY asset/folder/track/clip id, drops
      heavy fields (path→filename, media/effects/keyframes), and bounds huge lists by dropping
      WHOLE records with an explicit "N more — filter by kind/folderId" line (never a silent
      mid-list cut). Analysis-tool previews widened 240→1200 chars (same class of bug for
      beat/silence lists). The full untruncated object still reaches the UI popup via `data`.
      Both agent loops (sync `agent` + streaming `streamAgent`) share `runAgentCall`, so one
      fix covers both. Tests: ai-sdk 1040 green (+6 new `summarizeReadResult` cases incl. the
      50-asset id-preservation and 400-asset whole-record-drop scenarios); typecheck/lint
      clean. Docs: `CHANGELOG.md`.

- [x] **`list_assets` read tool (2026-07-09).** Added a focused media-bin read to the
      canonical registry (TS `@framepilot/ai-sdk` + Python `ai_tools` mirror): returns
      `{ assets, folders }` with optional `kind` (video/audio/image) and `folderId` filters —
      a cheaper, targeted alternative to `get_project_state`. Wired end-to-end: Zod +
      Pydantic schemas (parity guard green), TS `read` closure + Python handler + dispatch
      map, and auto-advertised over MCP via `buildMcpTools` (no MCP code change). Registry is
      now **29 tools** (25 available + 4 gated). Tests: ai-sdk 895, mcp-server 92, engine
      ai_tools 54 — all green; typecheck/lint clean on ai-sdk/mcp-server + ruff/mypy on the
      engine; ai-sdk dist rebuilt. Docs: `docs/api/ai-tools.md`, `docs/api/mcp-server.md`,
      `docs/guides/mcp-server.md`, `CHANGELOG.md`.

- [x] **AI media-bin reads use the live editor snapshot (2026-07-26).** `Editor` now
      derives the AI project input from its authoritative timeline/media-bin store instead of
      the asynchronously persisted app snapshot, eliminating empty `list_assets` results while
      assets are visible. Desktop transports that validated snapshot on every run, and the main
      process refreshes its in-memory working document after the optimistic revision check
      without advancing the persisted revision. Regression tests, desktop/web typecheck, and
      lint pass. Docs: `CHANGELOG.md`.

- [x] **H0.2 (partial) — render text/title overlays, closing a honesty gap (2026-07-10).**
      `compile_timeline`'s clip-kind dispatch loop skipped every clip of kind `text`
      (`add_text_overlay` clips, `asset_id == "__text__"`) — the op validated and applied to the
      timeline (survived save/undo) but never appeared in a render, violating the "an edit that
      applies must render" invariant. Added `framepilot_engine/render/text_overlay.py`
      (`render_text_overlay_image`/`text_overlay_style`, reusing `render/captions.py`'s
      `wrap_lines`) and wired a `text`-kind branch into the compiler's loop (`_compile_text_clip`)
      that burns the clip's `text` effect in, centered, honoring optional `fontSize`/`color`
      params if an authoring UI ever sets them (only `text` is persisted today — see
      `OverlaysPanel.tsx`). `unsupported_track_types` no longer reports `text` as deferred.
      Golden test `test_compile_burns_in_text_overlay` renders with/without the overlay and diffs
      a region around the frame centre to prove the glyphs actually reach the pixels (not just
      that compile doesn't crash); `test_unsupported_track_types_excludes_captions_when_burning`
      updated for the new dispatch. No schema change (text overlays already modeled). See
      `plan/FRAMEPILOT-AI-PRODUCT-PLAN.md` H0.2 and `CHANGELOG.md`. Engine: `pnpm engine:lint` /
      `engine:typecheck` clean on the touched files; `pytest tests/test_render_compiler.py` 41/41
      green (full suite green except the pre-existing ffmpeg-8.x `test_service.py` route
      failures, unrelated). LUT rendering (the other H0.2 honesty gap) is a follow-up commit.

- [x] **H0.1 — Transcription via AI model, the ASR keystone (2026-07-10).** The AI gains
      hearing: `transcript` was populated only externally; nothing produced it. Added, end to
      end (schema→engine/model→op→tool→UI→tests), never faking a result:
  - **Engine** `framepilot_engine/audio/asr.py`: local whisper-cli (whisper.cpp CLI, not a
    Python binding) discovery + `base.en` model management (explicit `setup_model`/
    `POST /asr/setup`/`framepilot setup-asr`, SHA256-verified, gitignored
    `~/.framepilot/models` cache — never a silent download); a pure `--output-json-full`
    parser that merges whisper.cpp's sub-word BPE tokens into whole words with real
    per-word timestamps (`-ml 1 -sow --dtw`, no whitespace-split/interpolated fake
    timings) and clamps non-monotonic/zero-duration entries; a content-hash transcription
    cache. Exposed via `/asr/status`, `/asr/setup`, `/transcribe` (service.py, 503 on
    missing binary/model — never a fabricated transcript) and `asr-status`/`setup-asr`
    (cli.py). 99% coverage (38 tests); live audio not exercised (no whisper-cli/model in
    this sandbox) — covered via a realistic fixture JSON + contract tests for the
    unavailable path.
  - **`editor-core`** new reversible project op `set_transcript` (apply/invert/validate,
    100% coverage) — the patch primitive `transcribe` writes through.
  - **`ai-sdk`** a small ASR provider abstraction (`providers/asr-types.ts`) parallel to the
    chat `AiProvider`: `LocalWhisperCliClient` (default, talks to the engine sidecar) and
    `GroqTranscriptionProvider` (opt-in hosted `whisper-large-v3`, reuses `groq.ts`'s
    `GROQ_BASE_URL`/auth + `errors.ts`'s classification, word-level timestamps straight
    from Groq's API — no client-side merging needed). `resolveAsrProviderConfig`/
    `createAsrProvider` default to `whisper-cli` (no consent gate); Groq is only
    constructed when explicitly configured. `transcribe` tool registered in both the TS
    tool-registry and the Python `ai_tools` mirror — takes an ASR provider's already-fetched
    `words` and returns a `set_transcript` patch (mirrors the `add_asset` precedent: the
    provider call is a separate concern from the tool). 100% coverage on the new provider
    modules; ai-sdk dist rebuilt.
  - **`web-editor`** minimal Settings → AI → Providers → "Whisper / Speech-to-text"
    section: provider dropdown, local model status + "Set up" action, hosted-Groq
    off-device disclosure label.
  - **Follow-ups (explicitly deferred, not done this session):** wiring `transcribe` to
    auto-run on import; a sidebar action that calls the provider and previews/applies the
    result; a third ASR provider; confirming the `base.en` SHA256 checksum against the
    official release (authored offline, no network access to verify — see
    `framepilot_engine/audio/asr.py`'s `ASR_MODELS` comment).
  - **H0.1a — NVIDIA hosted ASR + dedicated ASR key (2026-07-19).** Added the deferred
    third provider: `NvidiaTranscriptionProvider` (`providers/nvidia-asr.ts`,
    `nemotron-asr-streaming` on `integrate.api.nvidia.com`, mirrors the Groq ASR provider).
    Hosted ASR now uses its **own pasteable API key** (`AiConfig.asrApiKey`, env
    `FRAMEPILOT_ASR_API_KEY`) in a dedicated slot — no longer the chat provider key —
    plumbed through shared-types, the browser + desktop config stores (readable/round-trips
    like the embeddings key), and `useAiConfig`. Settings → AI → Speech-to-text gains the
    NVIDIA option and a dedicated key field with the off-device disclosure + model shown.
    `resolveAsrProviderConfig`/`createAsrProvider` take optional overrides and no longer
    fall back to the chat `GROQ_API_KEY`/`NVIDIA_API_KEY`. Tests: ai-sdk nvidia-asr (7) +
    providers ASR selection, desktop ai-config ASR slot, web-editor storage + SettingsDialog.
    **Still deferred:** wiring the hosted providers into the live transcription pipeline
    (today captions come from the Python `/analyze` whisper-cli pass, which does not yet
    honor the selected hosted provider/key) — the provider/config/UI layer is complete and
    tested, the live wire is the remaining piece.
  - Tests: engine 38 (asr) + updates to `test_service.py`/`test_cli.py`/`test_ai_tools.py`;
    editor-core 100% coverage maintained (182 tests); ai-sdk 954 tests green, 100% coverage
    on new modules (ollama.ts's pre-existing 81.8% gap is baseline-red, confirmed via
    `git stash`, not a regression); web-editor 788 tests green. See
    `plan/FRAMEPILOT-AI-PRODUCT-PLAN.md` H0.1 for the per-line-item checklist.

- [x] **H0.1 follow-up — CORS preflight 405 on "Set up" + a setup-help popup
      (2026-07-10).** Clicking "Set up" for the local Whisper model surfaced "Method Not
      Allowed": the renderer's `fetch()` to the engine sidecar is cross-origin (Vite dev
      origin, or the packaged app's literal `null` file:// origin, vs. the sidecar's own
      `http://127.0.0.1:8765`), and `create_app()` never registered CORS middleware, so
      Starlette answered the browser's `OPTIONS` preflight with a bare 405 (no route
      registered for it) — confirmed empirically with a `TestClient` before fixing.
  - **Engine**: `config.py` gains `cors_allowed_origins` (default `["http://localhost:5173",
"null"]`, overridable via `FRAMEPILOT_CORS_ORIGINS`); `service.py`'s `create_app()`
    registers `CORSMiddleware` from it. New tests: preflight succeeds for the dev origin
    and the packaged app's `null` origin, is rejected for an unknown origin.
  - **`web-editor`**: `AsrSettings`' "Set up" no longer swallows a failure into a bare
    inline "error" state. If `whisper-cli` isn't installed (Set up only fetches the model
    file, never the program), or the setup call itself throws, a popup dialog
    (`AsrSetupHelpDialog`) explains why and links to a new docs page instead.
  - **`apps/desktop`**: the renderer had no window-open handler at all, so `target="_blank"`
    links (including the pre-existing `PRICING_URL` links) had no destination in a
    sandboxed `BrowserWindow`. Added `setWindowOpenHandler` in `main.ts` routing `https://`
    links to the OS browser via `shell.openExternal` and denying everything else — this is
    what makes the new docs link (and the existing pricing links) actually navigate.
  - **`apps/website`**: new guide `content/docs/local-transcription-setup.mdx` (category
    Guides) covering installing `whisper-cli` and what "Set up" does vs. doesn't do, linked
    from `captions-silence-and-shorts.mdx`'s Next steps.
  - Tests: engine 566/569 green (3 pre-existing unrelated `RenderJob.status` failures,
    confirmed via `git stash` on `main`); web-editor 831 tests green.

- [x] **H1.5 — Before/After AI-Review Player (done 2026-07-10).** First Horizon 1
      slice (WS-J/J3 "Preview / monitors" + H1.5 "preview-first review" in
      `plan/FRAMEPILOT-AI-PRODUCT-PLAN.md`). Wires the already-computed but previously-discarded
      before/after Timeline diff from `assembleEdit` (`packages/ai-sdk`) through to a new
      `AiReviewPlayer` component in `apps/web-editor`, so an AI-proposed edit's `DiffCard` shows a
      real before/after video preview (spring-loaded A/B toggle, scrub-linked) instead of only a
      text summary of ops.
  - `editor-core`: `structuredDiffTimeline(before, after): ChangedRegion[]` (added/removed/modified
    regions with before/after ranges).
  - `ai-sdk`: `ReviewCard` now carries `before`/`after`/`changedRegions` through to the UI.
  - `web-editor`: `AiReviewPlayer.tsx` mounts the real `PreviewPlayer` (HTML video — render-vs-preview
    rule honored, no separate render pipeline) against a read-only `useShadowEditor` shadow view of
    either timeline; every mutator on that shadow view is an explicit no-op so Accept/Reject stay the
    only path that touches the real project via `applyPatch`. Features: hold-to-compare A/B ("Hold for
    before" button + `b` key, spring-loaded back to "after" on release) sharing one `PlayheadClock` so
    the same instant is compared; a persistent Before/After pill; scrubber tick marks derived from
    `changedRegions`; auto-seek to the first changed region on mount; an allowlist-based honesty check
    (`PREVIEWABLE_KINDS`) that surfaces a warning badge if a future region kind can't be shown 1:1
    (everything previewable today); an "Approximate" badge when before/after clip durations differ at
    the region under the current playhead. `EventNode.tsx`'s `DiffCard` gained a collapsed-by-default
    "Show preview" toggle that mounts it only when `card.before`/`card.after` exist — invalid diffs keep
    the old disabled "Preview" stub. `AiSidebar.tsx` threads `project.assets`/`project.fps` down.
  - Explicitly deferred out of this slice (stays open J3/H1.7 work): safe-area/title-safe guides
    and the source-vs-program monitor split (**both shipped 2026-07-11**, see H1.7 below);
    side-by-side/wipe compare remains open (untracked by H1.7 — a different feature from the
    source-vs-program split).
  - Tests: new `AiReviewPlayer.test.tsx`; `EventNode.test.tsx` extended (preview toggle gated on
    before/after presence; Accept still calls the real apply path; shadow preview never leaks into the
    live project). `pnpm verify` green (tests/typecheck/lint).
  - **Side-by-side compare (done 2026-07-11, closes the last open H1.5/J3 item).**
    `AiReviewPlayer` gains a layout toggle ("Hold to compare" / "Side by side") in its toolbar.
    Side-by-side mounts TWO `PreviewPlayer`s live — one per timeline — over the SAME shared
    `PlayheadClock`, each labeled "Before"/"After" directly. Correctness details: the AFTER panel
    is always the write-through clock master; the BEFORE panel's `useShadowEditor` becomes
    read-follow-only (`seek`/`seekTransient` no-op) while split layout is active, so two live rAF
    loops never fight over `clock.set` every frame; `playing` is lifted out of `useShadowEditor`
    into `AiReviewPlayer` so either panel's transport drives both; `PreviewPlayer`/`PreviewAudioMixer`
    gained a `muted` prop, applied to the BEFORE panel only, so audio doesn't double up. Ready-gating
    is intentionally NOT cross-wired between the two players (documented trade-off: BEFORE's own
    prepare-on-play gate only affects its own paint timing, not AFTER's, since it never writes the
    clock) — a brief BEFORE-side desync while its media pool warms is accepted rather than adding
    cross-instance coordination. **Wipe compare (single frame, draggable split line) is deliberately
    NOT built here** — a small increment on top of side-by-side, tracked as an explicit follow-up,
    not silently dropped. Perf: doubling live `PreviewPlayer`s doubles decode/pool cost
    (`PREVIEW_POOL_SIZE` per side); shrinking the pool for this dual-mount case would require
    threading a pool-size param through `selectors.ts`'s pool machinery — deferred as not a small,
    contained change.
    - Tests: `AiReviewPlayer.test.tsx` extended — layout toggle switches panel count and hides the
      hold-to-compare control; both panels render the same scrubbed instant; BEFORE panel's video is
      muted, AFTER's is not; all pre-existing hold-to-compare tests pass unmodified. 8/8 green.
      `pnpm --filter @framepilot/web-editor test/typecheck/lint` and full `pnpm verify` green.

- [x] **H1.5/J4 — Footage search v1 over transcript (done 2026-07-11).** The Media
      bin (`apps/web-editor/src/components/MediaBin.tsx`) gains a unified search box that
      matches both asset filenames (unchanged, case-insensitive substring) and every word
      in `Project.transcript` — a creator can search what was _said_ and jump to it, not
      just search by filename.
  - New pure module `apps/web-editor/src/editor/transcriptSearch.ts`: `searchTranscript`
    does **whole-word** matching (a query token must equal a transcript word once both
    are folded to bare letters/digits via `captions.ts`'s now-exported
    `stripPunctuation`) — chosen over substring matching so "cat" doesn't fire on every
    "category"/"catalog" in a transcript (prose, not filenames). A multi-word query
    ("thank you") matches a contiguous run of words, giving phrase search for free.
    Each match carries a "keyword in context" snippet (`SNIPPET_CONTEXT_WORDS` words
    each side) and maps its `start` time back to whichever clip/asset occupies that
    instant on the timeline via the existing `clipsActiveAt` (`selectors.ts`) — the
    same lookup the preview player already uses to resolve "what's on screen now"; no
    new time-mapping logic was invented. Transcript word times are confirmed
    timeline-time (the `transcribe` AI tool's `set_transcript` op has no per-asset
    scoping), matching what `TranscriptView`'s word buttons already assume.
  - `MediaBin.tsx`: one search input (unified rather than a second search box —
    "search media & transcript"); when a query is present, the folder/grid tree is
    replaced with two labeled result groups ("Media" — filename matches; "Spoken in
    your footage" — transcript matches, each a clickable snippet + timestamp). Clicking
    a transcript result calls `editor.seek(match.start)`, the same affordance
    `TranscriptView`'s word buttons already use. No transcript yet → an honest
    "Transcribe your footage to search what is said." message, never a silent empty
    list. `formatClock` moved from `TranscriptView.tsx` into `captions.ts` (shared,
    de-duplicated) since both now format the same seek timestamps.
  - Tests: `transcriptSearch.test.ts` (whole-word vs. substring, case-insensitivity,
    multi-word phrase, snippet context, clip/asset mapping, stale-transcript
    null-mapping, empty query/transcript); `MediaBin.test.tsx` extended (no-transcript
    empty state, whole-word match excludes a substring false-positive, click-to-seek,
    filename + transcript results shown together). `pnpm --filter @framepilot/web-editor
test`/`typecheck`/`lint` green (885 tests).

- [x] **H1.6 — Agent-mode maturity: widen the planner path, honest fallback, verify
      parity, plan-approval gate, mid-run steering (AGENT-NATIVE P11.1/P11.2/P11.3/P11.4/
      P11.5/P11.6, 2026-07-11).**
      Widens what the live planner (DAG) path can honestly execute, replaces its silent
      discard-and-replay with an inspectable reason, wires the real technical-safety
      battery into recipe _and_ planner verify (not just the sequential agent path), and
      adds the two UI-facing autonomy controls: a plan-approval gate before execution and
      mid-run steering while a run is in progress.
  - `packages/ai-sdk/src/kernel/montage-leaves.ts`: new `PLANNER_LEAVES` export — the
    UNION of the one hand-authored `MONTAGE_LEAVES` beat-sync shape and every
    already-shipped, already-tested `RECIPE_LEAVES` pure primitive (ripple-delete/
    caption/pacing/hook/punch-in/filler-cleanup synthesis). Conservative widening: it
    recognizes MORE of what the driver can _actually run_ — never a shape the driver
    can't execute.
  - `packages/ai-sdk/src/orchestrator.ts`: `isRecognizedPlan`'s `analysis` case now
    checks `PLANNER_LEAVES` (was `MONTAGE_LEAVES`) — a Planner-authored plan can compose
    ANY of those proven leaves, not just the montage shape. `streamPlannedEdit`'s five
    "unsupported" exit points now emit a `notification` carrying a machine-inspectable
    `reason: PlannerFallbackReason` (`intent_unparseable` | `plan_unparseable` |
    `plan_uncompilable` | `unrecognized_task_shape` | `execution_unsupported`) plus a
    specific human `detail` — additive; the existing `PLANNED_EDIT_UNSUPPORTED_NOTICE`
    `text` string is unchanged so `AiSidebar`'s existing string-matching fallback probe
    keeps working unmodified.
  - `packages/ai-sdk/src/kernel/plan-driver.ts`: `executePlannedEdit`'s default `leaves`
    is now `PLANNER_LEAVES` (was `MONTAGE_LEAVES`), matching the widened gate.
  - `packages/ai-sdk/src/events.ts`: `NotificationEvent`/`NoticeNode` gain optional
    `reason`/`detail` fields (mirrors `ErrorEvent.detail`) — additive, every existing
    notification producer/consumer is unaffected.
  - `packages/ai-sdk/src/kernel/recipe-leaves.ts`: the shared `verify` leaf (the ONE
    registration point both `RECIPE_LEAVES` and `PLANNER_LEAVES` reuse) now runs the
    real `critic.ts#critique()` battery — the exact function the sequential agent path
    already calls — against the working project once the patch has structurally
    validated (an invalid patch still fails immediately, unchanged). The full
    `CritiqueReport` is exposed on the new `RecipeTaskOutput.critique` field.
    `durationTargetSeconds`/`targetPlatform` thread through from the `verify` step's own
    `args` when a caller sets them; render-gated checks stay honestly `skipped` (no
    preview render inside a pure leaf).
  - `apps/web-editor/src/components/ai/AiSidebar.tsx`: comment-only — documents the
    `tryPlannedEditFirst` gate's exact scope (Agent mode + `plan`-kind decisions only;
    desktop explicitly excluded, not a silent gap) now that P11.1 makes it meaningfully
    "primary" in practice; no logic/behavior change.
  - Docs: `plan/AGENT-NATIVE-COMPLETION-PLAN.md` P11.1/P11.2/P11.5/P11.6 marked `[x]`
    with shipped-detail notes (P11.3/P11.4 remain `[ ]`, explicitly separate);
    `plan/FRAMEPILOT-AI-PRODUCT-PLAN.md` H1.6 bullet added; `CHANGELOG.md` entry added.
  - Tests: `montage-leaves.test.ts` (`PLANNER_LEAVES` is the union of both registries,
    same `assemble_patch`/`verify` function objects); `recipe-leaves.test.ts` (`verify`
    runs the full 8-check battery, fails on a technical check even though the patch
    validated, recognises/ignores `targetPlatform`, warns-not-fails on a no-op patch);
    `planned-edit-stream.test.ts` (a THIRD, `RECIPE_LEAVES`-only plan shape —
    `find_hook`/`synth_hook_restructure` — runs live with zero montage vocabulary; four
    new honest-fallback-reason cases); `events.test.ts` (notification reason/detail
    threads through `reduceEvents`); new `kernel/verify-parity.test.ts` (P11.6 — recipe/
    planner/agent paths land on the identical 8-check-id battery). `pnpm --filter
@framepilot/ai-sdk test/typecheck/lint` green (1085 tests, +17); `pnpm verify` green.
  - **P11.3/P11.4 shipped 2026-07-11 (commit `44df709`):** plan-approval gate and
    mid-run steering, completing the two items the kernel half above deferred.
    `packages/ai-sdk/src/run-controls.ts` is the new kernel module — `PlanApprovalGate`/
    `createPlanApprovalGate` and `SteeringQueue`/`createSteeringQueue`, both carrying a
    live, non-serialisable resolver/queue OUTSIDE the pure `Command`/`AgentOptions`
    boundary. Plan-approval: when the up-front drafted plan has MORE than
    `PLAN_APPROVAL_STEP_THRESHOLD` (3) steps, the run pauses before its first turn for a
    new `PlanApprovalCard` (`apps/web-editor/src/components/ai/PlanApprovalCard.tsx`) —
    numbered plan, inline Approve / Edit request / Cancel, no modal; a plan with 3 or
    fewer steps is never gated. Mid-run steering: a new `SteeringInput`
    (`apps/web-editor/src/components/ai/SteeringInput.tsx`) next to the running-task view
    lets the user queue guidance while a run is in progress, without a Stop+restart; it
    is folded into the model context at the run's next per-turn boundary (the same
    boundary that already checks Stop/abort), with an honest "Steering applied: ..."
    notification once it lands — not an instant mid-step redirect. Both are **browser-
    only** — Electron IPC can't carry the live resolver/queue, an explicit documented
    gap, same precedent as planner-first/variations. New `kernel/conductor.ts`
    `awaiting_approval` `RunPhase`/effect/fold and `orchestrator.ts` `awaitApproval`/
    `runTurn` steering-pop handlers. Tests: `kernel/conductor.test.ts`,
    `kernel/driver.test.ts`, `orchestrator-stream.test.ts` (threshold on/off, approved/
    cancelled fold, steering fold at turn boundary, no-resolver-wired honest degrade);
    `PlanApprovalCard.test.tsx`, `SteeringInput.test.tsx`, and matching describe blocks
    in `AiSidebar.test.tsx` exercising the real flows end to end against a fake session.
    Full-suite evidence: `packages/ai-sdk` 1101/1101 tests, `apps/web-editor` 929/929
    tests, both typecheck/lint clean. See `docs/adr/0051-plan-approval-gate-and-mid-run-
steering.md` and `plan/AGENT-NATIVE-COMPLETION-PLAN.md` P11.3/P11.4 for the full
    breakdown. Desktop `planned-edit` parity remains tracked under P6.2/P10, unchanged
    by this task.

- [x] **H1.7 — J3 safe-area/title-safe guides + source-vs-program monitor split
      (done 2026-07-11).** Closes both "Explicitly deferred out of this slice" J3
      sub-items named in H1.5 above.
  - Safe-area/title-safe guides: a new `safeAreaGuidesByDefault` setting
    (`apps/web-editor/src/editor/useSettings.tsx`), off by default, mirrors the
    existing `gridByDefault` pattern exactly (same persistence, same Settings-dialog
    toggle, same monitor-toolbar toggle). Deliberately named `safeAreaGuidesByDefault`,
    not `safeAreaByDefault` — that shorter name is already claimed by `mergeSettings`'s
    back-compat read of a pre-rename persisted key that means "show the grid" (see the
    comment at `useSettings.tsx` ~line 116); reusing it here would make an old
    `{ safeAreaByDefault: true }` blob ambiguously mean two different features. A new
    `.preview-safe-area` overlay (`PreviewPlayer.tsx`, sibling to `.preview-grid`) draws
    action-safe (`inset: 5%`) and title-safe (`inset: 10%`) bordered rects via
    `::before`/`::after` (no per-line DOM, same convention as the grid), styled with the
    existing `--border-strong` design token (`styles.css`) — pure percentage insets on
    `.preview-frame`'s existing `--aspect`-driven sizing, so it works for 9:16 and 16:9
    with no orientation branching. Tests: `PreviewPlayer.monitor.test.tsx` extended
    (default off, toolbar toggle shows/hides the overlay, `safeAreaGuidesByDefault`
    setting honored on mount); `useSettings.test.tsx` extended (new key is opt-in and
    independent of the legacy `safeAreaByDefault` back-compat key).
  - Source-vs-program monitor split: a new **`SourceMonitor.tsx`**
    (`apps/web-editor/src/components/`) — deliberately NOT a reuse or fork of
    `PreviewPlayer.tsx` (which drives a full `UseEditor` through a pooled
    multi-clip timeline compositor; a Source monitor previews exactly one raw
    asset, a different shape entirely). Its own `<video>`/`<img>`, own
    play/pause/frame-step/scrub transport (visually consistent with the program
    monitor: reuses `.preview`/`.preview-stage`/`.preview-frame`/`.transport`/
    `.transport-btn`/`.transport-play` from `styles.css`, plus new
    `.source-scrubber`/`.source-scrubber-range` for the marked-range highlight).
    In/out point marking (`I`/`O` keys or In/Out buttons) is **local component UI
    state only** — never `useEditor`/the patch-undo store (invariant 5);
    `SourceMonitor`'s props are `{ asset, fps }`, no `editor` at all, so it is
    structurally incapable of dispatching a patch. The `I`/`O` shortcuts are a
    local `keydown` listener scoped to the component (mounted only while an
    asset is loaded), not wired into the shared registry
    (`editor/shortcuts.ts`) — that registry's `ShortcutDeps` is shaped around
    the one editing timeline/selection model, and a mark-range concept that
    touches no patch/undo state and belongs to exactly one panel doesn't belong
    growing it. `Editor.tsx` gains a plain **Source | Program** tab strip
    (`.monitor-tabs`) in the center stage; Program (the existing `PreviewPlayer`,
    behavior byte-for-byte unchanged) is the default, and only the active tab's
    monitor is mounted (an accepted trade-off: switching tabs resets the
    inactive monitor's local transport state, in exchange for never letting a
    hidden video keep playing audio, and never paying for two decode pipelines
    at once). `MediaBin.tsx`'s asset card gains an `onClick` (previously
    unhandled — only the inner "Add"/"remove" icon buttons had click handlers)
    that loads the asset into Source and switches the tab; the existing
    `onDoubleClick` → insert-to-timeline path is untouched (Premiere/Resolve
    convention: click previews, double-click inserts).
  - **Explicitly deferred, not silently dropped** (per the narrow-slice scoping
    for this task): inserting/overwriting the marked in/out range onto the
    timeline, three-point editing, and gang/sync playback between the two
    monitors.
  - Tests: new `SourceMonitor.test.tsx` (empty state; video vs. image asset
    rendering; transport play/pause/frame-step/scrub; in/out marking shows the
    range on the scrubber, via both buttons and `I`/`O` keys; state resets when
    the loaded asset changes; a dedicated test asserting a sibling real editor
    store's history never moves across a full interaction sequence).
    `MediaBin.test.tsx` extended (card click calls `onOpenInSource` and does NOT
    add to the timeline; double-click still adds to the timeline; the "add to
    timeline" icon button does not also fire `onOpenInSource`; rendering without
    the new optional prop doesn't throw). `Editor.test.tsx` extended (Program is
    the default tab; clicking a Media-panel asset loads Source and switches the
    tab, unmounting the real `PreviewPlayer`; switching back to Program remounts
    it; opening Source with nothing loaded shows its own empty state). Full
    `apps/web-editor` suite: 79 test files / 949 tests, typecheck and lint
    clean.

- [x] **H1.5c — Selection ↔ AI context loop + creative vocabulary (2026-07-11).**
      Closes an audited "dead but plumbed" gap (AGENT-NATIVE P8.4/P8.7) and adds a first
      slice of curated creative-intent vocabulary (P13.2). Data/routing layer only — the
      Cmd+K entry point and the "@" pin-context picker UI are separate follow-ups.
  - `apps/web-editor/src/editor/selectors.ts`: new `selectionRange(timeline, selectedIds)`
    — the bounding time range of a clip selection (earliest `start` to latest `end`,
    skipping stale ids). The single source of truth for "selection → range"; no such
    helper existed before (checked copy/paste, delete-clips — none compute a bounding
    range), so this is the one place both call sites below share it from.
  - `apps/web-editor/src/components/ai/AiSidebar.tsx`: resolves `editor.state.selectedIds`
    - `.timeline` to a range via `selectionRange` and threads it as `AiSessionInput.selection`
      on every run (already fully plumbed through `editor/ai.ts`'s Browser/Desktop sessions
      and `orchestrator.ts`'s `ToolContext` — the sidebar was the only missing populate
      step). Also passes `hasSelection: composerSelection !== undefined` into `routeCommand`,
      making the router's `direct_edit` kind reachable (previously dead — always `undefined`).
      Removing the "Selected" chip for a turn (see below) means that turn's request omits
      `selection` too — an explicit removal is honored, never silently re-added.
  - `apps/web-editor/src/ai/composerActions.ts`: `buildContextItems(project, selection?)`
    takes an optional `ComposerSelection` (range + clip count) and prepends a removable
    `{ id: 'selection', kind: 'selection', label: 'Selected: N clip(s), S–Es' }` chip —
    the composer's context row is now selection-derived, closing the loop with the AI
    request above.
  - `apps/web-editor/src/components/ai/Composer.tsx`: fixed a real (pre-existing, unrelated
    to this task's ask but found while wiring it) gap — `contextItems`/`onRemoveContext`
    were fully threaded as props but never rendered, so no context chip (not just the new
    selection one) was ever visible or removable in the UI despite `.ai-context`/
    `.ai-context-chip` CSS already existing for exactly this. Added the render (mirrors the
    existing attachment-chip markup/pattern).
  - `packages/ai-sdk/src/kernel/router.ts`: a curated `CREATIVE_PHRASES` list, checked
    before the generic topic+action loop, for phrasing that shares no vocabulary with an
    existing recipe signature. Wired to `improve_pacing` (all describe tightening/faster
    cuts, which is exactly what that recipe does, reusing its own aggressiveness-keyword
    extraction): "punchier"/"punchy", "tighten this/it up", "snappier", "build (the)
    energy". Deliberately left unmapped (falls through to `plan`, not forced onto the
    wrong op): "let it breathe"/"add some space" (opposite of every registered recipe —
    none add pacing room), "cut to the reaction"/"hold on her face" (needs shot-level
    content understanding, not a keyword match), "match the music" (beat-sync exists as a
    planned-edit capability, not a router recipe — nothing to route to without inventing
    one).
  - Docs: `plan/AGENT-NATIVE-COMPLETION-PLAN.md` P8.4 marked `[~]` (a)+(b) shipped, (c)
    Cmd+K keybinding open; P12.7's selection↔context bullet marked `[x]`; P13.2 marked
    `[~]` (first slice shipped, planner fluency for unmapped phrases open).
    `plan/FRAMEPILOT-AI-PRODUCT-PLAN.md` H1.5 bullet added.
  - Tests: `selectors.test.ts` (`selectionRange` — empty/single/multi-clip/cross-track/
    stale-id cases), `composerActions.test.ts` (chip omitted with no selection, chip
    shape + singular/plural label + rounding with one), `Composer.test.tsx` (context chips
    render + remove, empty state renders nothing), `AiSidebar.test.tsx` (selection threads
    into the request, `hasSelection` reaches the router, an explicitly removed chip is
    NOT sent for that turn), `router.test.ts` (each new creative phrase, aggressiveness
    param threading, the deliberately-unmapped phrases still route to `plan`).
    `pnpm --filter @framepilot/ai-sdk test/typecheck/lint` and
    `pnpm --filter @framepilot/web-editor test/typecheck/lint` green; `pnpm verify` green.
  - **P13.2 closure follow-up (2026-07-11, same day):** re-investigated the three
    deliberately-unmapped creative phrases (still zero new model dependency — router stays
    a deterministic matcher). Result: no new phrase mapped, but the docs above were
    partly wrong and are now corrected. **"match the music"** was reclassified — it
    already correctly falls through to `kind: 'plan'` and the Planner already _can_
    satisfy it via the existing beat-sync montage leaves (`kernel/montage-leaves.ts`,
    P3.1/P11.1); it was never a routing gap, only a documentation gap (previously implied
    "nothing to route to"). **"let it breathe"/"add some space"** and **"cut to the
    reaction"/"hold on her face"** are confirmed to stay permanently unmapped for
    different, precise reasons (not lumped together): the former needs a new "loosen
    pacing" recipe this codebase doesn't have (`synthPacingOps` only ever emits
    `ripple_delete`s and doesn't even read its `aggressiveness` param — verified by
    reading the leaf directly); the latter needs shot-level content understanding
    (Horizon 2, `FRAMEPILOT-AI-PRODUCT-PLAN.md` H2.1). `kernel/router.ts`'s
    `matchCreativePhrase` doc comment and `router.test.ts` updated accordingly. See
    `plan/AGENT-NATIVE-COMPLETION-PLAN.md` P13.2 (now `[x]`, closed for Horizon 1) for the
    full breakdown. `pnpm --filter @framepilot/ai-sdk test/typecheck/lint` green.

- [x] **H1.5c (second half) — Cmd+K command palette + point-react-refine clip trigger
      (complete 2026-07-11).** Closes the two "separate follow-ups" the first half of H1.5c
      explicitly deferred (AGENT-NATIVE P12.2's `Cmd+K` bullet, P13.3's point-react-refine
      bullet). The "@" pin-context picker for multiple pinned refs (P8.7 — shipped as a
      narrow slice in the H1.5c third-slice entry below) and preview-player point-clicking
      (scoping to a raw timecode rather than a clip, the other half of P13.3) remain
      separate follow-ups; the latter is still un-started.
  - `apps/web-editor/src/components/CommandPalette.tsx` (new): one shared palette UI/
    request path for two entry points. With an active selection, its free-text box sends
    the typed prompt as a scoped AI edit carrying the existing `selectionRange` through
    the exact `AiSidebar`/`runTurn` path the composer already uses — no parallel request
    path. Without a selection, it shows an honest hint ("Select a clip to scope your edit,
    or open the AI sidebar for a general request") plus a fallback action that opens/
    focuses the AI sidebar — it never silently no-ops. Arrow-key list navigation (Up/Down
    - Enter) was built directly here since no prior list-nav precedent existed to extract
      from (checked `ShortcutList.tsx`/`Menu.tsx`).
  - `apps/web-editor/src/editor/shortcuts.ts`: rebound `mod+k` — `edit.split`'s `keys` is
    now just `['s']`, and a new `ai.commandPalette` shortcut (group `'AI'`) owns `mod+k`.
  - `apps/web-editor/src/components/ai/AiSidebar.tsx`: added an imperative handle
    (`AiSidebarHandle.runQuickEdit`, via `forwardRef`/`useImperativeHandle`) so the palette
    (mounted in `Editor.tsx`) can fire a prompt into the same `runTurn` the sidebar's own
    composer submit button uses. Session/conversation continuity for follow-up refinement
    is not a new mechanism — it reuses the existing `active conversation ?? create new`
    logic in `runTurn`, so after a quick edit lands the user keeps refining in the
    now-visible sidebar composer against the same conversation.
  - `apps/web-editor/src/components/ClipContextMenu.tsx`: new "Ask AI about this clip"
    item — selects the clip, then opens the same palette pre-scoped to it (the
    point-react-refine trigger: click a clip → describe the problem → AI adjusts that
    moment).
  - `apps/web-editor/src/components/TimelineView.tsx`: threads the new `onAskAiForClip`
    prop from the context menu down to `Editor.tsx`.
  - `apps/web-editor/src/components/Editor.tsx`: owns palette open state, projects the
    current selection into the palette's scope, and queues/dispatches the quick edit.
  - `apps/web-editor/src/components/ShortcutList.tsx`: new `'AI'` group in the `?` help
    overlay for the rebound/new shortcuts.
  - `apps/web-editor/src/styles.css`: new `.command-palette*` rules reusing the existing
    `.overlay-backdrop` pattern.
  - Docs: `plan/AGENT-NATIVE-COMPLETION-PLAN.md` P12.2's `Cmd+K` bullet and P13.3 marked
    `[x]`/`[~]` shipped (clip-based trigger; preview-click point noted as deferred);
    `plan/FRAMEPILOT-AI-PRODUCT-PLAN.md` H1.5 bullet extended; `CHANGELOG.md`-equivalent
    customer-facing entry added under `apps/website/content/changelog`.
  - Tests: `CommandPalette.test.tsx`, `ClipContextMenu.test.tsx` (new); `shortcuts.test.ts`,
    `useShortcuts.test.tsx`, `AiSidebar.test.tsx` extended. `pnpm --filter
@framepilot/web-editor test/typecheck/lint` green (909 tests); `pnpm verify` green.

- [x] **H1.5c (third slice) — "@" pin-context picker, narrow slice (2026-07-11).** Closes
      the last item the two H1.5c halves above deferred as a "separate, un-started
      follow-up" (AGENT-NATIVE-COMPLETION-PLAN.md P8.7). Scoped narrow, as directed: an "@"
      query in the composer opens a searchable list of timeline clips + `project.assets`,
      letting the user pin additional clip/asset context items (beyond the auto-derived
      selection chip) as N independently-removable chips. **Deferred, not silently
      dropped:** `@range`/`@marker`/`@track` entity kinds — P8.7's full Cursor/Windsurf-style
      scope stays open for a later slice.
  - `packages/ai-sdk/src/context-builder.ts`: new `PinnedEntity` (`{kind: 'clip'|'asset',
id, label}`) and `ContextInput.pinned?: readonly PinnedEntity[]`; a new "Pinned
    context" prompt block (`summarizePinned`), surfaced only when non-empty (never
    claims context the model doesn't get). `packages/ai-sdk/src/reliability/types.ts`:
    new `pinned` tier in `CONTEXT_TIERS`, ranked just below `selection` (an explicit pin
    is high-priority, but the live selection still wins under budget pressure);
    `orchestrator.ts`'s `TIER_LABELS` extended for the honest trim notice.
  - `apps/web-editor/src/editor/ai.ts`: new `AiSessionInput.pinned?: readonly
PinnedEntity[]`, threaded by `BrowserAiSession` into the context object exactly like
    `selection`. **Browser-only, deliberately** — `DesktopAiSession` does not forward it
    over IPC yet (documented gap; natural home is the P6 cross-surface parity pass),
    same precedent as `selection`/`variations`/`planned-edit`.
  - `apps/web-editor/src/ai/composerActions.ts`: `pinnableEntities(project)` (every
    timeline clip + every `project.assets` entry, clip labels combining the source
    asset's filename with the clip's timeline range); `isAtQuery`/`filterAtEntities`/
    `removeAtQuery` mirror the existing `isSlashQuery`/`filterSlashCommands` pattern for
    a trailing `@query` token. `buildContextItems(project, selection?, pinned?)` gained
    the third param — one removable chip per pinned entity (`pin:<kind>:<id>`, kind
    `pinned-clip`/`pinned-asset`), architecturally free since `ContextItem` was already a
    flat, id-keyed array.
  - `apps/web-editor/src/components/ai/Composer.tsx`: new `atEntities`/`onPinEntity`
    props; typing `@query` opens a dropdown (reuses the slash-command palette's
    `.ai-slash` markup/styles — same interaction shape); picking an entity removes the
    `@query` token from the composer text and calls `onPinEntity`.
  - `apps/web-editor/src/components/ai/AiSidebar.tsx`: new `pinnedEntities` state (what
    the user has picked this conversation) and `atEntities = pinnableEntities(project)`
    memo; `sendPinned` filters out any pin the user explicitly removed from its chip
    THIS turn (same honesty rule as the pre-existing `sendSelection`) before it reaches
    `runInputFor`'s `pinned` field.
  - Docs: `plan/AGENT-NATIVE-COMPLETION-PLAN.md` P8.7 given a dated sub-bullet marking
    this narrow slice done (the full `@range`/`@marker`/`@track` scope stays `[ ]`);
    `plan/FRAMEPILOT-AI-PRODUCT-PLAN.md` H1.5 bullet's "not built here" list updated;
    `CHANGELOG.md` and `docs/guides/ai-sidebar.md` given a plain user-facing entry.
  - Tests: `composerActions.test.ts` (`isAtQuery`/`filterAtEntities`/`removeAtQuery`,
    `pinnableEntities` labelling, pinned chips merge into `buildContextItems` alongside
    the selection chip); `Composer.test.tsx` (`@` opens the picker, picking adds a chip
    and consumes the query token, bare `@` lists everything, Enter does not submit
    mid-query); `AiSidebar.test.tsx` (a picked pin threads into the request's `pinned`
    field, an explicitly-removed pin is NOT sent that turn — mirrors the existing
    selection-removal test); `context-builder.test.ts` ("Pinned context" block rendered/
    omitted, dropped just before `selection` under extreme budget pressure).
    `pnpm --filter @framepilot/ai-sdk test/typecheck/lint` (1105 tests) and `pnpm
--filter @framepilot/web-editor test/typecheck/lint` (964 tests) green.

- [x] **H1.5 — Variations / A-B compare, edit-mode slice (2026-07-11).** First slice of
      AGENT-NATIVE-COMPLETION-PLAN.md P13.1 ("give me N options"). Scoped to `edit` mode
      only — the one genuinely model-driven single-proposal path in this codebase (Cmd+K /
      the sidebar's "Edit" mode); recipe/planned-edit/agent runs are deterministic or
      already-converged single proposals, so "variations" of them would just be the
      identical result run twice — never offered there, by construction (the flag only
      reaches `streamEdit`, and only when the router's resolved mode is actually `edit`, not
      a mode the router downgraded to `recipe`).
  - `packages/ai-sdk/src/orchestrator.ts`: new `Orchestrator.editVariations(input, signal?)`
    — proposes `EDIT_VARIATION_COUNT` (2) independent candidates, each its OWN real
    `provider.complete()` call sampled at a different `temperature` (reuses the existing
    `AiCompletionRequest.temperature` knob every provider already accepts — no new
    sampling machinery), each turned into a patch through the exact same
    `assemble()`/`assembleEdit()` path a single `edit()` call uses. A candidate that
    calls no tool, or whose calls all fail to resolve to operations, contributes no
    variant (never a fabricated empty one); the run only comes back empty if EVERY
    candidate did. `streamEdit(input, options, { variations: true })` is the new opt-in
    third param (default `{}`, so every existing call site is unaffected); when set it
    delegates to a new private `streamEditVariations`, which is deliberately
    **non-streaming** under the hood — `AiProvider.stream()`'s terminal chunk has no
    channel for real token `usage` (only `complete()`'s `AiResponse.usage` does), and this
    feature's entire point is an honest **combined** cost across every candidate, so every
    candidate goes through `complete()`. The turn still reads as one coherent run: status →
    the first candidate's rationale + timeline-action cards (a preview of "Take A") → one
    `diff` event carrying every candidate via a new `variants` field → a `usage` event with
    the real summed cost → `completed`.
  - `packages/ai-sdk/src/events.ts`: `DiffEvent`/`DiffNode` gain an optional
    `variants?: readonly EditResult[]` (all candidates); `edit` always mirrors
    `variants[0]`, so every pre-existing single-proposal consumer is unaffected.
    `TurnEmitter.diff` takes an optional second `variants` arg.
  - `apps/web-editor/src/components/ai/EventNode.tsx`: `DiffCard` renders a Take A/B
    tab row (`role="tablist"`) only when `node.variants.length > 1`, tracking a local
    `selectedVariant` index that re-points the SAME `toReviewCard`/`AiReviewPlayer` at
    whichever candidate is selected — never N simultaneous player instances (per the
    task's explicit performance/simplicity guidance). Accept applies the **selected**
    candidate's `EditResult` (not always the primary); once a decision lands, the tabs
    are disabled and the decided-state message names which Take was applied and says
    the other was discarded — never left orphaned/pending.
  - `apps/web-editor/src/editor/ai.ts`: new `AiSessionInput.variations?: boolean`
    (edit-mode only); `BrowserAiSession` threads it into `streamEdit`'s options.
    **Desktop-deferred, deliberately**: `DesktopAiSession` does not forward it over the
    IPC contract yet (P6 cross-surface parity is the natural home for that) — never a
    silent drop, because the composer only shows the toggle without an Electron bridge.
  - `apps/web-editor/src/components/ai/AiSidebar.tsx`: new "Show 2 alternatives" toggle
    (mirrors the existing agent-mode "Plan first" toggle's pattern), visible only in Edit
    mode with no desktop bridge, **off by default**, its hint stating the cost
    implication up front ("doubles the real cost of this edit"). Gated into the request
    via `runMode === 'edit'` (the ROUTED mode, not just the user's selected mode) so a
    command the router downgrades to `recipe` never carries the flag even with the
    toggle on.
  - Docs: `plan/AGENT-NATIVE-COMPLETION-PLAN.md` P13.1 marked `[~]` (edit-mode slice
    shipped; desktop IPC + concurrent candidate calls + recipe/agent variations
    explicitly out of scope, documented); `plan/FRAMEPILOT-AI-PRODUCT-PLAN.md` H1.5
    bullet extended; `CHANGELOG.md` + a website changelog entry added.
  - Tests: `orchestrator-stream.test.ts` (`editVariations` + `streamEdit` variations —
    default-unaffected, real N-candidate proposal, combined real cost, honest-zero cost
    when no provider reports usage, dropping an empty candidate, all-empty failure,
    abort-to-cancelled); `EventNode.test.tsx` (single-candidate never shows a switcher,
    tab switching re-points the same card, accept applies the selected variant and
    discards the other unambiguously, decided state locks the tabs); `AiSidebar.test.tsx`
    (toggle edit-mode-only + off-by-default + threads `variations: true`, recipe-routed
    command never carries the flag even with the toggle on, toggle hidden on desktop).
    `pnpm --filter @framepilot/ai-sdk test/typecheck/lint` and `pnpm --filter
@framepilot/web-editor test/typecheck/lint` green; `pnpm verify` green.
  - **Deferred** (documented, not silently dropped): desktop IPC threading (P6);
    variations for recipe/planned-edit/agent modes (out of scope by design — see
    rationale above); concurrent/parallel candidate calls (this slice calls candidates
    sequentially — real, distinct, honestly-costed calls with much simpler code;
    "visibly concurrent" is P8's separate concern).

- [x] **H1.2 — Speed / time-remap, schema v6 slice (schema + patch engine only,
      complete 2026-07-10).** Second of five H1 schema bumps (v5–v9)
      (`plan/FRAMEPILOT-AI-PRODUCT-PLAN.md` C5, WS-C, H1.2). Foundation-layer only,
      per build order — Python render engine, AI tool, and editor UI wiring are
      separate follow-ups.
  - `timeline-schema`: `SCHEMA_VERSION` → **6**. New optional `Clip.speed`
    (`z.number().positive()`) — a **constant** playback rate (not a curve; see
    ADR 0046 for why a curve was deferred). Absent/`1` is today's unchanged
    1:1 timeline/source-duration behavior. Invariant:
    `end - start === (sourceEnd - sourceStart) / speed` — `sourceStart`/
    `sourceEnd` keep meaning "the asset range consumed"; `end` is derived.
    Additive v5→v6 migration (`migrate: (raw) => raw`).
    `schema/project.schema.json` regenerated.
  - `editor-core`: new reversible op `set_clip_speed` (`clipId`,
    `speed: number | null`, `null` resets to 1x) — recomputes `end` from the
    clip's (untouched) source range and the new speed; `1x` canonicalized as
    an _absent_ `speed` field (mirrors `set_track_flags`'s "off ≡ absent").
    Same-shape exact inverse (mirrors `set_caption_style`/`set_track_flags`):
    restoring the prior speed deterministically restores the prior `end` too
    (no separate start/end restore needed). Defensive `OperationError
('invalid_speed', …)` for non-positive/non-finite input.
    **Ripple-vs-isolated:** scoped to the target clip only (no downstream
    ripple), matching `trim_clip`'s convention — an overlap this creates is
    caught by the existing `overlap_error` check, same as a manual trim.
  - `validator`: new whole-timeline `speed_duration_mismatch` check (runs
    after every op, alongside `overlapChecks`/`transitionOverlapChecks`) that
    rejects ANY clip whose `start`/`end`/`sourceStart`/`sourceEnd`/`speed`
    disagree with the invariant above — not just clips touched by
    `set_clip_speed`. New `invalid_speed`/`speed_duration_mismatch`
    `ValidationCode`s; `set_clip_speed` registered in `SUPPORTED_OPERATIONS`.
  - **Known limitation (documented, not silent):** `trim_clip`/`split_clip`/
    `delete_range`/`ripple_delete` still map timeline deltas onto the source
    range 1:1, unaware of `speed` — trimming an already-sped-up clip can
    violate the invariant and be rejected by the validator. Out of scope for
    this schema-only slice; a real UI need for trimming sped clips is the
    natural trigger for that follow-up.
  - Tests: `timeline-schema` migration test (v5→v6, additive, existing clip
    untouched) + speed parse/reject-non-positive tests; `editor-core`
    apply/invert round-trip (2x, 0.5x, reset via `null` and via `speed: 1`),
    missing-clip-id, and invalid-speed (zero/negative/non-finite) tests for
    `set_clip_speed`; validator tests for `invalid_speed` and a hand-crafted
    `speed_duration_mismatch` clip (injected via `restore_clips`, proving the
    check isn't limited to `set_clip_speed`-produced clips). `pnpm --filter
@framepilot/timeline-schema test/typecheck/lint` and `pnpm --filter
@framepilot/editor-core test/typecheck/lint` green; 100% branch/line/func
    coverage maintained on `editor-core` (`operations.ts`/`validator.ts`).
  - **Known gap, now closed (see H1.2b below):** `engine/python/tests/test_schema_parity.py`
    reported a `Clip` field mismatch until the Python Pydantic model gained
    `speed` in the engine follow-up (render support — MoviePy time-remap).
  - See ADR 0046.

- [x] **H1.2b — Speed / time-remap, Python render engine (complete 2026-07-10).**
      Closes the engine gap H1.2 flagged: the render engine now actually applies
      `Clip.speed`, not just parses it.
  - `framepilot_engine/timeline/models.py`: `Clip.speed: float | None` added
    (mirrors `caption_style`'s alias convention from ADR 0045/H1.1);
    `SCHEMA_VERSION` bumped to **6**. `test_schema_parity.py` green again.
  - `framepilot_engine/render/compiler.py`: new `_apply_speed()` helper applies
    MoviePy 2.x's `vfx.MultiplySpeed(factor=speed)` (via `with_effects`; there
    is no `.fx()`/`speedx` in this codebase's installed MoviePy 2.x) to a
    clip's subclipped source **before** it is placed/split, for both
    picture-kind (video) and standalone audio-kind clips — stills have no time
    dimension so are unaffected. `MultiplySpeed` threads the same remap
    through attached audio/mask automatically (`apply_to=["mask","audio"]`).
  - **Pitch-shift decision (documented, not silent):** sped-up/slowed-down
    audio pitch-shifts (time-domain resampling only) — no pitch-preserving
    time-stretch exists in `framepilot_engine/audio/mixing.py`, and building
    one is out of scope for this slice. Accepted as an honest MVP limitation
    (ADR 0046 addendum).
  - **Render-time invariant enforcement:** `_apply_speed` defensively checks
    the remapped duration against the clip's timeline span (small
    frame-accuracy tolerance, mirroring `_subclipped_source`'s existing
    slack) and raises `CompileError` — loud, typed — rather than silently
    drifting if the schema validator's invariant is ever violated at render
    time (e.g. a hand-crafted project file).
  - Tests (`tests/test_render_compiler.py`): 2x-speed time-compression, 0.5x
    slow-mo time-stretch, a standalone audio-clip speed case, a
    duration-mismatch → `CompileError` case, and an unset-speed regression
    case (byte-for-byte-equivalent duration/behavior to pre-H1.2b).
  - `pnpm engine:test` (581 passed), `engine:lint`, `engine:typecheck` all
    green.
  - **Still out of scope, tracked as a separate follow-up:** no editor UI
    exposes `speed`/`set_clip_speed` yet (H1.2i — the "H1.2h" label used here
    originally was later claimed by the markers/chapters follow-up; see
    H1.2i below); nothing is user-reachable from schema+engine alone.
  - See ADR 0046 addendum.

- [x] **H1.2c — Crop rect, schema v7 slice (schema + patch engine only, complete
      2026-07-10).** Third of five H1 schema bumps (v5–v9)
      (`plan/FRAMEPILOT-AI-PRODUCT-PLAN.md` C6, WS-C, H1.2). Foundation-layer
      only, per build order — Python render engine, AI tool, and editor UI wiring
      are separate follow-ups (mirrors H1.2/H1.2b's split).
  - **Precedent check (per task instructions):** `Clip` has no `transform`
    field — the plan's "transform" is `Clip.keyframes` (a curve), not a
    static rect. The relevant precedent is masking: `AddMaskOp.bounds`/
    `TrackObjectOp.region` already use `MaskBounds { x, y, width, height }` as
    frame fractions (0..1), stored in effect `params` (no schema field).
    Crop is promoted to a real `Clip` field — like `captionStyle`/`speed`
    before it — because it's a single static rect (not an effects family)
    that both renderer and editor UI need typed access to.
  - `timeline-schema`: `SCHEMA_VERSION` → **7**. New `CropRectSchema`
    (`x`/`y`/`width`/`height`, fractions 0..1 of the **source** frame —
    matches `MaskBounds`'s existing convention), with its own `.refine()`s
    rejecting an out-of-bounds rect (`x + width <= 1`, `y + height <= 1`) and
    non-positive width/height. New optional `Clip.crop: CropRectSchema`.
    Absent = uncropped (today's unchanged full-source-frame behavior).
    Additive v6→v7 migration (`migrate: (raw) => raw`).
    `schema/project.schema.json` regenerated.
  - `editor-core`: new reversible op `set_clip_crop` (`clipId`,
    `crop: CropRect | null`, `null` clears back to uncropped) — same-shape,
    exact inverse (mirrors `set_caption_style`/`set_clip_speed`): restores
    the clip's prior crop wholesale. Defensive `OperationError('invalid_crop',
…)` re-validates against `CropRectSchema` before apply (out-of-
    bounds/zero/negative rect rejected even if a hand-built op bypasses the
    validator).
  - `validator`: new `invalid_crop` `ValidationCode`, mapped from
    `OperationError`'s `invalid_crop`; `set_clip_crop` registered in
    `SUPPORTED_OPERATIONS`. No new whole-timeline consistency check needed
    (unlike v6's `speed_duration_mismatch`) — crop has no relationship to
    `start`/`end`/`sourceStart`/`sourceEnd` to go stale against.
  - Tests: `timeline-schema` migration test (v6→v7, additive, existing clip
    untouched) + crop parse/reject-out-of-bounds/reject-non-positive tests
    (all prior migration tests' expected `appliedTo`/`schemaVersion` bumped to
    include the new v6→v7 step); `editor-core` apply/invert round-trip (set,
    replace, reset via `null`), missing-clip-id, and invalid-crop
    (out-of-bounds/zero-width/negative-height) tests for `set_clip_crop`;
    validator tests for `missing_reference`/`invalid_crop` and an accepting
    set+clear patch. `pnpm --filter @framepilot/timeline-schema
test/typecheck/lint` and `pnpm --filter @framepilot/editor-core
test/typecheck/lint` green; 100% branch/line/func coverage maintained on
    `editor-core` (`operations.ts`/`validator.ts`).
  - **Known gap (not silent):** `engine/python/tests/test_schema_parity.py`
    will report a `Clip` field mismatch until the Python Pydantic model gains
    `crop` in an engine follow-up (render support — actually cropping the
    frame). Python engine, AI tool registry, and editor UI are explicitly out
    of scope for this commit, per this task's explicit instruction.
  - See ADR 0047.

- [x] **H1.2d — Crop rect, Python render engine (complete 2026-07-10).** Closes
      the engine gap H1.2c flagged: the render engine now actually crops the
      source frame, mirroring H1.2b's speed follow-up.
  - `timeline/models.py`: new `CropRect` model (`x`/`y`/`width`/`height`,
    field-for-field matching `MaskBounds`'s existing frame-fraction
    convention; defined here rather than imported from `operations.py` to
    avoid a circular import). New optional `Clip.crop: CropRect | None`.
    `SCHEMA_VERSION` → **7** (now matches the TS source of truth).
  - `render/compiler.py`: new `_apply_crop`, converting the fractional rect to
    pixels against the **source** clip's actual resolution and applying
    MoviePy's `vfx.Crop(x1, y1, x2, y2)`. Runs immediately after subclipping,
    before speed/color-grade/mask/transition/letterbox placement — the
    standard crop-then-fit order, and the only order under which
    `_place_video_clip`'s letterbox scale and `_attach_mask`'s rasterized
    geometry (both read off `source.size`) agree with what the crop leaves on
    screen.
  - Tests (`tests/test_render_compiler.py`): a split-color (left red / right
    blue) fixture proves a crop over the right half renders only blue; a
    second case combines that crop with an existing `scale` keyframe to prove
    crop composes with transform keyframes rather than being overridden; a
    regression test proves an uncropped clip still renders deterministically
    unchanged. No redundant out-of-range-crop test was added on the engine
    side — that is already rejected by the TS/Pydantic schema layer, and the
    engine trusts pre-validated input here exactly as it already does for
    `Clip.speed` and `MaskBounds`.
  - `pnpm engine:test` (584 passed), `pnpm engine:lint`, `pnpm
engine:typecheck` all green; `test_schema_parity.py` no longer reports the
    `Clip` field mismatch H1.2c flagged.
  - See ADR 0047 addendum.

- [x] **H1.2e — Blend mode, schema v8 slice (schema + patch engine only,
      complete 2026-07-10).** Fourth of five H1 schema bumps (v5–v9)
      (`plan/FRAMEPILOT-AI-PRODUCT-PLAN.md` C8, WS-C, H1.2). Foundation-layer
      only, per build order — Python render engine, AI tool, and editor UI wiring
      are separate follow-ups (mirrors H1.2c/H1.2d's split).
  - `timeline-schema`: `SCHEMA_VERSION` → **8**. New `BlendModeSchema`, a
    12-mode enum (`normal`/`multiply`/`screen`/`overlay`/`darken`/`lighten`/
    `color-dodge`/`color-burn`/`hard-light`/`soft-light`/`difference`/
    `exclusion`) chosen as the subset expressible as simple per-channel
    arithmetic (what Pillow/NumPy can realistically composite without a
    colorspace conversion) — the non-separable CSS modes (`hue`/`saturation`/
    `color`/`luminosity`) are deliberately excluded. New optional
    `Clip.blendMode: BlendModeSchema`. Absent (or `'normal'`) = today's
    unchanged alpha-over compositing. Meaningful only on clips with something
    composited beneath them (e.g. an `overlay`-track clip) — documented, not
    schema-enforced (mirrors `crop`'s scoping note). Additive v7→v8 migration
    (`migrate: (raw) => raw`). `schema/project.schema.json` regenerated.
  - `editor-core`: new reversible op `set_clip_blend_mode` (`clipId`,
    `blendMode: BlendMode | null`, `null` resets to `'normal'`/default) —
    same-shape, exact inverse (mirrors `set_clip_crop`/`set_clip_speed`):
    restores the clip's prior blend mode wholesale; `'normal'`/`null` both
    canonicalize to _absent_ (mirrors `set_track_flags`/`set_clip_speed`'s
    "off ≡ absent" convention). Defensive `OperationError('invalid_blend_mode',
…)` re-validates against `BlendModeSchema` before apply.
  - `validator`: new `invalid_blend_mode` `ValidationCode`, mapped from
    `OperationError`'s `invalid_blend_mode`; `set_clip_blend_mode` registered
    in `SUPPORTED_OPERATIONS`. No new whole-timeline consistency check needed
    (unlike v6's `speed_duration_mismatch`) — blend mode has no relationship
    to any other clip field to go stale against.
  - Tests: `timeline-schema` migration test (v7→v8, additive, existing clip
    untouched) + blendMode parse/reject-unknown-string tests (all prior
    migration tests' expected `appliedTo`/`schemaVersion` bumped to include
    the new v7→v8 step); `editor-core` apply/invert round-trip (set, replace,
    reset via `null`, explicit `'normal'` canonicalized to absent),
    missing-clip-id, and invalid-blend-mode tests for `set_clip_blend_mode`;
    validator tests for `missing_reference`/`invalid_blend_mode` and an
    accepting set+clear patch. `pnpm --filter @framepilot/timeline-schema
test/typecheck/lint` and `pnpm --filter @framepilot/editor-core
test/typecheck/lint` green; 100% branch/line/func coverage maintained on
    `editor-core` (`operations.ts`/`validator.ts`).
  - **Known gap (not silent):** `engine/python/tests/test_schema_parity.py`
    will report a `Clip` field mismatch until the Python Pydantic model gains
    `blend_mode` in an engine follow-up (render support — actually
    compositing the blend mode via Pillow/NumPy). That follow-up is also
    where the 12-mode enum would be trimmed if any mode proves impractical to
    render correctly, per this task's explicit instruction. Python engine, AI
    tool registry, and editor UI are explicitly out of scope for this commit.
  - See ADR 0048.

- [x] **H1.2f — Blend mode, Python render engine (complete 2026-07-10).**
      Closes the engine gap H1.2e flagged: the render engine now actually
      composites `Clip.blend_mode`, mirroring H1.2b/H1.2d's speed/crop follow-ups.
  - `timeline/models.py`: new `BlendMode` `StrEnum` (field-for-field mirror of
    the TS `BlendModeSchema`'s 12 modes) and optional `Clip.blend_mode:
BlendMode | None` (alias `blendMode`). `SCHEMA_VERSION` → **8** (now
    matches the TS source of truth; `test_schema_parity.py` green again).
  - `render/blend.py` (new): per-channel NumPy formulas for all eleven
    non-`'normal'` modes — `multiply`/`screen`/`darken`/`lighten` (direct
    min/max/product/complement), `overlay`/`hard-light` (the same piecewise
    expression, discriminating on the blend vs. base layer respectively),
    `color-dodge`/`color-burn` (divide-guarded at the 0/1 boundary),
    `soft-light` (standard W3C compositing-1 formula), `difference`/
    `exclusion`. All vectorized, no per-pixel Python loop.
  - `render/compiler.py`: picture layers now carry their clip's `blend_mode`
    alongside the placed MoviePy clip. When every layer is `'normal'`/absent
    (the common case), compositing takes the **original, untouched**
    single-`CompositeVideoClip` path — guaranteeing byte-identical output to
    every pre-v8 render. Only when at least one layer sets a real blend mode
    does the new `_composite_with_blend_modes`/`_blend_layer_over` progressive
    fold run: each layer either joins the running composite the plain
    alpha-over way or is blended onto it (base = everything composited so
    far, blend = the clip's own picture — see ADR 0048's addendum for the
    z-order reasoning), still respecting the clip's own alpha
    (`result = base*(1-alpha) + blended*alpha`). A clip with nothing beneath
    it (sole clip on a base track) is a true no-op, not a crash.
  - Tests: `tests/test_render_blend.py` (new) hand-checks the pure formulas
    (multiply/screen/difference/exclusion/overlay/hard-light/darken/lighten/
    color-dodge/color-burn boundary cases/soft-light, plus a schema-coverage
    guard that every non-`'normal'` `BlendMode` has a formula).
    `tests/test_render_compiler.py` adds hand-computed-pixel integration tests
    for multiply/screen/difference/darken against an exact-RGB two-clip
    composite, a `'normal'`-vs-absent byte-identical regression guard, and a
    base-track-clip-with-blend-mode no-op/no-crash test.
  - `pnpm engine:test` (601 passed), `pnpm engine:lint`, `pnpm
engine:typecheck` all green; `test_schema_parity.py` no longer reports the
    `Clip` field mismatch H1.2e flagged.
  - **Known limitation (documented, not fixed this slice):** feathered mask
    edges / mid-fade-transition frames can see a subtle double-attenuation at
    fractional alpha (full clips and alpha-0/1 pixels are unaffected) — see
    ADR 0048 addendum's "Known limitation" note.
  - See ADR 0048 addendum.

- [x] **H1.2g — Markers/chapters, schema v9 slice (schema + patch engine only,
      complete 2026-07-11).** Fifth and last of five H1 schema bumps (v5–v9)
      (`plan/FRAMEPILOT-AI-PRODUCT-PLAN.md` C21, WS-C, H1.2). Foundation-layer
      only, per build order — Python render engine, AI tool, and editor UI wiring
      (the existing preview-only `EditorState.markers`/`toggleMarker`/
      `TimelineView.tsx` marker ticks) are separate follow-ups (mirrors
      H1.2c/H1.2e's split).
  - `timeline-schema`: `SCHEMA_VERSION` → **9**. New `MarkerSchema`
    (`id`, `time: number.nonnegative()`, optional `label`/`color`) — one
    shape covers both a bare "marker" and a labeled "chapter" (see ADR 0049
    for why two parallel concepts weren't introduced). New
    `Project.markers: MarkerSchema[]` (project-scoped, sibling to
    `Project.transcript` — a marker is a global timeline position, not a
    per-clip/per-track attribute). Additive v8→v9 migration
    (`migrate: (raw) => raw`). `schema/project.schema.json` regenerated.
  - `editor-core` (`project-operations.ts`, alongside `add_asset`/
    `create_folder`): new project-scoped ops `add_marker` (flat `id`/`time`/
    `label?`/`color?`) and `remove_marker` (`id`). Granular pair, not a
    whole-array `set_markers` replace — matches the real user action ("press
    M" adds one marker). `add_marker`'s inverse is `remove_marker` (exact,
    lossless); `remove_marker`'s inverse is `add_marker` re-carrying the
    removed marker's own snapshotted fields (not a `restore_markers`
    whole-list primitive — a marker has no downstream reference for a
    partial re-insert to endanger, unlike assets/folders). Re-added markers
    land at the end of the array (no order semantic; documented, tested as a
    set-equality roundtrip).
  - `validator`: new `ValidationCode`s `duplicate_marker`/`missing_marker`/
    `invalid_marker_time`; new `ValidateOptions.markers` context (same
    "can't prove it, don't block it" stance as `assetIds`/`folders`).
    `add_marker`/`remove_marker` registered in `PROJECT_OPERATION_TYPES`.
  - Tests: `timeline-schema` migration test (v8→v9, additive) + all prior
    migration tests' expected `appliedTo`/`schemaVersion` bumped to include
    the new v8→v9 step; `editor-core` apply/invert round-trip (add, remove,
    remove-of-a-bare/labeled/colored marker, exact-order roundtrip for the
    last-in-array case), duplicate-id-rejected, negative/non-finite-time-
    rejected, remove-nonexistent-rejected, and validator tests for
    `duplicate_marker`/`missing_marker`/`invalid_marker_time` plus a
    working-state-advance test (create+remove+recreate the same id within one
    patch). `pnpm --filter @framepilot/timeline-schema test/typecheck/lint`
    and `pnpm --filter @framepilot/editor-core test/typecheck/lint` green;
    100% branch/line/func coverage maintained on `editor-core`
    (`project-operations.ts`/`validator.ts`).
  - `apps/web-editor/src/editor/store.ts`'s `PLACEHOLDER_META` (a pre-existing
    placeholder `Project` view for the patch engine, already stubbing
    `transcript`/`aiMemory`/`history`) gained `markers: []` — a mechanical
    fix so the package still typechecks against the new required field, not a
    wiring of the markers feature (`toggleMarker`/`EditorState.markers`/
    `TimelineView.tsx` are untouched, per this task's explicit scope).
  - **Known gap (not silent):** `engine/python/tests/test_schema_parity.py`
    will report a `Project` field mismatch until the Python Pydantic model
    gains `markers: list[Marker]` in an engine follow-up, which is also where
    `add_marker`/`remove_marker` should be mirrored to
    `timeline/operations.py` and the AI tool registry, and where the web
    editor's marker UI should finally persist through the validate→apply→
    record pipeline instead of local component state. Python engine, AI tool
    registry, and editor UI wiring are explicitly out of scope for this
    commit.
  - See ADR 0049.

- [x] **H1.2h — Markers/chapters, Python parity + UI persistence (complete
      2026-07-11).** Closes the two gaps H1.2g flagged, mirroring the
      H1.2b/H1.2d/H1.2f engine-follow-up pattern (Python parity) plus, uniquely
      among the five H1.2 schema slices, the UI wiring (markers had no prior
      editor-UI feature at all to leave untouched, unlike speed/crop/blend which
      already had render-only UI gaps).
  - **Python schema parity:** `engine/python/.../timeline/models.py` gained a
    `Marker` Pydantic model (`id`, `time: float`, optional `label`/`color`) and
    `Project.markers: list[Marker]`; `SCHEMA_VERSION` 8→9.
    `test_schema_parity.py` green; `pnpm engine:test`/`engine:lint`/
    `engine:typecheck` all green (601 tests).
  - **UI persistence (the actual point of this slice):** `EditorState.markers`
    (`apps/web-editor/src/editor/store.ts`) is now `readonly Marker[]` sourced
    from `project.markers` (`Editor.tsx` passes it into `useEditor`), carried
    through `toProject`/`applyUserPatch`/`undoEdit`/`redoEdit` exactly like
    `assets`/`folders`, and lifted back into the saved `Project` alongside the
    timeline. The old local-only `store.ts#toggleMarker` is deleted; a new
    `patch-builders.ts#toggleMarkerPatch` (built on `findNearbyMarker`, same
    epsilon as the old toggle, and `addMarkerPatch`/`removeMarkerPatch`)
    resolves the "M" toggle into a real `add_marker`/`remove_marker` patch, so
    the existing "M" key / toolbar button / `shortcuts.ts` call sites are
    **unchanged** — only `useEditor.ts#toggleMarker`'s internals moved from a
    reducer-local mutation to `dispatch({type:'apply', patch})`. New marker ids
    use `nextMarkerId()` (`marker_<Date.now().toString(36)>_<counter>`),
    mirroring `MediaBin.tsx`'s `nextFolderId` convention (not a UUID),
    consistent with `createFolderPatch`'s caller-supplied-id shape.
    `TimelineView.tsx`'s marker ticks now render real `Marker[]` (id-keyed),
    show a labeled marker's title as a tooltip, and tint by `color`;
    `snapTargets`/`adjacentMarker` (which take `number[]`) are fed
    `markers.map(m => m.time)` at their two call sites, unchanged otherwise.
  - **Deferred, documented (not silent):** a click-to-rename affordance
    (promoting a marker to a titled chapter after creation) is real UI work
    beyond this slice's acceptance bar ("markers/chapters persist and appear
    on the timeline") — `removeMarkerPatch` + `addMarkerPatch` with a label
    already composes a rename losslessly today (two ops instead of one).
    Auto-chapter generation from the transcript is a separate AI-tool
    follow-up, untouched.
  - Tests: `patch-builders.test.ts` (add/remove op shape, `findNearbyMarker`
    epsilon, `toggleMarkerPatch` add/remove/negative-no-op, store round-trip
    add→undo→redo, remove→undo, validator-rejection-of-unknown-remove);
    `store.test.ts`/`shortcuts.test.ts` updated for the `Marker[]` shape (no
    more bare-number markers); `panels.test.tsx` (labeled marker tick renders
    a title/color tooltip); `Editor.test.tsx` (marker persists into the lifted
    `project.markers`, undo/redo round-trips it, "M" still toggles it off).
    `pnpm --filter @framepilot/web-editor test/typecheck/lint` green (856
    tests, +2 web-editor test files' worth of new cases); full `pnpm verify`
    green (web-editor 856, editor-core 252, timeline-schema 49, engine 601).
  - See ADR 0049 ("Follow-up closed" addendum).

- [x] **H1.2i — Speed / crop / blend mode, web-editor Inspector UI (complete
      2026-07-11).** Closes the last of the three H1.2 UI gaps H1.2b/H1.2d/H1.2f
      each flagged (`Clip.speed`/`Clip.crop`/`Clip.blendMode` were schema+engine
      complete but had no editor UI). Note: H1.2b's own text originally forward-
      referenced this slice as "H1.2h", but that label was claimed first by the
      markers/chapters follow-up above — this is that same deferred slice under
      its corrected number.
  - `apps/web-editor/src/editor/patch-builders.ts`: three new builders
    mirroring `setCaptionStylePatch`'s shape exactly — `setClipSpeedPatch`
    (clip-exists + finite-positive guard, `null` resets), `setClipCropPatch`
    (clip-exists + finite-fields guard, `null` clears), `setClipBlendModePatch`
    (clip-exists guard, `null` resets to `'normal'`) — thin wrappers around
    `set_clip_speed`/`set_clip_crop`/`set_clip_blend_mode`, each a single
    reversible patch with a deterministic id.
  - `apps/web-editor/src/editor/selectors.ts`: pure helpers alongside the
    existing `colorGradeParams`/`colorGradeCssFilter` pattern —
    `clipSpeed`/`clipCropRect`/`clipBlendMode` (read the clip field, default
    when unset), `FULL_FRAME_CROP`, `isFullFrameCrop`, `BLEND_MODES` (the 12
    engine values), and `cropClipPath` (an approximate CSS `clip-path` for the
    live preview — see below).
  - **Inspector UI** (`apps/web-editor/src/components/Inspector.tsx`, the
    per-clip property panel — not `EffectsPanel.tsx`, which is the effects
    _catalogue_; `EffectsPanel`'s existing color-grade/transition tiles apply
    through the same patch-builder convention but are a different panel):
    new `SpeedPanel` (preset chips + a custom scrub, "Apply"/"Reset speed"),
    `CropPanel` (x/y/width/height numeric scrubs, "Apply"/"Reset crop"), and
    `BlendModePanel` (a 12-option dropdown). Each is seeded from the selected
    clip's current value and re-mounted per clip (`key={clip.id}-*`, matching
    `ColorPanel`/`AudioPanel`), and each is absent entirely (not merely
    disabled) when nothing is selected, matching the Inspector's existing
    empty-state convention.
  - **Apply-on-change convention (deliberately mixed, per the panel's own
    precedent):** Speed and Crop use an explicit "Apply" button — the
    dominant convention in this Inspector for multi-field numeric edits
    (`ColorPanel`, `AudioPanel`, `TransitionPanel`'s duration). Blend mode
    applies instantly on selection — mirroring `TransitionPanel`'s kind-swap
    dropdown, the established convention for a single persisted enum choice.
    This is not a new UX pattern; it picks the existing convention that
    already matches each control's shape.
  - **Crop UI scope decision (documented, not silent):** shipped as numeric
    x/y/width/height inputs, not an on-canvas drag gizmo.
    `PreviewTransform.tsx`'s handle machinery (reused by the H4 on-canvas
    transform) is built for single-point uniform scale/translate around a
    center, not an independent 4-edge/2-corner rect with asymmetric resize —
    reusing its gesture _pattern_ (ref-based drag state, preview-then-commit-
    on-release) for a proper crop gizmo is a real follow-up, tracked here, not
    a drop-in extension. The numeric version is fully functional today (same
    reversible patch either control would produce), meeting the "user-
    reachable" bar this slice targets.
  - **Preview approximation decision:** `PreviewPlayer.tsx` now applies
    `mixBlendMode`/`clip-path` CSS to the active video/image element for a
    rough live blend/crop preview (native browser primitives approximating
    the engine's real composite/crop, per the render-vs-preview invariant —
    the deterministic result stays the Python render). The crop `clip-path` is
    a mask-in-place, not a zoom-to-fill — an honestly rough approximation
    documented in `cropClipPath`'s doc comment. **Speed preview is explicitly
    deferred**, not wired: the monitor's master playback clock
    (`PreviewPlayer.tsx`'s `tick` loop) maps the front `<video>` element's own
    `currentTime` 1:1 onto timeline time; naively setting `playbackRate` alone
    would desync that mapping and could cut early/late, and this clock has no
    unit-test coverage (explicitly `v8-ignore`d as e2e-only per its own
    comments) — too much correctness risk to touch without a way to verify it
    here. The committed patch and the actual Python render are unaffected;
    only the live scrub/playback preview does not yet visually speed up.
  - Tests: `patch-builders.test.ts` (op shape, apply+undo+redo back to
    default, null-clears-to-default, missing-clip/invalid-value → `null`, one
    `describe` block per builder, mirroring `setCaptionStylePatch`'s);
    `panels.test.tsx` (`Inspector speed/crop/blend mode` — absent without a
    selection, preset+scrub+Apply+Reset round-trip for speed, scrub+Apply
    round-trip for crop, instant-commit-no-Apply-button for blend mode).
    `pnpm --filter @framepilot/web-editor test` (873 tests, all green),
    `typecheck`, and `lint` all green.

- [x] **H1.2j — Speed / crop / blend mode / markers / animated captions, AI tool
      registry exposure (complete 2026-07-11).** Closes the last open gap H1.2/c/e/g
      each flagged as out-of-scope: `set_clip_speed`, `set_clip_crop`,
      `set_clip_blend_mode`, `set_caption_style` (animated-caption highlight), and the
      `add_marker`/`remove_marker` pair were schema+engine+editor-UI complete but had
      **no AI tool**, so the agent could reach every one of these edits only through
      direct manipulation — never via chat/agent mode.
  - `packages/ai-sdk/src/tool-registry.ts`: six new `mutateTool`/`projectMutateTool`
    entries, each reusing the schema package's own Zod schema for its rich value
    (`CaptionStyleSchema`, `CropRectSchema`, `BlendModeSchema`) so the tool argument
    can never drift from the persisted data model — a `null` clears back to
    unstyled/default on every one, mirroring the existing `set_track_flags`
    convention. `add_marker` derives a deterministic id from `time`+`label` when
    none is supplied (idempotent re-issue).
  - **Scope categories (K6.2), thought through rather than left at kind defaults:**
    each tool declares `capabilities` beyond the bare `mutate` default —
    `captions`, `timing`, `reframe`, `compositing`, `markers` — so a scoped prompt
    (`selectTools`/`scopedToolDescriptors`, `tool-scope.ts`) can target "the
    captioning tools" or "the reframe tools" without the caller needing to
    enumerate tool names, and so the registry stays flat-prompt-safe (§6.2) as it
    grows past 100 tools.
  - `packages/mcp-server`: no code change needed — its tool surface is auto-derived
    from `TOOL_REGISTRY` (parity-tested), so all six are exposed to external MCP
    clients (Claude Desktop etc.) for free.
  - **UI-surface gap found and closed in the same slice:** `apps/web-editor`'s AI
    activity-card tool→icon/label map (`components/ai/toolMeta.ts`) has an
    exhaustiveness test asserting every `TOOL_REGISTRY` tool is mapped (no silent
    generic-icon fallback) — the six new tools tripped it. Added entries (`Gauge`
    for speed, `Crop` for crop, `Layers` for blend mode, `Flag` for markers,
    reusing `Captions` for caption styling) plus the three new `lucide-react`
    re-exports in `components/icons.tsx`.
  - Tests: `tool-registry.test.ts` (arg validation incl. the reused nested Zod
    schemas' own rejections, patch-validator round-trip, capability/`mutates`
    assertions) and `tool-scope.test.ts` cover the scoping; `toolMeta.test.ts`
    covers the UI map. `pnpm verify` green (ai-sdk 1131 tests, web-editor 964
    tests, engine 617 tests).
  - **Also, this slice (repo-wide):** added an explicit **logging** working rule
    to `AGENTS.md` §7 and `CLAUDE.md` §2 — new/touched modules that do anything
    worth tracing must log through the shared scoped logger (`createLogger` from
    `@framepilot/shared-types` in TS, `logging.getLogger` in Python), not a bare
    `console.log`/`print`, so a live session stays greppable/attributable.

- [x] **H1.3a — Wire the async render queue to HTTP (engine only, complete
      2026-07-11).** `POST /render` (final export) used to run synchronously and
      block the HTTP request until FFmpeg finished, returning `200` with the
      completed/failed `RenderJob`. It now submits to the already-tested
      `RenderQueue` (`engine/python/framepilot_engine/render/queue.py`,
      `test_render_queue.py` — built in a prior slice but never wired to HTTP) and
      returns `202` immediately with `{ "jobId": "...", "status": "queued" }`
      (`RenderAcceptedResponse`). Two new routes: `GET /render/jobs/{job_id}`
      (poll status/result; `result` is the same `RenderJob` shape the old
      synchronous response used) and `POST /render/jobs/{job_id}/cancel`
      (idempotent no-op if already terminal; `404` if unknown). Real mid-encode
      cancellation (PRD §18.3) is now possible over HTTP. `POST /render/preview`
      is unchanged and deliberately stays synchronous — previews are downscaled/
      short and callers want an immediate result. See ADR 0050 and
      `docs/api/python-engine-api.md`.
  - **Known gap, not yet closed (H1.3b, next slice):** `apps/desktop`'s
    `render/export-client.ts` and `apps/web-editor` still expect the old
    synchronous `200`+`RenderJob` contract and were not touched here — they
    will now get a `202`+`jobId` body they don't yet know how to poll.
    Wiring the export dialog UI (and web-editor's equivalent) to submit,
    poll, show progress from, and cancel against the new contract is tracked
    as **H1.3b**, mirroring how H1.2's schema→engine→UI slices were each
    shipped and honestly flagged as not-yet-end-to-end until the next slice
    landed.
  - Tests: engine-side `RenderQueue` coverage is unchanged (pre-existing,
    `test_render_queue.py`); route-level behavior exercised via the sidecar's
    existing FastAPI test suite. `pnpm engine:test`, `pnpm engine:typecheck`,
    `pnpm engine:lint` green.

- [x] **H1.3b — Desktop/web-editor consumption of the async render contract +
      platform export presets (complete 2026-07-11).** Closes the H1.3a gap and
      the plan's "export presets as creator actions" ask together.
  - `apps/desktop/electron/render/export-client.ts`: `exportViaSidecar` now
    branches on `req.preview`. Preview stays the old single-await
    `POST /render/preview` (unchanged, per the engine decision). A full export
    POSTs `/render`, then polls `GET /render/jobs/{jobId}` every **750ms**
    (frequent enough to feel live, sparse enough not to hammer the sidecar
    during a render that can run seconds to minutes) until a terminal status,
    reporting every observed transition via an injectable `onProgress`
    callback and honouring an injectable `AbortSignal` — on abort it calls
    `POST /render/jobs/{jobId}/cancel` before returning
    `{ ok: false, error: 'Export cancelled.' }`.
  - `apps/desktop/electron/render/export-hub.ts` (new): `ExportHub`, mirroring
    `AiStreamHub`'s shape (`ai/ai-stream.ts`) — mints an unguessable
    `requestId`, submits+polls in the background, pushes progress over a new
    IPC channel, and scopes cancel to the sender that started the run
    (cross-window cancel is a no-op), with destroy-cleanup on both.
  - New IPC surface (`packages/shared-types/src/ipc.ts`,
    `apps/desktop/electron/ipc/contract.ts`, `preload.cts`): `exportVideoStart`
    (invoke → `requestId`), `exportVideoCancel` (send), `onExportProgress`
    (push), plus the `ExportProgressMessage`/`ExportJobStatus` wire types. The
    old `exportVideo` invoke is kept for the (currently unused) preview path.
  - `apps/web-editor/src/components/ExportDialog.tsx`: replaced the static
    "Rendering…" message with real `queued` → `running` → terminal states plus
    a `Cancel export` button, wired through new `bridge.ts` wrappers
    (`exportVideoStart`/`exportVideoCancel`/`onExportProgress`). **No numeric
    progress bar** — the sidecar's `RenderTask`/`RenderJob` carry only a coarse
    status, never a live 0–100 figure (this project's no-fake-progress
    invariant), so the UI shows the real status transitions instead.
  - Platform export presets (`engine/python/framepilot_engine/render/presets.py`):
    renamed the 3 old presets to the plan's 4 named platforms —
    `reels` (1080×1920), `tiktok` (1080×1920), `shorts` (1080×1920),
    `youtube` (1920×1080) — plus kept `square` (1080×1080, a real
    already-shipped capability not itself named in the plan, not dropped).
    `linkedin_16_9` was retired as a _distinct_ entry (it was pixel-identical
    to the new `youtube` preset); LinkedIn video still exports fine via
    `youtube`'s same 16:9 file, and "LinkedIn" remains a first-class
    _content-style_ target elsewhere (`AiStreamAgentOptions.targetPlatform`) —
    a separate concern (agent pacing) from this module (container/codec), so
    nothing there changed. Each preset now carries a `loudness_target`
    (default `"social"`, -14 LUFS) as a **recommended default only** — loudness
    stays the existing, fully separate, user-controllable render option
    (`social`/`podcast`/`broadcast`); a preset never force-applies it. `-14
LUFS` is the widely documented integrated-loudness convention shared by
    short-form/streaming platforms (YouTube's published target; Spotify/
    TikTok/Instagram normalize around the same figure) — see
    `audio/filters.py`'s `LOUDNESS_PRESETS` docstring.
    `apps/web-editor/src/components/ExportDialog.tsx`'s `EXPORT_PRESETS` is
    still a hand-synced copy of the engine dict (same drift risk flagged
    previously) — not resolved with shared build tooling here; both sides now
    carry a comment pointing at the other so a future drift is at least
    visible on read, which was judged the right amount of de-duplication for
    5 string/dimension pairs vs. standing up cross-package codegen.
  - Tests: `export-client.test.ts` rewritten for the async contract
    (queued→running→completed, failed, cancel-mid-poll — all driven by an
    injectable `sleepFn`, no real timers); `ExportDialog.test.tsx` rewritten
    to stub the new triad and drive progress via an emitted message instead of
    one resolved promise (adds a cancel-button test); `App.test.tsx`'s export
    flow test updated to the same pattern. Engine: `test_timeline_models.py`,
    `test_render_pipeline.py`, `test_render_compiler.py`, `test_render_golden.py`
    updated for the renamed preset ids/constants (a golden fixture's
    `preset_id` was updated; the golden aHashes themselves are unchanged since
    `reels`'s dimensions/codec are byte-identical to the old `reels_9_16`).
    `pnpm --filter @framepilot/desktop test/typecheck/lint`,
    `pnpm --filter @framepilot/web-editor test/typecheck/lint`,
    `pnpm --filter @framepilot/shared-types test/lint`, `pnpm engine:test`,
    `pnpm engine:lint`, `pnpm engine:typecheck` all green.

- [x] **H1.4 (first half) — Filler-word + awkward-pause cleanup recipe (complete
      2026-07-11, commit `f04edd4`).** Closes the "filler-word / 'um' removal" half of
      H1.4. A new 0-model `filler_cleanup` recipe (Descript-style), built entirely on
      the existing recipe DAG/leaf architecture — no new `editor-core` op; composes
      `ripple_delete` exactly like `remove_silence`'s `synthRippleDeletes`.
  - `packages/ai-sdk/src/kernel/plan-compiler.ts`: new `fillerCleanup` recipe —
    `detect_filler_cleanup` (analysis) → `synth_filler_deletes` (analysis) →
    `assemble_patch` → `verify`, registered as `filler_cleanup` in `RECIPES`.
  - `packages/ai-sdk/src/kernel/recipe-leaves.ts`: `detect_filler_cleanup` matches
    a case-insensitive, punctuation-stripped filler lexicon (um/uh/erm/er/hmm)
    against the project's word-level transcript, plus awkward-pause spans (gap >
    `CAPTION_GAP_SECONDS`, the existing 0.8s precedent, reused rather than
    inventing a new number — tightened to 0.25s, not 0s, since a hard cut to zero
    reads as an unnatural jump-cut). Deliberately excludes "like" and multi-word
    phrases: "like" is too overloaded (comparison/verb/filler) for a 0-model
    recipe with no judgment to disambiguate — silently cutting a meaningful "like"
    would be worse than not offering the cut at all. No-transcript case degrades
    honestly (zero spans, a distinguishing summary), matching the existing
    `transcript_cues`/`find_hook`/`synth_pacing_ops` pattern. `synth_filler_deletes`
    combines filler + pause spans into one latest-first `ripple_delete` sequence
    on the target track (same ordering discipline `remove_silence` already uses so
    ripple deletes don't invalidate each other's indices).
  - `packages/ai-sdk/src/kernel/router.ts`: the `filler_cleanup` signature is
    checked before `remove_silence`'s, so "clean up the awkward pauses" claims the
    more specific recipe while bare "dead air" still routes to `remove_silence`
    unchanged.
  - Tests: `recipe-leaves.test.ts`'s `filler_cleanup leaves (H1.4)` describe block
    (case/punctuation-insensitive matching, "like" never matched, boundary-exact
    gap not treated as awkward, honest empty result for no transcript, combined
    latest-first ripple-delete ordering, singular/plural summary wording);
    `plan-compiler.test.ts` extended for the new recipe shape.
    `pnpm --filter @framepilot/ai-sdk test/typecheck/lint` green.
  - **Note:** this recipe shipped without its own dated `plan/PLAN.md` entry at
    the time (only the H1.4 "second half" below was documented) — this entry
    backfills that gap, added 2026-07-11 during the H1-closure pass.

- [x] **H1.4 (second half) — Master-bus EQ + dynamics compression, engine +
      Export dialog (complete 2026-07-11).** Closes the "EQ, multiband compression"
      half of the Phase 6/9.2 "Advanced sound" deferral for **single-band** EQ and
      **single-band** compression (multiband compression, buses, and auto-SFX stay
      deferred/gated on a richer audio master spec, per PLAN.md 9.0/9.2 — see that
      section's updated wording).
  - `engine/python/framepilot_engine/audio/filters.py`: new `EQ_PRESETS` (named
    3-band recipes — `flat` (explicit no-op), `warm`, `bright`,
    `voice-clarity` — each a `(freq, gain_db, octaves)` tuple chained through
    ffmpeg's peaking `equalizer=f=:width_type=o:w=:g=` filter, one invocation
    per band) and `COMPRESSION_PRESETS` (named preset `voice` — threshold
    -18dB, ratio 3:1, attack 20ms, release 250ms, makeup +4dB — through
    ffmpeg's `acompressor`). **Creator-language surface, per the product's
    "plan terms not raw parameters" invariant**: `RenderOptions`/the sidecar
    contract only accept preset names, never open dB/ratio/attack/release
    knobs (the task explicitly asked for (a) named presets over (b) raw bands,
    matching this codebase's philosophy). `build_master_filter` gained `eq`
    and `compression` keyword args (both `str | None`, unknown names raise
    `ValueError` mirroring the existing `loudness` preset validation).
  - **Chain order — de-noise → EQ → compression → loudness → limiter**
    (changed from the prior de-noise → loudness → limiter): EQ/compression
    reshape the signal's tone and dynamics and must run _before_ loudness
    normalization measures/targets the final level, so loudnorm sees the
    post-EQ/compression signal, not the raw one; the limiter still runs last
    as the final peak-safety net after loudnorm's true-peak target. Documented
    in `filters.py`'s module docstring, not just implemented silently.
  - Compression defaults follow commonly-cited broadcast/podcast voice-
    compression practice (moderate ~3:1 ratio, fast attack to catch
    plosives/transients without over-squashing, release slow enough to avoid
    audible pumping, makeup gain to restore the level lost to gain reduction)
    — not invented numbers; EQ presets follow standard voice-EQ moves (cut
    sub-bass rumble, presence-peak boost ~3-4kHz for intelligibility, a touch
    of air on top; `warm`/`bright` are the classic de-harsh/add-crispness
    variants) — see the in-code comments next to each preset table for the
    per-preset reasoning.
  - `render/pipeline.py`: `RenderOptions.eq`/`RenderOptions.compression` added
    (same `Field` style as `denoise`/`loudness`/`limiter`), threaded through
    `_apply_master_audio_pass` into `build_master_filter` — no new wiring
    mechanism. `service.py`: `RenderRequest.eq`/`.compression` added and mapped
    into `RenderOptions` in the `/render` route, mirroring the existing
    `denoise`/`loudness`/`limiter` mapping exactly (the synchronous preview
    path's `_run_render` was deliberately left untouched — it doesn't thread
    `denoise`/`loudness`/`limiter` today either, so adding `eq`/`compression`
    there would be new, not matching, surface).
  - **UI scope decision (small, low-risk, done — not deferred):** the Export
    dialog (`apps/web-editor/src/components/ExportDialog.tsx`) already had a
    natural slot — a flat sequence of Loudness/denoise/limiter controls with
    local `useState` per field, no complex form machinery — so an EQ preset
    `Select` and a "voice compression" `Checkbox` were added there directly,
    same shape as the existing controls, feeding the same `exportVideoStart`
    IPC call (no new IPC method needed; `ExportRequest` just widened with two
    more optional fields). Full chain updated end to end: `packages/
shared-types/src/ipc.ts` (`ExportRequest.eq`/`.compression`),
    `apps/desktop/electron/render/export-client.ts` (`postRenderRequest` now
    sends `eq`/`compression` in the camelCase→snake_case HTTP body) — the
    Electron main/`ExportHub` layers needed no change (they already spread the
    whole request object rather than listing fields).
  - Tests: `test_audio_filters.py` (flat-is-explicit-noop vs. `None`-is-unset,
    each named preset's filter-string shape, unknown-preset `ValueError` for
    both EQ and compression, full 7-part chain order); `test_render_pipeline.py`
    (`RenderOptions` defaults, `_apply_master_audio_pass` threading);
    `ExportDialog.test.tsx` (new EQ-preset + compression-checkbox test) and
    `export-client.test.ts` (existing exact-body assertions updated for the two
    new fields). `pnpm engine:test` (617 passed), `pnpm engine:lint`,
    `pnpm engine:typecheck` green; `pnpm --filter @framepilot/web-editor
test/typecheck/lint` (875 tests), `pnpm --filter @framepilot/desktop
test/typecheck` (199 tests), `pnpm --filter @framepilot/shared-types build`
    all green.

- [x] **H1.1 — Animated captions, schema v5 slice (complete 2026-07-10).**
      First of five H1 schema bumps (v5–v9), each its own small commit
      (`plan/FRAMEPILOT-AI-PRODUCT-PLAN.md` H1.1). The schema + op landed first,
      then the Python engine (render) side, then this final update — the
      `CaptionEditor.tsx` UI switch-over to `set_caption_style` — which closes the
      slice end-to-end (schema → op → render → UI).
  - `timeline-schema`: `SCHEMA_VERSION` → **5**. New `CaptionStyleSchema`
    (fontFamily/fontScale/textColor/outlineColor/outlineWidth/position/
    highlight{enabled,color,animation}/presetId), all optional/defaulted, on a
    new optional `Clip.captionStyle` field — modeled as a first-class typed
    field (like `Clip.keyframes`), not nested in the caption `Effect`'s
    free-form `params`, so the renderer/UI never do stringly-typed lookups for
    karaoke animation. Additive v4→v5 migration (`migrate: (raw) => raw`).
    `schema/project.schema.json` regenerated. See ADR 0045.
  - `editor-core`: new reversible op `set_caption_style` (`clipId`,
    `captionStyle: CaptionStyle | null`) — same-shape exact inverse (mirrors
    `set_track_flags`), defensive re-validation against `CaptionStyleSchema` at
    apply (`OperationError('invalid_style', …)`), registered in the validator's
    `SUPPORTED_OPERATIONS` with a new `invalid_style` `ValidationCode`.
  - **Python engine (this update):** `timeline/models.py` gains
    `CaptionStyle`/`CaptionHighlight` Pydantic models mirroring
    `CaptionStyleSchema` 1:1 and `Clip.caption_style` (alias `captionStyle`);
    `SCHEMA_VERSION` bumped to 5 to match, closing the
    `test_schema_parity.py` gap ADR 0045 called out. `render/captions.py`
    gains a styled/animated caption renderer (font family with a safe
    fallback, scale, text/outline color via real Pillow stroke, top/middle/
    bottom position, a `presetId` table mirroring `captions.ts`'s
    `CAPTION_TEMPLATES`, and per-word `pop`/`karaoke-fill` highlight driven by
    the clip's transcript-derived active words) — a clip with no
    `captionStyle` still renders through the exact byte-identical pre-v5
    baseline path. `render/compiler.py`'s `_caption_layers` wires it in: a
    static styled image is cached once per clip, an animated one renders a
    synced RGB+alpha-mask `VideoClip` per output frame. **Engine-only**: no UI
    surface exists yet to author a `captionStyle`, so this is a render
    capability, not a shipped user-facing feature (see CHANGELOG).
  - Tests: `timeline-schema` migration test (v4→v5, additive, existing caption
    clip untouched) + captionStyle parse/round-trip/reject-out-of-range tests;
    `editor-core` apply/invert round-trip, missing-clip-id, and invalid-style
    tests for `set_caption_style`. Engine: `test_render_captions.py` extended
    (unstyled-matches-baseline regression, styled color/outline/position,
    preset lookup, `caption_style_is_animated`, karaoke-fill and pop pixel
    differences across frame times); `test_render_compiler.py` adds a
    styled+highlighted caption compiler-wiring test (`get_frame` differs
    across sampled times). `pnpm engine:test`/`engine:lint`/`engine:typecheck`
    green (576 passed); `pnpm --filter @framepilot/timeline-schema
test/typecheck/lint` and `pnpm --filter @framepilot/editor-core
test/typecheck/lint` green; 100% coverage maintained on `editor-core`.
  - **Known gap, tracked not silent:** `engine/python/tests/test_schema_parity.py`
    will report a `Clip` field mismatch until the Python Pydantic model gains
    `captionStyle` in the engine follow-up (explicitly out of scope for this
    commit per the maintainer's task split).
  - **Editor UI (this update, closes the slice):** `CaptionEditor.tsx`'s
    existing style controls (template gallery, size slider, color swatches,
    position buttons) were local `useState` only — no persistence. They now
    read/write the **selected** caption clip's `Clip.captionStyle` through a
    new `setCaptionStylePatch` builder (`apps/web-editor/src/editor/
patch-builders.ts`, mirrors `applyColorGradePatch`'s single-clip shape) and
    `editor.applyPatch` — the same "select a clip, edit it, apply immediately,
    no Save step" convention `EffectsPanel` uses for color grades/transitions,
    reading `editor.state.selection` rather than inventing a new selection
    mechanism. Clicking a caption row in the timeline-synced list now selects
    that clip (in addition to seeking, its prior behavior); each caption row
    renders from ITS OWN persisted style, not a single shared preview, so the
    list always reflects what will actually render. Controls are disabled
    (not hidden) with a "Select a caption below to style it" hint when no
    caption clip is selected — same convention as `EffectsPanel`'s "Select a
    clip to apply effects." Keyword-highlight chips and the burn-in checkbox
    stay preview-only/local (no schema field backs either yet — not part of
    this slice). UI position name `'center'` maps to the schema's `'middle'`
    at the persistence boundary only, so existing CSS classes and labels are
    unchanged. Tests: new `CaptionEditor.test.tsx` (disabled-until-selected,
    apply + undo through the real store, re-sync on selection change) and a
    `setCaptionStylePatch` block in `patch-builders.test.ts` (op shape,
    apply/undo/redo round-trip, clear-with-null, missing-clip). `pnpm --filter
@framepilot/web-editor test/typecheck/lint` green (849 tests).

## Phase P — AI Video Editor: End-to-End Product Plan — `[ ]` proposed (2026-07-10)

> **Master product roadmap: [`plan/FRAMEPILOT-AI-PRODUCT-PLAN.md`](./FRAMEPILOT-AI-PRODUCT-PLAN.md)**
> (sub-plan convention). Written from the **video editor's** point of view for the **end product**
> (not an MVP): the full set of capabilities, tools, **AI-model integrations**, schema evolution,
> and a **rewritten pro-grade editor UI** needed to make FramePilot the best AI editor for
> creators. Two decisions: **(a) AI models do the perception & generation** — transcription,
> vision/understanding, background removal, voiceover, generative b-roll are hosted (+ optional
> local) **models behind a provider abstraction (`@framepilot/ai-media`)**, we do **not** build a
> CV/ML/generative stack; **(b) the UI is rewritten** (Workstream J) referencing **DaVinci
> Resolve / Premiere Pro / CapCut**. Out of scope for now: an **owned music catalog** (users
> import their own audio; beat-sync/duck still work) and **collaboration/sharing**. Four horizons —
> **H0** foundation-true + kernel-mature + UI foundation/timeline (ASR keystone, close the
> honesty gaps where edits don't render, orchestration maturity, design system), **H1** the
> complete instant creator editor (animated captions, speed/crop/blend/markers, platform export,
> preview-first + variations + Cmd+K, monitors/bin/inspector), **H2** the co-editor that
> _understands the footage_ (vision-via-models, auto-reframe, long→short repurposing, brand,
> long-horizon autonomy, color/audio/command-palette UI), **H3** generative studio + scale + UI
> polish. Subsumes the orchestration detail in
> [`AGENT-NATIVE-COMPLETION-PLAN.md`](./AGENT-NATIVE-COMPLETION-PLAN.md) (Workstream A) and
> reframes the Phase 9 deferred/dependency-gated items by the editor-first thesis. Every capability
> is end-to-end (schema→engine/model→op→tool→UI→tests); the media/model integration ships before
> the AI behavior that calls it; **AI-model provider strategy + cost model + consent/labeling
> policy** need maintainer sign-off first (CLAUDE.md §5, listed in §11 of the sub-plan).

## Phase L — LangChain/LangGraph migration of the AI layer (end to end) — `[~]` structurally complete, operationally unstarted (2026-08-07)

> **Full plan in [`plan/LANGCHAIN-MIGRATION.md`](./LANGCHAIN-MIGRATION.md)** (sub-plan convention).
> **Scope decided by the maintainer (2026-08-06): COMPLETE END-TO-END MIGRATION.** LangGraph owns
> orchestration, LangChain owns providers and tools, the bespoke kernel is deleted. An earlier
> revision recommended a narrower provider-only adoption; that assessment is retained in §3 of the
> sub-plan as _what we are knowingly trading away_ — it is context for the mitigations, not a brake.
> Blast radius **≈56,600 LOC** of AI-layer production code (`ai-sdk` 34,262 prod / 36,190 tests /
> **2,358 tests green**, 77 tools, 9 providers, 21 skills, **zero runtime deps but `zod`**; plus
> mcp-server, desktop `RunCoordinator`, web-editor sidebar, Python tools/brain).
> **13 phases, est. 4–7 engineer-months**, strangler-fig, desktop-first, parity oracle = recorded
> golden agent sessions. The migration is tractable because two existing structures map onto
> LangGraph almost 1:1 — the 6-member `ConductorEffect` union **is** the node set, and `RUN_STAGES`
> **is** a forward-only state machine. Five design decisions carry it (§5 of the sub-plan):
> **(1)** LangChain chat models under a FramePilot `resilientChatModel` Runnable, with LC-internal
> retries disabled so there is one retry authority; **(2) nodes are shells, decisions stay pure** —
> M3 extracts every Conductor decision into pure functions _before_ any graph code, preserving
> table-testability and the coverage story; **(3)** one canonical registry adapted to
> `StructuredTool`, with wipe-guard / patch validation / classification / `unavailable`-refusal
> **inside** the tool wrapper so they run whatever invoked the tool; **(4) the checkpointer is
> implemented over the existing `RunRecord` WAL** — LangGraph never gets its own storage, so ADR
> 0073 keeps one authority; **(5)** memory adapted via `BaseStore`, never a parallel store (PRD §8.7).
> The event-id `seq` contract is preserved by driving the existing emitter from node boundaries —
> **`streamEvents` is never used to build user-visible events.** Invariants that do not move: typed
> ops with apply+invert, AI emits patches only, no schema change, render-vs-preview, TS↔Python
> schema sync. **Blocked on maintainer sign-off:** dependency adoption (CLAUDE.md §5 — reverses the
> documented raw-`fetch` decision in `providers/anthropic.ts`), LangSmith telemetry (user
> footage-derived content egress — default off, opt-in, redacted), and the **coverage policy**
> (proposed two-tier: 100% on the pure core, a named threshold on adapter shells — no blanket
> reduction). **M12 is the point of no return; M0–M11 revert individually.**
>
> **The paragraph above is the plan as written on 2026-08-06, kept for the reasoning behind the
> mitigations. It is no longer the state.** All three gates are closed, all thirteen phases are
> terminal, and M12 has been passed — see the status block below for what that does and does not
> mean.

**Status `[~]` — every phase M0–M13 has reached a terminal state (done, or declined with a
reason). The code is finished; the migration is not proven. Read the sub-plan's status block
before trusting any `[x]` in it — the four items below are what "not proven" means, and they
need real API spend, real footage and a desktop run, so they cannot be closed from a repo.**

1. **M0.1 caught a real regression, it is fixed, and TTFT is now at parity.** 2026-08-07,
   deepseek, same project, ~$8.50 of real spend across three captures. The first comparison
   showed **TTFT p50 1,499 → 11,650 ms on LangChain (7.8×)** with 19 of 49 calls emitting
   nothing until the end. Root cause: the adapter dropped DeepSeek's entire reasoning
   stream, because `ChatDeepSeek` carries it on `additional_kwargs` and we read only
   `content` — a dead sidebar during thinking, not just a bad number. After the fix
   (M0.1c): **p50 1,521 ms vs native 1,499 (1.5%), 0 of 63 degenerate.** Risk 1 materialised
   and the baseline is what caught it; that is M0.1 paying for itself.
   **The gate still says no:** `checkAgainstBudget` returns `withinBudget: false` on
   **p95 TTFT +9.5%** (2,377 vs 2,170 ms) — one tail regression, not yet distinguishable
   from noise at 5 prompts with 1-vs-3 failed runs. **Cost and cache remain incomparable
   (M0.1d)** — native never reads cache counts back, so the gate "passing" cost is an
   artifact, not a result. Two of three acceptance metrics are still unusable as a budget,
   so every phase's DoD item remains unverified and **no phase fully met its DoD**.
2. ~~**LangChain serves no traffic.**~~ **Resolved 2026-08-07 (M2.5, ADR 0105).** The native
   adapters are deleted and `FRAMEPILOT_AI_PROVIDER_IMPL` with them — LangChain is the only
   provider implementation, chosen on the matched M0.1 capture (faster on every latency
   measure, `withinBudget: true`). **The four `GITHUB_*` and `FRAMEPILOT_AI_PROVIDER_IMPL`
   entries in the root `.env.example` are now dead and can be deleted — that file is the
   maintainer's.**
3. **Nothing has run on desktop with real footage** — the surface CLAUDE.md calls priority #1.
   Now the only provider path, so this is the last untested surface rather than one of two.
   Note desktop no longer routes AI through Electron's `net.fetch` (ADR 0105), so proxy and
   enterprise-CA behaviour changed and has not been exercised.
4. **M12 deleted the kernel driver before 1–3**, on a precondition the maintainer waived
   knowingly (2026-08-07). There is no runtime fallback; reverting means reverting the commit.

**Next three actions, in order:** run the baseline harness → flip
`FRAMEPILOT_AI_PROVIDER_IMPL=langchain` on desktop and compare against it → if it holds, change
the default and begin M2.5 (deleting the native adapters).

- [x] **Merged `plan/autonomous-edit-phase0-diagnosis`** (2026-08-06). It carried a **shell-level
      LangGraph migration of the Conductor driver** (ADR **0099** — renumbered on merge; it
      collided with the TwelveLabs ADR 0097). Real partial credit toward M6/M7, but not a
      substitute: no checkpointer, no LC tools, no provider change, `streamAuto` untouched.
      **Its full suite was red where its own CI did not look** — cancellation dropped every
      buffered event, non-`Error` throws were replaced by an internal LangGraph `TypeError`, the
      web-editor build was broken, 27 unit tests + 3 e2e specs asserted removed settings UI, and
      engine lint/mypy were red. All fixed in the merge commit; the frozen `streamAgent` golden
      now passes byte-for-byte against the pre-migration event stream.
- [x] **M13 — ADR 0100 "No LangChain in the Python engine."** Done out of order because it needs
      no dependency, oracle or sign-off, and the open question invited repeated re-investigation.
      Python runs no agent loop; adopting LangChain there would _build_ an orchestrator with no
      consumer and a second run-state authority (against §5.4).
- [x] **The `ai-sdk` 100% coverage gate is GREEN again** (2026-08-06). It was red on merge from
      untested product code, not from LangChain shells, so §11.3's two-tier coverage proposal was
      never needed and the policy gate closed without a policy change. `media-understanding-runtime.ts`
      (0%, 338 lines) turned out **not** to be dead — `visualIndex.ts` imports it — so it was covered,
      not deleted. Current: **2,939 tests, 100% on all four metrics.**
- [x] **All three §11 gates are closed** (2026-08-07).
      **[x] Dependency adoption — signed off 2026-08-06** (M1), extended to five more providers at M2.
      **[x] LangSmith/telemetry — DECLINED** (ADR 0101). `langsmith` does install early as a hard
      dependency of `@langchain/core`, so the risk was real: an inherited `LANGSMITH_*` env var would
      have egressed user footage-derived content without touching a FramePilot flag. A test now pins
      that tracing stays off. **[x] Coverage policy — closed without change**, see above.
- [x] **M0.** **M0.3** Zod unification, **M0.4** dependency dossier, **M0.5** baseline gates,
      and the **M0.1 instrument** — which required fixing that `providers/anthropic.ts` set two
      `cache_control` breakpoints but never read `cache_read_input_tokens` back, leaving risk 3's
      acceptance metric unmeasurable. **M0.2** landed as a real parity oracle: nine recorded golden
      sessions plus a comparator that returns a **divergence list, not a boolean**. It earned its
      keep immediately — it caught a §7.4 sequence violation in the graph (the emitter seeded from
      `state.seq` instead of `result.endSeq`) that the scripted-handler parity test could not see.
      **Still outstanding: the M0.1 numbers**, which are item 1 above and are deliberately not
      fabricated.
- [x] **M3–M12 done.** Phase K's §11.4 gate was satisfied first, per the maintainer's decision,
      so M3 did not chase a moving target. M12 deleted `kernel/driver.ts`; `kernel/conductor.ts`
      stays, because it holds the pure decisions the graph nodes call (§5.2).
- [x] **Three modules this migration built were deleted again** (ADR 0103) — M5's WAL
      checkpointer and its desktop adapter, and M4's `toLangChainTools`. Each had zero non-test
      consumers. That was correct rather than an oversight: LangGraph's checkpointer exists to
      serve `interrupt()`, which M9 declined, and wiring it would have created a second resume
      authority against §5.4; `langchain-chat.ts#withTools` already binds the canonical registry's
      own schemas by reference, so M4's adapter had no path to be on. M4's one unique assertion —
      that LangChain puts on the wire exactly what MCP advertises — was moved to that real path.
- [~] **Independent findings** — §13 of the sub-plan.
  **[x] Python tool-registry parity** — landed as a generated fixture + CI drift test. It
  immediately found **16 genuinely drifting tools**, now pinned as a strict-xfail baseline:
  three with required-field drift (`add_asset`, `add_clip`, `add_track`), five where
  `extra="forbid"` is **not inherited by nested Pydantic models** so nested objects accept
  unknown keys TS rejects (**widens the security boundary**), and eight missing bounds/enums
  (`get_frame` accepts a negative timestamp). [ ] Fixing them is follow-up work, deliberately
  not bundled with the detector.
  **[x] Duplicate ADR 0071** — TwelveLabs SDK renumbered to **ADR 0097**.

## Discovered (2026-07-12) — still-image import misclassified as video

- [x] **Photos imported as zero-length "video" → blank preview + `thumb_000.png`
      ENOENT flood (root cause + self-heal).** ffprobe reports a still image (WhatsApp
      JPEG) as a single-frame video stream with a bogus ~0.04s duration; the
      `/asset-media` classifier keyed off duration (`"video" if has_video and
duration`), so every photo imported as video and the timeline chased derived
      filmstrip frames + a proxy that are never generated for a still. Fix: classify
      on container format via `MediaInfo.is_image` (`_STILL_IMAGE_FORMATS` in
      `probe.py`; used by `service.py`). Editor hardened to render pre-fix projects
      without re-import: `previewMediaSrc` skips the proxy for images, `initialState`
      in `useAssetThumbnail` renders an image's own source over any stale derived
      thumb pointer, and `clipFilmstripFrames` returns `[]` for images (tiled still,
      not a per-frame strip). The image's bin tile also drops the play overlay +
      duration badge (`bin-card-play`/`bin-card-dur` gated on non-image kinds in
      `MediaBin.tsx`) — a still isn't playable and has no intrinsic duration. Tests:
      `test_media_probe.py` (`is_image` cases),
      `test_service.py` (bogus-duration image → `image`), `media.test.ts`,
      `selectors.test.ts`, new `useAssetThumbnail.test.ts`.

## Discovered (2026-07-12) — Media bin: filter/sort/density/used-indicator/hover-scrub

- [x] **Media/Assets sidebar power-user features (UI/UX redesign brief, phase 1
      of N).** User handed over a full editor-shell redesign brief; Media sidebar
      prioritized first, rest of the shell deferred. `packages/ui/src/tokens.css`
      already implements the brief's dark palette/spacing/motion almost verbatim, so
      this is feature work, not a re-skin: asset count in the header, filter chips
      (All/Video/Audio/Images — no "Text", not a real `Asset['kind']`), a sort
      dropdown (Recent/Name/Duration/Type/Unused, reusing existing array order for
      "Recent" — no schema change), a "used on timeline" indicator dot (derived from
      `editor.state.timeline`, not persisted), a 3-stop density control (S/M/L,
      persisted via new `useMediaBinView.ts` mirroring `useTrackLayout.ts`), and a
      client-side hover-scrub preview for video cards (real `<video>` seek-on-hover,
      no engine/filmstrip precompute needed). Filter/sort bypass the folder tree via
      the same flattening the unified search already does, rather than inventing a
      second grouping scheme. Deferred to follow-up passes (see below).
- [ ] **Media bin: list view mode** — dense sortable rows (thumb/name/type/
      duration/resolution/date), a distinct alternate row renderer from the grid.
- [ ] **Media bin: multi-select + batch action bar** (add-all/delete/tag).
- [ ] **Media bin: sticky type-grouping headers** — only if the user wants literal
      grouped sections in addition to/instead of the filter-chip toggle.
- [ ] **Media bin: missing/offline media status glyph** — needs its own look at
      how proxy/offline state is currently surfaced before designing the affordance.
- [ ] **Editor shell redesign, remaining regions** — top bar, preview/transport,
      AI/Inspector/Transcript panel — per the same brief, once the Media sidebar
      pass lands and is reviewed. (Timeline region done — see below.)

## Discovered (2026-07-12) — Timeline: visual refresh + Cmd-drag-duplicate/roll-edit/fade-handles

- [x] **Timeline region of the editor-shell redesign brief (phase 2 of N,
      scoped pass).** User handed over a full "greenfield" timeline design +
      interaction spec; audit found `TimelineView.tsx` (2144 lines, virtualized via
      `@tanstack/react-virtual`, patch/undo-driven) already implements most of the
      spec's visual language (quiet chrome, barely-there lane alternation, snap/
      razor guides, hover-reveal trim handles, muted per-type clip fills) and
      interaction model (marquee select, cross-track drag-move, edge-trim, razor
      split, ruler scrub, cmd-scroll zoom, track collapse/mute/lock/solo/reorder,
      transitions, read-only keyframe rail) via the existing shared token system
      (`packages/ui/src/tokens.css`, accent `#6d5cf6`, ADR 0028) — so no new token
      fork and no rewrite of the positioning model (clips/lanes keep `left`/`width`,
      not `transform`, since rows are already virtualized). Scoped, per user
      decision, to: (1) a visual pass confirming the existing CSS already matched
      the brief's intent (no selector/markup renames), and (2) closing three
      confirmed mouse-gesture gaps: **Cmd/Ctrl-drag duplicate** (new
      `duplicateClipAtPatch`/`duplicateClipsAtPatch` in `patch-builders.ts`, mirrors
      `moveClipPatch`/`moveClipsPatch` but adds instead of moving), **roll edit** on
      a butt-joined cut (new `rollEditPatch` — one patch, two `trim_clip` ops,
      ordered shrink-before-grow so the validator never sees a transient overlap;
      shared `rollBounds` selector clamps both the live drag-ghost and the
      committed patch to the same bound), and **audio fade handles** (corner
      drag-handles on audio clips calling the existing `setAudioPatch`
      fadeInSeconds/fadeOutSeconds — no schema change, Phase 6 sound work already
      supported it). **Alt is already bound to "invert snapping" during a
      move/trim drag**, so Cmd/Ctrl was used for duplicate + roll instead of the
      spec's literal Alt binding (user decision) — this preserves the existing
      snap-invert gesture. Tests: `patch-builders.test.ts`
      (`rollEditPatch`/`duplicateClipAtPatch`/`duplicateClipsAtPatch`),
      `TimelineView.interactions.test.tsx` (Cmd-drag-duplicate, roll-edit,
      fade-handle drag). No schema change, no keyboard remap.
- [ ] **Timeline keyboard-model rework** (deferred, per user decision) — the
      spec's I/O in/out points, Q/W ripple-trim-to-playhead, proper J/K/L shuttle
      with speed-ramp, and explicit A/B/H tool-mode state are not implemented; the
      current shortcut registry (`shortcuts.ts`) is hardcoded (no user remapping
      UI) and was left untouched this pass.
- [ ] **Clip grouping (Cmd+G/ungroup)** — not implemented; needs a new
      `groupId`-style schema field + migration + docs (CLAUDE.md §5 sign-off)
      before it can be built, deliberately not started here.
- [ ] **Video/image opacity self-fade handles** — only audio fade handles
      shipped this pass (an existing `adjust_audio` param); a non-transition
      per-clip opacity fade for video/image clips would need a small new render
      param and was left as a follow-up rather than invented speculatively.

## Discovered (2026-07-12) — Project History panel + persisted history

- [x] **History panel — see/undo/redo/jump every edit end to end (complete
      2026-07-12).** User asked for a header **History** button opening a
      creatively-architected, video-editor-friendly panel over the _existing_ shared
      undo/redo stack (`EditHistory`, `history.ts`), plus removal of the redundant
      "Timeline updated" toast. Shipped as 7 reviewable slices, one commit each:
      **(1) Engine** — `goto`/`gotoProject` fold the tested `undo/redo` primitives to
      jump to any cursor; additive-optional `HistoryEntry.committedAt` threaded through
      `commit*` (100% coverage on `history.ts`, no schema change). **(2) Store/adapter**
      — `gotoEdit` (reconciles selection), `committedAt` stamping (injectable `now`),
      `selectHistory`, and `goto()`/`history` surfaced on `useEditor`. **(3) Persistence**
      — web build now seeds `createEditorState` from `fromPersistedHistory(project.history)`
      and lifts `toPersistedHistory` back on every edit, so history survives reload
      (same contract as the desktop/MCP session; ADR 0053; Zod `history` stays
      `z.unknown()`). **(4) UI** — `HistoryPanel.tsx` right-side drawer "edit reel":
      per-op icons + human labels/chips (reusing `describeOperation`/`projectNames`),
      You-vs-AI badges + AI reason, relative time, multi-op expand, current-point
      marker, dimmed redo tail, hover before/after via folding stored `patch`/`inverse`
  - `diffTimeline`, You/AI filter, empty state. **(5) Wiring** — topbar button
    (active state), App-owned `historyOpen` threaded to Topbar + Editor, `⌘⇧H`
    shortcut in the existing History group. **(6)** removed the "Timeline updated"
    toast (error toasts stay). **(7)** e2e `history-panel.spec.ts` (open, list, jump,
    redo-tail, ⌘⇧H/Esc) + guide `docs/guides/history-panel.md` + this entry. Tests:
    editor-core 262, web-editor unit suite green (+HistoryPanel/store/Toasts),
    3 new e2e. No `project.fp.json` schema change; five invariants hold.
- [ ] **Persist a proper Zod type for `Project.history`** (deferred) — it remains
      `z.array(z.unknown())`; editor-core owns the shape via `fromPersistedHistory`.
      Fully typing the `Patch`/`Operation` union in Zod is future hardening, not
      required for correctness (ADR 0053).
- [ ] **Keyboard roving in the panel** (deferred) — ↑/↓ across rows + Enter; today
      Escape closes and native button focus/Tab works. Low-risk polish follow-up.

## Discovered (2026-07-12) — Timeline toolbar IA reorg + orange brand identity

- [x] **Timeline toolbar reorganized by function, not proximity (complete
      2026-07-12, ADR 0054).** User asked for a pure information-architecture pass:
      same controls, grouped by scope. Groups now read **Tools** (Selection/Blade,
      new `tool` state lifted to `Editor.tsx` alongside the existing
      `editMode`/`rippleOnDelete` lift) → **Clip actions** (Split/Delete/Ripple,
      unchanged) → **Markers** → **Edit mode** (Overwrite/Insert + Ripple-on-delete
  - new inline **Snapping** toggle wired to the existing `settings.snapping`)
    → **History**, then a right-aligned **View/zoom** cluster (Zoom out/in/**to
    fit** together — fit reuses the `framepilot:zoom` window event the `⇧Z`
    shortcut already dispatched, no ref-lifting needed). Deduped the blade
    (was in both the toolbar and a floating gutter cluster) and Export (was in
    both the toolbar and the header — the toolbar's copy was already dead,
    `Editor.tsx` never wired its `onExport`). Add track moved into the
    track-header gutter with a Video/Audio picker (`Menu`/`MenuItem`); the
    toolbar collapses Markers then Clip actions into a `⋯ More` menu via
    `ResizeObserver` before ever wrapping to a second row. New shortcuts
    `tool.select` (`A`), `tool.blade` (`B`), `view.snapToggle` (`N`) in the one
    `SHORTCUTS` registry. Hand/Pan tool intentionally **not** added (would be new
    interaction, not reorg — deferred, see below). Tests: `coverage.test.tsx`,
    `TimelineView.interactions.test.tsx`, `shortcuts.test.ts` updated, 47 passing;
    typecheck/lint clean.
- [x] **Orange brand identity — real logo, everywhere (complete 2026-07-12,
      ADR 0054).** Replaced the placeholder violet→blue mark with the actual
      FramePilot logo (`ui_revamp/logo/framepilot logo-clean.png`, used as-is per
      explicit direction — only squared to a canvas for favicon/icon generators,
      no other edits) and moved the accent from indigo `#6d5cf6` to `#e5670a`
      (sampled from the mark) in **both** independent token systems
      (`packages/ui/src/tokens.css` dark/light/`data-theme`, and the website's own
      Tailwind `@theme` in `globals.css`), plus six marketing components that had
      hardcoded the old accent's rgb triplet directly in arbitrary-value shadows.
      Re-ran `pnpm generate:og` to regenerate `og.png`/favicons/PWA icons from the
      new logo + accent. `apps/desktop` had no app icon at all — added
      `build/icon.png` (1024×1024) + `mac.icon`/`win.icon`/`linux.icon` in
      `electron-builder.yml`, with a `.gitignore` exception since electron-builder's
      `buildResources: build` dir is source, not build output. `tokens.test.ts`'s
      brand-pin test updated (not deleted) so a future change must touch it too.
- [ ] **Unify the two accent-token systems** (deferred, ADR 0054 risk note) —
      `packages/ui/tokens.css` and the website's own `@theme` block can drift again
      independently next time either changes alone. Worth its own ADR/refactor.
- [ ] **Hand/Pan timeline tool** (deferred) — the reorg's Tools group ships
      Selection + Blade only; adding a real pan-drag interaction is new
      functionality, intentionally out of scope here.

## Discovered (2026-07-13) — Prompt-surface audit (lead-prompt-engineer pass)

- [x] **Tool descriptions disambiguated for the model (complete 2026-07-13).**
      The terse mutating-tool one-liners never said which reference frame their
      times use, the trim/split/keyframe ambiguity a model actually hits:
      `trim_clip`/`split_clip`/`delete_range`/`ripple_delete`/`add_clip`/
      `add_text_layer`/`add_caption_layer` now state "timeline seconds",
      `add_keyframes` states clip-relative times (and points simple zooms at
      `punch_in`), `delete_range`↔`ripple_delete` cross-reference the gap
      behaviour, `get_selected_range` documents its null case. Python mirror
      (`engine/python/.../ai_tools/registry.py`) synced, including its stale
      "Add a transition onto a clip" (it joins two adjacent clips). MCP parity +
      schema-parity guards unaffected (they compare names/schemas, not prose).
- [x] **Agent-mode instruction reordered + deduplicated** (`orchestrator.ts`):
      read-ids-first now precedes the edit directive; the two overlapping
      manage_assets cautions folded into one; plan-drafting instruction tightened.
      Same constraints, fewer tokens, no behavioural assertions weakened.
- [x] **Sidebar copy for newer ops/tools moved to editor language**
      (`describe.ts`): `set_clip_speed`/`set_clip_crop`/`set_clip_blend_mode`/
      `set_caption_style`/markers/`set_transcript`/`set_effect_params` op labels and
      `analyze_silence`/`detect_scenes`/`detect_beats`/`list_assets`/`transcribe`
      tool verbs no longer fall through to `humanize()`'s data-model naming;
      `describeToolCall` drops a dangling preposition when no clip/asset ref
      resolves ("Finding silences", never "Finding silences in"). streamAgent
      golden updated deliberately for the new tool-card title.
- Deliberately unchanged: `SYSTEM_PROMPT` + context blocks (already the
  exemplar: invariants-first, stable prefix, volatile blocks last), the kernel
  proposer/classifier prompts (already tight JSON-contract prompts), and
  `critic.ts` check details (they cite raw clip ids — fixing that needs
  `ProjectNames` plumbing through `critique`, a behaviour change, not wording).

## Discovered (2026-07-13) — Agent-loop validation feedback (screenshot bug)

- [x] **Per-call validation in the agent loop (complete 2026-07-13).** Mutating
      tool calls used to compile ops and report `completed` (green card, "Added text
      overlay…"), with validation deferred to the end-of-turn batch — so a rejected
      turn showed success cards, then "No edits were applied … Try rephrasing the
      request", and the model never saw the validator's reason. Now `runAgentCall`
      validates each mutating call against a turn-local speculative working copy
      (threaded call-to-call in `executeToolCalls`, `agent()`, and `attemptRepair`):
      an invalid call fails ITS card with the validator's message (also fed back to
      the model via the log), valid calls still land, and a later call can reference
      clips created earlier in the same turn.
- [x] **Rejected turns retry instead of dead-ending.** `conductor.ts
onTurnResult` (and the non-streaming `agent()` loop) no longer stop the run on
      a validator-rejected real-ops turn: the rejection falls through to the same
      bounded spin guards as a zero-op turn (exact-signature repeat or
      `MAX_CONSECUTIVE_NO_PROGRESS`), so the model gets a chance to fix the cause.
      Per-call rejections are tallied (`rejectedOpCount`/`rejectionNotes` on
      `AgentTurnResult`) so the honest empty-run notice still fires when a run lands
      nothing. A fully-rejected repair pass records an honest non-applied step.
- [x] **Prompts teach the track-overlap invariant.** Agent-mode instruction +
      `add_text_layer`/`add_clip` descriptions (TS + Python mirror) now state clips
      on one track can never overlap and that a rejected call should be corrected,
      not repeated or abandoned.
- [x] **Capability gap: the agent cannot create tracks.** `add_layer` exists in
      editor-core (Phase 2 type-agnostic layers) but is not exposed as an AI tool,
      so "stack N simultaneous overlays" is impossible when no free track exists —
      the agent can only work around it. Expose an `add_layer`/`add_track` tool
      (registry + Python mirror + MCP parity) to close it.
      **Done (2026-07-15):** `add_track` mutate tool → `add_layer` op (advisory
      `type`, z-order `atIndex` default front, optional/deterministic `id`); agent
      contract now points at it as the escape hatch for the track-overlap invariant.
      Python mirror (`AddTrackArgs` + handler + dispatch) keeps the name-parity guard
      green; MCP surface auto-exposes it from `TOOL_REGISTRY`. Like the sibling
      styling ops, the layer op is applied by the TS host, not the sidecar, so it is
      intentionally absent from the Python `Operation` union. Tests: ai-sdk 1419,
      engine 969 green; new-code branches (id-collision) covered both sides.

## Discovered (2026-07-13) — Orchestrator + AI sidebar gap-closure audit

- [x] **Three-agent audit of the orchestration layer, transport, and sidebar UI
      found gaps where shipped machinery (cost meter, recovery table, tier routing,
      Semantic Index, task-DAG progress UI, persisted UI state) is wired to paths the
      default Agent-mode run never takes — all nine bounded fixes closed
      (2026-07-13).** See `plan/ORCHESTRATOR-GAP-CLOSURE.md` §2 for detail: deduped
      the desktop provider allowlist against ai-sdk's own list; fixed `runOutcome.ts`
      blaming the model for a user-cancelled empty run; registered 6 AI tools missing
      from the Python engine mirror (with a new TS↔Python parity test); `streamAgent`
      now emits real `usage` + the specific `RunStatus` values the sidebar already
      had labels for (`generating`/`running_tool`/`reading`/`searching`); fixed a live
      bug where the Conductor's default per-turn op cap (40) silently overrode the
      documented default (100); the sidebar's retryable-error notices gained inline
      Retry/Copy-details, `ConversationUiState` (draft/tool-expansion/scroll) is now
      actually persisted across reload, and the message list's live region no longer
      announces virtualization scroll churn + modals now trap focus. Larger
      control-flow work (recovery-table wiring into `streamAgent`, budget
      enforcement, tier routing for the agent path, Semantic Index as the agent
      loop's context source, live desktop steering/approval) is explicitly tracked
      but deliberately deferred — see that doc's §3 for why each one needs its own
      scoped plan rather than folding into a gap-closure pass. Engine 654 tests,
      ai-sdk 1181, web-editor 1112 — all green; typecheck/lint clean throughout.

## Discovered (2026-07-13) — 3 pre-existing e2e failures, unrelated to the gap-closure work above

- [ ] **`tests/e2e/specs/ai-edit-review-apply-undo.spec.ts` asserts stale decision-pill
      copy.** Two of its three tests fail: the "Accept" test waits for the text
      `'Applied — use Undo to revert.'`, but `EventNode.tsx`'s accepted-decision note
      has read `'Use Undo to revert.'` (no em dash, no "Applied" prefix — that's now a
      separate pill) since commit `c48eca5` (2026-07-12, "editor-first AI review UX +
      bigger before/after popup") — a wording change that never got the e2e spec
      updated to match. Same story for the "Reject" test: it waits for
      `'Rejected — the agent will remember.'`, but the actual copy is `'The assistant
will remember this.'`. **Confirmed unrelated to the orchestrator/sidebar
      gap-closure work in the entry above** — verified via `git log -L` that the
      copy predates this session's branch, and none of that work's four commits
      touch `EventNode.tsx`'s `ai-diff-decided`/`ai-decision-note` block. Fix: update
      the two `getByText(...)` assertions in the spec to match current copy (or vice
      versa, if the shorter copy was itself unintentional — worth a quick look at
      whether "Applied — use Undo to revert." was the intended wording that
      regressed instead).
- [ ] **`tests/e2e/specs/project-and-transport.spec.ts` — "New project resets to
      an empty timeline" can't find `getByLabel('io message')`.** No `"io message"` or
      `"Fresh Cut"` string exists anywhere in current `apps/web-editor/src` — the
      New Project flow's confirmation UI has drifted since the spec was written (likely
      related to the pre-existing "New-project dialog drift" flakiness already noted
      in this file's 2026-06-28 entry, though the exact element/copy has since changed
      further). Needs someone to open the New Project flow and update the spec to
      match whatever confirms the reset today.

## Discovered (2026-07-13) — Sidebar status shimmer, per-turn diffs, bundled skills

Three-task unit of work on `feat/agent-ux-and-skills` (shipped as separate commits):

- [x] **Visible "Thinking…" shimmer in the sidebar header** — the header rendered
      only an aria-labelled spinner for `status` events; it now renders
      `runStatusLabel(view.status)` as shimmering text that tracks the live run state,
      and the redundant inline spinner next to the reasoning node's shimmer is gone.
      (`AiSidebar.tsx`/`EventNode.tsx`/`styles.css`; CHANGELOG "Fixed".)
- [x] **Per-turn agent diffs — instant auto-apply, per-step manual review**
      (ADR 0056). Each successfully validated turn (and the Critic repair pass) emits
      its own `scope:'turn'` + `turnIndex` diff the moment it lands; finalize/settle no
      longer emit a combined diff, so nothing can double-apply. Auto mode applies each
      step instantly (one undo entry per turn); manual mode stacks "Step N" review
      cards with the existing Apply all / Reject all. Additive `DiffEvent`/`DiffNode`
      fields only — no timeline-schema change.
- [x] **Bundled runtime skills system** (ADR 0057). Developer-authored strict-markdown
      playbooks in `packages/ai-sdk/skills/*.md` (starter: `keyframe-animation`,
      `short-form-pacing`); `scripts/generate-skills.mjs` embeds them into committed
      generated modules (`src/skills/generated.ts` + Python mirror
      `ai_tools/skills_generated.py`) so the SDK stays filesystem-agnostic and the
      TS↔Python registries serve identical content. New `skills` context tier
      (manifest only, dropped after `timeline`/before `memory` under budget) + pure
      `load_skill` read tool; agent paths default to `BUNDLED_SKILLS` with zero host
      wiring (desktop/web/MCP). `tools:` frontmatter is validation-only in v1 —
      dynamic tool re-scoping after load is deferred. `skills.ts` at 100% coverage;
      guide: `docs/guides/authoring-skills.md`.

## Discovered (2026-07-14) — Full editing-craft skill suite + editing-skills-expert agent

- [x] **Full professional skill suite** (14 new skills; 16 bundled total, cap 32).
      Crosscutting editor-craft playbooks in `packages/ai-sdk/skills/`, each grounded
      against the real registry/schema/engine (no assumed capabilities; `detect_faces`/
      `generate_mask` never referenced): `edit-prep`, `hook-crafting`,
      `silence-and-filler-cutting`, `caption-design`, `color-grading` (params verified
      against `render/color.py`), `audio-polish` (split-based ducking — gain is
      per-clip constant), `cut-and-transition-grammar`, `vertical-reframe` (crop-rect
      math), `broll-and-layering`, `beat-synced-editing`, `speed-ramping` (split-based
      ramps — speed is per-clip constant), `titles-and-text`, `story-structure`,
      `finishing-and-delivery`. Fixed factual errors in `keyframe-animation`
      (`ease_out` → `ease-out`, `punch_in` has `startTime`/`endTime` not `time`,
      properties are `scale`/`x`/`y`/`rotation`/`opacity`); `short-form-pacing` now
      lists `analyze_silence`. Regenerated TS + Python mirrors; ai-sdk 1216 tests and
      engine `test_ai_tools.py` 76 tests green; dist rebuilt.
- [x] **`editing-skills-expert` subagent** (`.agents/agents/claude/`): owns
      writing/maintaining the bundled skills; mandates verifying every tool name,
      param, and enum against `tool-registry.ts` / `timeline-schema` / the render
      engine before writing a recipe (never assume), plus the generate→test→build flow.
- [x] **Prompt centralization + craft refinement** (`packages/ai-sdk/src/prompts.ts`).
      Audited every model-facing prompt and moved them into one dependency-free module:
      `SYSTEM_PROMPT` (re-exported from context-builder for back-compat), the plan-mode
      instruction (deduped from `plan()`/`streamPlan()`), the agent-mode instruction +
      nudge/plan/steering/actions/repair blocks, and the five kernel contracts
      (classifier, IntentParser, Planner, EditProposer, Critic judgment, select_shots —
      builders take enums/catalogs as params so no import cycles). Tool descriptions
      deliberately stay in `tool-registry.ts` (per-tool API surface, not prompts).
      Refinements: senior-editor identity in the system contract; agent mode now
      directs the model to `load_skill` the matching craft playbook before specialized
      work; plan instructions order steps structure→pacing→polish; Critic judgment
      judges hook/rhythm/goal like an editor; select_shots gets montage-variety taste.
      Five invariants and tested contract tokens ('plan only', 'CommandRouter')
      preserved; 1216 ai-sdk tests + web-editor typecheck green; dist rebuilt.

## Discovered (2026-07-14) — Media Intelligence Substrate ("Project Brain") — `[x]` COMPLETE (2026-07-15)

> **Sub-plan: [`plan/ORCHESTRATION_ENHANCEMENT_PLAN.md`](./ORCHESTRATION_ENHANCEMENT_PLAN.md)**
> — davinci-resolve-mcp-style analysis/indexing/storage/memory/orchestration
> substrate: per-project derived `brain.sqlite` (WAL, provenance, rebuildable;
> `project.fp.json` stays canonical), persisted+cached analysis (plus unlocked
> loudness/black/freeze analyzers, depth tiers), transcript/marker FTS +
> `search_media`, optional local embeddings + `find_similar`, host-LLM vision
> protocol (`extract_frames` → `commit_vision`), durable chunked analysis jobs +
> caps, markdown memory tiers + cross-project soul + `session_context`.

- [x] **B0** Project Brain storage substrate (sidecar-owned SQLite, provenance, JSON sidecars, rebuild)
- [x] **B1** Analysis substrate: loudness/black/freeze analyzers, depth tiers, persist+cache results, warm `AnalysisResultsBag`
- [x] **B2** Indexing & search: FTS ingest, `search_media` tool, orchestrator routing, semantic-index enrichment
- [x] **B3** Embeddings & `find_similar` — shipped as an **opt-in** `embeddings` extra + `FRAMEPILOT_EMBEDDINGS_MODEL_DIR` gate (license scan green): no model bundled, honest keyword-only degrade when unconfigured, so the dependency gate is satisfied without forcing the dep on anyone
- [x] **B4** Vision protocol: `/extract-frames`, pending-vision → `commit_vision`, prompt contract (no built-in CV — the driving model does the seeing; in-app multimodal image injection deferred, ASK-gated)
- [x] **B5** Durable jobs, chunked batch analysis, run-grouped undo, analysis caps, wire `recoveryFor()`, session warmup
- [x] **B6** Memory tiers: markdown project memory, cross-project soul, `session_context` tool, hygiene
- [x] **B7** MCP parity, security review, ADR + guides, e2e/golden, reconcile Phase 4 analysis-tool prose — **the last phase, DONE (2026-07-15)**. Parity: no live gap, but nothing guarded it — a new registry tool reaches the MCP host with no edit to the client/dispatch, so an unmapped analysis tool POSTed to `<baseUrl>undefined` and an unhandled action defaulted to `render` (silently exporting a video); both now typed refusals with parity tests. Security: 3 of 5 risks verified clean (FTS structurally injection-proof, provenance un-launderable off the wire, no secrets); fixed a real agent-reachable DoS (`every_n` frame grid materialized before the cap) + a latent `memory/` traversal + `.gitignore` gaps. Docs: three drifts corrected (ADR schema version, `every_n` description, unproven degradation claims). Tests: golden loudness/black against real ffmpeg + a brain-absent e2e; rebuild determinism was already covered by B0.3.
      **Discovered (not done, deliberately):** the search-driven **Playwright** flow needs a sidecar-booting e2e harness — real infrastructure, its own slice. Covered at integration level meanwhile (`test_service_brain.py` + `brain-client`/`sidecar-executor` tests). See the sub-plan's B7.4 for the full rationale.

## Discovered (2026-07-15) — Agent loaded skills forever, edited nothing — `[x]` COMPLETE (2026-07-15)

Reported from a real desktop run (DeepSeek, agent mode, `planFirst`): the model drafted
a 10-step beat-sync plan, called `load_skill` on the same playbooks turn after turn, then
finalized with "No changes were made" — 0 ops applied.

- [x] **Root cause: `load_skill` results were truncated to ~34% of the playbook.** In the
      agent loop a read tool's result reaches the model as a log _note_ built by
      `summarizeReadResult`, which had no `load_skill` case — so it fell to the default
      `previewJson(value, ANALYSIS_PREVIEW_MAX)`: a JSON-escaped 1200-char slice of a ~3 KB
      skill, cut mid-sentence. The model re-called `load_skill` trying to get the rest until
      the Conductor's `MAX_CONSECUTIVE_NO_PROGRESS` (4) guard stopped the run. The guard was
      reporting the bug honestly, not causing it. Fixed: a `load_skill` case delivers the body
      whole, as prose (ADR 0057 §6's actual intent).
- [x] **Loaded playbooks are pinned for the run** (`HostCallContext.loadedSkills` →
      `agentSkillsBlock`), outside the rolling `AGENT_LOG_RECENT` (6) log window, so a body
      cannot age out mid-run and force a re-load. A repeat `load_skill` is answered from the
      pinned copy instead of re-pasting KB into the turn note; both agent loops and the repair
      pass share one run-scoped ledger. Bounded by `MAX_PINNED_SKILLS` (8) with an honest
      refusal — never a silent body cut.
- [x] **Coverage gap closed (the reason this shipped).** The existing ADR 0057 test
      asserted the body reached the _UI popup_ (`tool_result.result`) — true the whole time the
      model was starved. New tests assert on the model's actual messages: full body delivered,
      pinned once, survives log compaction, cap refuses honestly. `orchestrator.ts`/`prompts.ts`
      at 100% stmts/branches/funcs/lines.
- Verified: ai-sdk 1372 tests + full workspace (`pnpm test` 3176, `pnpm typecheck`) green;
  lint clean; `dist` rebuilt (desktop consumes built dist). ADR 0057 amended; CHANGELOG
  "Fixed". No schema change, no new dependency. **Last updated:** 2026-07-15

## Discovered (2026-07-15) — Agent Orchestration Hardening — `[x]` COMPLETE (2026-07-15)

> **Sub-plan: [`plan/AGENT-ORCHESTRATION-HARDENING.md`](./AGENT-ORCHESTRATION-HARDENING.md)**
> — two real desktop runs drafted a good 10-step beat-sync plan and finalized with
> "No changes were made" (0 ops). The `load_skill` truncation above was the first cause
> and is fixed; four defects remain: the no-progress guard cannot tell reconnaissance
> from spinning; the plan/step/guard budgets are mutually incoherent (12 vs 8 vs 4); the
> vision protocol advertises sight no provider can deliver and `commit_vision` persists
> the resulting fabrication to the brain (ADR 0055 violation); and the deterministic
> beat-sync montage core is unreachable from desktop. Adds a generic model-authored
> `ask_user` primitive and a montage **tool** (model-driven, not a flow handler), plus a
> compact tool/thought activity feed. Branch `fix/agent-orchestration-core`; reviewed
> with an independent model (Fable 5). **Landed** in 7 commits: three of the four defects
> proved to be ONE defect — a result the model needed (skill playbook, beat grid, frame
> pixels) silently sliced to fit a character budget. Adds ADR 0059 (`ask_user`), amends
> ADR 0057. `pnpm test` 3229 / typecheck / lint green; ai-sdk 100% coverage package-wide.
> **Superseded (2026-07-15):** the "open: montage tool unproven against a real model" item
> above is moot — the entire montage feature (the W4 tool, `synthesize_beat_montage`,
> `select_shots`, `montage.ts`/`montage-leaves.ts` and their TS+Python mirrors) was removed
> by explicit product decision (see `plan/AGENT-ORCHESTRATION-HARDENING.md`'s "Outcome"
> section). `detect_beats`/`detect_scenes` and `buildBeatGrid` are KEPT — only the
> beat-sync-as-a-tool planner path is gone; the planner now runs on `RECIPE_LEAVES`
> (`propose_edit` + the existing pacing/caption/hook/etc. leaves) with no montage
> vocabulary. **Last updated:** 2026-07-15

## Discovered (2026-07-15) — Montage feature removed by product decision — `[x]` COMPLETE (2026-07-15)

> Explicit product decision: remove the entire montage feature (not iterate on it) —
> the W4 "montage as a tool" slice above, and everything it depended on outside the
> parts KEPT for other reasons. Everything below is deleted or de-wired; TS + Python
> both fully green after removal.

- [x] **TS kernel:** deleted `packages/ai-sdk/src/kernel/montage.ts`, `montage-leaves.ts`,
      and their tests (`montage.test.ts`, `montage-leaves.test.ts`,
      `montage-parallelism-golden.test.ts`). `PLANNER_LEAVES` collapsed into `RECIPE_LEAVES`
      as the one default leaf registry `orchestrator.ts`/`plan-driver.ts` use. `router.ts`,
      `kernel/index.ts`, `semantic-index.ts` dropped montage wiring while preserving
      `buildBeatGrid` (still used by `semantic-index.ts`) and the generic `detect_beats`/
      `detect_scenes` analysis tools — **explicitly KEPT**, not part of this removal.
- [x] **`synthesize_beat_montage` tool:** removed the tool, its Zod schema, and the
      `beatGridFromTempo`/`placeCutsOnBeats` helpers from `tool-registry.ts` and `prompts.ts`.
- [x] **`select_shots` model step** (montage's shot-selection step, wired through
      `plan-driver.ts`): gone. The planner path now survives on the general `propose_edit`
      step + `RECIPE_LEAVES` alone.
- [x] **`planned-edit-stream.test.ts`** rewritten (not deleted) to drive a
      `propose_edit`/pacing plan end-to-end instead of the montage/`select_shots` plan,
      preserving that integration-test coverage.
- [x] **Python mirror:** deleted `engine/python/framepilot_engine/analysis/montage.py`
      and `engine/python/tests/test_montage.py`; removed `SynthesizeBeatMontageArgs`, the
      `synthesize_beat_montage` tool spec, handler, and dispatch entry from
      `registry.py`/`handlers.py`/`dispatch.py`/`tests/test_ai_tools.py`. `detect_beats`/
      `detect_scenes`/`beats.py` explicitly KEPT.
- [x] **Web-editor:** removed the dead `synthesize_beat_montage` entry from
      `apps/web-editor/src/components/ai/toolMeta.ts`; fixed a stale comment in
      `apps/web-editor/src/editor/ai.ts` that described the planner as recognizing "the one
      plan shape (§8.4 beat-sync montage)" — it now describes plans as built from
      `RECIPE_LEAVES` primitives generically.
- Verified: ai-sdk 1359 tests, typecheck, lint green; Python engine 962 tests, ruff,
  mypy green; web-editor 1126/1127 (the 1 failure, `add_track` missing from
  `toolMeta.ts`, is a pre-existing unrelated gap confirmed via `git stash`, not caused
  by this removal); typecheck and lint clean. See `plan/AGENT-ORCHESTRATION-HARDENING.md`
  W4 for the superseded note on the work this removes.

## Discovered (2026-07-15) — Agent Loop Budgets for Long-Form (Movie/Documentary) Planning — `[x]` COMPLETE (2026-07-15)

> Even with the same-day recon-vs-spin fix above, the loop's defaults (`maxSteps` 8,
> `maxOpsPerRun` 200, gate threshold 3, nudge-after 2, spin cap 2) were sized for a
> single short-form ask ("trim this", "add captions"), not a movie/documentary-length
> plan with many scenes and several analysis passes. Raised together, in both
> `kernel/conductor.ts` (the streaming path) and its mirrored constants in
> `orchestrator.ts` (the legacy single-shot path): `DEFAULT_MAX_AGENT_STEPS` 8→30,
> `DEFAULT_MAX_OPS_PER_RUN` 200→800, `PLAN_STEP_HEADROOM` 2→4, `NUDGE_TO_EDIT_AFTER`
> 2→6, `MAX_CONSECUTIVE_NO_PROGRESS` 2→10 (a genuine-stall backstop only — the recon
> budget still absorbs legitimate setup turns). `PLAN_APPROVAL_STEP_THRESHOLD` moved
> 3→10, deliberately kept below the drafter's own 12-step parse cap so an
> actually-maximal plan can still cross the approval gate.

- Verified: ai-sdk 1414 tests (updated fixtures that hardcoded the old defaults/plan
  lengths to derive from the exported constants instead), typecheck, lint all green;
  `dist` rebuilt. CHANGELOG "Fixed". No schema change, no new dependency.

## Discovered (2026-07-16) — AI Edit Continuity & Timeline Motion — `[~]` core landed

> **Sub-plan: [`plan/AI-EDIT-CONTINUITY-AND-MOTION.md`](./AI-EDIT-CONTINUITY-AND-MOTION.md)**
> — real agent use showed a run that finds a partially-edited timeline "starts
> fresh": a full-track `ripple_delete` wipes prior work and every follow-up run
> wipes the previous one's output, so a project never converges. Fixed with
> defense in depth: a continuity rule in the agent contract (continue from the
> given timeline, never rebuild) **plus** a deterministic wipe guard
> (`packages/ai-sdk/src/wipe-guard.ts`, wired into `runAgentCall` on both control
> paths) that rejects a delete clearing every clip on a multi-clip track of
> pre-run work — disabled when the user's own prompt asks for a reset. Also adds
> animated timeline feedback: `useEditPulse` derives touched clips from the edit
> history; touched clips flare via a framer-motion overlay (agent edits get a
> stronger ember halo, undo reads cool/quiet) and ripple shifts glide via
> pulse-scoped left/width transitions. Reduced-motion honoured; `framer-motion`
> (MIT) added to web-editor after license scan. Also fixed: `FRAMEPILOT_SOUL_ROOT`
> (and the other path envs) never expanded `~`, so the cross-project soul wrote
> to `<cwd>/~/...` — `config.py` now `expanduser()`s all path envs.

- [x] **C1** Wipe guard module + 15 unit tests; ai-sdk suite 1374 green; dist rebuilt
- [x] **C2** Agent-contract continuity rule (`prompts.ts`)
- [x] **C3** `useEditPulse` hook + tests; TimelineView pulse overlay + glide CSS; web-editor 1134 green
- [x] **C4** Engine `config.py` tilde expansion + test (engine config tests green)
- [ ] **C5** Context digest of prior applied edits for resumed conversations (A4 in sub-plan)
- [ ] **C6** Golden transcript test for the blocked-wipe path (A5); sidebar/minimap pulse echoes (B6–B8)

## Discovered (2026-07-16) — Token-friendly tool surface for long-form editing — `[~]` core landed

> Deep tool-registry audit driven by real long-form use: every read was
> all-or-nothing (`get_timeline`/`get_transcript` dump everything — thousands of
> tokens per orientation read on an hour-long project), deleting a specific clip
> required hand-computing `delete_range` times (the classic fat-finger that takes
> out half a track), and the reversible `remove_layer`/`move_layer` engine ops had
> no AI tool. Added, TS + Python mirrored (parity test green), exposed over MCP
> automatically, mapped in `toolMeta`:
> **Reads** — `get_timeline_summary` (per-track counts/spans/flags, no clip
> bodies), `get_clips` (windowed by trackId/start/end, paginated compact rows with
> effect/keyframe counts), `get_clip` (one clip in full detail), and an optional
> `start`/`end` window on `get_transcript`.
> **Mutates** — `delete_clip` / `delete_clips` (id-addressed, exact-span ranges
> derived in-process; batch ripples applied back-to-front so ranges stay valid),
> `remove_track` / `move_track` (→ `remove_layer`/`move_layer`).
> **Wipe guard hardened** — a call's deletes are judged in AGGREGATE per track
> (many narrow deletes that together clear a track = one wide wipe) and
> `remove_layer` of a populated track of pre-run work is rejected too.
> Agent contract now steers long-form runs to the compact reads and id-addressed
> deletes (`prompts.ts`).

- [x] **T1** TS registry: 3 new reads + windowed transcript + 4 new mutates; ai-sdk tests green
- [x] **T2** Wipe guard: per-call aggregate coverage + `remove_layer`; tests
- [x] **T3** Python mirror (registry/handlers/dispatch) + tests; parity green; ai_tools coverage held
- [x] **T4** `toolMeta` display entries; docs (`docs/api/ai-tools.md`, MCP guide/API); CHANGELOG
- [x] **T5** Python `Operation` union closed (2026-07-16): `add_layer`/`remove_layer`/`move_layer`, `set_effect_params`, and the v5–v8 styling ops (`set_caption_style`/`set_clip_speed`/`set_clip_crop`/`set_clip_blend_mode`) now have Pydantic models, apply + invert (round-trip tested), and `validate_patch` support incl. the TS `speed_duration_mismatch` invariant and `duplicate_layer`/`invalid_speed` codes. Engine 1013 tests, ruff+mypy green; new code fully covered.

## Discovered (2026-07-15) — Intelligent Silence Handling (speech-aware detection & cuts) — `[ ]` proposed

> **Sub-plan: [`plan/INTELLIGENT-SILENCE-HANDLING.md`](./INTELLIGENT-SILENCE-HANDLING.md)**
> — close the classic dB-threshold failure mode (quiet-but-real speech below the
> noise floor gets cut). Three deterministic signals cross-checked, no ML VAD, no
> new dependency: word-level transcript as speech ground truth, R128 loudness for
> a per-footage adaptive noise floor, `silencedetect` stays the level gate.
> Audit found the deterministic `remove_silence` recipe path has **no** transcript
> guard today (`synth_ripple_deletes` cuts every detected range verbatim), plus an
> asset-time/timeline-time conflation and a silently dropped `maxSilenceSeconds`
> recipe param — evidence in the sub-plan's §1 gaps table (SG1–SG6).

- [ ] **S1** Speech-guard core: pure `speech-guard.ts` — subtract padded transcript-word intervals from silent spans (trim/split/drop + honest typed report), 100% coverage
- [ ] **S2** Time-base mapping (asset→timeline via clip source in/out) + wire the guard into `synth_ripple_deletes`; fix the dropped `maxSilenceSeconds` param
- [ ] **S3** Adaptive noise floor: `noiseFloorDb: 'auto'` derived from brain-cached R128 loudness (resolved value in the cache `params_hash`); honest source-tagged fallback
- [ ] **S4** Engine-side `overlapsSpeech` annotation on silence ranges (asset-time ASR cache; serves MCP/raw-tool clients too) with TS↔Python parity fixture
- [ ] **S5** `speech_integrity` critique check — a patch that deletes spoken words fails verify on both the recipe and agent paths (enforced invariant, not prompt guidance)
- [ ] **S6** Skill/tool-description updates, guide + ADR + CHANGELOG, plan reconcile; e2e if the B7.4 sidecar-booting harness has landed (honest deferral otherwise)

## Discovered (2026-07-16) — Orchestration efficiency (Claude Code loop patterns) — `[x]` done (2026-07-16, all five phases E1–E5 + ADR 0060; DoD met, see sub-plan §4)

> **Sub-plan: [`plan/ORCHESTRATION-EFFICIENCY-CC-PATTERNS.md`](./ORCHESTRATION-EFFICIENCY-CC-PATTERNS.md)**
> — a study of the de-minified Claude Code orchestration loop (third-party
> source mirror; **patterns only, no ported code**) against our Conductor.
> We already match it on correctness (spin guard, budgets, checkpoint/resume,
> pinned skills); the gaps are efficiency: turn tool calls run strictly
> serially even for pure reads, history is only a rolling window (old read
> payloads ride along verbatim), the per-turn prompt prefix has no
> byte-stability guarantee (prompt-cache hostile), no token-delta
> diminishing-returns stop, and read-only routes advertise the full mutating
> tool surface. Five phases, `packages/ai-sdk`-scoped, desktop-first evidence.

- [x] **E1** Concurrent read/analysis batches in `executeToolCalls` (kind-based partitioning, bounded pool, serial mutations preserved, event-order golden test, perf evidence: 374ms → 123ms on a 3-read turn, 3.05×) — ADR 0060 (2026-07-16)
- [x] **E2** Micro-compaction tier in `compactAgentLog`: clear old read/analysis payloads in place (marker + read-memo re-read path) before the rolling window drops lines (2026-07-16)
- [x] **E3** Prompt-prefix cache stability: run-stable prefix assembled once (shared with repair pass), deterministic tool-descriptor sort, byte-stability golden tests; audit found + fixed steering-before-skills prefix break (2026-07-16)
- [x] **E4** Diminishing-returns stop in the Conductor reducer (consecutive low-token-delta, zero-op turns ⇒ honest "converged" completion, distinct from stall; legacy-loop parity mirror + parity-harness scenario) (2026-07-16)
- [x] **E5** Route-scoped tool surface: question/chat route advertises read/analysis/ask kinds only (audit: it was already toolless — now an enforced, tested ceiling); measured 5824→1775 est. tokens (−70%) vs full surface; deferred schemas verdict: not built (2026-07-16)

## Discovered (2026-07-18) — Visual embedding reliability + Settings control room — `[x]` complete

> Real footage indexing exposed a provider-contract mismatch: NVIDIA requires the
> `modality` list to match batched `input` cardinality. In parallel, Settings is
> being reorganized around editor tasks and system readiness while preserving the
> existing local preference/provider stores and project-safety boundaries.

- [x] **SR1** Enforce NVIDIA visual-embedding request cardinality and add regression coverage
- [x] **SR2** Redesign and implement every Settings section with responsive, accessible navigation and readiness feedback
- [x] **SR3** Verify focused engine/UI tests, typecheck, lint, visual states, docs, and CHANGELOG
      (35 Settings tests; 61 embedding/index-service tests; web typecheck/lint and
      Python Ruff green; browser-verified at 1280px, 700px, and 430px with no overflow)

- [x] **SR4** Compact wide-screen Settings layout: use the dialog's available width so Editing and Playback controls do not require avoidable scrolling
      (SettingsDialog: 36 focused tests; web typecheck + lint green; browser checked with two
      429px Playback cards and no panel overflow at the wide breakpoint)

## Discovered (2026-07-19) — Remove unsupported vision protocol — `[x]` complete

- [x] **VP1** Remove `extract_frames` and `commit_vision` from the Python engine registry
      and delete `/extract-frames` and `/commit-vision`.
- [x] **VP2** Remove the matching AI SDK schemas, sidecar routing, prompts, budget
      accounting, MCP delegation, and UI activity metadata; restore exhaustiveness parity
      for every remaining registry tool.
- [x] **VP3** Delete protocol-only tests and documentation; verify AI SDK, MCP, web-editor,
      and engine suites plus type checks. **Last updated:** 2026-07-19

## Discovered (2026-07-19) — Orchestrator edit/index reliability root-cause pass — `[x]` complete

> Real desktop evidence: a ~20-second beat-synced image edit repeatedly emits
> `add_clip` calls whose short timeline spans retain the image asset's default 5s
> source range, so validation rejects every operation and the run ends with zero
> edits. Visual-index reads for the same image also vary between a low-score safety
> placeholder and a useful scene caption. Audit the executable contracts first,
> then rewrite model-facing guidance only where it reduces remaining ambiguity.

- [x] **OIR1** Reproduce and prove the invalid `add_clip` construction/recovery path;
      move duration reconciliation into a deterministic, schema-validated boundary
      and add agent-stream regression coverage for sub-second beat intervals.
- [x] **OIR2** Trace visual indexing/caption persistence and retrieval ranking end to
      end; make placeholder safety captions non-authoritative and ensure useful
      indexed evidence is returned consistently, with engine/AI SDK regression tests.
- [x] **OIR3** Lead-prompt-engineer audit of the system contract, mode instructions,
      tool descriptions, context ordering, and failure recovery against the Cursor
      orchestration patterns; preserve a stable cacheable prefix and rewrite only
      evidence-backed prompt surfaces.
- [x] **OIR4** Verify focused suites plus typecheck/lint, update architecture/API docs,
      CHANGELOG, generated artifacts, and reconcile this plan with measured results.
      Focused AI SDK (320 tests) and engine (162 tests) suites pass; AI SDK/desktop
      typechecks, AI SDK build, focused Ruff, and strict mypy pass. Full `pnpm verify`
      reaches the pre-existing UI token assertions in `packages/ui/src/tokens.test.ts`
      (current dark/accent tokens differ from the test's expected rebrand values).
      **Last updated:** 2026-07-19

## Discovered (2026-07-19) — Exact analysis handoff + action recovery — `[x]` complete

> Desktop evidence: a 37-onset, non-uniform beat grid was truncated to 32 model-facing
> timestamps and the prompt incorrectly told the agent to reconstruct the missing
> onsets from BPM. The agent repeatedly requested the same timeline/assets/beat data,
> those memo-served reads made no progress, and the Conductor correctly—but
> prematurely—stopped before any mutation. The positional plan ledger then displayed
> read-only turns as completed edit steps, making the failed run look further along
> than it was.

- [x] **OAR1** Preserve every exact beat onset needed for editing; never synthesize a
      non-uniform detector result from average BPM, with short-clip and long-grid tests.
- [x] **OAR2** Add a deterministic action-recovery turn after cached-only repetition:
      narrow the advertised tools to mutation/ask tools and inject the next-action
      constraint without destabilizing normal prompt prefixes.
- [x] **OAR3** Make plan completion evidence-based: read-only/cached turns cannot check
      off an edit step; an applied validated patch advances the ledger.
- [x] **OAR4** Add stream/reducer regressions for the screenshot sequence, verify the
      affected packages, and update orchestration docs plus CHANGELOG. Full AI SDK:
      77 files / 1,495 tests pass; AI SDK typecheck, lint, build, and `git diff --check`
      pass. Full workspace `pnpm verify` remains blocked only by the pre-existing UI
      token assertions recorded in OIR4 above. **Last updated:** 2026-07-19

## Discovered (2026-07-23) — WorkspaceShell rail clamp on narrow windows — `[x]` complete

> Desktop evidence: on a narrowed window, `WorkspaceShell`'s `framepilot-body` grid
> gave both rails their full persisted pixel widths and let the center stage
> (program monitor/timeline) absorb the rest via `minmax(0, 1fr)` — with no floor,
> so the stage got squeezed to a sliver while the rails stayed full width.

- [x] **RC1** Add `clampRailWidthsToContainer` (`packages/ui/src/WorkspaceShell/useRailLayout.ts`):
      given the live container width (via `ResizeObserver`), shrink both rails —
      proportionally, never below their own `RAIL_BOUNDS` min, collapsed rails
      untouched — so together they never leave the center stage under
      `MIN_STAGE_WIDTH` (320px). Unmeasured (`Infinity`, e.g. jsdom) is a no-op.
- [x] **RC2** Wire the clamp into `WorkspaceShell.tsx`: measure `.editor-workspace`'s
      width and use the clamped widths for the grid column + both rails' inline
      `style.width`, instead of the raw persisted/collapsed widths.
- [x] **RC3** Give the Electron window a hard floor (`apps/desktop/electron/main.ts`,
      `minWidth: 900, minHeight: 600`) below the rails' own min-width floor so the
      OS-level resize can't get the layout into a state the clamp has no slack left
      to fix.
- [x] **RC4** Verify: `@framepilot/ui` unit tests (37/37, incl. 5 new
      `clampRailWidthsToContainer` cases), `@framepilot/web-editor`'s `Editor.test.tsx`
      regression gate (33/33) and full suite (633/633), typecheck + lint clean on
      `ui` and `desktop`. **Last updated:** 2026-07-23

## Discovered (2026-07-23) — Agent-run step-local activity stream — `[~]` automated work complete

> An agent run is one event turn but many model/tool steps. Keep its activity legible:
> give each step its own thinking record in chronological order, and reserve the plan
> checklist for runs that actually drafted a bounded plan instead of growing one row per
> turn.

- [x] **AS1** Emit and settle reasoning by step key; suppress the synthesized plan ledger
      for unplanned runs, with AI SDK stream/parity coverage.
- [x] **AS2** Polish the AI sidebar's ordered reasoning/tool sequence, add renderer/sidebar
      regressions, and reconcile ADR, sidebar/orchestration plans, and changelog. Focused UI
      (92), AI SDK (1,609), full workspace/browser e2e, and `pnpm verify` are green.
- [ ] **AS3** Manual desktop acceptance on a minutes-long local file: verify multiple
      step-local thinking accordions stay interleaved with their tool cards, an unplanned
      run has no checklist, and Plan first keeps a bounded checklist. Requires a running
      desktop session and user media. **Last updated:** 2026-07-23

## Discovered (2026-07-25) — Project-scoped chat history + responsive editor surfaces — `[~]` implementation complete

> AI conversations are currently stored app-wide without a project identifier, so
> every project can display every conversation. The Transcript rail also forces
> four-word rows, monitor view controls overload the bottom transport, and the
> Assets header can clip when the resizable rail becomes narrow.

- [x] **PSU1** Add explicit project ownership to conversation records and enforce it
      at persistence load/save boundaries, with legacy unscoped records hidden
- [x] **PSU2** Mount monitor view controls into the right side of the shared
      Source/Program header and keep playback centered below the picture
- [x] **PSU3** Use naturally wrapping transcript lines and make the Assets header
      restructure cleanly at narrow rail widths
- [~] **PSU4** Regression coverage, web-editor typecheck/lint, production builds,
  docs, and changelogs are complete. Full workspace TypeScript verification
  passes (web editor: 99 files / 1,306 tests); `pnpm verify` reaches 1,412/1,413
  Python tests and is blocked only by the unrelated existing
  `test_transcribe_falls_back_to_whisper_when_asset_not_indexed` environment
  expectation (422 returned vs 503 expected). **Last updated:** 2026-07-25

## Foundational initiative (2026-07-23) — Durable orchestration engine + synchronized AI workspace

> Architecture review: `docs/reports/2026-07-23-orchestration-workspace-architecture-review.md`.
> Target architecture: `docs/architecture/orchestration-execution-engine.md`.
> Canonical execution plan: [`plan/ORCHESTRATION-FOUNDATION-INITIATIVE.md`](./ORCHESTRATION-FOUNDATION-INITIATIVE.md).
> Proposed decision: ADR 0073. This initiative supersedes remaining orchestration work
> scattered across older sub-plans; those remain historical records.

- [x] **OF0** Map the current desktop/browser/MCP execution paths, context flow,
      controls, events, persistence, patch review/apply, recovery, and scale boundaries.
- [x] **OF1** Produce a risk-ranked architectural assessment with source evidence.
- [x] **OF2** Define the target execution engine: one authority, durable run WAL,
      typed command/event protocol, universal Effect Runtime, revisioned project commits,
      task-graph fast/complex paths, synchronized `RunView`, and production SLOs.
- [x] **OF3** Create an incremental F0–F8 implementation plan with verification and
      rollback-friendly exit gates.
- [~] **OF-T0** Restore real transcription end to end: invoke the configured ASR
  provider in the trusted host, apply non-empty results through `set_transcript`,
  synchronize workspace progress/errors, and make the agent use that same execution
  path instead of supplying `words: []`.
- [x] **OF-T0.1** Add the deferred functionality-first implementation now; record new
      transcription coverage as explicit next-round work while still running focused
      existing checks required by repository policy.
- [ ] **OF-T0.2** Next round: add dedicated desktop/UI/agent/MCP regression coverage,
      exercise live local/Groq/NVIDIA media fixtures, and run the full verification matrix.
- [~] **OF4** Execute F0 — contract freeze and failing cross-surface evidence.
- [~] **OF5** Execute F1 — durable run service and full-duplex desktop controls.
- [x] **OF5.1** Fix durable-run lifecycle reliability: separate renderer detach from
      intentional Stop, make cancellation origin mandatory and auditable, classify
      timeout/interruption/failure distinctly, surface terminal reasons on recovery,
      guarantee a canonical terminal event/snapshot projection, and checkpoint stream
      snapshots without rewriting one for every token event. Focused protocol/desktop/UI
      suites (135 tests), affected typecheck/lint, full workspace typecheck/lint/tests,
      production web build, and 39 browser e2e tests pass. `pnpm verify` reaches 1,412 /
      1,413 engine tests and stops only at the pre-existing unrelated TwelveLabs fallback
      expectation (expected 503, received 422). **Last updated:** 2026-07-25
- [x] **OF5.2** Prevent desktop auto-commit project refreshes from replacing the visible
      running AI conversation with an empty new chat. Restore the durable run's owning
      conversation as the active selection on renderer recovery, retain cancellation
      authority across detach, and add remount/recovery regression coverage. Focused
      sidebar/session tests (60), all web-editor tests (1,312), workspace typecheck/lint/
      package tests, 39 browser E2E tests, editor + website production builds pass.
      `pnpm verify` reaches 1,412 / 1,413 engine tests and stops only at the pre-existing
      unrelated TwelveLabs fallback expectation (expected 503, received 422). **Last
      updated:** 2026-07-26
- [x] **OF5.3** Bound model-facing project reads and desktop transport events so undo
      history or other bulky tool results cannot inflate the durable WAL or exhaust the
      Electron main-process heap; detach subscriptions safely when a renderer frame is
      disposed between its liveness check and IPC send. Add captured-shape regression
      coverage and update lifecycle diagnostics. The source projection strips undo history
      and render media; renderer AI requests also omit history while host refresh preserves its
      authoritative copy. Expandable tool payloads are capped at 256 KiB, the WAL at 64 MiB,
      and legacy oversize state quarantines before parse. A live run now loads its validated
      WAL once and appends against an O(1) index instead of reparsing it twice per token;
      terminal indexes evict. Disposed send races detach once. The reported TimelineView/
      Editor Fast Refresh invalidations are removed. Full `pnpm verify`, website typecheck/
      build, and diff hygiene pass; web-editor 2,305, browser E2E 75, engine 2,237 with one
      intentional skip. **Last updated:** 2026-08-03
- [~] **OF6** Execute F2–F8 — runtime consolidation, project revisions, canonical DAG,
  workspace projection, scale, hardening, and legacy-path deletion.
  **Last updated:** 2026-07-23
- [~] **OF7** Agent task memory and execution continuity — detailed design for gate F6
  (context/memory/scale) and the recovery half of F7. Traced a production run that
  re-oriented itself for 3,430 events and applied nothing: the model's only memory of
  prior turns is a rolling `string[]` whose payloads compaction deletes with
  `[old result cleared — re-read if needed]`, while the read memo answers the
  resulting re-read with "already in your context" and routes the payload to the UI
  instead of the model — a deadlock with no recovery path. Introduces a durable
  `RunWorkingState`, an evidence store with targeted `recall_evidence`, a
  nine-stage forward-only task machine, a decision ledger, semantic loop detection,
  a meaningful-progress requirement, revision-scoped invalidation, and a
  streaming/orchestration event split.
  **Full plan in [`plan/AGENT-TASK-MEMORY.md`](./AGENT-TASK-MEMORY.md)**; ADR 0075.
  Complements ADR 0074, which added the behavioral rail for the same run.
  Phases M0–M4 are implemented on `feat/agent-task-memory` with the full workspace
  green (16 packages; ai-sdk 1,869 tests) and every new deterministic module at 100%
  coverage. Deliberately deferred: semantic distillation (a heuristic would produce
  confident wrong facts), and with it the decision ledger's population and M5's
  objective-driven incremental verification; M6's stream/orchestration event split is
  independent and untouched. **Last updated:** 2026-07-26

## Discovered (2026-07-28) — run-state causal integrity and safe recovery — `[x]` done

- [x] **RSI1** Trace and close every path that permits apply/verify/completion without a
      durable normalized objective, explicitly committed execution plan, decision-bound
      operation ledger, matching run/project identity, and evidence-backed deliverable
      verification. Block mutation on integrity loss, recover only from authoritative
      persisted state, preserve retry/reload/compaction continuity, prevent duplicate
      operations, and surface structured diagnostics in the editor. Functional implementation
      landed on `codex/fix-run-state-integrity`; the 30 deferred assertions RSI2 closes out
      below were the last blocker and are now resolved. ai-sdk is 2,082/2,082, desktop is
      242/242, web-editor is 1,351/1,351. **Last updated:** 2026-07-29
- [x] **RSI1a** Fix the one desktop `ai-stream` failure named above (root cause, not a test
      change): `onVerifyResult` in `packages/ai-sdk/src/kernel/conductor.ts` gated the run's
      own causal completion (`verificationPassed`, ADR 0081 — did a real, decision-traceable
      mutation land) on the Critic's separate content report (`r.ok`, ADR 0022 — duration/
      export/caption/safe-area/asset checks, explicitly informational: "warnings inform, they
      don't block"). A run that validated, applied, and traced a real edit to its committed
      plan was denied its own "Applied N edits" summary and finalized `failed` solely because
      an aspirational caller-supplied target (e.g. a duration/platform the model's tools
      cannot invent their way to) went unmet — the Critic's findings were already surfaced
      unconditionally as `notification`/`warning` events, so this doubled as a silent,
      redundant hard-fail. `verificationPassed` is now `planReconciled && deliveredWork`
      (a real succeeded, plan-traceable operation), independent of `r.ok`; the Critic report
      is untouched. Fixes `apps/desktop/electron/ai/ai-stream.test.ts`'s `maps a target
platform through agentOptions` (desktop is now 242/242); ai-sdk's full suite goes from
      2,045/2,078 to 2,048/2,078 (3 more of the RSI2-deferred assertions below now pass, with
      no new failures — confirmed by diffing the full failing-test list before/after).
      `pnpm typecheck`/`pnpm lint` pass for `ai-sdk` and `desktop`. **Last updated:** 2026-07-28
- [x] **RSI2** Resolved the 30 assertions RSI1 deferred (they blocked PR #110's CI) by
      auditing each one against ADR 0081 rather than restoring old expectations wholesale.
      24 of the 30 were confirmed **stale** — the pre-RSI1 "model stops calling tools ⇒
      completed" behavior ADR 0081 explicitly retired: `onVerifyResult`'s
      `verificationPassed = planReconciled && deliveredWork` (unchanged) and
      `working-state.ts`'s own `stageEntryViolation` (entering `verify` requires a
      succeeded operation; `complete` requires `isDelivered`) both already enforce that a
      run without a landed, traceable edit ends `failed`, never `completed` — by design,
      not by omission. Updated the 24 (`orchestrator-stream.test.ts` ×19,
      `orchestrator-auto.test.ts` ×1, `kernel/parity.test.ts` ×4) to assert `failed` with a
      comment naming the ADR 0081 reason, and regenerated the frozen golden snapshot
      (`kernel/streamAgent-golden.test.ts.snap`) to capture both the same status change and
      the new `run_state` projection events ADR 0081 added at every reducer boundary.
      3 were genuinely stale in a different way (a real behavior change RSI1 made on
      purpose, just not yet reflected): `kernel/conductor.test.ts`'s empty-drafted-plan
      fold, cancelled-approval effect shape, and stale-resume fold now assert the actual
      RSI1 behavior (an empty plan or an unreplayable checkpoint pauses for integrity
      review instead of silently falling through/restarting) — see the two genuine code
      fixes below for the messaging bug this surfaced. 1 was a straight version bump
      (`working-state.test.ts`'s pinned `WORKING_STATE_SCHEMA_VERSION`, 1 → 2, matching
      the v1→v2 migration ADR 0081 already ships in `migrateWorkingState`) — added 4 new
      migration tests (`kernel/working-state.test.ts`) since that path had zero coverage:
      restoring a legacy plan from a committed decision, orphaning an untraceable succeeded
      operation outside a committed plan, not flagging a legacy record for review outside an
      execution stage, and confirming a genuinely-v2 (or unknown-version) record is left
      alone. 2 genuine code fixes, both in `conductor.ts`, found while investigating the
      conductor.test.ts trio above: (1) `finalize` could emit BOTH a specific integrity
      warning (e.g. "Run paused before editing: the planning turn produced no executable
      decisions") AND the generic "reviewed the footage but never made a change" notice for
      the same event — the second was also factually wrong when no turn had run yet; now
      suppressed whenever this fold already pushed its own warning. (2) The stale-resume
      path's own handler notice in `orchestrator.ts` still said "starting over" after RSI1
      stopped the run from actually doing that — reworded to "pausing for reconciliation".
      No behavior was reverted from the intentional RSI1 design; only test expectations were
      corrected and two messaging bugs were fixed. Final counts: ai-sdk 2,082/2,082 (0
      failed, up from 2,048/2,078 — 4 net new tests, the working-state migration coverage),
      desktop 242/242, web-editor 1,351/1,351; `pnpm typecheck`/`pnpm lint`/`pnpm test` all
      green repo-wide (root `turbo run test/lint/typecheck --concurrency=1`). ai-sdk's own
      `test:coverage` 100%-threshold gate (not part of `pnpm verify`, which uses plain
      `pnpm test`) still fails on pre-existing gaps in `working-state.ts` (89%),
      `invariants.ts` (95%), `plan-driver.ts` (96%), `stage-policy.ts` (95%), and one
      unrelated pre-RSI1 line in `conductor.ts` (99.84%) — all inherited from RSI1's
      original implementation (verified unchanged by diffing coverage-relevant code before/
      after this task's edits) and explicitly in scope for a full RSI2-style coverage pass
      ("transition-guard, persistence-failure, out-of-order write, snapshot/WAL recovery,
      compaction, retry, reload, idempotency, stale-revision, intent-verification,
      false-completion, cancellation... coverage") rather than this specific fix. Flagging
      rather than backfilling silently: closing that gap is real, additional test-writing
      work, not something implied by "make the 30 failing assertions pass."
      **Last updated:** 2026-07-29

## Discovered (2026-07-28) — planned-edit bindings and compact plan dock — `[x]` done

- [x] **PEB1** Make validated DAG dependencies the canonical upstream binding for pure
      planned-edit leaves, normalize omitted bindings before execution, reject conflicting
      bindings at compile time, and cover the reported montage assembly path. The exact
      planner → proposal → assembly → validation → verification integration passes with
      `assemble_patch.args.from` omitted; focused ai-sdk coverage is 89/89.
- [x] **PEB2** Move the latest plan out of the scrolling activity thread into a compact
      header-adjacent accordion: collapsed shows the most recently active step, expanded
      shows the full ledger, with keyboard and screen-reader state preserved. Web-editor
      typecheck/lint and all 1,349 tests pass; website typecheck/build also pass. The full
      ai-sdk count is 2,004/2,037 with the same 33 RSI2 deferred contract assertions present
      before this task and no new failures. **Last updated:** 2026-07-28

## Discovered (2026-07-28) — empty planned edits and scheduler-task accordion — `[x]` done

- [x] **EPT1** Treat an empty `propose_edit` result as a rejected mutating proposal, feed
      the exact failure back through the bounded correction path, and fail the task/run if
      it remains empty. Never assemble, verify, or terminally complete a no-op as though
      the requested montage landed. Exact empty→repair and empty→empty integration paths
      pass through the real planner driver and streaming orchestrator.
- [x] **EPT2** Convert `TaskRunView`—the real checklist emitted by planned DAG runs—into a
      header-docked accordion that resets collapsed for every run, previews the most recent
      task, and reveals the full concurrent/settled task set only when expanded. Web-editor
      typecheck/lint and all 1,350 tests pass. AI SDK focused coverage passes 77/77 and its
      full suite is 2,007/2,040 with the same 33 deferred RSI2 assertions; desktop remains
      241/242 with its same deferred false-completion expectation. **Last updated:** 2026-07-28

## Discovered (2026-07-28) — planned proposal identity and semantic trust boundary — `[x]` done

- [x] **PIS1** Give EditProposer an explicit, exhaustive project identity catalog that
      separates valid asset ids from valid track ids, including the field-level contract
      that these namespaces are not interchangeable.
- [x] **PIS2** Validate the complete proposed operation batch against the working project
      before accepting the model task; return actionable validator issues through a bounded
      correction turn and retain assembly-time validation as defense in depth.
- [x] **PIS3** Make any defense-in-depth assembly rejection report its validation issue,
      verify the empty → wrong identity → corrected live regression, and update architecture,
      product changelogs, and focused/full verification evidence. Focused driver/proposer/
      assembly/stream/prompt suites pass 139/139; AI SDK typecheck and lint pass. The full
      AI SDK suite is 2,010/2,043 with exactly the same 33 deferred run-state assertions
      present before this task and no new failures. Website typecheck and production build
      pass with the updated customer changelog. ADR 0084. **Last updated:** 2026-07-28

## Discovered (2026-07-28) — multi-stage planned-edit working state and terminal closure — `[x]` done

- [x] **MPC1** Project every validated ancestor assembly into downstream model/analysis
      context so polish steps can reference the clips created earlier in the same DAG.
- [x] **MPC2** Canonicalize model-authored plans so every typed mutation flows through one
      final combined assembly and terminal verification, including plans that incorrectly
      end on `propose_edit` after an earlier verify.
- [x] **MPC3** Harden structured proposal recovery for common provider wrappers without
      accepting arbitrary prose, cover the reported 12-step assembly→verify→polish shape,
      audit adjacent lifecycle gaps, and update docs/changelogs with verification evidence.
      Focused compiler/driver/proposer/prompt suites pass 128/128; the exact multi-stage
      stream regression passes both successful polish and empty→prose→empty exhaustion.
      AI SDK typecheck and lint pass; its full suite is 2,022/2,055 with exactly the same
      33 deferred run-state assertions as the pre-task baseline and no new failures. The
      full web-editor suite passes 1,351/1,351; web-editor typecheck/lint pass. Website
      typecheck and production build pass. ADR 0085. **Last updated:** 2026-07-28

## Discovered (2026-07-28) — the beat-grid rule blocked the montage it was meant to enforce — `[x]` done

**Symptom (reported run):** "cut on every drum hit, reuse clips by trimming" failed three
different ways in a row — `propose_edit: Error: beat-backed add_clip boundaries must use
detected onset times; off-grid: 30`, then `model response was not valid JSON`, and (in the
first, "successful" run) a montage whose clips were spaced uniformly at 1.5s and did not
follow the music at all.

**Root cause — one over-broad assertion plus one hardcoded reply cap.** The private beat
rule in `plan-driver.ts` checked every `add_clip` boundary regardless of track type, so the
music bed's own `0 → 30` placement and the montage's final frame could never be on-grid; it
derived its grid only from clips already on the timeline, so a bed placed by the same
proposal made the rule silently vanish; and it rejected near-misses without naming a legal
onset. Independently, the Anthropic adapter sent `max_tokens: 2048` on every request, which
truncated a ~60-call proposal into invalid JSON.

- [x] **BG1** Extract the rule to `kernel/beat-grid/beat-alignment.ts`: picture tracks only,
      `trim_clip`/`split_clip` included, outer boundaries exempt only outside the grid's
      range, interior near-misses snapped onto real onsets with `sourceEnd` re-derived, real
      misses rejected with the nearest legal onset named, and an unresolvable grid refused
      (recovered from a placement in the same proposal) instead of silently passing.
- [x] **BG2** Give `AiCompletionRequest` an optional `maxTokens`, reserve proposal-sized
      reply room in EditProposer, and honor it in the Anthropic adapter clamped to the
      selected model's real output ceiling.
- [x] **BG3** Make the correction turn actionable (copy a named replacement value verbatim,
      keep the unobjected parts), stop leaking `Error:` into the editor's failure text, and
      document that `add_clip` derives `sourceEnd` itself so reuse-by-trimming goes through
      `sourceStart`. New `beat-alignment` suite passes 18/18 at 100% statement/branch/
      function/line coverage; the previously failing beat-synchronization regression in
      `orchestrator-auto` now passes. AI SDK typecheck and repo-wide lint/typecheck pass;
      the full AI SDK suite is 2,045/2,078 with exactly the same 33 deferred run-state
      assertions as the pre-task baseline, and the one desktop `ai-stream` failure is also
      unchanged from baseline — no new failures anywhere. ADR 0086.
      **Last updated:** 2026-07-28

---

## Discovered (2026-07-27) — the run's memory was switched off by two drifted allowlists — [x] done

**Symptom (reported runs):** the agent re-read the timeline, re-browsed the media bin,
re-detected the beat, re-indexed media and re-mapped footage over and over inside a single
run, re-orienting itself every few tool calls and burning tokens reconstructing context it
had already paid for. Reported as "a fundamental flaw in the orchestration architecture".

**Root cause — the architecture was already there and correctly built; two hand-maintained
tables that gate it had fallen behind the 62-tool registry, and both default unlisted tools
to the value that disables memory.**

- [x] **`kernel/stage-policy.ts` kept local INSPECTION/ANALYSIS/GUIDANCE allowlists.**
      Anything unlisted became role `other`, and `briefing.ts#distil` deliberately records
      no fact for `other` — so the tool's finding never reached the briefing's
      "ESTABLISHED — do not gather again" section, and the model had no memory that it had
      run. `stageAllowsRole` also lets `other` through during execution, so those tools
      stayed callable after the plan locked. Missing: `detect_beats`, `index_media`,
      `describe_footage`, `transcribe`, `get_project_state`, `get_timeline_map`,
      `map_time`, `list_edit_boundaries`. Three listed tools no longer exist.
- [x] **`kernel/evidence-store.ts` kept a local REVISION_INDEPENDENT allowlist.** Anything
      unlisted became `timeline_dependent` and was evicted by `invalidate()` on **every**
      applied patch — and `working-state.ts#onProjectRevisionChanged` dropped the matching
      facts with it. Missing: `detect_beats`, `index_media`, `describe_footage`,
      `find_similar`, `list_assets` (adding a clip does not add an asset).
- [x] **The two failures compound exactly where the user saw them.** `detect_beats` was
      absent from _both_, so a beat-synced montage — which applies one cut per beat —
      recorded no fact about the beat map and lost the payload to the very first cut. No
      memory, no cache, no `recall_evidence` handle: the only way forward was to run
      `detect_beats` again. Then again after the next cut. The `beat-synced-editing`
      playbook declares five of the misclassified tools among its sixteen.
      → Replaced both with one explicit table in `packages/ai-sdk/src/tool-classification.ts`
      covering every registered tool, parity-tested against `TOOL_REGISTRY` in **both**
      directions so a new tool fails CI until it is classified — the decision can no longer
      be made by omission, which is what let this rot silently. Added
      `asset_dependent`/`transcript_dependent` store scopes so the bin and transcript
      invalidate on the operations that actually change them; both narrow to
      `revision_independent` for facts, so no working-state schema change.
- [x] **The run-stable prompt head was never cacheable.** `agentStableInstruction` (E3.2)
      memoizes the contract + committed plan + pinned playbooks to be byte-identical across
      a run, but `agentMessages` emitted it **after** `buildContext`'s project block, which
      re-renders the timeline summary from the mutating working copy. Every applied patch
      changed the prefix ahead of the head and re-billed all of it — up to eight pinned
      playbooks — which is also the reported token fluctuation. The Anthropic provider only
      broke on the system block and the tool array, its comment assuming anything in a user
      message was per-turn volatile. → The head is now its own message between the
      system/history prefix and the turn-varying tail, flagged `cacheBoundary`; the provider
      places a second breakpoint at its end. Advisory: providers without prompt caching
      ignore it, and a wrong value costs cache efficiency, never correctness.

**Verification:** the montage case is pinned as behaviour, not table contents — thirty
consecutive cuts leave the beat map, media index, bin listing and shot descriptions intact
and recallable, while `add_asset` still drops the bin; and `apply`/`enhance`/`repair` now
withhold `detect_beats`/`index_media`/`describe_footage`/`transcribe` while keeping
`get_timeline` and `recall_evidence` open. Prompt stability is pinned by a test asserting
the head message is byte-identical across a mutating turn and contains no timeline block.
The frozen golden event stream is unchanged; its prompt is **338 tokens smaller**, because
executing runs now correctly withhold re-analysis tools. Workspace green (`pnpm verify`,
16/16; ai-sdk 1,917 tests); ai-sdk coverage matches the main baseline on all four metrics.
ADR 0079.

**Deliberately not done:** the larger redesign items in the report that this repo already
implements (run working memory, the stage machine, plan locking, evidence recall, loop
detection, recovery-without-restart) were reviewed and left alone — they were not the
defect. Semantic distillation stays deferred for the reason recorded under OF7.

---

## Discovered (2026-07-26) — captions landed at source timestamps; completion was asserted, not verified — [x] done

**Symptom (reported run):** an agent shortened a video correctly, then reported captions
and transitions as complete. Neither was. The captions carried **source** timestamps, so
speech from 197s of the camera file was captioned at 197s on a ~92s edited sequence; the
transition sat where there was no cut. Every operation had returned `applied`.

**Root cause — three independent gaps, all invisible in a simple project:**

- [x] **No source↔sequence mapping existed anywhere.** `Project.transcript` was a flat,
      unattributed `{word,start,end}[]` and every consumer read its timestamps as
      sequence time — true only for one untrimmed clip at t=0, which is the state a
      project is in _before_ anyone edits it. Both caption generators
      (`apps/web-editor/src/editor/captions.ts`, `kernel/recipe-leaves.ts`) segmented the
      raw transcript and wrote the result straight onto the track; the panel received the
      timeline and used it only to find clips to clear. With no tool to ask, the agent
      did the arithmetic in prose — per-segment offsets — which breaks on speed changes,
      reused ranges, straddling words, and any edit made after the sums.
      → `packages/editor-core/src/timeline-map.ts` (the only place that converts;
      source→sequence returns a **list**, because a moment can be cut or reused) and
      `captions/derive.ts` (map → drop deleted → group into runs that never cross a cut →
      segment each run → clamp). Segmentation itself untouched (ADR 0071).
- [x] **Nothing could detect staleness.** Schema v12 adds `TranscriptWord.assetId`
      (+ `confidence`/`speaker`), `timeline.revision`, and cue
      `derivedFromRevision`/`source` provenance, with a v11→v12 migration that attributes
      single-asset transcripts and refuses to guess for multi-asset ones. `applyOperation`
      bumps the revision gated on a **comparison of the mapping**, not an allowlist of
      "structural" ops — an allowlist containing `delete_range` would mark every caption
      stale the instant it was written, since generation clears old cues that way. The
      counter moves forward through undo rather than rewinding, so it can only
      over-report staleness.
- [x] **Nothing could contradict a completion claim.** No `verify_*` tool existed in the
      59-tool registry. Added `verify_captions`/`verify_transitions` (read committed
      state, report concrete issues), the read tools that replace the arithmetic
      (`get_timeline_map`, `map_time`, `get_mapped_transcript`, `list_edit_boundaries`),
      and an agent contract that names the two timebases, bans the conversion, states the
      cuts→captions→styling→transitions order, and requires "applied but not verified"
      when verification did not run. `get_transcript` had documented its window as
      "timeline seconds"; corrected.
- [x] **Transitions could be added where no cut exists.** `add_transition` stamped its
      effect onto any clip id. `listEditBoundaries`/`transitionEligibility` now check
      adjacency, track and order, and `applyOperation` refuses. Deliberately **not**
      gated on source handles: `render/transitions.py` ramps the incoming clip's own
      first seconds, so this engine borrows nothing from beyond the cut and a handle gate
      would have refused transitions it renders correctly — including the timeline UI's
      default drop. Handles are still reported, as the difference between blending two
      shots and fading through black.

**Verification:** the reported scenario is pinned as a test — the six retained ranges
(6.86–19.5, 28.5–53.45, 110–119.5, 132–142, 155–170, 197–208) rippled into a continuous
timeline — asserting only retained speech is captioned, cues sit at real sequence
positions, none spans a cut, and reorder/trim/speed/multi-asset/reload all move the
captions with the footage. `verify.test.ts` pins that the exact broken output is
_detected_. Workspace green (16 packages; editor-core 449, ai-sdk 1,883, web-editor 1,312);
engine 1,412 passing with one pre-existing twelvelabs failure that fails identically on a
clean tree. ADR 0076; schema v12.

**Deliberately not done:** frame-level playback verification (verification reads timeline
state, not rendered pixels — it catches everything in the reported failure, but "visible
in playback" is still proven by a render); nested/compound sequences, which the schema
does not model — `buildTimelineMap` is the one place that must learn to flatten them when
they arrive. **Last updated:** 2026-07-26

## Discovered (2026-07-26) — live asset inventory for AI turns — `[x]` complete

- [x] **BXR1** Make every AI turn capture the editor's current timeline/assets/folders at
      execution time, then prove `list_assets` sees newly imported media through the real
      sidebar/session request path.

## Discovered (2026-07-26) — beat-sync execution routing — `[x]` complete

- [x] **BXR2** Give analysis-dependent beat synchronization its own classifier route into
      the bounded planned-edit executor, and prove a detected non-uniform beat grid produces
      validated, reversible `add_clip` operations on exact detected boundaries. Reject
      off-grid model proposals at the plan driver and consume the bounded repair path.
- [x] **BXR3** Update architecture documentation and changelog, then run focused and
      workspace verification. Full TypeScript typecheck, lint, unit/integration suites,
      builds, and 39 browser e2e tests pass. Engine: 1,412 / 1,413 tests pass; the only
      failure is the pre-existing unrelated TwelveLabs transcription expectation already
      recorded above (expected 503, received 422). **Last updated:** 2026-07-26

## Discovered (2026-07-26) — live context window — `[x]` complete

- [x] **CWR1** Surface the currently running model call's context occupancy as a compact
      ring immediately left of the AI sidebar Send/Stop control, with used/total tokens
      plus the exact remaining count on hover and an accessible text equivalent.
- [x] **CWR2** Add contract/UI regression coverage and update architecture,
      provider guidance, developer changelog, and customer changelog.
      AI SDK (1,886), web editor (1,310), desktop (242), and browser E2E (40) tests pass;
      workspace TypeScript typecheck/lint, website/editor production builds, and
      `git diff --check` pass. The TwelveLabs-to-local-ASR regression no longer depends
      on Whisper being absent from the developer machine; `pnpm verify` is fully green,
      including all 1,413 engine tests. **Last updated:** 2026-07-27

## Discovered (2026-07-26) — Ollama compatibility + planner fallback continuity — `[x]` complete

- [x] **OPF1** Negotiate unsupported Ollama sampling parameters safely: retry an explicit
      `temperature` deprecation/unsupported 400 once without that field, remember the
      capability for the provider instance, and preserve cancellation/error contracts.
- [x] **OPF2** Restore automatic planned-edit → sequential-agent continuation for requests
      whose bounded DAG is unparseable, uncompilable, or unsupported;
      preserve the original request, controls, context, cancellation, and all real usage.
- [x] **OPF3** Harden long-video orchestration with bounded semantic context, analysis-
      first fallback behavior, regression/golden/E2E coverage, documentation, and
      changelogs. Do not claim pixel-perfect review without render evidence.

## Discovered (2026-07-27) — single-provider orchestration continuity — `[x]` complete

- [x] **SPO1** Remove model-tier routing from Settings, browser/desktop persistence, IPC,
      environment configuration, provider factories, and user-request dispatch.
- [x] **SPO2** Make the selected active provider own classification, planning, agent work,
      and repair end to end; retain tier labels only as non-routing cost metadata.
- [x] **SPO3** Verify cancellation, fallback, long-video context, provider compatibility,
      docs/ADR/changelog accuracy, and release readiness after the consolidation. AI SDK
      (1,886), web editor (1,310), desktop (242), and browser E2E (40) tests pass; workspace
      typecheck/lint/tests, website/editor builds, license scan, and `git diff --check` pass.
      `pnpm verify` is fully green, including all 1,413 engine tests; the formerly
      environment-dependent TwelveLabs-to-local-ASR fallback regression is deterministic.
      **Last updated:** 2026-07-27

## Discovered (2026-07-28) — ai-sdk coverage-gate closure (RSI2 follow-up) — `[x]` complete

- [x] **CGC1** Close `packages/ai-sdk`'s `pnpm test:coverage` gate to 100%/100%/100%/100%
      (was 98.77% lines / 98.52% branches), adding ~150 targeted tests across
      `conductor.ts`, `plan-driver.ts`, `plan-compiler.ts`, `working-state.ts`,
      `context/invariants.ts`, `stage-policy.ts`, `tool-registry.ts`,
      `semantic-index-slice.ts`, `proposers/types.ts`, `providers/ollama.ts`, `verify.ts`,
      `evidence-store.ts`, `recipe-leaves.ts`, and `orchestrator.ts`. Found and fixed two
      real bugs surfaced by the gap-hunting: `migrateWorkingState` dropped a legacy
      operation's `atRevision` field on migration (schema-invalid record), and
      `streamPlannedEdit`'s hardcoded "starting over" resume-failure text had drifted from
      the RSI1 "pausing for reconciliation" behavior already implemented in
      `conductor.ts#onResumeResult` (a stale golden snapshot masked the mismatch).
      Genuinely unreachable defensive branches (confirmed via exhaustive call-site
      tracing, not guesswork) are marked with `/* v8 ignore */` and a reasoning comment.
      `packages/ai-sdk` 2,166/2,166 tests pass (up from 2,082); `apps/desktop` 242/242;
      workspace typecheck/lint clean. **Last updated:** 2026-07-28

## Discovered (2026-07-30) — a provider outage read as "Done — no further edits." — `[x]` complete

Live run (`landspace nature`, Ollama-compatible gateway at 127.0.0.1:8317): the gateway
returned 529/503 on the classifier, then accepted the agent stream and closed it with an
error frame. The SSE parsers skipped that frame, so the turn came back with no text and no
tool calls — which the run read as a voluntary finish. The creator saw "Done — no further
edits.", an "Instant · no AI needed" cost chip, an untouched timeline, and a bare Retry
button, while the run itself settled `failed` on verification.

- [x] **POF1** Classify an in-stream SSE error frame as a typed `ProviderError`
      (`providers/errors.ts#classifyStreamError`) and throw it from BOTH parsers
      (`parseOpenAiSse`, `parseAnthropicSse`), so `ResilientProvider` retries it before the
      first chunk instead of the run inheriting a silent empty answer.
- [x] **POF2** Treat a turn with neither prose nor a tool call as a failed turn, not a
      finished run (`orchestrator.ts#runTurn`): no fabricated "Done — no further edits.",
      a retryable error card when nothing landed, and a warning that KEEPS the edits when
      earlier turns already applied work.
- [x] **POF3** Make a `failed` run always explain itself (`conductor.ts#finalize`): a
      voluntary finish that still fails verification now states that nothing was applied and
      the timeline is unchanged, instead of leaving the model's prose as the only account.
- [x] **POF4** Stop captioning a failed run with a cost chip (`AiSidebar`): a dropped request
      reports no usage, so a $0 total read as the deterministic "Instant · no AI needed".
- [x] **POF5** Stop warning `working state dropped — unparseable` for an ABSENT record
      (twice per run from `run-coordinator`'s projection check), which had trained the log to
      cry wolf over a real dropped ledger.
      Tests: new `classifyStreamError` unit battery, error-frame tests for both parsers +
      `OllamaProvider.stream`, empty-response tests in `orchestrator-stream`/`parity`
      (golden snapshot updated), the failed-run notice in `conductor.test.ts`, and a
      no-chip-on-failure test in `AiSidebar.test.tsx`. `packages/ai-sdk` 2,180 tests with
      the coverage gate at 100/100/100/100; web-editor 1,355; desktop 242; workspace
      typecheck/lint clean. **Last updated:** 2026-07-30

## Discovered (2026-07-30) — orchestration continuity, activity ownership, and stable context — `[x]` complete

Live exported run: a 30-second beat-aligned montage repeatedly re-read the same timeline
evidence, applied only partial batches, stopped after validation/render failures, and
reported aggregate edits without completing the creator's objective. The same report
showed historical thought nodes inheriting the active thinking state, run status in the
sidebar header, chat/context instability across panel navigation, and incomplete model
capability matching for `glm-5v-turbo`.

- [x] **OAC1** Reproduce and prove the core orchestration/context root causes, then fix
      objective continuity, bounded recovery, and large-project completion at the owning
      layer rather than adding UI or prompt workarounds.
- [x] **OAC2** Give each reasoning/activity node immutable lifecycle ownership and move
      live generating/thinking/tool status into an animated composer-adjacent activity
      surface; remove mutable run status from the AI sidebar header.
- [x] **OAC3** Keep durable agent execution and the active conversation attached while
      switching between AI, Inspector, and other right-rail panels.
- [x] **OAC4** Make context-window occupancy stable and request-scoped, and populate
      `model-capabilities.ts` for `glm-5v-turbo` using slash-insensitive model-id matching
      with the 200,000-token context and 131,072-token output limits.
- [x] **OAC5** Add focused core/UI/desktop regressions, update architecture/user docs and
      both changelogs, then run coverage and release-readiness verification.

      Verification: `@framepilot/ai-sdk` 2,184 tests with 100/100/100/100 coverage;
      `@framepilot/web-editor` 1,358 tests; desktop 242 tests; 41 Playwright E2E tests;
      Python engine 1,421 tests; workspace typecheck/lint/build and website production build
      green. **Last updated:** 2026-07-30

## Third-party media sourcing — `[~]` shipped on Openverse · two evidence runs outstanding

> **Sub-plan: [`plan/3rd-party-sourcing/README.md`](./3rd-party-sourcing/README.md)**
> (created 2026-08-23, maintainer-approved). FramePilot can only edit media the user already
> put on disk. This gives it one outward reach: **background music from a third-party
> provider, fetched in the Electron main process and materialized as an ordinary project
> asset.**

The audit corrected the premise. Only _acquisition_ is missing — everything downstream is
built and idle: `add_asset` + invert (`project-operations.ts:17`), `placeAssetPatch`
(`patch-builders-base.ts:1477`), `adjust_audio` with `duckUnderTrackId`/fades/normalize
(`operations.ts:242`), `AudioRoleSchema` `music` (`timeline-schema/src/index.ts:52`),
`detect_beats`, and `POST /asset-media` which already returns duration/kind/peaks/proxy for
any on-disk path (`service.py:348`). A grep for every major provider name returns **zero
hits** — no prior art, no half-built branch.

Two constraints found: the renderer **cannot** reach a provider host
(`connect-src 'self' fp-media: <engine>`, `media-protocol.ts:139`) — but `media-src`/`img-src`
already allow `blob:`, so previews ride IPC bytes and **no CSP change is needed**; and `Asset`
has **no provenance field** and `Project` no metadata bag. Zero new dependencies (Node `fetch`
in main; `httpx` already an engine dep). Reuses the ASR provider shape, the `hostTranscribe`
key-custody pattern, and the Capability-Pack download _shape_ — but **not** Capability Packs
themselves (ADR 0114 packs are immutable FramePilot-controlled runtimes, not per-project
licensed media).

**Maintainer decision 2026-08-23 (D2): attribution-required tracks are supported** — the UI
shows the licence and the user may use any track the provider offers. A search-time badge
cannot discharge a publish-time obligation, so attribution is **persisted**: `Asset.source`,
**schema v19 → v20 with a migration, approved as part of that decision**, plus a Credits view
that lists and copies every required credit at export. Non-commercial-only licences stay
refused — FramePilot users monetize, and no badge makes an NC track safe.

**Provider research done 2026-08-23 (D4, sourced in `PROVIDERS.md`): every candidate gates
commercial API use.** Freesound is non-commercial-only without an MTG/UPF agreement; Jamendo
needs a quote; **Pixabay has no music endpoint in its public API at all**. Decision: **build
on Openverse** (no key, no agreement, 1M+ CC audio records, commercial-use filtering, and a
pre-formatted `attribution` string per result) and **ship on Epidemic Sound ES Connect**
(purpose-built for embedding a licensed catalogue in third-party editors, no attribution, the
user's own subscription confers commercial rights; self-serve free tier now, partnership to
go live). The second provider is therefore earned, not speculative — the adapter generalizes
when Epidemic actually lands.

**Provider set closed 2026-08-23 — do not reopen without maintainer sign-off.** Openverse
**ships** as the free tier (not a scaffold), accepted against its uneven aggregate catalogue.
**Epidemic's free tier cannot go live** (_"only licensed for paid tiers"_) — the account is
registered for evaluation (50 downloads · 100 streams · 50 create versions, enough for P1–P3),
and launching needs the sales-priced Scale/Enterprise tier, so **Openverse is what actually
ships** until that is signed. Bring-your-own-Epidemic-subscription is the confirmed shape,
mirroring bring-your-own-AI-key. Storyblocks, Soundstripe, Shutterstock, Artlist and Pond5
were evaluated and **parked** (comparison + cost-model trade-off in `PROVIDERS.md`);
AI-generated music is parked, not declined.

- [~] **P0** Openverse closed — endpoint, field set and **server-side NC filtering all
  verified against the live API 2026-08-23**, no key, no SDK, no dependency added.
  Epidemic's paid-tier conversation is **maintainer-blocked** and gates only the paid
  upgrade, nothing that shipped.
- [x] **P1** Asset provenance, schema v20, credits surface (ADR 0138)
- [x] **P2** Search + audition — Openverse adapter, main-process IPC, Sounds tab.
      **Deliberate divergence: no API key field**, because Openverse takes none and its
      optional auth is OAuth2 client-credentials, not a bearer key. Building it would have
      shipped a Settings control that does nothing. Recorded in the phase file and ADR 0139.
- [~] **P3** Download → asset → timeline → export — code and tests complete (cancel,
  truncation, ENOSPC, dedupe, offline reopen, one-press undo). **The manual real-media
  run is outstanding.**
- [~] **P4** `search_music`/`add_music`, parity green across TS ↔ Python ↔ MCP ↔
  classification ↔ the flags contract. **Registry token delta measured: +370 per
  request** (15,762 → 16,132). The agent evidence run is outstanding with P3's.

**Shipped:** ADR 0138 (provenance persisted) · ADR 0139 (provider media fetched in main,
including why no key field exists) · `docs/guides/music-sourcing.md` · privacy-page line ·
`CHANGELOG.md`. Two findings the plan's research did not have, both now normalized and
tested: Openverse reports **duration in milliseconds**, and its Jamendo records report
`filetype: "mp32"` — a quality code, not a container, which would have written files
nothing can open.

**What is left is not code.** Both outstanding items need a human at a desktop build with
real 5–15 minute footage: hear the bed under the voice in an actual export, and confirm the
credit survives save-and-reopen (`product-discipline.mdc` §8 — tiny fixtures cannot stand in
for a media claim).

**Stock photo & video is no longer deferred — see the section below.** The deferral was
reversed by maintainer decision 2026-08-24 and `DEFERRED-stock-footage-and-sfx.md` records the
reversal; that file's stock half is history, not a live decision. **SFX remains deferred** (a
placement problem, not a search problem; Freesound is the obvious source and is itself
commercially gated; `auto-SFX` is already tracked and blocked on the Phase 9.0 gate). An
**owned** music catalog stays out of scope per
`FRAMEPILOT-AI-PRODUCT-PLAN.md:22`; searching a _third party's_ catalog is a recorded,
deliberate delta from that decision (README §D1), not a reversal.

**Sequencing:** `product-discipline.mdc` §2 ranks integrations below finished-edit quality,
and the 2026-08-21/22 snapshots show consecutive captured runs each surfacing new priority-1
editorial defects. Picked up when that batch closes; not interleaved with it. Phase 4's cost
is known in advance: the registry is already 78 descriptors ≈ 15,710 tokens per request
(§ above, line ~118), so the agent tool waits until a human has confirmed the provider
returns usable tracks. **Last updated:** 2026-08-23

## Third-party stock photo & video (Pexels) — `[~]` shipped · evidence runs outstanding

> **Sub-plan: [`plan/3rd-party-sourcing/photo-video/README.md`](./3rd-party-sourcing/photo-video/README.md)**
> (created 2026-08-24). The picture half of the sourcing reach the music slice opened:
> **photos and video from Pexels, fetched in the Electron main process and materialized as
> an ordinary project asset**, with the same provenance, credits and undo guarantees.

**The deferral was reversed by maintainer decision 2026-08-24**, on the argument the original
deferral itself made: the reason to hold was the SUC-P1 compositing blocker, and a cutaway
that _replaces_ picture rather than stacking on it does not need compositing. So the feature
ships **non-overlapping only** — the panel disables **Add** with a reason, and `add_stock`
fails with one, when the target span already holds picture (ADR 0140). Picture-in-picture
waits on SUC-P1, and that is stated in the guide rather than left to be discovered.

Reuses every mechanism the music slice built: `Asset.source` provenance (schema v20, no new
migration), the Credits surface, the main-process key custody, the observed-not-counted quota
store, the atomic temp→rename download path, and the `hostUiOnly` tool gate. **Zero new
dependencies.** The one genuinely new piece is `picture-occupancy.ts` — the shared
"is this span already picture?" predicate — plus `stock-placement.ts`, the single builder the
Stock panel and `add_stock` both call so an agent-placed clip and a hand-placed one are the
same clip.

**Pexels chosen (ADR 0141):** free, no revenue share, commercial use permitted without
attribution (courtesy credit surfaced anyway, in its own **Suggested** group), photos and
video from one key, 200 requests/hour. The key is **write-only** in Settings and never leaves
main.

- [x] **P0** Key custody + observed quota store
- [x] **P1** Pexels adapter — photos and videos, licence codes normalized, unknown codes dropped
- [x] **P2** Main-process service, IPC surface, quota wiring
- [x] **P3** Stock panel with hover-scrub preview, per-tile placement verdicts, Credits'
      Suggested group
- [x] **P4** `search_stock` / `add_stock`, with the orchestrator arm that turns the host's
      download into a validated patch and the cross-path parity test that pins it to the
      panel's own builder
- [~] **P5** Docs and evidence — ADRs 0140/0141, `docs/guides/stock-sourcing.md` and the
  CHANGELOG are written; **the real-media desktop run is outstanding**, as it is for the
  music slice.
- [x] **P6** Both panels open with content instead of an empty list (2026-08-25). An empty
      search box now browses the provider's own feed — Pexels `/v1/curated` and
      `/videos/popular`, Openverse's catalogue without a `q` — labelled so a browse never
      reads as results for a search nobody ran; the missing-key state still wins over it, and
      an IPC call that rejects now surfaces as an error rather than a permanent skeleton.
      The Openverse browse is verified live; **the two Pexels browse endpoints are covered by
      offline tests only** and join the outstanding evidence run (`PEXELS-API.md` §5 Q6).
- [x] **P7** Panel layout: one control row, uniform tiles (2026-08-25). Search, the kind select
      and the Pexels credit share a row; the prose above the grid is gone. Stock tiles were
      carrying the item's own aspect ratio, which let a portrait tile resolve taller than its
      grid row and overlap the row beneath — measured at up to 75 px of collision in a
      headless-Chromium repro of the real stylesheet, and 0 after.

**What is left is not code**, exactly as above: a human at a desktop build placing a real
Pexels clip into a real edit, exporting it, and confirming the courtesy credit survives
save-and-reopen. `product-discipline.mdc` §8 — tiny fixtures cannot stand in for a media
claim. **Last updated:** 2026-08-25

## Scene Understanding & Advanced Compositing — `[ ]` not started

> **Sub-plan: [`plan/SCENE-UNDERSTANDING-AND-COMPOSITING.md`](./SCENE-UNDERSTANDING-AND-COMPOSITING.md)**
> (created 2026-07-31). One unified system — scene analysis, masking, tracking, depth —
> powering depth-aware text, clone compositing, background replacement, object removal,
> motion graphics and auto B-roll, in preview and export alike.

Audit found the blocking truth: the preview is a **single-picture-layer** engine
(`editor/selectors.ts:372` flattens every track into one time-ordered EDL) while the Python
export composites stacked layers with blend modes, and masks are **export-only** (no mask
stage exists in the WebCodecs engine). Segmentation and tracking are `NotImplementedError`
stubs (`masking/mask.py`, `tracking/tracker.py`), `object_track` writes data no renderer
reads, `duplicate_clip` does not exist, and `ProjectSchema` has nowhere to persist scene
analysis. `generate_mask`/`detect_faces` are correctly declared **unavailable** — they must
stay that way until P3 makes them real.

- [ ] **SUC-P0** Foundations: ADRs 0091–0095, dependency/licence gate, difficult-footage
      fixture set, capability manifest.
- [ ] **SUC-P1** Multi-layer picture compositing in the preview — **hard blocker for
      everything below**; also closes the existing blend-mode preview/export divergence.
- [ ] **SUC-P2** Mask stack v2 (schema v17): shape + spline roto + matte sources, boolean
      combination, previewed, on-canvas editing, timeline lane, three-runtime parity.
- [ ] **SUC-P3** Scene understanding service: detection, segmentation, tracking, depth,
      gesture — content-addressed sidecar cache, scoped/tiered/resumable jobs.
- [ ] **SUC-P4** Text (and graphics) behind objects — schema v18 composite stacks.
- [ ] **SUC-P5** Clone compositing — `duplicate_clip`, offsets, per-layer independence,
      seam detection and cleanup.
- [ ] **SUC-P6** Background replacement · **SUC-P7** Object removal ·
      **SUC-P8** Motion graphics + gesture-aware effects · **SUC-P9** Auto B-roll.
- [ ] **SUC-P10** AI SDK surface (sub-plan §6): every capability reachable from
      `packages/ai-sdk` — and so from Agent mode and external agents over MCP — on the day
      it is reachable from the UI. Capability-gated `available` (one manifest drives the
      model's tool list _and_ `mcp-server/src/tools.ts`'s descriptor filter), a job-handle
      contract for minutes-long analysis, a token-budgeted scene digest that never carries
      per-frame geometry, six new skills, `wipe-guard` extended to compositing, and a
      honesty regression suite extending ADR 0083's fail-closed rule to every compositing
      tool. Per-phase DoD: TS↔Python↔MCP parity plus a proof that each tool's `buildOps`
      yields a timeline deep-equal to the manual UI path.
- [ ] **SUC-P11** QA, performance budgets, golden media, persistence and undo coverage,
      plus an **app-size gate** (sub-plan §7.2.1). Measured baseline 2026-07-31: 521 MB
      installed / 205 MB DMG (Electron 230 MB, PyInstaller engine 241 MB of which cv2 is
      118 MB, asar 48 MB). Target budget 620 MB / 260 MB, with a test asserting **zero
      bundled model weights**.
- [ ] **SUC-DIST** Model distribution and cache (sub-plan §A1, §A6): weights are fetched
      **per feature** (CapCut's mechanic — SAM2-tiny on "Place Behind", nothing else), so
      the DMG stays near today's size; ONNX Runtime (+35 MB) is required over PyTorch
      (+250–400 MB); the analysis cache is **global and content-keyed**, shared across
      projects (Premiere's Media Cache model, not a per-project pile), bounded, LRU-evicted
      `final`-tier-first, relocatable, and user-clearable without ever touching
      user-authored roto/corrections. Cloud offload stays opt-in; local is the default.
- [ ] **SUC-UX** CapCut/Premiere-informed UI running across P1–P9: the Scene panel, the
      preview as a direct-manipulation surface, expandable timeline sub-lanes, a regrouped
      two-tier Inspector, non-blocking analysis progress, and full keyboard coverage.

## Discovered (2026-08-02) — intelligent professional captions — `[x]` complete

The supplied 35.55-second vertical reference demonstrates phrase-level caption pages with one
semantic anchor word, followed by a fast edit/preview regrouping loop. Six supplied stills add
stacked-anchor, editorial-italic, compact two-tier, dense kinetic, handwritten lyric, and bold
social-headline composition families. The existing caption system already has canonical
linguistic segmentation, editable cue identity, reversible merge/split, a data-driven template
catalog, and preview/export parity; this unit extends those foundations instead of replacing them.

- [x] **ICR1** Add deterministic contextual auto-emphasis and feed its semantic anchors into
      cue-boundary/layout scoring; expose one-click Auto emphasis and make generation use it by
      default while keeping manual keyword control.
- [x] **ICR2** Add schema-v16 caption layout geometry (free x/y placement, width, rotation,
      alignment, line height and safe-area behavior), preview/export parity, migration, and direct
      on-canvas move/resize/rotate/text editing through reversible caption patches.
- [x] **ICR3** Add six production-ready reference-led templates as pure catalog data and preserve
      lazy/hover-only gallery animation behavior.
- [x] **ICR4** Add focused core/schema/web/engine tests, caption render validation, docs, ADR,
      changelog, and a targeted accessibility/performance review. Repository-wide verification is
      intentionally excluded at the creator's request.
- [x] **ICR5** Add 20+ generally useful, licensed caption font families with one shared catalog,
      picker UI, template adoption, bundled preview/export assets, and focused parity tests.
- [x] **ICR6** Make Auto Emphasis AI-backed through a validated provider contract, retain a clearly
      identified deterministic fallback for offline/provider failure, and test both paths without
      allowing model output to mutate captions directly.
- [x] **ICR7** Register Auto Emphasis and complete caption composition as AI-callable tools. Cover
      track/per-cue template, x/y placement, font, scale/weight, rotation, width, alignment, spacing,
      line height, padding/background and safe-area fields; preserve tool-schema validation,
      reversibility, Python/MCP parity, and manual-vs-agent timeline equality.

## Discovered (2026-08-03) — whole-song caption generation passed with two giant cues — `[x]` complete

A live 195.32-second lyric-video run placed one transcript-fallback caption block over the full
song, then `verify_captions` reported success because all 786 words fell inside that time range.
The run produced only two resolved pages, applied an unreviewed multi-animation caption style, made
no image correction, could not render a preview, and still reported the edit as prepared.

- [x] **LCV1** Harden the low-level one-cue tool in both TS and Python so a full recording/song or
      paragraph-sized range is rejected before apply; whole sets continue through the canonical
      mapped segmenter into typed, validated and reversible cues.
- [x] **LCV2** Make caption verification fail closed on unsegmented transcript-fallback blocks and
      other implausibly coarse cue sets instead of treating time-range coverage as lyric quality.
- [x] **LCV3** Tighten caption/color/finishing playbooks so custom styling and visual-quality claims
      require representative preview evidence, and prevent stacked novelty animations by default.
- [x] **LCV4** Add focused regressions, update API/user docs and both changelogs, and run only the
      affected test/typecheck/lint suites (repository-wide verification excluded by request).

      Verification: 164 focused AI SDK tests and 98 Python AI-tool tests passed; AI SDK typecheck
      and lint, Python mypy/ruff, generated skill parity, website typecheck/production build,
      formatting and diff hygiene passed. **Last updated:** 2026-08-03

## Discovered (2026-08-05) — short clips could take neither a transition nor a caption; the sidebar retained every past run — `[x]` done

Two independent failures with one shape: a clip short enough that the thing being added is
longer than the clip, treated as an error rather than as something to fit.

- [x] **SHRT1** `add_transition` applies the duration `transitionEligibility` says the cut can
      carry instead of the one requested. The clamp was computed and discarded, so the effect
      was written over-long and the post-apply `transition_overlap` check refused the patch —
      every cut between clips under 1s (twice the UI's 0.5s default) was untransitionable from
      the UI, the AI and MCP alike. Dragging a transition handle past the shot now stops at the
      maximum rather than failing the edit.
- [x] **SHRT2** Caption derivation measures its majority rule against the shorter of the word
      and the clip, so a clip shorter than the word spoken over it is captioned with the word
      the viewer actually hears there. Normal cuts keep the word-relative half exactly (ADR 0076
      amendment); a barely-clipped word at a long clip's edge is still dropped.
- [x] **SHRT3** Regressions in `editor-core` (clamped apply, both ramp halves, sub-word clips,
      once-only word attribution, unchanged normal-cut drop) and `web-editor` (over-long handle
      drag clamps instead of erroring); ADR 0076 amended; CHANGELOG updated; `add_transition`'s
      tool description now states the clamp so the agent reports the applied duration.

      Verification: `turbo run test typecheck` green across all 25 tasks — editor-core 614,
      web-editor 2310, ai-sdk 2348. **Last updated:** 2026-08-05

- [x] **SHRT4** Sidebar heap containment. Measured first: the deterministic core is linear and
      sub-millisecond at 4 000 clips / 8 000 cues (`buildTimelineMap` 0.18 ms, `validatePatch`
      0.92 ms, `assembleContext` over a 40k-word transcript 0.48 ms), so the growth was
      retention, not algorithms. Two unbounded holders fixed: `hydrate` read **every**
      conversation's full event log at editor open (now metadata only; logs load on open and
      the resident set is capped at `MAX_LOADED_CONVERSATIONS`, with a flush-before-evict so a
      dropped log is never ahead of its disk copy), and every collapsed tool row re-serialized
      its whole payload per render for a clipboard string nobody had asked for (now a thunk).
      `cut-and-transition-grammar` teaches the clamp so the agent reports the committed
      duration.

      Verification: `turbo run test typecheck lint` green across 34 tasks — web-editor 2317
      (+7 focused regressions), ai-sdk 2348, editor-core 614; 98 Python AI-tool tests green
      after the skill regeneration. **Last updated:** 2026-08-05

- [ ] **SHRT5** Remaining performance areas need an instrumented run against real desktop-scale
      media, not static analysis: React commit profile during drag/zoom, proxy + thumbnail
      decode over `fp-media://`, provider round-trip latency (fewer/cheaper calls, not faster
      local code), and ffmpeg export throughput.

- [x] **AICH** AI tool + edit contract authority — closes the AI/orchestration/tool/engine
      audit. One contract per tool instead of the same rules re-stated across the autonomous
      manifest, the router, the TS registry, the operation layer, and the Python mirror.
      Invalid intent now stays invalid: quantization can no longer repair a negative
      transition into a legal one-frame edit, unknown arguments are named instead of silently
      stripped, locked tracks are enforced by the canonical patch authority (not just the UI),
      and `transcribe` is classified as the host mutation it always was. Host caching is
      scoped by each tool's declared `cacheScope`, so preview/export/transcribe never replay
      and `get_frame` is stamped with the timeline revision.

      Verification: `pnpm verify` green — TS typecheck/lint/tests at the 100% coverage gate
      (editor-core 689, ai-sdk 2855), 2437 Python tests, `ruff`/`mypy` clean. The verification
      pass itself found six defects the implementation pass could not see (inverted parity for
      defaulted arguments, host caching disabled rather than scoped, autonomous idempotency
      that never hit, a `diffProject` crash on projects without markers, internal patch ids in
      user-facing copy, and a stale hand-maintained Python mirror) — all fixed and covered.

      > **Sub-plan: [`plan/AI-CONTRACT-HARDENING.md`](./AI-CONTRACT-HARDENING.md)** ·
      > ADR: [`docs/adr/0107-ai-tool-and-edit-contract-authority.md`](../docs/adr/0107-ai-tool-and-edit-contract-authority.md)
      > **Last updated:** 2026-08-08

## Discovered (2026-08-11) — the durable run log recorded the whole project per tool call — `[x]` done

User report: "every time I open the app and ask to do something it overloads my memory —
more than 50 GB on the popup — it generally happens when I run some AI task on the AI
sidebar." Diagnosed from the reporter's own store (`orchestration/`: 242 runs, 1.1 GB, half
of it quarantine) rather than by inspection — one WAL held 36 MB across **196 events**, and
13 `run.effect_requested` records averaged 2.78 MB each, one of them 35 MB.

Root cause: `createDurableEffectObserver` recorded `JsonValueSchema.parse(JSON.parse(
JSON.stringify(effect)))` — the WHOLE `RuntimeEffect`. A `host_tool` effect carries
`effect.project`, and a project carries `history` (unbounded inverse patches; 39 MB against
8 KB of assets in the captured run). Per tool call that value was deep-cloned, walked by the
recursive `JsonValueSchema` lazy union, appended to the WAL, retained in `RunStore`'s cache
as both an object graph AND its JSON signature, and structured-cloned to every renderer.
Replaying the reporter's own payload: **13.0 s of blocked main process and 2.3 GB retained
for one run's 13 tool calls**. On top of that, startup reconciliation full-loaded every run
ever made into a cache that was never evicted (~2 GB measured, growing per session).

- [x] **RUNMEM1** `apps/desktop/electron/ai/effect-record.ts` — durable effect records are
      bounded audit projections (`describeRuntimeEffect` / `describeEffectResult`): tool
      identity + arguments + project id/revision, model calls by shape not prompt, tool
      outcomes by status/summary with frames counted rather than carried. Same captured
      payload now costs **1.1 ms and 295 bytes** instead of 13 s and 34 MB.
- [x] **RUNMEM2** `RunCoordinator.recordRuntimeEffect` bounds `detail`/`outcome` at the
      durable boundary (256 KB), so no future caller can reintroduce an unbounded blob into
      the WAL or the IPC push. Deliberately not applied to `run.stream_event` — those
      payloads are the renderer's UI contract and are already bounded in transport.
- [x] **RUNMEM3** `RunStore`'s parsed-WAL cache is LRU-bounded (`MAX_CACHED_RUNS`) with an
      explicit `evict`; eviction is safe because the WAL is authoritative and a re-read
      rebuilds an identical entry.
- [x] **RUNMEM4** `reconcileInterruptedRuns` classifies from the few-KB snapshot
      (`RunStore.peekSnapshot`) and only full-loads a run that is genuinely unfinished.
- [x] **RUNMEM5** `RunStore.prune` + `FileRunStoreIO.listRunIdsByRecency`/`deleteRun`/
      `pruneQuarantine` — 50 finished runs and 14 days of quarantine evidence are kept;
      the store no longer grows for the life of the install.
- [x] **RUNMEM6** Renderer: `DesktopAiSession.run`'s IPC inbox drains by removal instead of
      by read cursor (it kept a second full copy of every run's event stream resident), and
      the recovery handle's synchronous `localStorage` write is coalesced to 1 Hz with an
      explicit flush on settle instead of firing on every durable event.

      Verification: `pnpm typecheck` + `pnpm lint` green (15/15 tasks); desktop 286 tests,
      web-editor 2355 tests. New: `effect-record.test.ts` (9), `run-store.retention.test.ts`
      (8), 4 added to `run-coordinator.test.ts`. **Last updated:** 2026-08-11

## Discovered (2026-08-14) — review discarded a valid montage; the audio tool could not be called correctly — `[x]` done

User report, two runs of the same beat-synced montage prompt. Both applied and validated
their edits, and both ended with nothing: `Temporal review failed: edit_audio_0: Audio
discontinuity 12.62 dB exceeds 12 dB`, and before that `Invalid arguments for
"professional_audio"` twice with twelve refusals at once, then "Temporal repair did not
produce a valid patch."

Two independent root causes, both in the contract rather than the logic that reads it.

Continuity was measured without knowing where the cut was: `_audio_sample` split the
window in half regardless, so the window at frame 0 — clamped to `[0, 3)`, planned because
the music clip _starts_ there — compared the bed's own attack against itself. The planner
also fed the same check gain-automation extremes and clip midpoints, where the level moves
on purpose. Review failure discards the run's staged diffs, so 30 seconds of applied,
validated work was thrown away because the music began.

`AudioObjectiveSchema` was a flat object with every setting optional and the intent
families enforced only in `superRefine`, so `z.toJSONSchema` advertised every setting as
legal for every intent. The model authored a kitchen-sink `automate_gain` call, and the
bounded repair pass — reading the same schema — authored it again.

- [x] **AUDREV1** `packages/ai-sdk/src/temporal-review.ts` + `engine/python/.../
temporal_evidence.py` — `AudioEvidenceRequest.boundaryFrame` (optional, strictly
      inside the window). The engine splits there and reports `boundaryJumpDb` only when
      asked; the reviewer judges continuity only when the request named a splice. ADR 0115.
- [x] **AUDREV2** `planTemporalEvidenceForEdit` / `planTemporalEvidence` — only clip edges
      on audio tracks are splices, computed from the **unclamped** frame so a clip ending at
      the programme's end no longer invents an interior cut. Mix changes, mute toggles and
      lane extremes stay peak/level checks.
- [x] **AUDREV3** `packages/ai-sdk/src/controllers/audio-controller.ts` — the objective is a
      discriminated union, one strict variant per intent, published as `{ type: 'object',
oneOf: [...] }` like `map_time`. Misfiled fields are answered with the intent that owns
      them. Costs ~480 tokens in the tool block; goldens re-recorded. ADR 0116.

                                                    Verification: ai-sdk 3149 passed (the 3 `langchain-providers` temperature failures are
                                                    a pre-existing local edit commenting out temperature forwarding, untouched here);
                                                    engine 2542 passed; mcp-server 130 passed; `tsc`, `eslint`, `ruff`, `mypy` clean.
                                                    **Last updated:** 2026-08-14

## Discovered (2026-08-14) — an identity key grew with the size of the edit — `[x]` done

User report on a 30-segment montage prompt: the run stopped with a raw validation error,
`[{ "code": "too_big", "maximum": 256, "path": ["effects", 6, "idempotencyKey"] }]`, and a
Retry button.

Root cause: identity keys were built by serialising what the model had just done.
`idempotencyKeyFor` keyed a host-tool effect as `host_tool:<name>:<full JSON arguments>`,
and `turnSignature` joined every call's name and arguments verbatim; that signature is
then embedded in the conductor's operation keys. `EffectSnapshotSchema.idempotencyKey` is
`idSchema` — capped at 256 characters — so the cap was effectively a limit on how much
editing one call could describe. A montage call carrying thirty trim ranges breached it,
the run snapshot failed to parse, and the run died with its edits already applied.

The keys are only ever compared for equality. They need to be stable, unique and bounded,
not complete.

- [x] **KEYLEN1** `packages/ai-sdk/src/stable-key.ts` — `stableDigest` (cyrb53, dependency-
      free for the browser build) + `boundedKeySegment(value, maxChars)`: a readable head
      plus a digest of the whole input, so values differing only past the cut-off still
      compare as different.
- [x] **KEYLEN2** `idempotencyKeyFor` bounds the serialised arguments (150 readable chars),
      leaving room under the cap for `host_tool:`, the tool name and the `:rev:N` suffix.
- [x] **KEYLEN3** `turnSignature` bounds itself (96 readable chars), which also bounds the
      conductor's `runId:planId:decisionId:signature:index` operation keys and the ledger
      `intent` recorded from it.
- [x] **KEYLEN4** `apps/desktop/electron/main.ts` — the durable observer bounds every key it
      records (240). Producers bound their own; this is the boundary the cap is actually
      enforced at, so it holds the line for future producers too.

      Verification: ai-sdk 3155 passed (the 3 `langchain-providers` temperature failures
      remain a pre-existing local edit), desktop 358 passed; `pnpm typecheck` + `pnpm lint`
      green. New: `stable-key.test.ts` (5), 1 added to `effect-runtime.test.ts`.
      **Last updated:** 2026-08-14

## Discovered (2026-08-14) — one blocking route starved every analysis, and the edit was built on nothing — `[x]` done

User report: a 20s/30-cut beat-synced montage came back as 33 identically-spaced 0.625s
clips cycling the bin in library order. Nothing errored; the run reported success.

Three causes in series, from the desktop + sidecar logs:

1. `POST /brain/visual/footage-map → 200 (409026 ms)`, and in the same window **no log line
   at all** for `/detect-beats` or `/brain/visual/search` — they were never received. 34 of
   the service's 37 routes were `async def` containing no `await`: blocking bodies on the
   event loop. One 409s Pegasus call meant uvicorn could not read another socket. Even
   `/review/temporal-evidence`, which correctly uses `run_in_threadpool`, sat unread until
   the map finished and then completed 102s later — after the reviewer gave up at 120s.
2. Every sidecar tool shared one 120s budget, so a footage map over 11 assets could not have
   fitted in it even unqueued.
3. The three "failures" were routed around (correct), but `collectAnalysisBag` folds only
   completed results, so the proposer got no beat grid **and no word that one was missing**.
   Handed a hole, it invented an even grid.

- [x] **SIDECON1** `engine/python/.../service.py` — 34 blocking `async def` routes → `def`
      (FastAPI threadpools sync routes). ADR 0117. Guarded by
      `test_no_route_blocks_the_event_loop` (AST-structural: the fault is invisible to a
      single-request test) + `test_a_slow_route_does_not_stall_other_requests`, which was
      confirmed to fail against the old code (`/health` blocked the full 10s).
- [x] **SIDECON2** Concurrency hazards it exposes: `PRAGMA busy_timeout = 5000` in
      `BrainStore.open` (per-request connections + WAL make readers safe; a second writer
      used to fail instead of wait), and a lock around the process-wide embedder gate.
- [x] **SIDECON3** `sidecar-executor.ts` — per-tool timeout ceilings (`map_footage` 15 min,
      `transcribe` 15 min, `search_visual` 5 min); everything else keeps the strict 120s
      default, because a local decode taking two minutes IS a fault.
- [x] **SIDECON4** `EditProposerInput.evidenceGaps` + `collectEvidenceGaps` — the analyses
      that returned nothing are named to the proposer with the reason, and it is told not to
      substitute regular intervals or library order. ADR 0118.

      Verification: ai-sdk 3159 passed (the 3 `langchain-providers` temperature failures
      remain a pre-existing local edit commenting out temperature forwarding); engine 2544
      passed; `pnpm typecheck` + `pnpm lint` green (17/17); ruff + mypy (101 files) clean.
      **Last updated:** 2026-08-14

- [ ] **SIDECON5** Follow-up (not done): an objective cannot declare which analyses are
      load-bearing, so "beat-synced" losing its beat grid is handled by _telling_ the model
      rather than by failing the objective. Making that mechanical needs the planner to mark
      required evidence per step. See ADR 0118 §Consequences.

**Two end-to-end faults found from a user session on `project_scenery` (2026-08-14).** Both
were reproduced against that real project, not a fixture.

- [x] **CAPREGEN** Asking for captions on an already-captioned track failed silently.
      Caption clip ids are start-derived (`caption_<track>_<startMs>`), which is what makes a
      regeneration recognizable rather than duplicative — but `insertClip` rejects an id
      already on the track, so a second request threw `duplicate_clip` on the first cue and
      lost the whole patch. On `project_scenery` the collision was exact
      (`caption_layer_caption_4_90`, both at 0.09s). Since the requested template changes the
      words-per-line and therefore the segmentation, the second set is not the same set: 40
      existing cues vs 23 newly derived, so skipping collisions would interleave two
      segmentations. `synth_caption_layer` now leads with one non-rippling `delete_range`
      over the existing captions' extent — inverts to `restore_clips`, so one undo restores
      the previous set. An empty cue list deliberately clears nothing.

      Verified end-to-end on the user's project: 40 captions → `Synthesized 23 caption layers
      (headline), replacing 40`, patch applies, first cue `"Car, take a new route,"`.

- [x] **TEMPBUDGET** Temporal review timed out on every real project. The engine's batch
      ceiling and the client's timeout were independent numbers that had never been compared,
      and the arithmetic was never satisfiable: measured on `project_scenery` (37 clips,
      1080p from UHD sources) a compile is ~33s and a 5-frame evidence window ~2.1s, so the
      _default_ 48-request plan costs ~134s against a 120s timeout. The engine's advertised
      maximum (600 frames) cost ~285s. Now one shared budget — `MAX_RENDERED_FRAMES` 600→400
      (worst case ≈224s) and `DEFAULT_TIMEOUT_MS` 120s→300s — each side documenting the
      arithmetic and pointing at the other. ADR 0119.

      Frames are now sampled via `sorted(visual_frames)`: readers stream forwards and seek
      backwards expensively (60 frames = 18.8s ordered vs 38.8s shuffled). The old `set`
      iteration was ascending only by CPython's small-int hash order, which holds only while
      frame indices stay under the set's table size — i.e. only under ~35s of sequence.
      `test_samples_frames_in_ascending_order` uses frames 5 and 33 because `list({5, 33})`
      is `[33, 5]`; confirmed to fail against the old code.

      Verification: engine 2545 passed (was 2544 + the new ordering test); ai-sdk 3162 passed
      with the same 3 pre-existing `langchain-providers` temperature failures, confirmed by
      stash to come from the uncommitted local edit and not from this work; ruff + mypy +
      eslint + `tsc --noEmit` clean on every touched file; `@framepilot/ai-sdk` rebuilt so
      desktop/web-editor consume the fix rather than stale `dist`.
      **Last updated:** 2026-08-14

- [ ] **TEMPBUDGET2** Follow-up (not done): a role-isolated audio request compiles its own
      composition, so a batch touching dialogue and music pays the compile three times — the
      reason the worst case needs three. Removing it is an engine change to how role
      isolation is built and needs its own measurement. See ADR 0119 §Consequences.
      Deprioritized by REVIEWDECODE: a compile costs the same, but it is now a much larger
      share of a much smaller total, and the total is ~30s against a 300s budget.

- [x] **REVIEWDECODE** Review's real cost was **decode**, which sits upstream of every byte
      budget ADR 0123 added and therefore survived all of them. The review preset was built
      from `project.resolution` and `_resolve_clip_asset` returns the camera master, so a
      batch decoded, composited and measured 2160x3840 frames to produce means, ratios,
      percentiles and an 8x9 hash — statistics that cannot distinguish UHD from a quarter of
      it. `/render/frame` had the same waste in a more visible form: the vision reviewer asks
      for a 512px JPEG and the engine composited full resolution, then discarded 97% of it in
      a Pillow resize.

      Three changes, in the order pixels flow: `compile_timeline(max_decode_dimension=)`
      applies the ceiling in the *decoder* (`VideoFileClip(target_resolution=)` → ffmpeg
      `-s`) and never upscales; `acquire_temporal_evidence` caps its preset at
      `REVIEW_MAX_DIMENSION` (960) and passes the same figure as the decode budget;
      `grab_frame` composites at the size the caller asked for. Export passes `None` and
      still reads masters.

      Measured (8 clips, 2160x3840, 20 frames ascending, isolated processes):
      **273ms → 38ms** per frame, **781 MB → 176 MB** peak RSS. Compile is ~86ms/clip slower
      (one extra ffmpeg spawn to probe-then-reopen an oversized source), repaid after ~3
      frames. Accepted trade: `min`/`max` over a resampled frame no longer see a one-pixel
      excursion — the reason the cap is 960 and not 512 — and `renderSettings.identity`
      records the exact size measured, so a review stays reproducible. ADR 0124.

      Also closed the concurrency hole ADR 0123 left: it serialized
      `/review/temporal-evidence`, but the same unbounded concurrent compiles were reachable
      through `/render/frame` and the MCP server. The bound now lives in `CompositionCache`
      (`MAX_CONCURRENT_BUILDS = 1`), covering every caller, and bounds *builds* rather than
      borrows so a caller whose key is already cached never waits.

      Verification: engine 2574 passed (was 2559 + 15 new), ruff clean, mypy back to its
      5-error pre-existing baseline (added none); ai-sdk 3208 passed; repo `typecheck` and
      `lint` green; `@framepilot/ai-sdk` rebuilt. `FRAMEPILOT_MAX_REVIEW_CONCURRENCY` shipped
      with ADR 0123 but was never registered — added to `.env.example`, `turbo.json`
      `globalEnv`, and the configuration guide.
      **Last updated:** 2026-08-15

- [x] **TEMPGATE** An uncleared perceptual gate destroyed the run's applied work. Traced from
      a desktop session log: temporal evidence returned in 46s (TEMPBUDGET holding), review
      found a real issue, the one bounded repair produced 0 operations, and the run exited
      `failed`/`internal_error` — discarding 3 validated transitions and a colour grade that
      had already been applied. Four exits did this (`temporal-repair:failed`,
      `temporal-review:failed`, `vision-review:failed`, and the unreachable path, which had
      already been fixed in isolation). They now share `releaseUnreviewedDiffs`: the edits are
      released marked `unverified` with the concrete finding, and the run still fails.
      Safety is unchanged — `shouldAutoCommitAiDiff` requires `verified`, so an unverified
      diff can never auto-commit. ADR 0120.

      This deliberately reverses `editor-run-adapter.test.ts`'s "stops after one unsuccessful
      repair and **releases no staged patch**": the gate's job is to stop an edit being
      presented as checked, not to delete it.

- [x] **TEMPVIS** The review phase was invisible while it ran. The graph settles `completed`
      (sidebar prints "Done.") and only _then_ is evidence acquired — 46s of silence after
      the run claimed to be finished. Review now emits `task_started`/`task_finished` around
      acquisition, so it joins the existing `TaskRunView` step list with its spinner, shimmer
      label and live timer. No new UI: that component was already mounted and is what renders
      the "Plan n/n" header. The failure path settles the task too, or the step spins forever.

      Verification: ai-sdk 3162 passed (3 pre-existing `langchain-providers` temperature
      failures unrelated, see TEMPBUDGET); web-editor AI components 208 passed; `tsc --noEmit`
      clean; ai-sdk rebuilt so desktop/web consume it.
      **Last updated:** 2026-08-14

- [x] **TEMPREPAIR** The repair reporting its own success signal as a failure. Ruled out the
      mechanism first, against the live gateway: non-streaming tool calls work (1 call
      returned), streaming tool calls work (17 SSE chunks carried `tool_calls`). So the
      transport was never the problem and no fallback parser was warranted.

      The real defect is a contradiction in the contract: `repairPassInstruction` tells the
      model "reply without a tool call when done", and the orchestrator then treats exactly
      that reply as `Temporal repair did not produce a valid patch`. The model complied — the
      "Done." in the session transcript is its reply — and was reported as broken. The message
      now states what happened: the repair made no changes and the finding is still present.
      Combined with TEMPGATE the edits survive with the finding attached, which is the whole
      user-visible harm.

- [x] **RUNRECOVER** Interrupted runs were stranded permanently. `idempotencyKey` was a plain
      `idSchema` (max 256), so a snapshot carrying a longer key could not parse — and a
      snapshot that cannot parse cannot be _closed_ either, so startup reconciliation caught
      the error, skipped the run, and left it non-terminal to fail again on every launch.
      Producers are already bounded (`idempotencyKeyFor`, worst case ~214 chars), so this was
      purely a read-path problem for runs persisted earlier.

      `identityKeySchema` bounds instead of rejecting, via the existing `boundedKeySegment`.
      The `<= 256` guard makes the transform idempotent, which is load-bearing rather than an
      optimisation: a snapshot round-trips many times, and bounding unconditionally would
      re-truncate an already-bounded key on every pass.

      Verified against the real stranded artifact — run `cb12af31` on disk carried a 268-char
      `host_tool:search_visual:` key; it now parses to 256 and is stable on re-parse.

- [x] **PROVTEMP** `temperature` was commented out in `langchain-openai-compatible.ts`, which
      silently dropped it for every OpenAI-compatible endpoint and left 3 tests red. Confirmed
      against the live gateway that this was a genuine incompatibility, not a whim: gpt-5.5
      answers `Unsupported parameter: temperature` and fails the call outright.

      A model-name guess is especially wrong for this provider — it exists to address arbitrary
      servers by URL, so the name says nothing, and the capability catalog has no temperature
      notion to consult. The endpoint already knows and says so, so it is asked once and
      remembered per instance: send it, and on that specific rejection retry once without it.
      The stream override refuses to retry after a chunk has been yielded, since replaying a
      partially consumed stream would duplicate tokens and tool calls. Verified live:
      rejection detected → retried → answered.

      Verification for TEMPREPAIR/RUNRECOVER/PROVTEMP: ai-sdk **3168 passed, 0 failed** — the
      first fully green suite this session, the 3 long-standing `langchain-providers`
      temperature failures included; eslint + `tsc --noEmit` clean on every touched file;
      ai-sdk rebuilt.
      **Last updated:** 2026-08-14

**Latent core issues found while auditing for more of the same classes (2026-08-14).**

- [x] **COMPILECACHE** Compiled compositions are now borrowed from a small cache instead of
      rebuilt per call. Keyed on a fingerprint of the project document + media base + preset + burn_captions — deliberately NOT the timeline revision, which collides across
      projects and would serve a stale picture for an in-memory change that never bumped one.

      Borrowed under a per-entry lock rather than shared: MoviePy readers carry seek state
      and sidecar routes run in a threadpool, so handing one composition to two callers
      would interleave seeks and return frames from the wrong time. Eviction closes the
      whole clip tree and waits for the borrower, so readers are never pulled out from
      under an in-flight grab. Bounded to 2 entries.

      Measured on `project_scenery`, five frames at different times: 35.6s then 2.0 / 2.6 /
      0.7 / 0.3s — 41s total vs 178s uncached. Correctness verified against ground truth,
      not assumed: every cached frame is pixel-identical to a freshly compiled one (mean
      absolute difference 0.0000). ADR 0121.

      The d0c3603 leak contract moved rather than weakened — "closed after every call"
      became "at most N open, each closed on eviction"; the two engine tests asserting the
      old wording now assert the new one, plus an autouse fixture clearing the cache
      between tests (a process-wide content-keyed cache would otherwise serve one test
      another's monkeypatched fake).

- [x] **VISIONGATE** Closed. `acquireVisionRunReview` now returns `judged` — true only when
      a check actually reached `fail`. Both vision exits release the run's work on a real
      adverse verdict and stay fail-closed on a refusal to run (no consent, no reviewer, no
      identity, cancelled), which is a permission answer rather than evidence about the
      edit. The media-egress consent test is unchanged and still passes; a new test pins
      the verdict case. ADR 0120 updated.

- [x] **RUNVIS** The pre-plan phases are visible. From the session log, 38s elapsed between
      the run being accepted and the first step appearing — classify, parse intent and draft
      the plan all run before a plan exists to render, so the sidebar showed nothing while
      the run was deciding what to do. `streamPlannedEdit` now announces `understand` and
      `plan` as tasks (the emitter already had `taskStarted`/`taskFinished`), settling them
      on the failure and cancellation paths too so neither can spin forever.

      UI: `TaskRunView` was gated behind `tasks.length === 0` on the plan dock, from when
      tasks and the plan were two renderings of one DAG. They are complementary now, so both
      render — and the task panel is retitled **Activity**, because two panels both headed
      "Plan" read as the same thing drawn twice. Caught a regression this created: the
      temporal-review task alone would have hidden a five-step plan mid-run; a new test
      pins the two coexisting.

      Verification for all three: ai-sdk **3170 passed**, web-editor **2403 passed**, engine
      **2550 passed**, 0 failures anywhere; eslint + `tsc --noEmit` + ruff + mypy clean on
      every touched file; ai-sdk rebuilt.
      **Last updated:** 2026-08-14

- [x] **CTXBENCH** Context management measured, not assumed. Sub-plan:
      **`plan/context-management/`** — [README](context-management/README.md) (index, decision
      record, sequencing, definition of done) and
      [DIAGNOSIS-AND-BENCHMARK.md](context-management/DIAGNOSIS-AND-BENCHMARK.md) (findings
      F1–F10, the benchmark, the target architecture). Harness:
      `packages/ai-sdk/scripts/context-benchmark.mjs`; baseline:
      `reports/context-benchmark-baseline.{txt,json}`.

      Read-only, deterministic, model-free (recording provider double, fixed clock; two runs
      produce byte-identical JSON), built on the existing `ScriptedProvider` pattern, the
      context manifest's own estimator and the golden-corpus fixture shape rather than a
      parallel harness. Baseline: on a 60-minute project one planning turn costs ~22,333
      tokens, of which **1,346 (6.0%) describe the user's video** and 17,490 (78%) are tool
      schemas; the model sees **2.1% of clips and 6.7% of dialogue** with ~113,667 tokens of
      window unused. At the north-star 10-minute scale it is 12.8% / 40.0%. Sharpest single
      finding: `get_transcript` returns **25 of 1,500 words**, cut mid-JSON, with no count and
      no narrowing instruction — one of nine reads with no case in `summarizeReadResult`.
      Also recorded: the timeline has **no frame grid** (three tolerances, nothing that
      quantizes), so "precise edits" has no frame to be precise about. No runtime behaviour
      changed.

- [x] **CTX-PHASES** Context-aware professional editing — five phases, all closed
      (2026-08-26). `plan/context-management/`. One programme, not two: a professional
      editor's precision _is_ their knowledge of the footage. Before/after:
      `reports/context-benchmark-baseline.{txt,json}` →
      `reports/context-benchmark-after.{txt,json}`.

      **Headline.** On a 60-minute project the model saw 2.1% of its clips and 6.7% of its
      dialogue; it now sees **100% of both**. `get_transcript` returned 25 of 1,500 words;
      it now returns all of them. Every model trimmed against one hardcoded 190K window;
      every model now trims against its own, minus the ~19,500 tokens of tool schemas and
      agent contract the assembler never sees. Cuts land on frames — for MANUAL edits as
      well as AI ones — and preview/export cut-point divergence is **0 frames** at the
      delivery rate. The Critic gained six editorial checks (18 total, was 12), two of them
      repairable. And a follow-up request inherits what the last run learned instead of
      re-reading the footage. Cacheable prefix share went **up**, 81% → 91.6%.

      **Two things did not land as written, both recorded rather than quietly dropped:**
      the "unused capacity < 30,000" target is retired (at 60 minutes coverage is 100%, so
      the remaining window is genuinely spare, not waste), and P5.3's behavioural half is
      deliberately not shipped — the guard it would remove exists because instruction was
      already tried and lost, and the evidence to check the trade needs real run logs. Its
      cost is now measured per request instead of invisible.

- [x] **CTX-P1** [Phase 1 — see the footage](context-management/PHASE-1-see-the-footage.md).
      Honest read digests for the nine fall-through reads (`get_transcript` first);
      `ContextBudget` resolved from `capabilitiesFor` and inclusive of tool-schema cost;
      `MAX_CLIPS_PER_LAYER`/`MAX_TRANSCRIPT_WORDS` become budget-derived allocations floored
      at today's values. Closes F1–F4, F8. Exit: 10-min word coverage 40% → ≥ 95%, clip
      coverage 12.8% → ≥ 90%, budget over-assumption ≤ 0 on every model, cacheable prefix
      share ≥ 85%. **Shipped:** 10-min word AND clip coverage 100%; over-assumption −21,497
      on every probed model; cacheable share 91.6%. `get_transcript` 1.7% → 100%. Growing
      the slice broke the prompt cache (85% → 45%), so `AssembledContext.split` now puts
      the run-stable half of the context above the agent loop's cache boundary — only the
      timeline summary actually varies per turn.
- [x] **CTX-P2** [Phase 2 — select what matters](context-management/PHASE-2-select-what-matters.md).
      Wire `semantic-index-slice.ts#getSlice` (built, tested, exported, **zero consumers**)
      into the timeline/transcript tiers; derive the slice query from pinned → selection →
      request scope so a global request widens instead of narrowing; every omission carries a
      recall handle or a narrowing instruction. Closes F9, F10 and the honesty half of F4.
      **Shipped:** `context-retrieval.ts` — three pure functions, no framework. 60-min word
      coverage with a selection 6.7% → 100%; on a budget too small for the project,
      "tighten this" covers 59.8% of the span and "find the strongest moments" covers 100%.
      All 9 formerly-fall-through reads are honest (declared omission + the call that
      returns it), and a DROPPED tier now reaches the model, not just the UI.
- [x] **CTX-P3** [Phase 3 — frame-accurate edits](context-management/PHASE-3-frame-accurate-edits.md).
      **The plan's premise was wrong, and correcting it was most of the work (ADR 0146).** A
      complete frame grid already existed in `packages/ai-sdk/src/frame-time.ts` — rational
      rates, an explicit rounding policy, a per-operation normalizer — wired into
      `assembleEdit`. It ran for AI-authored edits ONLY: a UI patch reached `applyUserPatch`
      and was validated and committed without ever touching it, so a human trim landed at
      12.3874s while an AI trim landed on a frame. The grid moved to `editor-core` and
      `commitProjectPatch` applies it to every patch from either author. **No schema change,
      no migration** — option (a), with (b) and its trigger recorded in the ADR. Quantizing
      goes at the PATCH, not inside `applyOperation`, because the inverse is computed from
      the operation and a privately-quantizing apply would drift undo by a fraction of a
      frame per edit. Reads report frames (`map_time`, `get_mapped_transcript`,
      `list_edit_boundaries`); the cut skills state their craft rules in frames; and
      preview/export divergence is measured at **0 frames** at the delivery rate, with a
      pinned +1-frame limit when an export preset resamples (every preset forces 30fps).
      Outstanding and not claimed: verification against a camera original.
- [x] **CTX-P4** [Phase 4 — editorial judgement](context-management/PHASE-4-editorial-judgement.md).
      `critic.ts` has 14 checks and not one is editorial — they answer "is the deliverable
      well-formed", never "is this a good cut"; only 3 are in `FIXABLE_CHECKS`. Add
      `jump_cut`, `word_severed`, `dead_air`, `audio_slam`, `shot_rhythm`, `handle_starved`,
      each fixable by an existing tool (roll/slip/slide already exist and are AI-only) or
      honestly report-only; route the critic through the run's evidence store so it sees what
      the planner saw. **Shipped:** 6 checks (`jump_cut`, `word_severed`, `dead_air`,
      `transition_fit`, `audio_slam`, `shot_rhythm`), every threshold stated in frames with
      a rationale. `word_severed` + `transition_fit` are `fail` and repairable; the rest ship
      `warn` per the phase's own promotion rule. Two plan corrections: `handle_starved`
      cannot fire here (this renderer borrows no source frames across a cut) and was
      replaced by `transition_fit`; `word_severed` cannot be computed from the mapped
      transcript, which has already resolved every straddle, so it compares source in/out
      points instead.
- [x] **CTX-P5** [Phase 5 — memory across sessions](context-management/PHASE-5-memory-across-sessions.md).
      Seed a new run's `RunWorkingState` from the previous run's persisted facts/evidence/
      decisions for the same conversation + project, filtered by `FactScope` and revision;
      add one `remember_preference` tool over `memory-store.ts`'s existing typed setters
      (closed key set — the block says "honour these preferences" and nothing can record
      one); stop swapping the tool descriptor set mid-run (2 swaps/run, 30,751 tokens
      re-billed). Closes F5, F6, F7. **Shipped: P5.1 and P5.2. P5.3 measured, not shipped.**
      Carry-forward is one pure function plus host wiring (`RunCoordinator.latestWorkingStateFor`
      → `AiStreamHub` → `agentOptions.carriedForward`). Evidence handles are deliberately NOT
      carried — they address the previous run's in-memory store, so a carried handle is an
      address that cannot be dereferenced — and a carried fact says it is carried.
      `remember_preference` needed a new project operation (`set_ai_memory`) because the
      patch path had no arm for memory at all. P5.3's behavioural half is held back with its
      reasoning and trigger recorded; the cost it would save is now reported as
      `ContextManifest.usage.toolSchemaTokensRebilled`.

## Discovered (2026-08-28) — Editor chrome density + export/history panel UX

- [x] **One control size across the timeline tool row.** The row mixed 32px `.icon-btn`
      boxes holding 18px glyphs with 20px `.timeline-tool` boxes holding 16px glyphs, so
      the left and right halves read as different toolbars and the taller half set the
      row height. Both now use the library rail's proportion (16px glyph, 28px square)
      and the row's vertical padding is a half-step. `apps/web-editor/src/components/Toolbar.tsx`,
      `styles.css`.
- [x] **Track gutter tightened.** `editor-foundation.css` widened the header column to
      176px to fit 24px hit targets, but the surplus over the 154px the row actually needs
      did not pad the row — the flags are `margin-left: auto`, so it opened as one dead gap
      between the type glyph and the flag cluster. Column is 156px; the 24px hit targets
      (the accessibility contract that block exists for) are untouched.
- [x] **Export popover restructured: header / scrolling body / pinned action bar.** The
      popover itself was the scroller, so the Export button scrolled away below a credits
      list. The body is now the only scrolling region, the footer is a sibling, and the live
      status moved into the footer (one `role="status"` at a time). Options grouped into
      Format / Audio / Credits; Audio and a populated Credits list are `<details>` that state
      what they hide; the preset states its real output (`1080 × 1920 · 30 fps · MP4 (H.264)`)
      from the same width/height/fps the engine's `render/presets.py` carries.
- [x] **History panel: the reel is scannable again.** An agent patch's `reason` is a
      narration that routinely runs to paragraphs; printed whole, one row was taller than the
      panel. Reasons clamp to three lines behind a "More" (folded by character count, so the
      decision is pure and width-independent), filters carry counts, the header states the
      cursor position and the undone tail, the current row is labelled, and an author filter
      that matches nothing says so with a way back.
- [x] **Timeline minimap draws on the first paint.** It measured its own width only from
      `onPointerDown`, so it mounted at width 0 and rendered as an empty bar until clicked —
      a navigation aid you had to use blind. Measures in a layout effect and tracks resizes
      via `ResizeObserver`. Regression test in `TimelineView.viewlayout.test.tsx`.

## Discovered (2026-08-28) — the sidecar was never told its sandbox root

Root-caused from run `2ca2fcbe` (`run.md`): 61 photos in the bin, 2 edits made, **0 shots
placed**. Every analysis call returned `Analysis failed (500): Internal Server Error`, the
per-turn circuit breaker disabled `detect_beats`, the repetition guard stopped the run, and
the review engine rejected both batches with the same 500. See ADR 0156.

- [x] **The desktop hands the engine `FRAMEPILOT_PROJECTS_ROOT`.** The engine sandboxes every
      path against it and has no default; unset, `/detect-beats`, `/detect-scenes`,
      `/analyze-silence`, `/analyze`, `/transcribe`, `/asr/prepare-audio`, `/render`,
      `/render/frame` and `/review/temporal-evidence` are all dead. The app resolved that
      folder for itself all along and never passed it on, so the sidecar only ever saw it by
      inheriting a maintainer's shell. `resolveSidecarCommand` now emits it in all three
      branches. `apps/desktop/electron/sidecar/spawn.ts`, `main.ts`.
- [x] **The engine stopped resolving media against its own working directory.** Both inline
      project resolvers used `settings.projects_root or Path.cwd()`. `Path.cwd()` raises
      once the launch directory is unlinked (a checkout under a long-running sidecar), which
      is how a misconfiguration became an unhandled 500 — and it ran before the asset lookup,
      masking the 404/400 those routes could have given. `inline_media_base()` returns the
      sandbox root or raises the same 503 `sandbox()` raises. `engine/python/.../service.py`.
- [x] **One engine outage is reported once, with its count.** Every review in a turn shares
      one engine, so one outage published the identical warning once per batch — the user saw
      "Review could not run" twice in a row. `packages/ai-sdk/src/review-findings.ts`.
- [x] **Verified the recovered path against a full agent run.** Run `ea8e46ec` is that
      re-run — the same 61-photo project, the same montage request, one day later.
      `detect_beats` returned real grids for all three candidate tracks (53 / 91 / 119 onsets
      at 152 / 162 / 172 BPM), so the sandbox-root fix is proven end to end at the agent
      level and not only at the route. The run still placed no shots, for a completely
      unrelated reason in the beat-grid guard — see the section below.

## Discovered (2026-08-29) — the beat grid was holding the run to a track it never chose

Root-caused from run `ea8e46ec` (`run.md`): 61 photos, the music placed, **0 shots placed**,
35 minutes, $4.40. Six montage proposals refused with one byte-identical sentence, and the
remedy the refusal implied was a tool the stage policy had closed. Full analysis,
root-cause chain and reconciliation in **`plan/BEAT-GRID-EVIDENCE-DEADLOCK.md`**; the
decision in **ADR 0157**.

- [x] **Beat evidence is a ledger keyed by asset, not one last-writer-wins slot.**
      `detect_beats` is a `pure_read` and runs in parallel, so a turn auditioning three
      tracks had three concurrent writers on one field. Distinct keys commute.
      `packages/ai-sdk/src/kernel/beat-grid/beat-evidence.ts`.
- [x] **The grid resolves to the music under the picture.** "Which grid" is a fact about the
      project and the proposal, resolved deterministically (placed bed → bed this proposal
      places → ungrounded; ranked by placed duration then `assetId`), and only then handed to
      the boundary rule.
- [x] **An ungrounded grid is a measurement, not a veto.** Rejected only under `hardSync`,
      where the remedy is a mutation every execution stage offers. No run that did not
      declare hard sync can be permanently blocked by the grid.
- [x] **A tool whose output a validator consumes is offered in that validator's stage.**
      `VALIDATOR_INPUT_TOOL_NAMES` + `stageAllowsTool` in `kernel/stage-policy.ts`, asserted
      in both directions so the carve-out cannot become a hole. The same correction this file
      already made for `guidance`.
- [x] **A retry is bounded by being a different attempt.** A turn refused with the exact
      reason that refused the last one no longer earns the attempt's progress credit.
      `kernel/conductor.ts`.
- [x] **The run says what it could not do.** The stall notice names the standing refusal; a
      run that landed some edits reports the ones it did not; a whole-turn rejection
      re-settles its proposal cards as `failed` instead of leaving green ticks for clips that
      never reached the timeline.
- [x] **`picture_present` says which kind of nothing it found.** It counted every clip as an
      overlay, so a music bed and no picture was reported as "1 overlay/caption clip … renders
      as text on black" — naming a caption that did not exist. `packages/ai-sdk/src/critic.ts`.
- [ ] **Re-run the montage on desktop against the same 61-photo project.** The fix is proven
      through the real `streamAgent` (three tracks auditioned, one placed, the montage lands
      on its onsets) and mutation-tested, but not yet against the live desktop sidecar and
      real media. Confirm the clips land, the run reports its beat map, and the export path
      produces the 9:16 file the brief asked for.

- [ ] Keep this PLAN.md updated after every unit of work (check off / add tasks)
- [ ] Keep `docs/` updated for every change (see docs-maintainer rule)
- [ ] Keep `CHANGELOG.md` current (Keep a Changelog format)
- [ ] No skipped tests without a linked issue
- [ ] No new dependency without license review
- [ ] No render change without a golden-test update
- [ ] No unvalidated timeline operation reaches apply
