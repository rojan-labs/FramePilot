# 0124. Review measures statistics, not pixels

- Status: Accepted
- Date: 2026-08-15
- Amends: [0119](0119-the-evidence-batch-ceiling-is-a-time-budget.md),
  [0121](0121-compiled-compositions-are-borrowed-not-rebuilt.md),
  [0123](0123-review-is-admitted-not-merely-started.md)

## Context

ADR 0123 stopped a multi-turn run from holding seventeen review batches at once, and
bounded what one batch keeps resident in **bytes** rather than frames. Both were
necessary. Neither touched the largest term, because both count things that exist
_after_ a frame is decoded.

Decode is upstream of all of it. Every reader the compiler opens is opened on the
original camera master (`_resolve_clip_asset` returns `entry.resolved_path`; the engine
has no proxy concept), and the review preset was built from `project.resolution`. So
review decoded 2160x3840 frames, composited 2160x3840 frames, and measured 2160x3840
frames — to produce a mean, a black-pixel ratio, a set of percentiles, and an 8x9
perceptual hash.

Every one of those is a statistic over the whole picture. None of them can tell UHD
from a quarter of it. The most expensive thing the module did was decode 25 MB in order
to compute a 9x8 grayscale hash.

The same waste sat on `/render/frame`, in a form that is easier to see: the vision
reviewer asks for a **512-pixel** JPEG, and the engine composited the project's full
resolution and then threw 97% of the pixels away in a Pillow resize.

Measured on an 8-clip 2160x3840 sequence, sampling 20 frames in ascending order:

|                                   | frame size | per frame  | peak RSS   |
| --------------------------------- | ---------- | ---------- | ---------- |
| project resolution, native decode | 2160x3840  | **273 ms** | **781 MB** |
| review resolution + decode budget | 540x960    | **38 ms**  | **176 MB** |

781 MB is one batch, before a single frame is retained. Seventeen of them is the
incident ADR 0123 was written about.

## Decision

**Review measures at `REVIEW_MAX_DIMENSION` (960 on the longest edge), and no source is
decoded larger than the frame it is composited into.**

Three parts, in the order the pixels flow:

1. `compile_timeline` takes `max_decode_dimension`. When set, an oversized source is
   opened at a target resolution in the **decoder** (`VideoFileClip(target_resolution=)`
   → ffmpeg `-s`), not resized after ffmpeg has already produced the full frame. It is a
   ceiling, never a target: a 720p source under a 1080 budget is opened untouched,
   because upscaling in the decoder would cost more than not budgeting at all. The
   export path passes `None` and still reads masters — you finish from the master.
2. `acquire_temporal_evidence` builds its preset by capping the project's resolution,
   and passes the same figure as the decode budget.
3. `grab_frame` composites at the size the caller asked for rather than the project's,
   and budgets decode to match. A named export preset is still composited as authored —
   asking about Reels is a question about that format.

**Concurrent compilations are bounded in the cache, where every caller passes.** ADR
0123 serialized `/review/temporal-evidence`; the same unbounded concurrency was still
reachable through `/render/frame` and the MCP server. Bounding _builds_ rather than
routes puts the limit on the resource that actually costs (`MAX_CONCURRENT_BUILDS = 1`),
and leaves the common case free: a caller whose key is already cached — an agent
inspecting several frames of the revision it just built — never reaches the gate.

### What this costs, stated plainly

`min` and `max` over a resampled frame are a **different measurement**. A single stray
superwhite pixel is averaged into its neighbours and no longer registers, so scope
legality is slightly less sensitive than it was.

That is why the cap is 960 and not 512. At a quarter linear scale an excursion has to
cover about four source pixels to survive, and a legality problem worth failing an edit
over is a region — a blown highlight, a crushed shadow, a clipped sky — not one pixel.
A one-pixel excursion visible only to a full-resolution scope is below the noise floor
of the JPEG the audience will actually watch. Every other statistic review takes (means,
ratios, percentiles, hashes) is preserved.

Compiling is slightly _slower_: an oversized source is opened, measured, closed, and
reopened at the budget, which is one extra ffmpeg spawn per source (~86 ms/clip
measured). It repays itself after about three sampled frames.

`TemporalRenderSettings.identity` already carries the width and height, so a recorded
review still states exactly what it was measured at and remains reproducible. This is
what makes the trade auditable rather than silent.

## Consequences

One review batch costs ~4.4x less memory and ~7x less time per frame. Combined with ADR
0123's admission rule, peak review memory is now a small constant: at most
`MAX_CACHED_COMPOSITIONS` (2) plus one composition being built, each a fraction of what
one used to be.

The resident-byte guard from ADR 0123 becomes unreachable through the request path —
the largest legal batch (`MAX_REQUESTS` x 2 comparison frames at the cap) is ~354 MB
against a 512 MB budget. It is kept as defence in depth against a future ceiling change,
and `test_the_largest_legal_batch_fits_the_resident_budget` now asserts that arithmetic
directly, so raising `REVIEW_MAX_DIMENSION` or `MAX_REQUESTS` without re-checking the
budget fails a test rather than a user's machine.

The time budget of ADR 0119 gains a large amount of headroom (worst case ~30s against a
300s client timeout). The timeout is deliberately **not** lowered: it is headroom for a
slower machine and a heavier sequence, and tightening it would only create new ways to
report a healthy engine as unreachable.

Not taken here: removing the per-role audio recompile, still the reason the worst case
needs three compiles. It is now a much smaller share of a much smaller number, so it
drops further down the list rather than off it. See `plan/PLAN.md`.

Deliberately unchanged: the preview ring (`RING_CAPACITY = 24`) and the thumbnail
bitmap cache (`MAX_DECODED_BITMAPS = 256`) are also counts rather than byte budgets, and
were audited against the same question. They are sound because the resolution feeding
them is bounded upstream — the WebCodecs path mounts only when every source has a proxy,
and proxies are 540p — so the count implies a bounded byte figure. That reasoning is
recorded in `docs/guides/performance-budgets.md` so it does not have to be re-derived.
