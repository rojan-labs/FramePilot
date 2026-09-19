# ADR 0181 — A matte's monitor tier is derived by the host, beside the artifact

- **Status:** Accepted for the format, the engine function and the monitor's use of it (PX5.3).
  The desktop trigger — a new sidecar route — was **approved by the maintainer on 2026-09-18**
  (MO-17, recorded per CLAUDE.md §5) and is built (PX5.9, section "The trigger" below).
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

## The trigger (approved 2026-09-18, MO-17; built in PX5.9)

At PX5.3 this was left to the maintainer: the route is new sidecar surface (CLAUDE.md §5). It was
approved on 2026-09-18 on the terms below, and built as `POST /mattes/monitor-tier`
(`service.py`, `render/matte_tier_job.py`; API in `docs/api/capability-packs.md`):

- **Inputs.** The project folder, the artifact exactly as the mask pins it (key, file digests,
  size) and the asset's proxy path and display rotation. The route measures the proxy itself
  (hardened ffprobe) and turns the size for 90/270, as the monitor turns the decoded picture.
- **The BR4.12 limits of the other `/mattes/*` routes.** Every path through the projects-root
  sandbox; one request at a time (503); one total deadline sized from the frame count (600 s +
  0.5 s per frame, capped at 6 h; 504); `-protocol_whitelist file` / `-format_whitelist` (Matroska
  forced) on every master read and a `pipe,fd` / `rawvideo` whitelist on every encode input;
  bounded request fields (int64-safe sizes, hex digests, known file names); no path in any answer.
- **Real folders, pinned digests, atomic write.** `.framepilot-derived/mattes/<key>` and
  `matte-tiers` are walked with `lstat` (a link, or a master that is not a plain file, refuses
  with 400); the masters are hashed against the pins before the first frame and after the last
  (409); everything is written into `matte-tiers/.staging/<random>/`, probed back and renamed into
  place. A tier that already names these digests, size and frame count is left alone.
- **The host** (`capability-packs/matte.ts`) calls it after an artifact commits and on a cache
  hit, for a video asset with a proxy and an artifact with a foreground, in the background. A busy
  route is retried on a bounded schedule (about 8 minutes); any failure is logged by code and
  never changes the job's outcome. The monitor asks again for a missing `tier.json` every 30 s,
  so a tier made after it first looked is picked up without reopening the project.
- Cost on an M1 Pro: 84 ms per 4K frame for a disc filling 22% of the frame, 205 ms for a subject
  filling it, plus 24–84 ms for the alpha plane (a 3-minute 4K clip: roughly 10–25 minutes of
  sidecar CPU, in the background like a proxy); the measured end-to-end run on the Scale row is
  in `PX5-BUDGETS.md`, "PX5.9".

## Consequences

- A matte in the monitor is fast only where a tier exists; since PX5.9 the desktop makes one in
  the background after each committed artifact (and the fixture and the oracle generator make
  theirs); until it is written the monitor decodes the masters.
- Re-processing an artifact invalidates its tier by digest; nothing has to delete it.
- A clip shown at a size other than the tier's (an inset decoded smaller) uses the masters.

## Addendum (PX5.8, 2026-09-18): the alpha plane, for a matte whose source chain is the identity

The context above says the alpha cannot be pre-resampled because its edge controls run at source
resolution. That holds for a matte that USES them. For one whose every source-resolution step is
the identity at an instant — edge shift 0; no denoise, clean levels, morphology, shrink/grow,
blur or in/out ratio (so never `edgeMode: 'sharp'`, which supplies clean levels 0.25 / 0.75);
expansion and both feathers 0 — `matte_alpha` is `to_frame(samples / maximum)` followed by
invert and opacity, and the first half of that is a plane the host can make once like the
others. `render/matte_tier.py` `source_chain_is_identity` states the rule step by step from the
functions' own identity conditions, and the tests hold it to the export: where it is true, the
alpha drawn from the plane is `matte_alpha` within the plane's half step (1/131070); where
`sharp` is set, drawing from the plane would move alpha by more than 0.05.

- `write_monitor_tier` writes `alpha.mkv` (`round(resample(samples / maximum) × 65535)`, high
  then low byte rows, `W × 2H` intra-only gray FFV1) in the same pass as the planes, and
  `tier.json` names it under `alpha`. Still version 1: a reader without PX5.8 ignores the entry.
- The monitor reads the plane only for a mask whose chain qualifies at EVERY instant (none of
  the four scalar controls keyframed), only where the picture was decoded at the tier's size,
  and only when `alpha.mkv` opened as `tier.json` describes; the compositor then applies the rule
  per instant. Anything else decodes the source-size samples, as before. A malformed `alpha`
  entry makes the whole tier unusable; an `alpha.mkv` that does not open leaves the planes in use.
- Cost: 24–34 ms per 4K frame to make for the Scale disc, 84 ms for a subject filling the frame
  (on top of the planes' 84–205 ms); 3.6 ms per frame to decode at 960×540 where the 4K samples
  take 19.6–20.1 ms (`matte-decode.perf.test.ts`).
