# ADR 0181 — A matte's monitor tier is derived by the host, beside the artifact

- **Status:** Accepted for the format, the engine function and the monitor's use of it (PX5.3).
  **The desktop trigger is not built**: it needs a new sidecar route, which changes the sidecar
  contract and waits for the maintainer (CLAUDE.md §5).
- **Date:** 2026-09-18
- **Relates to:** ADR 0178 (mask stack), ADR 0179 (Smart Mask packs), ADR 0180 (the monitor
  composites every timeline); plan
  [`09-PREVIEW-EXPORT-PARITY.md`](../../plan/background-removal-ai/09-PREVIEW-EXPORT-PARITY.md)
  (the monitor may be lower resolution, never different content), evidence
  [`PX5-BUDGETS.md`](../../plan/background-removal-ai/PX5-BUDGETS.md) ("PX5.3").

## Context

The desktop monitor plays 540p proxies; a matte artifact is written at the source's display
size. To decontaminate, the monitor decoded the 4K RGB foreground master every frame (72 ms in
its TypeScript FFV1 decoder on flat colour, more on camera footage), uploaded 25 MB and
resampled it. With the GPU matte pass, the matte worker pool and the decoder's block copies the
Scale row still dropped 8.4% of frames on the masters alone.

What decontamination needs at the monitor is only `resample(band)` and
`resample(foreground × band)` at the picture's decoded size. Neither depends on anything the user
can change on the mask: every edge control (shift, levels, feathers, finesse, invert, opacity)
acts on the alpha. So those planes can be made once. The alpha cannot: its edge controls run at
source resolution before the resample, and a pre-resampled alpha would not be the export's.

Two places could make them. **The pack's encoder** (a new declared artifact file) was rejected:
the timeline schema enumerates artifact file names, so pinning one is a schema change and a
migration; the pack is a separate project that cannot use the engine's resample (it would carry
a copy that could drift); it does not know the monitor's decode size; and the host would have to
recompute the tier to trust it anyway. **The host**, from the masters it already verified, with
the engine's own `resample`, has none of those problems.

## Decision

- `render/matte_tier.py` `write_monitor_tier(project, artifact, size)` hashes the masters
  against the artifact's pins (digests before pixels), computes the two planes with
  `resample_limited` — value for value the engine's `resample`, computing only the outputs the
  band's box can reach — rounds them to 16 bits (`weight × 65535`, `colour × 257`), and writes
  them as byte planes (each value's high then low bytes, one `W × 8H` gray frame, intra-only FFV1
  with slice CRCs) plus `tier.json`, written last, naming the masters' digests, the source size,
  the frame count and the layout.
- It lives in `.framepilot-derived/matte-tiers/<key>/`, **beside** the artifact and never inside
  it: the artifact directory keeps exactly the files the host verified and the mask pins.
- The monitor uses a tier only when `tier.json` names exactly the digests its mask pins, covers
  every frame and has the documented layout, and only where the picture was decoded at the
  tier's size. Anywhere else, or if the tier is missing or fails to decode, it decodes the
  foreground master: a tier is an accelerator, never a source of truth. The export never reads it.
- The loss is the 16-bit rounding: at most 1/131070 of the weight and 1/514 of a colour level
  before the mix rounds to bytes, so no byte moves more than one level (tested against
  `decontaminate_dense` in Python and against the masters path in TypeScript). The PX4 oracle
  judges the tier path at its unchanged gates: its generator makes each tier at the size the
  export decoded the picture at.

## Not decided here (the pending trigger)

The desktop app does not make tiers yet. The smallest design: after the host commits a verified
artifact (BR4), it calls a sidecar route — shaped like `/mattes/frame-hashes` (one request at a
time, a deadline, no path echoed, paths confined to the projects folder) — with the artifact and
the size the monitor decodes the source's proxy at, and the route runs `write_monitor_tier`.
Cost on an M1 Pro: 84 ms per 4K frame for a disc filling 22% of the frame, 205 ms for a subject
filling it (a 3-minute 4K clip: roughly 8–18 minutes of sidecar CPU, in the background like a
proxy). That route is new sidecar surface, so it is the maintainer's call; until then the
monitor decodes the masters, correctly and slower.

## Consequences

- A matte in the monitor is fast only where a tier exists; the fixture and the oracle generator
  make one, the desktop does not yet.
- Re-processing an artifact invalidates its tier by digest; nothing has to delete it.
- A clip shown at a size other than the tier's (an inset decoded smaller) uses the masters.
