# Phase 7 — Export: after

## The headline

**A 30-second 4K → 1080×1920 export went from 48.2 s to 11.5 s — 4.2× — by deleting work,
not by encoding faster.**

Earlier in this mission, hardware encoding (VideoToolbox) cut ffmpeg's CPU from 146 % to
48 % and moved wall time barely at all: 94.2 s → 92.6 s. That result was the useful one,
because it **disproved** the obvious hypothesis. The encoder was never the bottleneck.

## What the profile said

`cProfile` over one real export of `mission-export-30s` (4K source, 1080×1920 frame),
in-process, sorted by cumulative time:

| | seconds | share |
| --- | --- | --- |
| total export | 48.2 | 100 % |
| `_encode` | 47.3 | 98 % |
| `write_videofile` → frame iteration | 44.1 | 92 % |
| **`PIL ImagingCore.resize`** | **33.3** | **69 %** |
| `PIL.Image.fromarray` / `frombuffer` | 3.9 | 8 % |

**69 % of the entire export was one line**, called 901 times — once per frame — at 37 ms
each.

## Why it was there

`decode_cap_for_clip` already capped the decode at the frame's longest edge plus 25 %
headroom, so a 3840×2160 source was decoded at 2400×1350. But a *landscape* source fitted
into a *portrait* 1080×1920 frame is only displayed at **1080×608**. So every frame was
decoded at 2400×1350 and then shrunk to 1080×608 by PIL, in Python, single-threaded — and
roughly three quarters of the pixels ffmpeg had just produced were thrown away.

## The fix

`fitted_decode_size(source, target)` computes the size a fit-to-frame clip is actually
displayed at, and `_open_source_reader` asks ffmpeg for exactly that. MoviePy's per-frame
resize then becomes a no-op, and the scaling happens in ffmpeg's SIMD scaler inside the
decode thread instead.

It applies **only** when the clip is a plain fit — no keyframes, no crop, no rendered
transform, no geometry-bending transition — because anything that moves or zooms has a
displayed size that is not knowable at compile time, and a soft zoom is worse than a slower
export. Those clips keep the old cap with its headroom. It also never requests an upscale:
asking for more pixels than the source has costs time and invents detail.

## Measured, both fixtures, same harness

| fixture | before | after | note |
| --- | --- | --- | --- |
| 30 s, 4K → 1080×1920 | **48.2 s** | **11.5 s** | 4.2× — output byte size unchanged (31.2 MB), validation still passes |
| 60 s, 360p → 1920×1080 | 3.7 s | 3.7 s | **no change, correctly** — the source is smaller than the frame, so there is nothing to downscale and the optimisation declines to act |

The second row is the one worth reading twice: an optimisation that reports a win on a
fixture it cannot possibly help would mean the measurement was wrong.

## The other P7.5 clauses, checked rather than assumed

- **Encode count = 1.** The master-bus audio pass runs `-c:v copy`, so video is encoded
  once. It is a no-op when no audio filter is set, and its temp file is atomically replaced
  into the output, so it leaves nothing behind.
- **Intermediate bytes = 0.** The only intermediate is that audio temp, and it is
  `Path.replace`d rather than copied-and-deleted.
- **Assets prepared but unreferenced = 0.** `index_assets` resolves and `stat`s paths but
  does **not** probe (`probe=False` on the render path) — 9 assets cost 1 ms in the
  profile — and `compile_timeline` opens a reader only for clips actually placed on a
  track. The 30 s fixture has 9 assets and 2 placed clips; nothing was being prepared for
  the other 7.

## Still open

- **Progress accuracy (< 5 % after the first 10 %)** is not measured. The progress channel
  exists and reports stage + fraction from the render subprocess; nobody has compared its
  curve against wall time.
- **Stream-copy passthrough** for an untouched same-codec same-resolution export is not
  implemented. It is listed in P7.5 as "rare but cheap to detect", and after this change the
  case it would serve — a clip that needs no scaling at all — is already the cheap path.
