# EL0.3 — Spike A: the shape raster, measured

**Status:** done, 2026-09-26. **Question:** can the engine draw every shape fast enough to be the
only rasteriser, so the monitor shows the export's own pixels (ADR 0190)?

**Answer: yes, with room.** The slowest preset draws in 2.4 ms at 1080p and 9.1 ms at 4K; the whole
preview round trip for one shape, in process, is 1.6–5.0 ms at 1080p. The monitor fetches a raster
once per change to a shape's params or the frame size (never per frame, never for a move or a
transform), so none of this is on the playback path.

## What was measured, and how

The spike was planned as a prototype before EL4a. It ran late: by the time it was written up, the
rasteriser it would have prototyped had shipped (`render/shape_raster.py`, EL4a and EL5). So these
numbers are the **shipped** rasteriser, which is the stronger evidence, measured with
[`el0.3_raster_bench.py`](./el0.3_raster_bench.py):

- `rasterize_shape` for the six EL4a staples and five EL5 generators (star, bubble, curved segment,
  icon path, labelled badge), each at its default preset size, median of 15 after one warm-up;
- `POST /preview/text-raster` with `kind: "shape"` through FastAPI's `TestClient`: validation,
  the raster, and the base64 RGBA body the monitor decodes. Loopback HTTP to the desktop sidecar
  adds well under a millisecond on the same machine and is not included.

Machine: Apple M1 Pro, Python 3.13 (`uv run`), Pillow 12.3.

| Preset                    | 1080p raster (ms) | 4K raster (ms) | 1080p route (ms) |
| ------------------------- | ----------------: | -------------: | ---------------: |
| `rounded-rect/highlight`  |               2.4 |            9.1 |              5.0 |
| `rounded-rect/filled`     |               2.1 |            8.4 |              4.7 |
| `ellipse/outline`         |               2.2 |            8.1 |              4.7 |
| `marker-highlight/yellow` |               1.0 |            3.8 |              3.0 |
| `line-arrow/red`          |               0.7 |            2.6 |              2.5 |
| `underline-marker/yellow` |               0.2 |            0.5 |              1.6 |
| `star-5/white`            |               1.0 |            3.6 |              2.8 |
| `speech-bubble/white`     |               2.1 |            8.3 |              4.8 |
| `curved-arrow/red`        |               0.9 |            3.1 |              2.5 |
| `icon/check`              |               1.0 |            3.9 |              3.1 |
| `numbered-circle/red-1`   |               0.4 |            1.0 |              1.7 |

The pre-spike estimate in 05 §2.2 (6.9 ms at 1080p, 26.5 ms at 4K) predated compositing each
channel as its own float32 plane; the full-frame worst case the raster-budget test pins is
`test_shape_raster.py::test_a_1080p_shape_rasters_inside_its_budget`.

## What follows

- The engine stays the only shape rasteriser; no browser approximation is needed for the desktop.
- The export draws a shape once per clip (the raster is constant over time; the clip's transform
  and envelope move it), so export cost is one raster per shape clip, not per frame.
