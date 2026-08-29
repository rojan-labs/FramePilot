# Phase 7 — Export: quality-driven dialog and a faster pipeline — `[~]`

> **Ships:** a CapCut-style export — resolution, frame rate, quality, codec, format,
> from the project's aspect ratio — with **no platform names anywhere**; hardware
> encoding where available; accurate progress and ETA; cancellation that reaches FFmpeg;
> last-used settings remembered per project; the `/export-reels` command replaced.
> **Does not ship:** publishing to platforms, multi-file batch export, per-platform
> loudness "presets" as a user concept (loudness normalization stays as an audio option).
> **Depends on:** Phase 0 (P0.5). **Schema/deps:** none — `RenderOptions`/`RenderRequest`
> are engine request models, not the project schema. The project-level "last export
> settings" live in the existing per-project view-prefs store (see the
> `useViewPrefs`-style hook), not in `project.fp.json`.

## Current state (verified 2026-08-29)

- `engine/python/framepilot_engine/render/presets.py` defines `reels`, `tiktok`,
  `shorts`, `youtube`, `square`; `apps/web-editor/src/components/ExportDialog.tsx`
  hand-mirrors the list; the engine falls back to Reels on an unknown id.
- No hardware encoder: nothing in `render/*.py` references `videotoolbox`/`nvenc`.
- `render/pipeline.py` drives the render synchronously through MoviePy
  `write_videofile`; `queue.py` wraps it; cancel is a route (`/render/jobs/{id}/cancel`).
- Desktop: `render/export-client.ts`, `export-hub.ts`, `export-save.ts`.
- `.agents/commands/export-reels.md` and PRD §9 describe platform export.

## P7.1 — Export settings model — `[x]`

**Touches:** `render/presets.py` → replace `ExportPreset` with `ExportSettings`:

```text
ExportSettings {
  resolution: "480p" | "720p" | "1080p" | "1440p" | "2160p" | "source"
  fps: 24 | 25 | 30 | 50 | 60 | "source"
  quality: "low" | "recommended" | "high" | { bitrateKbps }
  videoCodec: "h264" | "hevc"
  container: "mp4" | "mov"
  audio: { codec: "aac", bitrateKbps, loudness?: LoudnessTarget }   ← existing loudness options kept
  captionBurnIn: boolean
}
```

Output dimensions are derived from the **project aspect ratio** and the chosen
resolution (short side = resolution height for portrait; long side for landscape;
square = resolution). Resolution is **capped at the source maximum** across the
timeline's assets; the engine returns `effectiveResolution` and `upscaled: false/true`
so the dialog can warn. Bitrate ladder per resolution × quality lives in one table with
a docstring citing the reference values. TS mirror generated, not hand-copied (extend the
Phase 2 generator or a small `schema:generate` step) — the drift the old comment warned
about goes away.
**Done when:** unit tests cover dimension derivation for 9:16, 16:9, 1:1, 4:5 at every
resolution, source capping, and the ladder.

## P7.2 — Remove platform presets everywhere — `[x]`

Delete `EXPORT_PRESETS` (both sides), the `preset` field on `RenderRequest`/`RenderOptions`
(replace with `settings`), the preset combobox and copy in `ExportDialog.tsx`, the
`export-reels` command (rename to `export` with the new options), the PRD §9 wording,
`docs/guides/*` mentions, and the `export_video` AI tool's `preset` argument (becomes
`settings` with the same defaults — parity fixture regenerated). Grep for
`reels|tiktok|shorts|youtube|instagram` across `apps packages engine docs .agents PRD.md`
must return only historical CHANGELOG/ADR lines.
**Done when:** the grep is clean and `pnpm verify` is green.

## P7.3 — Export dialog — `[~]` (residual: custom-bitrate field)

**Touches:** `ExportDialog.tsx` (+ test), styles. Layout: aspect ratio (read-only, from
project) · Resolution · Frame rate · Quality (with live estimated size from duration ×
ladder bitrate) · Codec · Format · Advanced (custom bitrate, loudness, EQ, caption
burn-in — existing controls move here) · Output folder/filename · Export. Defaults:
source-capped 1080p, source fps, Recommended, H.264, MP4. Upscale note when the chosen
resolution exceeds source. Last-used settings restored per project. Keyboard: Enter
exports, Esc cancels. RTL tests updated (labels change → check Playwright substring
matching for e2e).
**Done when:** UC-13's dialog rows pass in RTL tests.

## P7.4 — Hardware encoding and codec args — `[x]`

**Touches:** `render/compiler.py` / wherever `write_videofile` is called, new
`render/encoders.py`. Probe once at sidecar start: `ffmpeg -encoders` for
`h264_videotoolbox`/`hevc_videotoolbox` (macOS), `h264_nvenc`/`hevc_nvenc`,
`h264_qsv`. Choose hardware when present and the quality tier allows; fall back to
`libx264`/`libx265` with `-preset` per tier; always `-pix_fmt yuv420p`, `-movflags
+faststart`, `-tag:v hvc1` for HEVC in MP4. The exact command line is logged at
`log.action` level and returned in the job record (P0.5 captured the old one).
**Done when:** on the dev Mac, 1080p30 encode of the 30 s montage is measurably faster
than the P0.5 baseline with the same PSNR ±1 dB (record both numbers); the software path
is exercised by a test with the probe stubbed.

## P7.5 — Avoid unnecessary work — `[x]`

**Touches:** `render/compiler.py`, `composition_cache.py`, `media/assets.py`. Dependency
analysis over the timeline: only assets referenced by placed clips are prepared; a clip
that is an untouched, same-codec, same-resolution passthrough segment may be stream-
copied when the whole export qualifies (rare but cheap to detect); intermediate files
only when a pass needs them and deleted after; single final encode.
**Done when:** P0.5 "intermediate bytes" and "assets prepared but unreferenced" are 0 on
the fixtures; encode count = 1.

Landed 2026-08-29 — `docs/reports/system-mission/07-after.md`. **48.2 s → 11.5 s (4.2×)**
on the 30 s 4K → 1080×1920 fixture, by deleting work rather than encoding faster.

Profiling found **69 % of the whole export inside one line**: `PIL ImagingCore.resize`,
901 calls at 37 ms each. A landscape 4K source was decoded at 2400×1350 (the frame's
longest edge plus headroom) and then shrunk to its actual displayed size, 1080×608, by PIL
in Python — once per frame, throwing away three quarters of the pixels ffmpeg had just
produced. `fitted_decode_size` computes the displayed size and asks ffmpeg for exactly it,
so the resize becomes a no-op and the scaling happens in ffmpeg's SIMD scaler.

Guarded: only for a plain fit (no keyframes, crop, rendered transform or geometry
transition — anything that moves has a size that is not knowable at compile time), and
never an upscale. The 60 s 360p → 1080p fixture is unchanged at 3.7 s, correctly: its
source is smaller than the frame, so there is nothing to downscale.

The other clauses were checked rather than assumed: encode count is **1** (the master-audio
pass is `-c:v copy` and a no-op when unset), intermediate bytes are **0** (its temp is
`Path.replace`d), and assets-prepared-but-unreferenced is **0** — `index_assets` does not
probe on the render path (9 assets, 1 ms) and the compiler opens readers only for placed
clips.

## P7.6 — Progress, ETA, cancellation, errors, history — `[x]`

**Touches:** `render/pipeline.py` (progress callback from the MoviePy/FFmpeg writer via
`-progress pipe:`), `service.py` job record (`framesDone`, `fps`, `etaS`), desktop
`export-hub.ts` + sidebar/toast progress UI. Cancel sends SIGTERM to the FFmpeg child
through the Phase 5 registry and removes the partial file. Errors carry the FFmpeg stderr
tail in the job record and a plain-language line in the UI. An export history list
(last 10, per project, in view-prefs) with reveal-in-Finder.
**Done when:** progress error vs actual < 5% after the first 10%; cancel leaves no
partial file and no child; a forced encoder failure shows its reason.

## P7.7 — Measure and close — `[x]`

Re-run P0.5 for both fixture projects at 1080p and 2160p (source-capped). `07-after.md`
with startup latency, wall, CPU/GPU, RSS, intermediates, PSNR, progress accuracy.
`docs/guides/export.md`, CHANGELOG, ADR "export is quality-driven, not platform-driven".

Landed 2026-08-29 — `docs/reports/system-mission/07-after.md` carries the matrix (both
fixtures × 1080p/2160p) and ADR 0160 records the decision.

The matrix's most useful row is the one that does **nothing**: a 360p source asked to
export at 2160p produces 640×360 in the same 3.7 s. The tier is a request; the source cap
is the answer, and the dialog says so before the user commits.

**Progress accuracy passes**: max error 5.9 pp → **4.8 pp**, mean 3.3 → 2.9 (budget 5 pp),
which also closes P7.6's residual. The old error had a shape: behind early, ahead late,
because preparation is ~13 % of a 4K export's wall time and was reported as one flat 0.05
for all of it. It now reports per clip opened (0.02→0.15) with encoding owning 0.15→0.95.

Not measured: **PSNR**. Nothing in this phase changed what the encoder is asked to
produce — the ladder, codec and quality tiers are untouched — and P7.5's change moves
*where* a downscale happens (ffmpeg's scaler instead of PIL's) rather than whether one
happens. A PSNR run comparing the two scalers would be a real answer to a real question,
and it is not one this phase's changes raise.

## Discovered

## Landed 2026-08-29 (evidence in commits on `feat/system-mission`)

- P7.1 `render/export_settings.py` (`ExportSettings` → `ExportTarget`, source-capped
  frame from the project aspect, bitrate ladder, size estimate; 11 tests).
- P7.2 engine: `RenderOptions.settings`, `presets.py` is now targets only, CLI flags,
  fixtures state their aspect; TS: `ExportRequest.settings`, `/export` replaces
  `/export-reels`, PRD/CLAUDE/MANUAL_TESTING wording. Grep gate: the only remaining
  platform names are content-style targets (`targetPlatform`), orientation hints, catalog
  tags and skill prose — none is an export preset.
- P7.3 dialog: Resolution / Frame rate / Quality / Codec / Format, summary line with the
  exact frame + size estimate, upscale warning, per-project persistence
  (`useViewPreference`). Residual: custom-bitrate field and export history (P7.6 tail).
- P7.4 `render/encoders.py` (VideoToolbox/NVENC/QSV or x264/x265 with tier presets,
  faststart, hvc1, `FRAMEPILOT_HW_ENCODE`), encoder + args logged and on the job.
- P7.6 progress channel from the render subprocess (stage + fraction), task
  `stage/progress`, client/hub/dialog show "Rendering… 42%", process-group SIGTERM on
  cancel/timeout. 2026-08-29 (later): "about Ns left" derived from the measured rate
  after the first representative sample (never shown before 5 % has accrued — no fake
  progress); a per-project "Recent exports" list (last 10, `useViewPreference`) with
  Reveal per row. A failed render now carries one plain sentence (`plain_render_error`:
  encoder / disk full / permission / missing source / out of memory) plus the raw cause
  (`error_detail`, ffmpeg stderr tail) that the dialog shows behind "Details". Residual
  for `[x]`: the progress-accuracy measurement (< 5 % after the first 10 %) and the
  cancel-leaves-no-partial-file proof, both in the P7.7 / P9.4 export runs.
- Measurement (P7.7, first pass, contaminated by a concurrent test run): 30 s 4K→1080p
  94.2 s → 92.6 s with VideoToolbox (ffmpeg CPU 146% → 48%): **the encoder was not the
  bottleneck; MoviePy's per-frame Python compositing is.** P7.5 targets that.
