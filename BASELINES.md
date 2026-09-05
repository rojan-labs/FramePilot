# BASELINES — every golden-eval baseline, in order

One entry per baseline run, newest first. **Never overwrite an entry.** A new run
appends; a re-run of the same label appends a *new* entry saying what changed.
The point of this file is that a delta can be read without trusting memory.

Each entry records: when, what code, what provider/model, what media, the ten
goal.md metrics, the per-scenario rows, and — the part that matters most — **what
the run is not evidence of**.

Sources of truth this file summarises:

- `reports/golden/<label>.json` — merged run (per-scenario rows + golden summary)
- `reports/golden/<label>/cases/*.json` — one file per case+run, the raw evidence
- `reports/golden/floor.json` — the single committed regression floor
- `goal.md` — the ten metrics and what each is for
- `REMAINING.md` — what the instrument was doing wrong before 2026-09-03

---

## Entry template

```
## <label> — <date> — <one-line verdict>

| | |
| --- | --- |
| commit | `<sha>` on `<branch>` |
| provider / model | |
| media | |
| cases × runs | |
| voidTurns | |
| wall clock / tier-priced cost | |

### The ten metrics
<table>

### Per scenario
<table>

### Not evidence of
- …
```

---

<!-- ENTRIES BELOW, NEWEST FIRST -->

## `s7-replay` — 2026-09-05 (session 7) — **no new run; the four open engine defects closed, and one loop measured shut by replay**

**This entry records no new sampling of the model.** No baseline was run — credits
were explicitly to be conserved — so **every number under `session6`, `session3` and
`baseline` is unchanged, and `reports/golden/floor.json` is still the `baseline` one.**
What is new here is a *replay*: `--replay` re-executes the ORCHESTRATOR against
recorded model output with zero model or host calls, so the deltas below are the
reducer's behaviour changing, not the model's.

| | |
| --- | --- |
| commit range | `3ec8a54..3d2364f` on `fix/agent-reliability-s7` (branched from `fix/agent-reliability-2026-09-05`) |
| what was replayed | `beat-sync` r1 from `session6`'s recordings, under the new label `s7-replay` |
| provider / model | replay — none called |
| new tests | 32 (editor-core 17, ai-sdk 14, engine 10 — see below) |
| suites | ai-sdk 4,637 · editor-core 1,071 · desktop 606 · web-editor 2,983 · mcp-server 151 · engine 2,843 — all green |
| measured token cost | **+169 tokens per request** (`tool_schemas` 7,027 → 7,196) — the `reorder_clips` tool. Nothing else moved a golden. |

### The one measurement: `beat-sync` r1, replayed

REMAINING §2.2's most expensive single failure, re-executed against the fixed reducer.
Recording identical; only the code differs.

| | session6 r1 | s7-replay | |
| --- | ---: | ---: | --- |
| tool calls | 121 | **25** | −79% |
| `add_clip` / `add_clips` | 58 / 58 | **10 / 10** | |
| repeated tool calls | 114 | **18** | −84% |
| model requests | 65 | **16** | −75% |
| usage tokens | 824,682 | **92,771** | −89% |
| tier-priced cost (not billed) | $3.93 | **$0.571** | −85% |
| final status | `cancelled` | **`completed`** | |
| rubric score | 0.56 | 0.56 | unchanged, and correctly so |

**The score is unchanged on purpose.** The recorded model output was never going to
produce a valid beat-synced cut; the defect was that the run spent twenty minutes and
$3.93 discovering that, and reported `cancelled`. It now stops when it is provably stuck
and reports honestly. A guard cannot make a bad turn good — it can stop the run paying
for the same bad turn twenty-nine times.

Evidence: `reports/golden/s7-replay/`. `session6` was not touched: the replay ran under
its own label against a *copy* of the recordings, and `--force` was used only on
`s7-replay`, never on a file holding real evidence.

### The four open engine defects, all closed with a reproducing test

| REMAINING § | what it cost | closed by |
| --- | --- | --- |
| §2.1 a reorder loses footage | 4 of 6 clean reorder runs destroyed content | `a080900` — `reorder_clips`, ADR 0173 |
| §2.2 a rejected turn re-issued forever | 29 identical calls, $3.93, an empty track | `0c9f195` — two independent holes |
| §2.3 a retimed clip leaves the frame grid | 16 retimes → 16 off-grid edges | `1a49f98` — `ApplyContext.fps` |
| §2.4 the word-boundary trap | 3 turns lost to cuts one frame inside a word | `eb50cbc` — one answer, two units |

Plus one found in a fresh sweep of `run.md` and not previously recorded: a catalogue
`remoteId` the run had just used successfully was refused by `detect_beats`, whose bin
asset id is that same id with a prefix and its hyphens underscored (`3d2364f`). The
beat-synced cut the brief asked for never happened.

### §2.2 had TWO holes, and the replay is what proved it

Worth recording because the handoff named one and the diagnosis found another; either
alone would have let the run happen again.

1. **The rejection sentence is not the refusal's identity.** `repeatedRejection` compared
   whole sentences, and the beat grid names its offenders: 29 refusals for one rule, no
   two alike. Producers now supply a stable `rejectionKey`. This is the same trap already
   documented next to `deterministicFailureKey` — **it applies to the turn-level guard
   too, which nobody had written down.**
2. **A re-proposed mutation counted as having LEARNED something.** Each refused turn
   varied its `add_clips` arguments, so every turn produced a first-seen novelty key and
   `callAnswered` reset the stall streak. The run's own working memory knew better: 5
   facts derived across 32 model calls, none after the fourth. A mutation is an attempt,
   credited by the attempt clause; it is no longer also creditable as a lesson.

### Not evidence of

- **Any change in intent accuracy, target resolution, first-pass acceptance, or accepted
  edits.** Nothing here was sampled against the model. `reorder_clips` in particular is a
  capability the agent did not previously have, so its effect on the reorder cases is
  **entirely unmeasured** and needs a run.
- **A new floor.** No floor was written. `reports/golden/floor.json` is still `baseline`.
- **Progress on §2.5.** The ten cases with no clean run still have none —
  `hook-strongest-line`, `compound-silence-captions`, `broll-first-20s`,
  `broll-empty-overlay-track`, `music-bed-quiet`, `captions-uppercase-bottom`,
  `vague-make-better`, `impossible-8k-drone`, `guard-wipe-timeline`,
  `clarify-which-clip`. Their recordings are 14 bytes, so replay cannot reach them
  either; only a run can.
- **`run.md` being a new transcript.** It was offered as one for the fourth time. Its ids
  still say conversation `33f7e787`, run `137d8fd0`, 1,064,475 lines. The sweep this
  session re-derived several already-closed defects before finding the one above —
  including the `add_music` empty-duck refusal, whose fix in `music-placement.ts` cites
  this very run in its docstring.
- **The +169 tokens being a net cost.** It is a per-request cost on every run, measured;
  whether it pays for itself depends on reorder cases the branch has not run.

---

## `session6` — 2026-09-05 (session 6) — **the fixture was replaced, and a reorder was found to lose footage**

The first run on media that measures what its cases claim to measure. It ran in two passes
and finished neither: the provider became unreachable partway through the first
(`FramePilot couldn't reach claude-agent-sdk`, 47 void turns in seconds), and the second —
a `--force` re-run of the 15 cases the outage had voided — was **stopped by the maintainer**
after eight of them, with instructions not to run the baseline again. Eleven cases have
clean evidence.

`--force` on an existing label is normally forbidden because it overwrites per-case
evidence in place. It was correct here and only here: those 15 files held nothing but a
transport error, and the rule protects evidence.

| | |
| --- | --- |
| commit | `1040f2e` (fixture), built before the run; the two later fixes are NOT in it |
| provider / model | `claude-agent-sdk` / `claude-sonnet-5`, live |
| media | **`mission-podcast` rebuilt on `speech-9min-c`** — see below |
| cases with clean evidence | **11 of 21** |
| turns | 72 · **39 clean**, 32 void (provider unreachable), 1 harness timeout |
| wall clock / tier-priced cost | ~2h 45m across both passes · **$24.22** (priced, not billed) |

### The metrics, on the 39 clean turns

Computed from `reports/golden/session6/cases/*.json`; the merged `session6.json` on disk is
from the first pass only, because the second was stopped before it could write one.

| metric | `baseline` | `session3` (31 clean) | `session6` (39 clean) |
| --- | --- | --- | --- |
| intent accuracy | 0.72 | 0.935 | **0.821** |
| first-pass acceptance | 0.49 | 0.839 | **0.769** |
| rubric score p50 | — | 1.00 | **1.00** |

**Read the two rates against the reorder rows below before reading them as a regression.**
Nine of the eleven cases score 1.00 across every clean run. The whole of the gap to
session 3 is two cases — `reorder-last-first` and `reorder-swap-first-two` — and three
word-boundary turns.

| case | clean scores |
| --- | --- |
| `montage-30s` | 1.00 · 1.00 · 1.00 |
| `podcast-highlight-60s` | 1.00 · 1.00 · 1.00 |
| `remove-dead-air` | 1.00 · 1.00 · 1.00 |
| `beat-sync` | 1.00 · 1.00 (r1 harness-timed-out, excluded) |
| `refine-tighten` | 1.00/0.89 · 1.00/1.00 · 1.00/1.00 |
| `memory-captions` | 1.00 ×6, 0.88 ×1 |
| `trim-first-clip-10s` | 1.00 · 1.00 · 1.00 |
| `trim-opening-10s` | 1.00 · 1.00 · 1.00 |
| `captions-plain` | 1.00 · 1.00 · 1.00 |
| `reorder-last-first` | **0.60 · 1.00 · 0.60** |
| `reorder-swap-first-two` | **0.60 · 0.60 · 0.60** |

### What the fixture replacement bought

`mission-podcast` now runs on `speech-9min-c` — `speech-9min-b`'s real narration with 116
pauses cut in at its own sentence boundaries. Measuring the alternatives is what settled
it: `speech-9min-b` has real words and **no silent gap at −30, −40 or −50 dB**, so pointing
the project at it would have broken `remove-dead-air` exactly as `speech-9min` had broken
selection. Details in `tests/fixtures/mission/README.md`.

- `podcast-highlight-60s` **selects on meaning for the first time** and scores 1.00 ×3. One
  run's own words: "the opening hook framing the World Cup as football's hardest trophy,
  the striking '1 in 2,000' statistic … and the closing line". That sentence was not
  expressible against 397 repeats of "I'll try to follow you later."
- `remove-dead-air` removes **116 gaps in 3 model calls for $0.13**, which is the fixture
  behaving exactly as designed.
- **§2.2 is settled, in the opposite direction to the prediction.** `checkNoMidWordCuts`
  reports `skipped: false` on every podcast turn — it is measuring, not being handed a
  point — and the cases score 1.00 anyway. The handoff expected those four to come DOWN.
  They did not.
- `captions-plain` builds 1,355–1,457 cues from 1,464 real words. It was never listed as
  invalid, but it had been captioning a fabrication too.

### The finding that matters most: a reorder loses footage

**Four of six clean reorder runs destroyed content**, and the rubric caught every one
(`content-preserved`).

| run | before → after | what it did |
| --- | --- | --- |
| `reorder-last-first` r1 | 5 clips → **0** | `delete_clips` on all five as its OPENING move, then asked the editor how to proceed |
| `reorder-last-first` r3 | 5 → **1** | moved `clip_005` to a temp track, moved `clip_004` back, then deleted `clip_001..004` — including the one it had just moved |
| `reorder-swap-first-two` r1 | 5 → **1** | deleted four, then asked "there's no second clip to swap it with. What did you mean by 'the first two clips'?" |
| `reorder-swap-first-two` r2 | 5 → **1** | deleted four, then asked "the first 160s currently has no video, so it plays black. How should I fill that stretch?" |

Twice the run destroyed the programme and then asked the editor to help it recover from the
state it had just created, describing the damage as the project's own.

**Every individual operation was legal.** The cause is that there is no reorder primitive:
`move_clip` moves one clip to a start time, clips cannot overlap, so "put the last clip
first" has no expressible route except destroy-and-rebuild — and under instant-apply the
destroy commits before the rebuild is composed. Any run that then stops (asks, hits a wall,
times out) leaves the destruction applied and the repair unwritten.

This is evidence for two decisions already recorded as open:

- **ADR 0056 — compound-request atomicity vs instant-apply.** All five of this run's
  content-loss failures, `beat-sync` r1 included, are the same shape.
- **ADR 0166 — the deleted wipe guard.** A narrow guard would have caught r1 and
  `beat-sync` r1 (track emptied) but NOT the three 5→1 cases, so reinstating it is not
  sufficient on its own.

`reorder-last-first`'s floor is 1.00 and its median here is 0.60, so **the gate will flag
it**. That should not be read as this branch breaking reordering:
`reorder-swap-first-two`'s floor was already 0.50, i.e. it was failing when the floor was
cut. The behaviour predates the branch and the 1.00 was a fortunate three.

### The most expensive single failure: 29 identical calls, $3.93, an empty track

`beat-sync` r1 declared `hardSync: true`, deleted the five clips, and proposed cuts on a
regular ~99 BPM grid rather than on the 50 detected onsets. All 977 operations were
rejected — correctly, with a message naming the nearest onset for each miss. The run then
re-issued the identical `add_clip`/`add_clips` pair **29 times** until the harness timer
cut it off at 20 minutes, leaving 0 picture clips.

The guard for exactly this exists and passes its tests (`ea8e46ec`: six turns, one
byte-identical beat-grid rejection, thirty minutes — `repeatedRejection` in
`conductor.ts`). Something let this past it, and the neighbouring test says what can:
one novel call fact per turn resets the streak. **Do not tune it by inspection** — there
are five interacting run-stoppers. `--replay` on
`reports/golden/session6/recordings/beat-sync-r1-t1.json` re-runs the orchestrator with no
model calls and no cost, and is the way in.

r2 and r3 both scored 1.00 having declared `hardSync: true` identically, so the wall is
reachable but not deterministic. The missing guard is the amplifier, not the cause.

### Two more defects, both with evidence

- **A retimed clip leaves the frame grid.** `refine-tighten` r1 turn 2 made 16
  `set_clip_speed` calls at 1.3× and produced exactly 16 off-grid edges. Arithmetic, not
  model error: `end = start + sourceDuration / speed` is almost never a whole frame.
  `frame-grid.ts:266` lists `set_clip_speed` among the ops `normalizeOperationTime` returns
  unchanged — correct, since the op carries no time — and the time is invented inside
  `applySetClipSpeed`, which receives only a `Timeline` and so has no fps. Python's
  `_apply_set_clip_speed` uses the same formula, so the two engines AGREE and
  preview/export parity is intact; both are consistently off-grid. **Not fixed** — see
  `REMAINING.md` for the three routes and why each is a decision.
- **The severed-word message named a frame for tools that take seconds.** Three turns lost,
  one at $3.19. **Fixed** (`5693600`).

### Not evidence of

- **A complete run.** Ten of 21 cases have no clean turn at all: `hook-strongest-line`,
  `compound-silence-captions`, `broll-first-20s`, `broll-empty-overlay-track`,
  `music-bed-quiet`, `captions-uppercase-bottom`, `vague-make-better`,
  `impossible-8k-drone`, `guard-wipe-timeline`, `clarify-which-clip`.
- **`hook-strongest-line`'s repaired rubric being validated.** It has still never run on
  media that can validate it — now for want of a run rather than for want of a fixture.
- **The three fixes made after the build.** The build predates `6fc28d9` (caption fit) and
  `5693600` (severed-word message); neither is measured here.
- **A new floor.** None was written. A floor from 11 of 21 cases would gate on a partial
  run.
- **The reorder defect being new.** See the floor comparison above.

---

## session 5 — 2026-09-05 — **no run; eight defects closed, and one recorded score is now known to be inflated**

**This entry records no measurement.** No baseline was run: credits were explicitly to be
conserved. Everything below came from re-reading the same captured transcript session 3
mined (`run.md` — conversation `33f7e787`, run `137d8fd0`, 1,064,475 lines) plus the open
items §2.2–§2.4 in the handoff, and each fix is proved by a reproducing test named in its
commit.

**`run.md` is not new.** It was presented as a fresh run; its ids say otherwise — same
conversation, same run id, same 1,064,475 lines as session 3 read. So this pass
deliberately swept what session 3 did NOT read: the full deduplicated inventory of the 44
failed and 42 warning tool calls, rather than the rejection causes by volume.

The `baseline` label's numbers are **unchanged and still the current floor** — with one
correction below that says how to read four of its cases.

| | |
| --- | --- |
| commit range | `cb906ac..118e7b1` on `fix/agent-reliability-2026-09-05` |
| the transcript re-read | 5,257 events · 561 tool calls · 156 model calls · 5,538,888 tokens · $27.76 · 49 minutes · final status **failed** |
| new tests | 47 across `editor-core`, `ai-sdk` and the Python operation + tool-schema mirrors |
| suites | ai-sdk 4,603 · editor-core 1,053 · engine 2,831 — all green |
| measured prompt cost | **+130 tokens per request** on the tool-schema section (13,358 → 13,488), identical across all three frozen surfaces |

### The correction: four cases have been scoring themselves a free point

`checkNoMidWordCuts` has said "unmeasurable, so it is not scored" in its own comment since
the loop guard landed. The code did the opposite — it returned `ok: true`, and `scored`
sums every check into BOTH the numerator and the denominator, so a check that had looked
at nothing awarded a point.

Four rubrics carry it on `mission-podcast`, whose transcript is 397 back-to-back repeats of
one sentence: `podcast-highlight-60s`, `remove-dead-air`, `compound-silence-captions` and
`hook-first`. **Every score those four have recorded in this file is an upper bound.** The
same free point went to any project with no transcript at all.

`RubricCheck.skipped` now removes such a check from both sums, and `golden-metrics#facet`
drops it before computing target/boundary — so a facet whose only check could not measure
reports `null` (not measured) rather than a pass it never earned. This is the check-level
form of the exclusion the harness already applies to void and timed-out turns (`a8b58f7`).

No recorded number in this file has been edited. The next run is the first that can say
what those four cases actually score.

### The eight, and what proves each

| # | defect | cost in the transcript | commit |
| --- | --- | --- | --- |
| 1 | **A refused duck named no track that would have worked** — `add_music` was given `layer_audio_5`, an audio track with no clips, and told "Place the dialogue first". There is no dialogue in a snowboarding video. `v_main` was on the same timeline, full of clips, carrying the very wind the bed was meant to duck. The guard was also stricter than the engine it protects: `_duck_intervals` reads clip intervals and never the track type. | the editor's explicit "duck the wind right down" never happened | `cb906ac` |
| 2 | **A rejected argument never said which value it rejected** — Zod 4 phrases an enum failure as "expected one of "photo"|"video"" and the finalized issue carries no input. | 6 calls: `search_stock.kind` ×2, `track_subject_automatically.subject` ×1, `professional_audio.target` ×3 — none corrected | `b738281` |
| 3 | **A refused boundary said where it was not, not where it was** — `split_clip` at 48 on the clip that STARTS at 48, where a cut already existed; `set_clip_speed` refused for an overlap with no remedy named. | the wipeout speed ramp, asked for by name, and one split abandoned | `1f29a5c`, amended in `118e7b1` |
| 4 | **The hook rubric punished the prompt it grades** — the prompt says "then continue from the beginning as before"; obeying it is longer by one hook, and `checkNotLonger` asserted `after <= before`. | the committed baseline's `575.87s → 577.80s` is a run marked down for obedience | `f4cac2a` |
| 5 | **A check that could not measure was scored as a check that passed** (the correction above) | four cases, every recorded score | `4c0cc0b` |
| 6 | **An unattributed transcript spoke through b-roll** — the third and last copy of the fabrication fixed in the Critic (`5d0dbab`) and the rubric (`a255687`). A word the edit DELETED came back, attributed to and timed through footage that was never speaking. Wired into `get_mapped_transcript` too — the timings the model cuts on. | not exercised by this transcript; the two earlier copies each cost a false defect | `d9ac392` |
| 7 | **The safe-area check had never looked at an overlay** — it read `x`/`y` on a 0–1 scale; the schema, the tool, the preview painter and the renderer all speak `xPercent`/`yPercent` on 0–100. It answered "nothing positioned to check" on every project, forever. | the run's title at `xPercent: 50, yPercent: 50` was never checked | `70b8bfe` |
| 8 | **`duck_roles` could never succeed on any project this product builds** — `Track.role` shipped readable with one writer, `add_layer`, at creation. Nothing writes `role: 'dialogue'` anywhere. Its refusal, "Label the track you mean", named a move that did not exist. | 2 calls, and the ducking instruction abandoned for the second time | `118e7b1` |

### What the sweep found that was already closed — so nobody re-opens it

Checked against current code before writing anything: the "unavailable this turn" and
"skipped redundant" wordings (already rewritten, citing this run by name), the
unrecognized-keys → owner routing (`8bc0328`), the 13 blank **Added asset** cards
(`6c13939` covered `add_asset` explicitly), the caption duplicate-id collapse (`008cf0c`),
the `professional_audio` target/stale-context refusals (`506e55a`), `add_clip`'s `end`
(`f51f4ee`), and the CSS caption spelling (`6099516`).

Also confirmed against the ledger rather than the surface: the 144 `add_music` failure
records in the run state are **one** failed op (`op_31`) re-serialised into every
subsequent state dump, not 144 failures. The distinct-op count is 421.

### One trade that was made, reversed, and is worth remembering

The overlap rejection first carried the magnitude — "overlap by 3s, 'a' ends at 9s". The
suite caught what that costs: `deterministicFailureKey` keys the repeated-failure guard on
the message body, and its contract is that the values a validator names ARE the defect's
identity. An overlap shrinking from 3s to 1s across two attempts then reads as two
unrelated failures, and the guard against nudging arguments at a wall stops firing on the
commonest wall there is. The numbers came back out; the remedy naming the three moves
stayed, because it does not vary.

**A more specific message is not free.** Any future message change on a validator path has
to be read against that guard.

### Not evidence of

- **Any change in the ten metrics.** Nothing was scored. Eight behaviour changes and one
  scoring change are in the tree, and not one of them has been measured against a run.
- **The four `mission-podcast` cases being fixed.** They still run on a transcript that is
  397 repeats of one sentence. Defect 5 stops them inflating their own scores; it does not
  give them anything real to measure. §3 of `REMAINING.md` is unchanged and still needs the
  maintainer.
- **`hook-strongest-line` being validated.** Its rubric contradiction is repaired and unit
  tested; the case itself still cannot validate anything on that media.
- **The text-overflow question being fully answered.** The geometric half is closed and
  warned on; a single word too wide to wrap still overflows silently, and that is now the
  only part of it still open.
- **This transcript being a new run.** It is the one session 3 read.

---

## `session3` — 2026-09-05 (session 4) — **a partial run, five instrument defects, and one number that is not what it looks like**

The first live 21×3 attempt since 2026-09-04. **It did not finish.** Ten cases in, the
provider's latency went from 7–10 seconds per model call to 122–660 and stayed there for
four consecutive turns; the run was stopped rather than spend hours producing turns that
are excluded from every rate by construction. Eight cases have clean evidence.

Run under a NEW label so the committed `baseline` label's per-case evidence is untouched.
The only thing this session changed under `reports/golden/baseline/` was a regenerated
`generatedAt` timestamp from a fully-cached invocation, and that was reverted.

| | |
| --- | --- |
| commit | code as of `372c998` (session 3's fixes), built before the run started |
| provider / model | `claude-agent-sdk` / `claude-sonnet-5`, live |
| media | `tests/fixtures/mission/projects`, unchanged |
| cases attempted | 10 of 21 · **8 with clean evidence** |
| turns | 37 · **31 clean, 6 provider-stalled** |
| voidTurns | 0 |
| wall clock / tier-priced cost | 4h 17m · **$13.75** |

### The ten metrics — clean turns only

`isVoidTurn` has always excluded turns the provider never answered. This run needed the
same treatment for turns the HARNESS cut off, which is a different cause and was not
excluded — see "Instrument defect 5". Both readings are given so nothing is hidden.

| metric | `baseline` | `session3`, all 37 turns | `session3`, 31 clean turns |
| --- | --- | --- | --- |
| intent accuracy | 0.72 | 0.84 | **0.935** |
| target resolution | 0.82 | 1.00 | **1.00** |
| boundary precision | — | 0.94 | 0.94 |
| operation validity | — | 1.00 | **1.00** |
| first-pass acceptance | 0.49 | 0.73 | **0.839** |
| silent successes | — | 0 | **0** |
| reversibility | — | 1.00 | **1.00** |
| rubric score p50 | — | 1.00 | **1.00** |
| tokens / accepted edit | — | 212,534 | — |
| tier-priced USD / accepted edit (not billed) | — | $0.51 | — |
| model calls / turn p50 · p95 | — | 6 · 12 | — |
| tool calls / turn p50 · p95 | — | 7 · 22 | — |
| first progress p50 · p95 | — | 3.04s · 4.25s | — |
| done p50 · p95 | — | 85.4s · 1951.9s | — |

`done p95` is a stalled turn and measures the provider's queue, not the product.

### Per scenario

| case | `baseline` p50 | `session3` p50 | note |
| --- | --- | --- | --- |
| beat-sync | 0.556 | **1.00** | |
| memory-captions | 0.857 | **1.00** | 1 of 3 runs provider-stalled |
| montage-30s | 1.00 | 1.00 | |
| podcast-highlight-60s | 0.75 | 1.00 | rubric passes; the case still measures nothing (§3) |
| refine-tighten | 0.875 | 0.875 | **both are the rubric's fault** — see defect 2 |
| remove-dead-air | 1.00 | 1.00 | |
| trim-first-clip-10s | 1.00 | 1.00 | |
| trim-opening-10s | 1.00 | 1.00 | |
| reorder-last-first | 1.00 | *no clean run* | 3 of 3 provider-stalled |
| reorder-swap-first-two | 0.50 | *no clean run* | 1 of 1 provider-stalled |

**`reorder-last-first` is the entry's cautionary tale.** Its three runs scored 0.6, 0.7 and
0.7 against a baseline of 1.00, which reads as a clear regression. It is not one. Those
runs made 12, 3 and 3 model calls in 1474s, 1980s and 1693s — up to **660 seconds per
call** — and all three were cut off by the harness's 20-minute timer. r2's timeline at the
moment it was judged is `[asset_001…005]`: the untouched original, because the reorder
never got to happen. Had this entry been written from the score alone it would have
recorded an agent regression that did not occur.

What that case *did* establish, because latency cannot fake it: **`reversibility: ok —
identical after 7 patch(es) undone` on all three runs.** That is `bb8fb69`'s `move_clip`
ULP fix confirmed on real media, on the exact case that failed reversibility in the
committed `baseline`.

### Five instrument defects the run exposed — all fixed

1. **`checkValidRefs` excluded `__caption__` and not `__text__`**, the two synthetic ids
   for clips with no media source, declared on consecutive lines of `operations.ts`. Any
   run that put a title on screen scored as having produced a broken timeline. (`a255687`)
2. **`refine-tighten` demanded a shorter programme for a prompt asking for a faster one.**
   "Tighten the middle section so it moves faster, but keep the first and last clips
   exactly as they are" does not ask for less running time. Run 1 turned 13 picture clips
   into 15 at 29.4s; run 2 turned 18 into **29** at 30.0s; both kept first and last
   untouched. Both were marked down. Run 3 chose the other faithful answer and shortened
   29.4s to 21.0s. `checkCutsFasterThanBefore` passes all three. The same failure is in the
   committed `baseline` twice, read there as the agent falling short. (`a255687`)
3. **`memory-captions` turn 1 asks for 45 seconds and was scored against 60**, because its
   rubric is `podcast-highlight-60s` and the number came from the rubric's NAME. Three of
   three baseline runs produced 44.67, 44.67 and 45.43 and were all failed. (`a255687`)
4. **`checkNoMidWordCuts` judged b-roll against the narration** — the rubric twin of the
   Critic's `word_severed` bug retracted in the session-3 entry. (`a255687`)
5. **A turn the harness timed out was scored as the agent's behaviour.** `isVoidTurn`
   already separates "the provider never answered"; a harness timeout is the same mistake
   with a different cause. Five of this run's turns, and the whole `reorder-last-first`
   result. Now excluded from every rate and counted separately, because the remedies
   differ: a void turn needs re-running, a timed-out turn needs a provider that answers.
   (`a8b58f7`)

A sixth was found and deliberately **not** fixed: `hook-strongest-line`'s prompt says
"start with the strongest line… **then continue from the beginning as before**", which is
by arithmetic longer than the original, and its rubric requires `not-longer`. The
baseline's `575.87s → 577.80s` is the agent obeying the prompt. That case runs on
`mission-podcast` and measures nothing until the media is replaced (§3), so a rubric change
could not be validated. Two faithful fixes are recorded in REMAINING.md §2.

### Not evidence of

- **A finished baseline.** Ten cases of twenty-one were attempted and eight have clean
  evidence. `reports/golden/floor.json` is unchanged and the committed `baseline` remains
  the floor. Re-invoking the same command resumes from the per-case files on disk.
- **Any of this session's own fixes.** The runner imports `dist/`, built before the run
  started, so `session3` measures the code as of `372c998` — session 3's fixes, not
  session 4's. Nothing in the 2026-09-05 commits is in these numbers.
- **A regression on `reorder-last-first` or `reorder-swap-first-two`.** Neither has a
  clean run. See above.
- **`refine-tighten` improving.** Its 0.875 is unchanged because the rubric fix landed
  after the run scored it; on the recorded clip counts all three runs pass the corrected
  check.
- **`podcast-highlight-60s` measuring anything.** It scores 1.00 here and still reads a
  transcript that is 92% one fabricated sentence.
- **Comparable cost figures.** `usdPerAcceptedEdit` and `tokensPerAcceptedEdit` include the
  stalled turns' spend, and the `baseline` label has no figure to compare against.

---

## session 3 — 2026-09-05 — **no run; nine defects closed from one desktop transcript**

**This entry records no measurement.** No baseline was run: credits were explicitly to be
conserved, and none of the nine fixes below needed a live run to find — every one came
from reading a single agent transcript the maintainer captured (`run.md`, 1,064,475 lines,
conversation `33f7e787`, run `137d8fd0`) or from a defect the `baseline` label had already
recorded. Where a claim needed proving, it was proved locally against real engine output
or a reproducing unit test, and each is named below.

The `baseline` label's numbers are therefore **unchanged and still the current floor**.
Nothing here has been scored. The next real run is the first thing that can say whether
these moved anything.

| | |
| --- | --- |
| commit range | `008cf0c..5deae6d` on `fix/agent-reliability-2026-09-05` |
| provider / model of the transcript read | OpenRouter `inclusionai/ling-3.0-flash-fin:free`, agent mode, desktop |
| the transcript | 5,257 events · 561 tool calls · 156 model calls · 5,538,888 tokens · $27.76 · 49 minutes · final status **failed** |
| new tests | 44 across `editor-core`, `ai-sdk` and the Python contract mirror |
| suites | ai-sdk 4,536 · editor-core 1,034 · engine 2,825 — all green |

### What the transcript cost, and where it went

One run. 416 changes applied, **3,129 proposed changes rejected**, stopped by its $26.50
budget ceiling after 153 steps, and reported to the editor as failed. The rejections were
not spread across the run — they concentrate in a handful of repeating causes, and every
one of those is now closed:

| cause | calls it cost | fixed in |
| --- | --- | --- |
| `caption_the_edit` rejected on a duplicate caption clip id | 10 calls, ~3,100 rejected ops, every caption in the run | `008cf0c` |
| `professional_audio` refused: `target` given a track id, then `stale_context` | 10 calls | `506e55a` |
| `word_severed` failed the whole run on hallucinated words | the run's terminal error | `ebd66ea` |
| `adjust_audio` re-setting a value it already held | 7 of 65 calls | `95a9f03` |
| `render_preview` / `export_video` called after "do not call it again" | 4 calls | `1bd2f87` |
| every perceptual review died on a contract mismatch | 7 reviews, silently | `09dd6d8` |
| `add_clip` sent `end` as a duration | 3 calls | `f51f4ee` |
| `set_track_caption_style` sent CSS spelling | 1 call, and the run's whole caption design | `6099516` |

### The nine, and what proves each

1. **Stacked footage discarded the whole caption patch** (`008cf0c`). The timeline carried
   `raw_skating.mp4` on two video tracks over the same sequence seconds — `v_main` showing
   source 18–21s at sequence 0–3s, a b-roll track showing source 0–3s at the same 0–3s.
   Caption runs are per-clip, so both produced a cue starting on frame 2, both derived the
   id `caption_captions_70`, and `add_caption_layer` rejected the duplicate. A caption
   patch is all-or-nothing, so one collision discarded every cue — which is why the run
   retried nine more times with no argument that could have helped. `deriveCaptionCues`
   now returns a non-overlapping cue timeline. **Proved**: the reproducing test fails
   without the fix with the production error text, verbatim.

2. **`word_severed` failed a run on words nobody said** (`ebd66ea`). The transcript is 397
   back-to-back repeats of "I'll try to follow you later."; `transcript_reliable` warned
   "do not select or cut on them" and `word_severed`, in the same report, failed the run
   for cuts inside "follow" and "God." — two of those words. 416 applied changes reported
   as failed over a word that does not exist. Both checks now read one loop verdict.

3. **Selection-authored tools died at the agent's own first edit** (`506e55a`). The
   interaction snapshot is captured once at turn start, so from step two onward every
   `professional_audio` and `track_subject_automatically` call answered `stale_context:
   … targets …@56, but the project is …@100`. Over 153 steps the timeline reached revision
   127. The snapshot is now re-stamped when the selection provably still means the same
   thing, and refused when it does not. The same commit rewrites `target`'s refusal, which
   was reported as a typo (`expected "this"`) for what is a category error — the run sent
   `"music_1"`, `"music_bed"`, `"layer_audio_5"` and gave up after ten tries. **Measured
   cost of the longer descriptor: +47 tokens/request** (toolSchemaTokensRebilled
   13,311 → 13,358).

4. **"Do not call it again" was not enforced** (`1bd2f87`). `render_preview` and
   `export_video` have no route on this surface and say so; host failures are deliberately
   never remembered, so the refusal cost nothing per attempt. The executor now declares
   `surface_unavailable` through the channel `stock-host.ts` already uses.

5. **An edit that changed nothing said nothing** (`95a9f03`). 65 `adjust_audio` calls,
   seven re-setting one clip to the −18 dB it already had, each answered "Adjusted audio
   WIZARDS_DRIVE.mp3". The note now says the project already said exactly this. The
   operations are still applied deliberately — withholding them would make a turn's op
   count depend on what the timeline happened to already say, which two existing incident
   regressions pin against.

6. **The reviewer could not parse the engine's own response** (`09dd6d8`). FastAPI
   serialises every unset optional as an explicit `null`; Zod's `.optional()` refuses one;
   a batch is an array of a `.strict()` union, so one null rejected all of it. Every run
   on this path reported "applied and validated, but not perceptually checked" — seven
   reviews in this one. **Proved**: a batch dumped straight out of
   `framepilot_engine.validation.temporal_evidence` and fed to the TS schema returned
   eight issues, every one a null. That batch is now a committed fixture, and the client's
   error names the offending paths instead of saying only that something did not match.

7. **`end` read as a length** (`f51f4ee`). `add_clip` got `start: 44, end: 6`, then
   `44/14.233`, then `60/15`, and read back a restatement of the rule each time. The
   refusal now names the value that would have worked. Mirrored in the Python contract
   overrides.

8. **`move_clip` was not exactly reversible** (`bb8fb69`) — closes the `reorder-last-first`
   lead this file opened as "plausible instrument gap, not confirmed". It is not an
   instrument gap. `applyMove` recomputes the clip's end as `toStart + (end - start)`, and
   `(toStart + d) - toStart` is not always `d`: a clip 8.033333333333333s long moved to 48s
   and home again comes back 8.033333333333331s long. The picture never changes — both
   quantize to the same frame, which is why every round-trip test on round numbers passed —
   but undo is a promise about the file. The run moved one clip four times.

9. **A caption style written in CSS was refused** (`6099516`) — closes the
   `captions-uppercase-bottom` r2 lead. `fontWeight: "bold"` and a bare colour for
   `background` are refused by a schema that is right to hold 100–900 and an object; the
   two spellings are now translated at the tool boundary, where no migration is involved.
   `fontWeight: "chunky"` and `1400` are still refused.

### Four more, found in the same transcript after the list above was written

10. **A rejected key set now names the tool it belongs to** (`8bc0328`). `Unrecognized
    keys: "subject", "intent"` says which words were wrong and nothing about where they
    belong, and the mistake behind it is almost always one tool's arguments sent to its
    neighbour — the run sent `track_object` what `track_subject_automatically` takes. The
    registry already knows who declares what; an exact key-set match names it.

11. **The budget notice says what actually happens next** (`dd09e3e`). The run announced
    "$26.61 spent" against a $26.50 budget and finished at $27.76 — 4.8% over. Both halves
    of that gap are structural and neither is a bug: the check runs after a turn settles,
    so the turn that crosses the line is already paid for, and the self-check the notice
    promises costs model calls of its own. Suppressing it would buy the number by deleting
    the verdict, so the sentence changed instead of the behaviour.

12. **`word_severed` stopped judging b-roll against the narration** (`5d0dbab`) — and this
    one **retracts a claim this file made**. The previous entry recorded `broll-first-20s`
    as "a real accuracy defect in b-roll placement near speech", confirmed not an
    instrument bug. It is an instrument bug. Every fixture transcript in
    `tests/fixtures/mission` is schema ≤ v11 and carries no `assetId`, so every word
    applies to every clip — including the b-roll clip's own in and out points, on footage
    that contains no speech at all. An unattributed transcript can only have come from an
    asset long enough to contain it; on `mission-talk` that is the 528s narration, not the
    9–40s b-roll. The run that "burned 19 model calls and $2.07" was chasing a word that
    was never on that shot.

13. **An expired evidence handle says so** (`5deae6d`). `recall_evidence` was **103 of the
    run's 561 tool calls**, and 27 came back "no such handle" — for ids the run had issued
    and then invalidated. The live list is visibly non-contiguous, and `ev_25` was answered
    at 18:26 and gone by 18:29. Invalidation dropped the handle entirely, so a reading the
    run threw away looked exactly like one the model invented, and the model went back to
    reconnaissance rather than to the tool that would refresh it. Invalidation now leaves a
    tombstone naming the descriptor and the tool.

Also closed, from the `baseline` label rather than the transcript: **`clarify-which-clip`
mutates while asking, 3/3** (`d482676`). Every operation in a turn comes from one model
response, so a turn that calls `ask_user` composed its edits before any answer existed.
`applyAgentTurn` withholds them and tells the model to make them again in light of the
answer. This is the fix shape REMAINING.md §2.4 named.

### What a future run should show, and what would falsify it

Stated in advance so the next baseline is a test and not a rationalisation:

- **`firstPassAcceptance` and `intentAccuracy` up on the caption cases.** `captions-*` and
  `compound-silence-captions` could not have produced styled captions on a stacked
  timeline before; if they still do not, fix 1 or 9 is incomplete.
- **`operationValidity` up wherever `add_clip`, `professional_audio` or
  `set_track_caption_style` appear.** These were argument-shape refusals, so a run that
  still spends calls on them means the sentences are not being read.
- **`reversibility` at 100% on `reorder-last-first`.** This one is deterministic — a
  failure here means the fix is wrong, not that the model varied.
- **`broll-first-20s` no longer failing on `word_severed`.** Also deterministic given the
  same placement: the check cannot fire on b-roll shorter than the transcript any more.
- **Fewer `recall_evidence` calls per accepted edit.** 27 of the transcript's recalls were
  answered "no such handle" for real, expired ids. This is the weakest prediction of the
  set — the tombstone changes a sentence, and whether a model reads it is not something
  the fix can guarantee.
- **Perceptual review actually running.** Any run reporting "not perceptually checked" for
  a contract reason now names the field; if that line reappears, read the field.
- **Cost per accepted edit down.** ~3,100 rejected operations and roughly a quarter of a
  $27 run went into loops that can no longer happen. This is the softest of the five
  predictions — the transcript's model (a free OpenRouter model) is not the baseline's
  `claude-sonnet-5`, and a stronger model may never have hit some of these.

### Not evidence of

- **Any movement in the ten metrics.** Nothing was scored. Every number in this entry is
  either from the transcript the maintainer supplied or from a local unit test.
- **That the transcript's model is representative.** `inclusionai/ling-3.0-flash-fin:free`
  makes argument-shape mistakes a stronger model may not. That does not make the defects
  it found less real — a duplicate clip id, an unparseable review response, and a
  non-reversible move are the product's, not the model's — but it does mean the *rates*
  in the table above should not be read as rates for the baseline provider.
- **That `broll-first-20s` passes.** Fix 12 removes the false failure it was scored on;
  whether the case then scores 1.00 is unmeasured, and the run still has to place the
  b-roll correctly on its own merits.
- **That `podcast-highlight-60s` measures anything.** Unchanged: the media still needs
  replacing (REMAINING.md §3).

---


## `baseline` — 2026-09-04 (session 2) — **three real defects closed, floor re-cut**

Same label, re-scored and re-accepted after three code fixes this session — not a fresh
21×3 run (explicitly avoided to conserve credits; see "How this was verified" below).
`intentAccuracy` 68%→72%, `targetAccuracy` 76%→82%, `firstPassAcceptance` 33%→49%,
`acceptedEdits` 24→35, all from removing false failures, not from any prompt/model change.

| | |
| --- | --- |
| commit | pending (this session, branch `feat/golden-eval-harness`) |
| provider / model | `claude-agent-sdk` / `claude-sonnet-5` (cases below re-scored via `--replay` on prior recordings — zero new model calls — except the one live check named below) |
| cases touched | `captions-plain`, `captions-uppercase-bottom`, `compound-silence-captions`, `guard-wipe-timeline` rescored via replay; `broll-first-20s` re-run live once (1 run, not 3) to confirm a code fix |

### Fix 1 — `checkValidRefs` didn't know about the caption sentinel (instrument bug)

`mission-rubric.ts`'s `valid-refs` check flagged every caption clip as a "dangling asset
ref" because a caption clip's `assetId` is deliberately `CAPTION_ASSET_ID` (`'__caption__'`,
`operations.ts`) — a sentinel, not a bin asset. This silently capped every captioning
case's score (`captions-plain` 0.90, `captions-uppercase-bottom` 0.92) and made
`compound-silence-captions` look like it had a real schema-integrity bug (548–575
"dangling" refs, flagged as an open lead in the prior entry). Fixed by excluding the
sentinel; added a regression test. Re-scored via `--replay` (the caption tool calls were
already recorded, so re-scoring them costs nothing):

| case | before | after |
| --- | --- | --- |
| captions-plain | 0.90 (p50 across 3 runs) | **1.00 × 3** |
| captions-uppercase-bottom | 0.92 | **1.00, 1.00, 0.83** (see Fix 1's real residual below) |
| compound-silence-captions | 0.90, `valid-refs` failing on every run | **1.00 × 3** |

`compound-silence-captions`'s "548 dangling refs" lead from the prior entry is now
**closed as an instrument artifact** — it was never a caption/silence-removal engine bug.

**A real, separate defect survived the fix**, visible only now that the false failure
stopped masking it: `captions-uppercase-bottom` run 2 genuinely called `caption_the_edit`
(captioning the whole edit) but never followed up with `set_track_caption_style`, so the
captions landed without the requested uppercase/bottom styling — `intent: failed`, not
scored 1.00. This is 1 of 3 runs; not yet diagnosed further. See leads below.

### Fix 2 — the Claude Agent SDK provider discarded correct edits as hard failures

The real, systemic bug of this session. `claude-agent-sdk.ts`'s sandbox deliberately sets
`maxTurns: 1` (the orchestrator owns the loop; the SDK should only ever need one of its
own turns to propose-and-defer a batch of tool calls). When the model proposes more than
one parallel tool call in a single message, the SDK sometimes needs more than one of its
own internal turns to finish deferring all of them — even though every one of them is
still deferred, never executed. When that happens, the SDK does not yield a `result`
message the adapter could inspect; it throws `Error: Claude Code returned an error
result: Reached maximum number of turns (1)` directly out of the `for await`, after the
tool-call chunks already streamed through. The adapter's `catch` block rethrew
unconditionally, discarding an edit that had, in every observed case, already landed
correctly on the timeline.

Measured before the fix: 16 case+run files carried this exact error
(`broll-first-20s` 3/3, `broll-empty-overlay-track` 3/3, `memory-captions` 3/3,
`beat-sync` 1/3, `captions-uppercase-bottom` 1/3) — every one of them scored
`intent: failed` against an `edit` expectation despite `checks` showing the requested
edit had actually been applied correctly.

Fix: when this specific error is caught and at least one tool call was already yielded in
the same stream, treat it as a normal completion instead of rethrowing. A result subtype
with no usable output (e.g. `error_max_budget_usd`) still throws. Two regression tests
added — one for a `result`-message shape defense-in-depth, one reproducing the real
throw-based shape measured against the installed SDK (0.3.259).

**How this was verified without re-running the baseline**: `--replay` cannot exercise
this fix — replay works from already-parsed chunk recordings, downstream of the provider
code that changed, and the affected recordings are truncated exactly at the crash (the
SDK never yielded the final "result" the recorder could capture). The only way to confirm
was a live call. Ran `broll-first-20s` once (not three times) before the fix — confirmed
the exact "max turns" crash reproduces on real media, `intent: failed`, $0.08. Fixed,
rebuilt, ran it again once — the crash is gone; the run now reaches its own self-check
(Critic) and fails there instead, on a real, different, newly-surfaced defect (below).
**This is not reflected in the `baseline` label's cached rows for `broll-first-20s`,
`broll-empty-overlay-track`, `memory-captions`, or `beat-sync`'s r1** — those still carry
the pre-fix crash and were deliberately NOT re-run under `baseline` (3 cases × 3 runs
would cost real money to re-confirm something already confirmed once). Read those four
cases' current numbers in this baseline as **stale positives for the wrong reason** — the
true state is "no longer crashes," not "still scores 0%."

### Fix 3 — `guard-wipe-timeline` conformed to the shipped decision (ADR 0166)

Not a bug — a decision the prior entry deliberately left open (see the pre-instrument
entry below and REMAINING.md §3.1). ADR 0166 is accepted and shipped (`wipe-guard.ts` is
gone); goal.md's "guard destructive intent" line predates it and was never reconciled.
Conformed the case rather than continuing to fail it against a requirement the product no
longer implements: added `checkTimelineWiped` + a `'wiped'` rubric (delete-everything is
`intent: edit`, not `ask`), changed the case's expectation to match. Rescored via
`--replay`: **0.60 → 1.00 × 3, first-pass.** Reversible if goal.md's line is reinstated —
see the comment left in `golden-cases.ts`.

### New leads, not yet run down

1. **`captions-uppercase-bottom` r2**: `caption_the_edit` ran, `set_track_caption_style`
   never followed. 1 of 3 runs. Real, now-visible defect (see Fix 1).
2. **`broll-first-20s`, live-verified post-fix**: with the crash gone, the run's own
   Critic self-check (`checkWordSevered`) now correctly fails on a genuinely severed word
   the agent's b-roll placement introduced — confirmed NOT an instrument bug:
   `runVerify` (orchestrator.ts:8541) already reconciles inherited-vs-new failures via
   `reconcileInheritedFailures`, so this is the run's own new defect, not footage it
   inherited. The agent burned 19 model calls / $2.07 failing to resolve it. Real
   accuracy problem in b-roll placement near a spoken word; not diagnosed further this
   session — expensive to reproduce (a full live run) and out of budget for this pass.
3. **`reorder-last-first` r1's reversibility failure investigated, not resolved.** Traced
   to the agent redundantly re-issuing `move_clip` on the same clip four times, one call
   using a truncated `toStart` (`119.967` vs the exact `119.96666666666667`). Confirmed
   `editor-core`'s `invertProjectPatch`/`applyMove` are correct in isolation, and confirmed
   `snapSecondsToFrame` collapses both values to the identical quantized float — so the
   **production path (`commitProjectPatch`, which quantizes once before invert/apply)
   should not reproduce this**. Whether the golden harness's `checkReversibility` (which
   calls `invertProjectPatch`/`applyProjectPatch` directly on `event.edit.patch`, bypassing
   `commitProjectPatch`) is scoring on genuinely unquantized data is unresolved — plausible
   instrument gap, not confirmed. r2/r3 of the same case used a different, cleaner
   strategy (new track, one move per clip) and undo perfectly. Needs a from-scratch repro
   with quantization traced step by step, not attempted this session (deep, uncertain
   payoff, no live-run budget left).
4. **`clarify-which-clip` mutates while asking, on all 3 runs, root cause identified but
   not fixed.** The agent correctly asks a clarifying question (`intent: ask` matches) but
   also applies 5 unrelated `set_clip_crop` (vertical-reframe) operations in the same
   turn — confirmed nothing in the orchestrator's ask-handling path (`orchestrator.ts`
   ~3976) stops mutating tool calls batched alongside an `ask` call from executing. The
   same "reframe everything" pattern appears across most cases on this project and is
   usually harmless/expected (most edit-intent cases score fine with it) — it is
   specifically wrong on an ask-only turn. Not fixed: `orchestrator.ts` is ~8,000 lines
   with dense, incident-driven invariants (see its own comments), and a structural fix
   here needs live verification this session's budget does not cover. The safe, narrow
   fix shape: when a batch of proposed tool calls includes an `ask`, do not apply the
   other calls in that same batch.

---

## `baseline` — 2026-09-04 — **the first real floor; accepted**

The first baseline where all four dead rubric checks are live, undo is measured, void
turns are excluded and re-run rather than counted, and Memory Store is cleared between
runs. This is now `reports/golden/floor.json`. Every future golden run is compared
against this entry, not the pre-instrument numbers below.

| | |
| --- | --- |
| commit | `4fa7ea4` on `feat/golden-eval-harness` (fixtures rebuilt after; not a new commit) |
| provider / model | `claude-agent-sdk` / `claude-sonnet-5` |
| media | `tests/fixtures/mission/projects/*.fp.json`, rebuilt same day via `mission-fixture-projects.mjs` |
| cases × runs | 21 × 3 = 72 turns |
| voidTurns | 0 (16 on the first pass — provider went dark for the last 6 cases; re-run separately, see below) |
| tokens / accepted edit · tier-priced cost / accepted edit | 548,398 · $1.15 (not billed — no price source, ADR-gated) |

Two-pass run, both merged into the one `reports/golden/baseline.json`/`floor.json`:
pass 1 was the full 21×3 and died to quota exhaustion after `music-bed-quiet` r3
(trap #4 in REMAINING.md, confirmed again); pass 2 re-ran only the 6 affected cases
with `--force`, and a final no-`--force` pass merged all 21 cases' cached results into
one summary (the runner scopes `summary.json` to the invocation's `--case`/`--category`
selection, not to everything on disk — rerun with no `--case` filter to get the merged
number).

### The ten metrics

| metric | value |
| --- | --- |
| intent accuracy | 68% |
| target resolution | 76% |
| boundary precision | 100% |
| operation validity | 100% |
| first-pass acceptance | 33% |
| silent successes | 0 |
| reversibility | 97% |
| accepted edits | 24 |
| model calls / turn p50 · p95 | 5 · 16 |
| first progress p50 · p95 · done p50 · p95 | 3.1s · 5.4s · 62.1s · 580.0s |
| failure quality | 17 failures: 13 loud, 12 explained |

### Per scenario

| case | category | score | intent | first-pass | undo ok | calls | USD/run | wall/run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| montage-30s | montage | 1.00 | 100% | 100% | 100% | 5 | $0.18 | 75.7s |
| podcast-highlight-60s | highlight | 0.75 | 0% | 0% | 100% | 5 | $0.46 | 117.5s |
| remove-dead-air | silence | 1.00 | 100% | 100% | 100% | 3 | $0.14 | 100.8s |
| beat-sync | beat | 0.56 | 33% | 33% | 100% | 6 | $0.29 | 128.2s |
| refine-tighten | pacing | 1.00 | 100% | 67% | 100% | 8 | $0.89 | 438.5s |
| memory-captions | memory | 0.86 | 67% | 0% | 100% | 6 | $1.07 | 198.4s |
| trim-first-clip-10s | trim | 1.00 | 67% | 67% | 100% | 4 | $0.10 | 28.9s |
| trim-opening-10s | trim | 1.00 | 100% | 100% | 100% | 4 | $0.11 | 37.6s |
| reorder-last-first | reorder | 1.00 | 67% | 67% | 67% | 8 | $0.54 | 118.5s |
| reorder-swap-first-two | reorder | 0.50 | 100% | 0% | 67% | 16 | $0.83 | 325.3s |
| captions-plain | captions | 0.90 | 100% | 0% | 100% | 8 | $0.56 | 48.6s |
| captions-uppercase-bottom | captions | 0.92 | 67% | 0% | 100% | 10 | $0.76 | 54.6s |
| hook-strongest-line | hook | 0.89 | 100% | 0% | 100% | 6 | $0.25 | 170.6s |
| broll-first-20s | broll | 1.00 | 0% | 0% | 100% | 4 | $0.08 | 24.9s |
| broll-empty-overlay-track | broll | 1.00 | 0% | 0% | 100% | 3 | $0.05 | 15.3s |
| music-bed-quiet | audio | 1.00 | 100% | 100% | 100% | 6 | $0.23 | 64.7s |
| compound-silence-captions | compound | 0.90 | 100% | 0% | 100% | 7 | $1.13 | 66.2s |
| vague-make-better | vague | 1.00 | 100% | 100% | 100% | 7 | $0.18 | 55.6s |
| impossible-8k-drone | impossible | 1.00 | 0% | 0% | 100% | 2 | $0.06 | 13.7s |
| guard-wipe-timeline | guard | 0.60 | 0% | 0% | 100% | 2 | $0.04 | 8.9s |
| clarify-which-clip | clarify | 0.60 | 100% | 0% | 100% | 4 | $0.10 | 31.2s |

### An instrument fix landed mid-baseline, not before it

`beat-sync` in `golden-cases.ts` was missing `musicAssetName: 'beat-100bpm.wav'`, so
`mission-baseline.mjs` never called `/detect-beats` and the case silently fell back to
the nominal-grid scoring `89a4c47` was supposed to have eliminated (REMAINING.md §5.2).
Fixed and rebuilt between the two passes above (no runner alive at the time — safe).
The number in this table (0.56) is scored against measured onsets. **`beat-sync` has no
pre-fix comparator** — the only prior number for it is the dead-metric one in the
pre-instrument section below, which isn't comparable either.

### Not evidence of

- **A price.** `tier-priced cost` is not billed spend (§4 of REMAINING.md); no model in
  the vendored catalogue has a real price.
- **`podcast-highlight-60s` measuring highlight selection.** Confirmed again:
  `mission-podcast`'s transcript is still the ASR loop (REMAINING.md §3.2). All 3 runs
  scored `intent=failed`/`cancelled` with the timeline unchanged at 575.87s — the agent
  correctly declining to select highlights from fabricated content, and the rubric
  correctly has no way to reward that.
- **`guard-wipe-timeline` measuring a real defect.** Score 0.60 × 3, failing
  `timeline-unchanged` because the agent wiped the timeline on request without asking —
  which is the behavior ADR 0166 mandates (REMAINING.md §3.1). This needs a maintainer
  decision on goal.md/the case, not an agent fix.

### New leads from this run, not yet diagnosed

1. **`beat-sync` is inconsistent, now that it's actually being measured.** r1 placed the
   music and hit every beat (1.00, first-pass). r2 asked instead of editing; r3 failed
   with the timeline unchanged — both scored via `has-music: 0 music clip(s)`, i.e. the
   agent never placed the music track in 2 of 3 runs of the same prompt. This is now a
   real, reproducible 33% first-pass rate on a case that used to be unmeasurable. Worth
   tracing before touching the beat-sync tool/prompt.
2. **`compound-silence-captions` fails `valid-refs` on every run** — 548-575 dangling
   asset refs, `ops` in the 1,200s (r1: 1269, r2/r3: 1290). This case also runs on
   `mission-podcast`, the ASR-loop media (§3.2), so the caption count is inflated by the
   397-times-repeated phrase — but a dangling asset ref is a schema-integrity check, not
   a content check, and it fired on every run. Recheck after `mission-podcast`'s media is
   replaced (§3.2 fix) before deciding whether this is a real caption/silence-removal
   engine bug or another artifact of the fabricated transcript.
3. **`clarify-which-clip` intent is correct but the case still fails.** `intent=ask`
   matches the expected `ask` on all 3 runs (100% intent accuracy) but score caps at
   0.60 because `timeline-unchanged` reports the timeline WAS modified — i.e. the agent
   asked a clarifying question and edited anyway, in the same turn. If this reproduces
   under `--replay`, it is a real "asks but doesn't wait" defect worth a product decision
   before it's called a bug.
4. **`reorder-swap-first-two` is the weakest fully-measurable case**: 0.50, 0% first-pass,
   67% undo-ok, 16 calls/turn (highest in the set) — worth a look at what it's burning
   turns on.

---

## Pre-instrument numbers — 2026-08-29 — **do not compare against these**

The only real-media numbers that existed before the golden harness. They are kept
for provenance, not for comparison.

| | |
| --- | --- |
| source | `reports/system-mission/after-orchestration-merged.json`, reduced into `reports/golden/floor.json` |
| provider / model | `openai-compatible` (the `trial/` bridge) / `claude-sonnet-5` |
| generated | 2026-08-29T08:40:23Z |
| cases × runs | the 6 mission scenarios × 3 |

| scenario | rubric p50 | calls p50 | tokens/turn p50 | runs | notDone |
| --- | --- | --- | --- | --- | --- |
| montage-30s | 1.00 | 31 | 33,503 | 3 | 1 |
| podcast-highlight-60s | 1.00 | 5 | 38,814 | 3 | 0 |
| remove-dead-air | 0.75 | 6 | 26,979 | 2 | 2 |
| beat-sync | 0.78 | 18 | 30,080 | 3 | 0 |
| refine-tighten t1 / t2 | 0.63 / 0.88 | 18 / 12 | 32,265 / 34,564 | 3 | 2 / 2 |
| memory-captions t1 / t2 / t3 | 0.63 / 0.71 / 0.43 | 10 / 61 / 2 | 31,328 / 33,070 / 0 | 1 | 0 / 1 / 1 |

### Not evidence of

- **Any of the ten goal.md metrics.** They did not exist yet; `floor.json`'s
  `summary` block is `null`. Intent, target, boundary, first-pass, reversibility,
  latency and failure-quality figures cannot be recovered from this run.
- **A comparable rubric score.** Four rubric checks were structurally broken at
  this point and all four read as calm — see `REMAINING.md` §2. In particular
  `cuts-on-frame-grid` failed on every case regardless of the agent, and
  `cuts-on-beats` was scored against a nominal grid the product never promised.
- **Three independent samples.** The Memory Store leaked between runs via a fixed
  project id until `cc86cb0`, so run 3 saw run 1's answers.
