# 0121. Compiled compositions are borrowed, not rebuilt

- Status: Accepted
- Date: 2026-08-14

## Context

Every read-only look at a project — `get_frame`, `measure_color`, a temporal evidence
batch — called `compile_timeline` and threw the result away. Measured on a 37-clip 1080p
sequence cut from UHD sources, compilation is linear and flat:

| video clips | compile | per clip |
| ----------- | ------- | -------- |
| 10          | 7.7s    | 0.77s    |
| 20          | 16.0s   | 0.80s    |
| 37          | 29.6s   | 0.80s    |

The frame actually wanted costs ~0.4s, so `get_frame` was ~98% recompilation. Three
consequences followed from the one cause:

1. A model inspecting its own edit paid the full compile per frame — about 30s each on
   that project, two and a half minutes to look at five frames.
2. `get_frame` and `measure_color` are model-callable and were never costed into
   `TOOL_TIMEOUT_MS`, so they sat on the sidecar's 120s default. At ~150 clips every such
   call times out, and a timed-out tool is routed around (the documented `map_footage`
   precedent) — the edit then gets built without the picture the model asked to see. The
   project that prompted this grew by 41 clips in a single command.
3. Temporal review recompiled per batch, on top of one compile per isolated audio role.

## Decision

A small process-wide cache (`render/composition_cache.py`) keyed by a fingerprint of
everything that can change a pixel: the project document, its media base directory, the
preset, and `burn_captions`.

Deliberately **not** keyed on the timeline revision. Revisions are per-project counters, so
two projects collide, and an in-memory edit that never bumped one would be served a stale
picture — which is exactly the frame a model is looking at to check its own work. Hashing
the model dump costs milliseconds against the 30 seconds it saves.

A composition is not a value, and the design follows from that:

- It owns an ffmpeg reader per source clip, so eviction closes the whole tree.
- Readers carry seek position, so it is **not** thread-safe, and sidecar routes run in a
  threadpool. Entries are therefore _borrowed_ under a per-entry lock, not shared:
  concurrent grabs of one project serialize (they contend on disk anyway), different
  projects still run in parallel, and eviction waits for the borrower rather than pulling
  readers out from under an in-flight grab.
- Two entries, not more: each holds a full set of open decoders, and the access pattern is
  repeated looks at one revision. Two covers a before/after comparison without turning a
  leak into a hoard.

## Consequences

Measured on the same project, five frames at different times: **35.6s, then 2.0s, 2.6s,
0.7s, 0.3s** — 41s total against 178s uncached. Correctness was verified against ground
truth rather than assumed: every cached frame is pixel-identical (mean absolute difference
0.0000) to one produced by a fresh compile.

The leak contract from commit d0c3603 is unchanged in substance but moved. It used to read
"the composition is closed after every call"; it now reads "at most
`MAX_CACHED_COMPOSITIONS` stay open, and each is closed on eviction". Two engine tests
asserting the old wording were updated to assert the new one, and an autouse fixture clears
the cache between tests — a process-wide cache keyed by project content would otherwise
serve one test the composition (or the monkeypatched fake) of another.

Not done here: the per-role recompile in temporal evidence. Each role is a different
project (`_role_isolated_project`), so it is a different key rather than a cache miss to
fix, and it is only paid by batches that measure a named stem.
