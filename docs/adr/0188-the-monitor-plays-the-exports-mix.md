# ADR 0188 — The monitor plays the export's mix

- **Status:** Accepted.
- **Date:** 2026-09-25
- **Relates to:** ADR 0052 (WebCodecs preview compositor, its audio-master clock), ADR 0180 and
  its 2026-09-25 amendment (the layer compositor is the default monitor), render-vs-preview
  (AGENTS.md invariant 4), plan `EQ30` in [`plan/PLAN.md`](../../plan/PLAN.md).

## Context

The picture half of "100% parity on preview/export" (EQ29) made the layer compositor the default
monitor everywhere. Its sound had not kept up:

- Footage was scheduled flat, at unity. A muted clip still spoke; fades, ducks and automation
  lanes did nothing; solo did not silence the other tracks; a reversed or speed-ramped clip was
  silent.
- Audio clips played from hidden `<audio>` elements on their own clocks. They re-synced only past
  half a second of drift, ignored clip speed, and skipped automation lanes.
- No preview path ran the channel strip (normalize, EQ, compression), which the export runs as an
  ffmpeg filtergraph and `mix_clip_audio` authors.

A monitor that plays a different mix from the file does harm beyond being wrong. A person who
hears a bed at full level where the export ducks it, or the agent acting on their complaint,
"fixes" a mix that was already right.

## Decision

The layered monitor plays every clip's sound on its own audio clock, shaped by TypeScript twins
of the export's audio code. Generated vectors from the export's own functions hold the twins in
place. (`preview/audio/`)

- **What sounds, and when** (`clip-audio.ts`): the export's rules. Footage on a hidden track is
  silent. An audio clip on a hidden track still plays. A freeze drops its sound. A reverse reads
  `D − |speed|·t − 1/fps`: MoviePy's time mirror lags one frame of the mirrored clip's own rate.
  A ramp reads through the export's 1 ms source table. A reversed or ramped clip's sound is
  resampled into a buffer of its own, kept in a bounded LRU cache, because a buffer source can
  only play forward at a rate.
- **How loud** (`mix-envelope.ts`): the fader, or the `gainDb` lane that supersedes it (sampled
  on the engine's 1 ms grid and interpolated as `np.interp`), times fades, times duck. It is
  scheduled as a Web Audio value curve on each clip's own gain node. The legacy element mixer
  shares the same envelope.
- **The channel strip** (`channel-strip.ts`): a port of the parts of ffmpeg the export's
  filtergraph uses. `volumedetect`'s measurement of MoviePy's 16-bit writer output,
  `af_biquads`' designs in direct form I, and `acompressor`'s gain computer with its defaults. It
  runs as an AudioWorklet between each clip's source and its gain, where the export runs it:
  after speed, before the fader. A context that cannot run worklets plays the clip unprocessed
  and logs why.
- **The contract is the vectors**, not a reading of the Python. `pnpm audio-mix:vectors` runs
  `_apply_audio_effects` over a constant signal, `_subclipped_source` + `_apply_speed` over an
  identity signal, and `build_clip_filter` through ffmpeg over a fixed signal. The TypeScript
  tests, and a Playwright spec that renders the shipped worklet in Chromium, are held to those
  numbers.

## Tolerances

- Envelope and time maps: 1e-9. Both sides compute in double precision.
- Filter designs: each band's impulse response at double precision, 1e-9.
- A strip over a signal: 1e-4 (-80 dBFS). The export's filtergraph reads a float WAV, so ffmpeg
  runs its biquads in float32. A 120 Hz shelf's poles sit so close to 1 that ffmpeg's own
  rounding moves its output by about 3e-5, while the designs agree exactly. A wrong Q, gain or
  knee moves the same signal by 1e-2 or more.

## Consequences

- Changing the export's audio code without regenerating the vectors fails the drift tests.
  Changing either side without the other fails the TypeScript tests.
- The monitor processes at its context's sample rate, while the export processes at 44.1 kHz.
  The designs are the same analogue filters, so only frequency warping near Nyquist differs.
- Not mirrored: the export dialog's master-bus options (loudness, limiter, denoise, master EQ and
  compression). They are delivery settings chosen at export time, which the monitor does not
  know.
- The legacy DOM monitor (the `legacy` kill switch until RD3) plays the shared envelope and clip
  speed, but not the strip, and not reversed or ramped audio.
