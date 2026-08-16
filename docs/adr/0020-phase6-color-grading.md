# ADR 0020 — Phase 6 (1/3): deterministic color grading + LUT core

- **Status:** Accepted
- **Date:** 2026-06-26
- **Phase:** 6 — Color, Sound & Transitions (PRD §6.7)
- **Supersedes / relates to:** ADR 0018 (Phase 5 render wiring), ADR 0011 (caption burn-in)

## Context

Phase 6 turns the long-stored-but-never-rendered `color_grade`, `transition`, and
audio effects into real output. We build it in three reviewable checkpoints —
**color → sound → transitions** — and gate any genuinely new dependency exactly as
Phase 5 gated its CV deps (numpy/Pillow/ffmpeg only; librosa-class features stay
`available:false`). This ADR covers the **color** checkpoint.

The TypeScript side already existed end-to-end: the `apply_color_grade` operation,
validator (`SUPPORTED_COLOR_GRADE_EFFECTS`), the `apply_color_grade` AI tool
(TS + Python parity), and a four-preset `EffectsPanel`. **Nothing rendered color** —
the compiler consumed only `audio_gain` and `mask` effects. The schema needs no
migration: `Effect.type` is an open string and `Effect.params` an open record.

## Decision

1. **Pure color math in `render/color.py`.** A parametric `ColorGrade`
   (exposure / contrast / saturation / temperature / tint / shadows / highlights;
   every axis a signed offset, `0` = identity) applied to a numpy `uint8 HxWx3`
   frame in a fixed, deterministic order (exposure → white balance → contrast →
   shadows/highlights → saturation → clamp). Param conventions match the existing
   UI/AI presets (`saturation:-1` = B&W, warm `temperature` raises red / lowers
   blue). No MoviePy import leaks in, so it is 100% unit-testable and golden-stable.
   The module also carries a pure `.cube` 3D-LUT **parser** (`parse_cube_lut`) and a
   trilinear **applier** (`apply_lut`).

2. **Compiler wiring.** `compile_timeline` applies a clip's `color_grade` effect to
   the source frames via MoviePy `image_transform`, _before_ the letterbox/transform
   resize and before the mask (color is a per-pixel RGB op independent of geometry;
   the mask only touches alpha). Identity grades are a no-op fast path.

3. **Idempotent grade by effect id.** `apply_color_grade` now **replaces** an effect
   with the same id rather than appending (mirrored in TS `operations.ts` and Python
   `operations.py`), so an interactive grade panel or a re-applied preset updates in
   place instead of stacking effects that would compound at render. A distinct id
   still appends. Reversibility is unchanged (the inverse remains `restore_clips`).

4. **Inspector "Color" panel.** Seven `ScrubNumber` controls seeded from the clip's
   current grade (re-mounted per clip via `key`), an **Apply** that writes the full
   grade as one reversible patch (`setColorGradePatch`, stable id `${clipId}__grade`),
   and a **Reset** to identity. Every change flows through validate→apply→record.

5. **Approximate live monitor preview + before/after.** The program monitor applies a
   CSS `filter` derived from the active clip's grade (`colorGradeCssFilter`, pure +
   tested) so grades are visible while editing, with a **compare** toggle that drops
   the approximation to show the ungraded source. This is explicitly _approximate_ —
   the deterministic truth is the Python render (render-vs-preview rule); CSS filters
   cannot reproduce the per-channel math exactly.

## Consequences

- Color now renders deterministically and is covered by pure unit tests plus a
  compiler integration test (a B&W grade collapses a colored clip's channel spread).
- **Deferred (honest, tracked):** **LUT file import** — picking a `.cube` from disk —
  is not yet wired into the compiler because it introduces an on-disk read outside the
  asset sandbox (CLAUDE.md §5: broadening the path sandbox needs approval first). The
  pure parser/applier already exist and are tested; only the sandboxed-path loading is
  pending. **Color keyframes** (animating grade params) and **advanced color** (curves,
  scopes, shot matching, skin-tone protection) remain Phase 6 advanced / future work.
- No schema change, no new dependency.

## Alternatives considered

- _ffmpeg `eq`/`curves` filters instead of numpy math._ Rejected for the per-frame
  grade: numpy keeps the math pure, testable, and identical across preview-less unit
  tests; ffmpeg filtergraphs are reserved for the audio checkpoint (afftdn/loudnorm).
- _Append-only color effects, last-wins at render._ Rejected: it bloats the project
  file on every slider change and is surprising; replace-by-id is the `adjust_audio`
  precedent.
