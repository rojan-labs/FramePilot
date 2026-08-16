# 0123. Review is admitted, not merely started

- Status: Accepted
- Date: 2026-08-15
- Amends: ADR 0122 (review reads, it does not gate), ADR 0119 (the evidence batch ceiling is a time budget)

## Context

ADR 0122 made perceptual review a reader so an edit could reach the timeline the
moment it validated. It changed *when* a review's findings are consulted. It did
not change what starting a review costs, and in removing the wait it removed the
only thing that had been limiting how many could exist at once.

Under the old design the next turn waited for the review of the previous one, so
exactly one review ever ran. That bound was a property of the ordering rather than
a decision anyone had written down. Detaching review kept the bookkeeping and
dropped the bound: every committed turn started a full sidecar review immediately.

A run of seventeen turns over UHD media then held seventeen review batches at
once, and each batch is expensive in a way that is easy to underestimate:

- The review preset is built from `project.resolution`, not a preview size, so at
  2160x3840 one decoded frame is ~25 MB — and it was retained as `float64`, an 8x
  promotion of decoder output, making it ~199 MB.
- `MAX_RENDERED_FRAMES` is 400. As a byte figure that is ~2.5 GB at 540p and ~80 GB
  at UHD. A frame *count* does not bound memory across resolutions.
- Each batch compiles the timeline, holding an ffmpeg reader per source clip.
  `COMPOSITION_CACHE` caps *cached* compositions at two (ADR 0121) but places no
  limit on concurrent builds against distinct revisions — which is exactly what a
  multi-turn run produces, since the cache key is project content.

The observed result was the machine exhausting memory and swapping to death.

Worse, most of that work was already destined to be discarded. `selectLiveFindings`
drops any finding whose region a later turn rewrote, and a run that repeatedly
grades the same clips rewrites those regions constantly. We were spending tens of
gigabytes rendering evidence we then threw away on arrival.

## Decision

The queue that tracks reviews also admits them. Two rules:

1. **At most one review runs at a time** (`FRAMEPILOT_MAX_REVIEW_CONCURRENCY`
   overrides). Peak memory becomes a constant instead of a function of run length.
   Nothing waits on this pool, so a queue behind it costs no wall-clock the user
   can observe — which is precisely what ADR 0122 bought.
2. **A superseded review never runs.** The test is the same `regionsOverlap`
   predicate `selectLiveFindings` applies at drain, evaluated before paying for the
   render instead of after. A review already running when its region is rewritten
   is aborted for the same reason.

Because the skip predicate is the drain predicate, this changes no output: every
finding it declines to produce is one that would have been dropped. It only
declines to spend minutes of UHD decode producing it.

Two supporting changes make one batch affordable rather than merely rare:

- Frames are reduced on decode and their pixels released. Only comparison requests
  need two frames alive at once; everything else turns a frame into a handful of
  scalars, so its pixels are dead the moment that reduction runs. What remains
  resident is bounded by **bytes**, not by frame count.
- The decoder's `uint8` output is no longer promoted to `float64`. Every consumer
  divided by 255.0 into float64 anyway, so this is the same arithmetic on an
  eighth of the bytes.
- `/review/temporal-evidence` is serialized process-wide. The client-side bound
  protects FramePilot's own run; this one holds for every caller, including the
  MCP server, and the resource it protects — the machine's memory — is contended
  by unrelated projects just as much as related ones.

## Consequences

Review cost is now proportional to the number of *surviving* regions rather than
to the number of turns, so a run of any length stays flat in memory.

A review can now wait behind another before starting. This is invisible in the
run's output: findings are consulted at turn boundaries and at the final drain,
and `drainAll` waits for queued reviews as well as running ones.

A batch built almost entirely from comparisons at UHD is now refused with a clear
error rather than allowed to exhaust the machine. Real batches are not
comparison-heavy, so this ceiling is not expected to bind in practice.

The honesty contract of ADR 0120 is preserved: a review we cancelled ourselves is
our own decision, not an unreachable reviewer, and is never reported to the user
as "review could not run".
