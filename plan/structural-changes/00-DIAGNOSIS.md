# Diagnosis — captured montage run `e36235cc` / `4aa31c96` (round 5)

**Source:** `run.md` (77,500 lines, 1,365 events), conversation `0049aed5`, project
`project_new_proj_mtbeyu802xjq`, model `openrouter/auto-beta`, 2026-08-27 11:02:51 → 11:32:37.

**Outcome:** the run reported **`completed`** with **"Passed with 1 warning(s)"**.

The brief asked for **at least 50 distinct picture clips**, beat-synced, 9:16, 30fps.
The final `get_timeline_summary` (11:31:30, three minutes before the run declared success)
returned:

```json
{
  "durationSeconds": 121.36,
  "trackCount": 3,
  "clipCount": 1,
  "tracks": [
    { "id": "video_broll", "clipCount": 0 },
    { "id": "video_main", "clipCount": 0 },
    { "id": "music_1", "clipCount": 1 }
  ]
}
```

**One clip. Both picture tracks empty.** 30 minutes, 367,398 tokens, $1.4288.

This is the fifth captured run of the same brief. Rounds 1–4 (see `plan/PLAN.md`) closed
harness defects: the run no longer dies early, the searches succeed, the recall trap is
open, the sourcing playbook is findable. **Those fixes worked.** The run reached `apply`,
held a 121-beat grid and 12 downloaded clips, and still shipped nothing. What remains is
not the harness.

---

## 1. What the run actually did

143 tool calls. Grouped by tool, with measured output cost (≈ chars/4):

| Tool               |   Calls |    ≈ Tokens | Share |
| ------------------ | ------: | ----------: | ----: |
| `recall_evidence`  |      62 |     289,370 |   37% |
| `search_stock`     |      19 |     268,742 |   34% |
| `search_music`     |      10 |      76,548 |   10% |
| `list_assets`      |       9 |      43,675 |    6% |
| `get_timeline`     |       4 |      28,475 |    4% |
| `add_stock`        |      18 |      25,376 |    3% |
| `describe_footage` |      11 |      12,698 |    2% |
| `add_music`        |       1 |      10,058 |    1% |
| everything else    |       9 |      35,787 |    4% |
| **total**          | **143** | **790,729** |       |

**Placement operations across the whole session: one.** `add_clip` for the music bed.
Zero `split_clip`, zero `trim_clip`, zero `set_clip_speed`, zero picture `add_clip`,
zero `add_transition`, zero reframe.

Project revision moved 0 → 5. The 17 recorded operations are 13 × "Added asset",
3 × "Add layer", and 1 × "Added clip" (the music).

### The run was never short of material

- `detect_beats` (11:24:06, **299ms**) returned **121 beats · ~70 BPM**. It was called once
  and its output was never used to place anything.
- `load_skill('beat-synced-editing')` succeeded and returned the full playbook, including
  the exact tool list needed (`add_clip`, `split_clip`, `trim_clip`, `set_clip_speed`).
- 12 stock videos landed on disk successfully (18 calls, 6 failures).

Twelve clips against 121 beats is roughly ten cuts per source — comfortably more than
the 50 the brief demanded. **Every input the edit required was present at 11:24:06, and
the run spent the remaining eight minutes gathering more.**

---

## 2. Core issue A — one regex disabled the entire quality gate

This is the highest-leverage finding in the investigation.

`packages/ai-sdk/src/acceptance.ts:explicitMinShotCount` extracts a minimum shot count from
the brief. It correctly matches `50+ visually distinct clips` → `50`. It is then discarded
by a guard intended to reject durations misread as shot counts (`acceptance.ts:118`):

```js
new RegExp(`\\b${match[1]}\\s*(?:s|sec|secs|second|seconds|m|min|mins|minutes)\\b`);
```

The brief contains a beat-map **example table**:

```
| 2 | 0.50s | 15 | medium | cut |
```

`0.50s` contains `50s`, and `.` is a non-word character, so `\b` matches between `.` and
`5`. The guard fires. `minShotCount` returns `undefined`.

Verified against the run's verbatim 9,885-character objective — three matches, all of the
same shape (`0.50s` twice in the example table, once in the frame-accuracy list).

The consequences cascade through every downstream gate:

1. `checkableAcceptance` omits `minShotCount`, so the run's recorded acceptance criteria are
   only: _"Every picture clip carries its own reframe"_, the SFX-unmeetable disclosure, and
   the catch-all _"Everything else … which no automatic check settles."_ **The single most
   checkable number in a 9,885-character brief never became a criterion.**
2. `critic.ts:checkShotCount` (line 423) reports `skipped — "No shot count was asked for."`
   Had it run, it would have returned `fail` ("The cut uses 1 shot but at least 50 were
   asked for").
3. `conductor.ts:1783` computes `verificationPassed = r.ok && planReconciled &&
deliveredWork`. A failing Critic check **already blocks completion correctly.** With the
   shot-count check skipped, `r.ok` was true, and a 1-clip timeline was folded to
   `complete`.

**The gate was built, wired, and correct. A false-positive regex switched it off.**
Round 2 fixed the mirror-image bug (a pacing table inventing a 0.6-second _duration_
target); the same table now suppresses the _shot count_. The lesson round 2 recorded was
about the duration reader specifically; the pattern is general.

---

## 3. Core issue B — sequential stock downloads consumed half the run

All 18 `add_stock` calls executed **strictly serially**. Verified by timestamp: each call
begins at the instant the previous one ends.

```
11:10:14  93.6s  ok      11:11:48   8.4s  FAIL ERR_QUIC_PROTOCOL_ERROR
11:11:56  89.5s  ok      11:13:26  73.4s  ok
11:14:39 154.0s  ok      11:17:13  94.2s  FAIL stalled
11:18:47  93.5s  ok      11:20:21   7.9s  ok
11:20:29 104.7s  ok      11:22:13  40.0s  FAIL stalled
── turn 4 ──
11:25:21  79.8s  ok      11:26:41  29.9s  ok
11:27:11  10.9s  ok      11:27:22  16.3s  ok
11:27:38  23.9s  ok      11:28:02  33.6s  FAIL stalled
11:28:36   6.9s  FAIL ERR_NAME_NOT_RESOLVED
11:28:42  0.07s  FAIL ERR_INTERNET_DISCONNECTED
```

**≈960 seconds — 16 of the run's 30 minutes — spent waiting on serialized downloads.
6 of 18 failed (33%).**

`search_stock` by contrast _is_ parallel (five calls at 11:08:21.558 share one timestamp).
The batching machinery in `packages/ai-sdk/src/concurrency.ts` works. `add_stock` is
excluded from it by `packages/ai-sdk/src/tool-contract.ts`:

```ts
add_stock: { executionPlane: 'host', effectClass: 'mutation',
             permissions: ['analysis','write'], concurrency: 'serial', … }
```

That row exists for a real reason — the comment above it documents a permissions hole where
`add_stock` fell to the `analysis` default and became advertised on the question route. But
`concurrency: 'serial'` conflates **two operations with completely different safety
requirements**:

- **acquire** — fetch a third-party file over the network. Pure I/O, no project state,
  embarrassingly parallel, and it is where 100% of the latency lives (7.9s–154s each).
- **commit** — register the asset and place a clip via a reversible patch. Touches the
  turn's speculative working copy, must stay serial, costs milliseconds.

Serializing the commit is correct. Serializing the acquire is what costs 16 minutes.

### The failure signature is not random provider flakiness

Failures cluster at the **tail** of each serial chain and **degrade in character**:
timeout → `ERR_QUIC_PROTOCOL_ERROR` → `ERR_NAME_NOT_RESOLVED` → `ERR_INTERNET_DISCONNECTED`.
The last two are local-stack failures, not Pexels failures, and the final call failed in
**74ms** — it never reached the network. A long serial chain of large downloads appears to
degrade the connection pool / DNS resolver. This matters for the fix: naive parallelism
without a bounded pool and a per-download timeout could make it worse, not better.

---

## 4. Core issue C — the model gathers instead of committing

With A and B removed the run still has no forcing function. The evidence:

- **62 `recall_evidence` calls.** The run re-read its own search results 62 times.
- Round 3 made a first-time recall count as progress (correctly — the run was being killed
  for obeying instructions). The side effect is that **gathering now satisfies the progress
  test indefinitely.** `loop-detector.ts:madeMeaningfulProgress` returns true on
  `learnedSomethingNew` alone; a novel recall is enough. The stall guard can no longer fire
  on a run that recalls its way through a hundred distinct evidence handles.
- The recovery action fired and was **ignored**. `loop-detector.ts:216` emits
  _"Make the next edit the request calls for … Do not read anything else first."_ It appears
  in the run state from version 90 onward. The very next tool calls are `list_assets`,
  `recall_evidence`, `recall_evidence`, `describe_footage` ×7, `recall_evidence` ×9.
  **It is advisory text against a model that is already ignoring advisory text.**
- The two `Gathered enough to work from — switching from reviewing the footage to making
the edit` notices (11:05:16, 11:32:25) also changed nothing.

The user's own read is correct: the next lever is structural, not advisory. A turn that has
never committed a placement must lose the ability to gather.

### Recalls are cheap in latency, expensive in tokens

Worth stating precisely, because it inverts an assumption carried from round 4: every
`recall_evidence` completes in **0ms**, so it looks free — and round 4 did shrink the stored
payload. But 62 recalls still cost **≈289,370 tokens, 37% of all tool output in the run** —
the single largest line item, averaging ~4,670 tokens each. Latency-free is not free.
Any fix that only makes recall faster makes the problem worse.

---

## 5. Core issue D — supporting defects

**D1. `describe_footage` is dead on stock assets.** All 11 calls returned
`{"packets":[],"backend":"twelvelabs","reason":"not_indexed"}`. The run tried twice (4 calls
at 11:24:58, 7 at 11:31:04), got nothing both times, and had no way to tell one downloaded
clip from another. A montage graded on _visual variety_ was assembled blind. Downloaded
stock is never enrolled into the visual index.

**D2. Searches request the wrong orientation.** Every `search_stock` passed
`orientation: "landscape"` for a brief whose first line of MASTER SPECIFICATION is
`**Format:** 9:16 vertical`. The acceptance criteria even recorded _"Every picture clip
carries its own reframe"_ — the run knew, and still sourced landscape.

**D3. Multi-word music queries silently degrade.** All 10 `search_music` calls report the
same shape: `Found 17 tracks for "epic cinematic" (nothing matched the whole phrase "epic
cinematic electronic driving percussion…")`. The provider drops to the first two words. The
run burned 10 searches / 76k tokens discovering this, then picked a 70 BPM track for a
"super-fast-paced" montage.

**D4. The run-state block re-serializes the full 9,885-char objective every turn.** 57
run-state blocks in the transcript, each embedding `objective.request` **and**
`objective.outcome` — the same brief twice. `acceptance.ts:JUDGEMENT_CRITERION` documents
this exact problem being fixed for `criteria`, but `outcome` is still a verbatim copy of
`request`.

**D5. Turn 2 blocked on `No traceable project mutation for the committed plan`** and the
session recovered by the user typing "continue from here" — twice. The run cannot restart
itself from a stall.

---

## 5b. Core issue E — context is rebuilt 52 times, 60% of it a tool catalogue

All 105 context manifests parsed, deduplicated by `requestId`: **52 model calls,
1,223,811 estimated input tokens.**

| Section                                         |      Tokens |     Share |
| ----------------------------------------------- | ----------: | --------: |
| `tool_schemas`                                  | **736,595** | **60.2%** |
| `latest_user_message` (request + run state)     |     221,347 |     18.1% |
| `conversation` (the brief, twice, plus history) |     253,633 |     20.7% |
| `system` contract                               |       7,270 |      0.6% |

**Context per call never grows and never compacts.** It oscillates 19,051 → 41,990;
`compaction.occurred` is `false` in all 105 manifests; the 128,000-token window peaked at
33% used. The per-call number looks healthy, nothing aggregates it, and nothing reports the
schema share — which is why a 1.22M-token run reads as 52 unremarkable ones.

One representative call totals 21,942 tokens: `tool_schemas` 16,962 (77.3%), conversation
4,845, system 135. Against that, the findings budget is
`AGENT_LOG_CLEAR_THRESHOLD_TOKENS = 1000` (`orchestrator.ts:500`): once the agent log passes
1,000 tokens — about two tool calls with real results — every payload older than
`AGENT_LOG_PAYLOAD_FRESH = 2` (`:504`) becomes `[old result cleared — recall ev_N]`.

**The model holds ~17× more context about tools it could call than about what it has found.**

That ratio produces the recall loop mechanically: a `remoteId` exists only in a search
payload; payloads survive two turns; placing a clip requires a `remoteId` the model no longer
holds; so it recalls; the recall re-inflates the log past 1,000 tokens and is cleared again.
**The 62 recalls are architecturally mandated, not a model failure.** Round 3 correctly
stopped the harness killing runs that recall — it did not change the reason they must.

The multiplier is round trips: 144 tool calls over **51 tool-bearing turns, mean 2.82**, with
**32 of 51 turns (63%) making one or two calls**, each paying a full ~23,500-token rebuild
plus an inference.

Full treatment and targets: `05-CONTEXT-ECONOMICS.md`.

---

## 6. What must change, in priority order

| #   | Change                                                  | Evidence                                             | Plan |
| --- | ------------------------------------------------------- | ---------------------------------------------------- | ---- |
| 1   | Stop the acceptance guard rejecting valid shot counts   | 1-clip timeline reported `completed`                 | `01` |
| 2   | Make a run that has committed nothing unable to gather  | 62 recalls, recovery ignored                         | `02` |
| 3   | Split `add_stock` into parallel acquire + serial commit | 960s serial, 33% failure                             | `03` |
| 4   | Rebalance the context budget; cut round trips           | 1.22M input tokens, 60.2% tool schemas               | `05` |
| 5   | Close D1–D5                                             | blind selection, wrong orientation, degraded queries | `04` |

Sequencing rationale: **1 before everything.** Until the gate can fail this run, no other
change is measurable — a run that reports success at 1 clip gives no signal about whether
2 and 3 helped. Fix 1 converts the outcome from a false pass into a blocked run with a
named reason, which is the instrument the rest of the work is measured with.

One item in `05` runs ahead of that ordering: **measure whether the live provider path
honours the cache breakpoint**. It is a measurement, not a change, it costs nothing to take
now, and if the answer is no then 736,595 tokens were billed at full price and that outranks
everything else in this table.
