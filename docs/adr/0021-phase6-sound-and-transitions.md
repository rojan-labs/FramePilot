# ADR 0021 — Phase 6 (2–3/3): sound & transitions

- **Status:** Accepted
- **Date:** 2026-06-26
- **Phase:** 6 — Color, Sound & Transitions (PRD §6.8–6.9)
- **Relates to:** ADR 0020 (Phase 6 color), ADR 0018 (Phase 5 render wiring — opacity deferral)

## Context

After the color checkpoint (ADR 0020), the remaining Phase 6 work is **sound** and
**transitions**. Both are deterministic render concerns and both were unbuilt: the
`audio/mixing.py` primitives were `NotImplementedError` stubs (only static gain
rendered), and `transition` effects were stored on clips but never composited.
Per the agreed plan, new dependencies stay **gated** (numpy / Pillow / ffmpeg only).

## Decision

### Sound (PRD §6.8)

1. **Pure per-clip audio math** in `audio/mixing.py`: `fade_gain_at`,
   `peak_dbfs`/`normalize_gain`, `duck_gain_at`, `apply_gain_envelope`, `db_to_gain`
   — numpy over sample/time arrays, 100% unit-testable.
2. **One operation, extended:** `adjust_audio` (TS `operations.ts` + Python mirror)
   gained optional `fadeInSeconds`/`fadeOutSeconds`/`muted`/`normalize`/
   `duckUnderTrackId`/`duckAmountDb`, persisted on the single `audio_gain` effect
   (still replace-not-stack). No new operation, no schema change, and the
   gain-only AI tool stays valid (new fields are optional).
3. **Compiler mixer** composes static gain (incl. mute + peak-normalize) with
   time-varying fade and presence-duck envelopes into one MoviePy audio
   `transform`; gain-only clips keep the cheap scalar path.
4. **Master bus via ffmpeg** (`audio/filters.py`): a pure `-af` builder
   (de-noise `afftdn`, loudness `loudnorm` presets social/podcast/broadcast,
   limiter `alimiter`) applied as a single post-encode pass in `pipeline.render`
   (atomic temp-replace, before validation). Threaded through `RenderOptions`, the
   sidecar `/render` route, the CLI (`--denoise`/`--loudness`/`--limiter`), the
   export IPC + bridge, and the web **Export dialog**.
5. **UI:** the Inspector **Audio** panel (gain, fade in/out, mute, normalize, duck
   under track) commits one reversible `adjust_audio` patch via `setAudioPatch`.

### Transitions (PRD §6.9) — and the deferred opacity render

6. **Opacity now renders.** The Phase 5 deferral (ADR 0018) is closed: a clip's
   animated `opacity` composites via the clip mask. `unsupported_animated_properties`
   no longer reports it.
7. **Pure transition envelopes** (`render/transitions.py`): a `transition` effect on
   the incoming clip eases it in over `durationSeconds` — opacity (fade /
   cross-dissolve), geometry (push slide / zoom-out), or a decaying Gaussian blur.
8. **Compiler** combines geometric mask × clip opacity × transition fade into one
   (possibly time-varying) alpha mask, folds push/zoom into the placement transform,
   and applies the blur as a per-frame Pillow pass. The `CompositeVideoClip` now
   sets `bg_color=(0,0,0)` so partial-alpha layers blend over black (a single-layer
   composite otherwise ignores a <1 mask). Because layers composite top-down, an
   opacity ramp is a true **cross-dissolve** when clips overlap and a fade-from-black
   when they are sequential — one primitive, both cases.
9. **UI:** the EffectsPanel transition palette adds **Blur** (the kind was already in
   the schema enum).

## Consequences

- Sound and transitions render deterministically with full unit + golden-style
  integration coverage; the golden frame-hash test is unaffected by `bg_color`.
- **Deferred (honest, gated):** advanced **sound** — EQ, multiband compression,
  buses, auto-SFX — and advanced **transitions** — beat detection / rhythm- and
  motion-matched suggestions, and audio-synced "whoosh" — need either a richer
  master spec (schema) or a new dependency (e.g. `librosa`), so they stay out per
  the gating decision (CLAUDE.md §5). LUT **file** import (ADR 0020) is still
  pending its sandboxed-path decision.
- No schema change and no new dependency across either checkpoint.

## Alternatives considered

- _A new operation per audio feature (`add_fade`, `mute`, …)._ Rejected: it
  multiplies the TS/Python/validator/AI parity surface. Extending `adjust_audio`
  with optional fields on one `audio_gain` effect is the `color_grade` precedent.
- _Sample-domain numpy de-noise/loudness._ Rejected: a poor reimplementation of
  well-tested ffmpeg DSP; the master pass shells out to ffmpeg like render validation.
- _Overlapping clips to model cross-dissolve._ Rejected for now: it would mutate the
  timeline (overlap) and risk validator overlap errors; the opacity-ramp primitive
  already yields a true dissolve when clips overlap.
