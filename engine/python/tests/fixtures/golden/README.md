# Golden render fixtures

`reels_testsrc2.json` holds **perceptual average hashes** (aHash, 64-bit) of
frames sampled from a deterministic `testsrc2` source rendered through the real
pipeline to the 9:16 Reels preset (see `tests/test_render_golden.py`).

Perceptual hashes (compared with a small Hamming-distance tolerance) are used
instead of exact frame/byte hashes so the test is stable across ffmpeg/codec
versions while still catching real regressions (wrong frame, black output,
mis-scaled content).

## Regenerating (only when framing changes intentionally)

Run the snippet in `test_render_golden.py`'s docstring (or render the fixture
source and recompute `average_hash` per timestamp), then update `ahash`. Keep
`hamming_tolerance` small (≤ ~12 of 64 bits).
