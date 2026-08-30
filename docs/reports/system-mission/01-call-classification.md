# P1.1 — the call ledger, classified

Every `tool_call` event across the mission's after-runs
(`reports/system-mission/runs/after-*.json`), terminal entries only so a `running` +
terminal pair is not double-counted. "Identical" means the same tool with the same
`argsSummary` **inside one run**.

**684 tool calls · 116 identical repeats · 17 %.**

| tool | calls | identical repeats | % | classification |
| --- | --- | --- | --- | --- |
| `ripple_delete` | 140 | 0 | 0 % | keep — every call is distinct work |
| `get_frame` | 127 | 14 | 11 % | keep-but-shrink — vision reads, bounded by the analysis caps |
| `set_clip_crop` | 84 | 23 | 27 % | **deterministic** — writing the same crop twice changes nothing |
| `trim_clip` | 48 | 0 | 0 % | keep |
| `get_clip` | 44 | 17 | 39 % | **cache** |
| `get_clips` | 32 | 17 | 53 % | **cache** |
| `get_timeline` | 31 | 16 | 52 % | **cache** |
| `delete_clip` | 31 | 15 | 48 % | **investigate** — see below |
| `delete_clips` | 27 | 9 | 33 % | **investigate** |
| `recall_evidence` | 22 | 1 | 5 % | keep — recall is the cheap path by design |
| `load_skill` | 18 | 0 | 0 % | keep |
| `add_clip` | 9 | 0 | 0 % | keep |
| `detect_beats` | 8 | 0 | 0 % | keep |
| `add_clips` | 7 | 0 | 0 % | keep |

## The finding

**The model does not repeat edits. It repeats reads.** Every mutation that builds the cut
— `ripple_delete` 140, `trim_clip` 48, `add_clip`/`add_clips` 16, `move_clip` 6 — has
**zero** identical repeats. The repetition is concentrated in the tools that ask what the
timeline currently looks like: `get_clips` 53 %, `get_timeline` 52 %, `get_clip` 39 %.

That is a cache-shaped problem, not a prompt-shaped one. A timeline read is a pure function
of the project revision, and the revision only moves when a mutation lands — the working
state already tracks it (`onProjectRevisionChanged` invalidates `timeline_dependent`
facts). A read cache keyed on `(tool, args, revision)` removes roughly **50 calls** from
this sample without the model needing to be told anything.

## The two rows worth investigating rather than caching

`delete_clip` (48 %) and `delete_clips` (33 %) repeating with identical arguments is not a
redundant read — it is the model deleting the same clip twice. Either the first delete did
not land and nothing said so, or it landed and the model did not observe the effect. The
"already satisfied" path exists (`kernel/already-satisfied.ts`) and files a repeat as
*succeeded* rather than *failed*, which is right for the ledger but means the run pays the
round trip anyway. Worth a look at whether the post-mutation arrangement note is reaching
the next turn.

## Caveat on the method

`argsSummary` is a rendered summary, not the raw arguments. For a no-argument tool like
`get_timeline` every call is identical by construction and the number is exact; for tools
whose summary elides a field, two different calls could read as identical. The mutation
rows all being **0 %** is the check that this is not systematically over-counting: if the
summary were lossy enough to manufacture repeats, `ripple_delete` at 140 calls would show
some.

## What this does not cover

Ordering and concurrency (P1.2) are not visible in this table — it counts what was called,
not what could have been called in parallel.
