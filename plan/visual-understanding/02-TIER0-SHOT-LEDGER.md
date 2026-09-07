# 02 — Phase VU1: the tier 0 shot ledger (ffmpeg only, keyless)

**User outcome.** Import footage on a clean install with no key anywhere, open Agent mode,
and the agent can say which clips are dark, warm, shaky, soft, static or duplicates, and where
every shot starts and ends. Nothing left the machine and no model ran.

**Scope gate.** Current workflow gap: the agent has zero facts about pictures on the default
install (`00-DIAGNOSIS.md` §2.1). Minimum slice: one ffmpeg pass per asset → `shots.measured`
→ visible in `describe_footage` and the Settings coverage line. Reuse: `visual_sampler.py`,
`visual_indexing.py`, the `/brain/visual/index` job, `analysis_results`, `visual_outcomes.py`.
Deferred: labels, entities, captions (VU5/VU6), any UI beyond the coverage line.

## VU1.1 One decode, every measured fact `[ ]`

One ffmpeg invocation per asset produces every tier 0 signal. Decoding twice at scale is the
cost we cannot afford; parsing text is cheap.

```
ffmpeg -hide_banner -nostats -i <media> -an \
  -vf "fps=2,scale=160:-2,
       scdet=threshold=8,
       signalstats,
       siti,
       blurdetect,
       blackdetect=d=0.1:pic_th=0.98,
       freezedetect=n=-60dB:d=0.5,
       metadata=mode=print:file=-" \
  -f null -
```

- `fps=2` gives two samples per second: enough for per-shot statistics, four times cheaper
  than the sampler's 1 fps JPEG extraction per candidate today (which stays, for keyframes).
- `scale=160:-2` before every filter. Statistics on 160 px wide frames are within noise of
  full-res for means and percentiles (verify in VU1.6 against full-res on the fixtures).
- `signalstats` → `YAVG YMIN YMAX YLOW YHIGH UAVG VAVG SATAVG HUEAVG` per frame.
- `scdet` → `scene_score` per frame; cut candidates where score crosses the threshold. Cross-
  check against `analysis/scenes.py` (`select='gt(scene,T)'`) on the fixtures and keep ONE
  scene source: the sampler's `scene_cuts` become `scdet` output so the two never disagree.
- `siti` → spatial information (detail) and temporal information (motion) per frame.
- `blurdetect` → per-frame blur; per-shot sharpness = 1 − normalised median.
- `blackdetect`, `freezedetect` → intervals; a shot inside one is flagged.
- Audio loudness per shot: a second, audio-only pass (`ebur128`) only when the asset has an
  audio stream; cheap and reuses `analysis/loudness.py` parsing.

Parsing lives in a new pure module `analysis/shot_stats.py` (fold frame rows into shots given
cut times; 100% covered, golden-tested on captured `metadata=print` text, no ffmpeg in tests).
The runner mirrors `visual_indexing.BytesRunner` so the decode is injectable.

Warmth calibration: `warmth = clamp((VAVG − UAVG) / 64, −1, 1)` on the 8-bit U/V means,
offset so `ref/colorchart.png` reads 0.0 ± 0.05. Record the offset as a constant with the
fixture hash in the test. Contrast index `= (YHIGH − YLOW) / 255` shot median.

Motion class from `TI` median over the shot, thresholds fixed by the fixtures:
`static < 3`, `slow < 8`, `handheld < 15` (with high TI variance), else `fast`. Print the
thresholds in one constants block; do not scatter them.

## VU1.2 Shot boundaries `[ ]`

Shots come from the sampler's fold (`plan_spans`) fed with `scdet` cuts. A shot is a span; the
keyframe is the span's `keyframe_t` (already the phash frame). Stills are one shot. Very long
static spans (screen recordings, interviews) are split at 30 s so per-shot stats stay local;
the split is a `shot_index` boundary, not a scene cut, and carries `splitOf: true`.

## VU1.3 Persist `[ ]`

- Brain migration v4 (`01-ARCHITECTURE.md` §4). Append-only, tested forward from a v3 file
  fixture.
- `BrainStore.upsert_shots(asset_id, content_hash, tier, rows)` writes one tier column and
  bumps `updated_at`; `list_shots(asset_ids, since?)`; `delete_shots_for_asset`.
- `asset_digest` rebuilt in the same transaction from the shots of the asset.
- `visual:outcome` row gains `tiers: {measured: ok|failed|skipped, ...}`.

## VU1.4 The route runs tier 0 with no key `[ ]`

In `/brain/visual/index`:

1. Resolve the job and slice exactly as today.
2. For each asset in the slice: run tier 0 if `shots.tier0_version != TIER0_VERSION` for the
   current content hash. This happens **before** the embedder/captioner resolution and does
   not depend on either.
3. Then, if an embedder is available, tier 1 (today's NVIDIA arm, later the pack); if a
   captioner is available, tier 2. Their absence is recorded, never an early return.
4. Remove the `if embedder_res.client is None: return VisualIndexResponse(available=True, reason=…)`
   short circuit. The response's `reason` becomes per-tier coverage.

The TwelveLabs arm (`_tl_index_slice`) also runs tier 0 first; TL then fills `described`
from its captions/spans as it does today. Tier 0 is the floor under every backend.

## VU1.5 Import hook without a key `[ ]`

- `apps/web-editor/src/editor/visualIndex.ts`: `shouldAutoIndex` returns true whenever the
  sidecar is reachable. Keys only decide which extra tiers run.
- `apps/desktop/electron/main.ts`: `enrolStockAsset` drops its key check; the enroller is
  used for **every** acquired asset (human import via the media-import IPC, stock, music
  with video). One hook, one batching enroller, one loop per project — the shape
  `asset-enrolment.ts` already argues for.
- Session warmup (`session-warmup.ts`) stays at `quick`; the ledger job is its own loop with
  `priority: 'timeline'` first (assets already on the timeline), then `bin`.
- Browser build: no sidecar, no ledger, honest `unavailable`. Accepted per CLAUDE.md.

## VU1.6 Evidence `[ ]`

- Engine tests: `shot_stats` golden on captured filter output for `camera-4k60-40s.mov`,
  `talk-1080p-98s.mp4`, `vertical-30s.mp4`, `photos/p26.jpg`; migration v4 forward test;
  route test proving a keyless request produces `shots.measured` rows and a coverage reason.
- Accuracy: hand-labelled `tests/fixtures/mission/labels/tier0.json` (see `06`) with
  exposure class, warmth class, motion class, sharpness class per shot for the 5 videos and
  60 photos. Target: ≥ 90% agreement on exposure and motion, ≥ 85% on warmth, ≥ 85% on
  sharpness. Record the actual numbers in this file.
- Speed: the whole mission fixture set (about 10 minutes of video plus 60 photos) measured on
  the M1 Pro. Target ≤ 2× real-time single worker at 160 px. Record wall clock, CPU seconds,
  peak RSS.
- Desktop: import `camera-4k60-40s.mov` with no key configured; the Settings coverage line
  reads `measured 1/1`; `describe_footage` returns shots with words, not `not_indexed`.

## VU1.7 Definition of done

`[ ]` all of VU1.1–VU1.6 checked · `[ ]` `pnpm engine:test` green · `[ ]` `pnpm verify` green ·
`[ ]` ADR "Tier 0 perception is keyless and ffmpeg-only" accepted · `[ ]` `docs/guides/media-intelligence.md`
updated (tiers, privacy boundary) · `[ ]` CHANGELOG entry · `[ ]` plan reconciled.
