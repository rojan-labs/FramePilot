# Professional audio commands

FramePilot's professional audio path translates editor intent into revision-bound
`mix_clip_audio` commands. The compiler is the only layer that emits `adjust_audio`; callers do not
assemble gain, fade, normalization, or sidechain operations themselves.

## Supported objectives

`professional_audio` currently supports:

- `level`: resolve `this`, `these`, or `playhead` from the live interaction snapshot, then apply
  bounded gain, mute, peak normalization, and frame-based fade settings.
- `duck_selection`: treat the primary selected clip's track as the bed and exactly one other
  selected audio-capable track as its sidechain. An optional positive `reductionDb` is stored as the
  renderer's negative ducking gain; the default is 12 dB.

- `duck_roles`: express the instruction directly — `bedRole: 'music'`, `sidechainRole: 'dialogue'`
  ducks every clip on every `music` track under the one `dialogue` track. Roles come from the
  authored `Track.role` (schema v17, ADR 0111), so this needs no selection at all.

- `eq`: replace the clip's corrective EQ curve — up to eight bands, each a `low-shelf`, `peaking`,
  `high-shelf`, `high-pass`, or `low-pass` at a stated frequency. Shelves and peaks require a
  `gainDb`; the pass filters cut a range outright and refuse one.
- `compress`: even out a performance with a hard-knee compressor (`thresholdDb`, `ratio`,
  `attackMs`, `releaseMs`, and optional `makeupGainDb`).
- `automate_gain`: ride the level over time. Points are authored in **clip-relative frames** like
  every other time in this layer, and are stored as keyframes on the clip's canonical `audio_gain`
  effect — the schema's own lane shape, evaluated by the keyframe engine both runtimes share.

The tool accepts no clip or track IDs. This is deliberate: selection and authored roles establish
which audio the editor means.

## The channel strip is one effect, and one order

Gain, fades, ducking, EQ, compression, and the automation lane all live on the single canonical
`<clipId>__gain` effect, and the renderer runs them in one stated order:

`mute → normalize → EQ → compressor → fader (gain or automation, fades, ducking)`

Two consequences worth knowing, because they are choices rather than accidents:

- **Gain is a fader move, so the compressor sees the clip at its recorded level.** Lowering a clip's
  level therefore does not quietly stop it compressing, which is what would happen if the fader ran
  first.
- **An automation lane supersedes the static `gainDb` for as long as it runs** rather than
  multiplying with it. One parameter cannot have two authored answers at one instant. Authoring both
  in a single command is refused (`conflicting_gain`), and so is setting a static level on a clip
  that already has a lane — the fix named in the rejection is to clear or re-author the lane, not to
  guess which one the editor meant.

An `eq` or `compress` edit merges with whatever mix the clip already carries, so cleaning up a
recording never resets the level someone set. The reverse holds too, and at the operation level:
`adjust_audio` **carries EQ, compression, and the lane forward** when it does not mention them.
That asymmetry with the level fields is deliberate — `adjust_audio` is the "set the level" verb and
the low-level tool emits only `{clipId, gainDb}`, so rebuilding the effect from the operation alone
meant "lower this clip 3 dB" silently deleted a processor chain authored moments earlier, with the
patch reporting success and the loss audible only on playback. An omitted processor is not an
instruction to remove one.

Removal stays expressible by saying so: an empty `eq.bands` clears the EQ, and an empty
`automation.points` clears the lane.

EQ is applied as a zero-phase magnitude curve through overlap-added real FFTs, from the analog (RBJ) prototypes
rather than digital biquads: no group delay to smear a transient or shift sound against picture, and
no cramping near Nyquist, so a 16 kHz shelf means the same thing at 44.1 and 48 kHz. It is corrective
EQ, not a phase-accurate model of an analog desk. It runs on half-overlapping Hann-windowed blocks
that sum to unity rather than one transform over the clip: a single FFT over a ten-minute stereo bed
costs more than a gigabyte, and peak memory should not scale with clip length on the desktop media
path. The compressor detects peaks in 1 ms blocks, which
is also the contract's minimum attack — every attack the editor can author is one the envelope can
actually follow.

Ducking fails closed rather than guessing:

| Situation                                | Result                                                    |
| ---------------------------------------- | --------------------------------------------------------- |
| No track carries the bed role            | `bed_role_unlabelled` — label the track, do not rename it |
| No track carries the sidechain role      | `sidechain_role_unlabelled`                               |
| Two tracks carry the sidechain role      | `sidechain_ambiguous` — ducking follows one trigger track |
| `duck_selection` with no/many sidechains | `sidechain_unresolved` / `sidechain_ambiguous`            |

A role is never inferred from a track name or filename: a lane called "music" routinely holds a
voice-over, and ducking the wrong bed is silent in the timeline and only audible on playback. Use
`duck_selection` when the project's tracks carry no roles yet.

## Compiler contract

`compileAudioCommand`:

1. verifies timeline revision, rational frame rate, target clip, lock state, and audio-capable media;
2. converts fade frames to exact seconds using the supplied rational rate;
3. merges omitted settings from the clip's canonical `<clipId>__gain` effect;
4. rejects invalid gain, fade duration, self-ducking, missing/non-audio sidechains, a duck amount
   without a sidechain, an out-of-range or ill-formed EQ band, compressor settings the renderer
   cannot honour, and an automation lane whose times repeat or fall outside the clip;
5. validates the resulting patch and constructs its exact inverse before returning it.

The TypeScript and Python operation boundaries both replace the canonical `audio_gain` effect and
enforce the same sidechain rules. Python also persists the same `linear`, `equal-power`, and
`smooth` fade-curve values used by the TypeScript contract.

## Review behavior

Any changed `audio_gain` effect requests deterministic mix evidence near the clip beginning,
middle, and end, including embedded audio on video tracks. Evidence checks peak headroom and abrupt
boundary-level changes.

A gain automation lane additionally requests its own **quietest and loudest authored points**. The
middle of a clip proves nothing about a ride that dips at 0:03, and sampling every point would let a
long lane fan out unbounded — two extremes are what the reviewer needs and all it takes.

Role-isolated measurement works on top of the authored `Track.role`: a `dialogue`/`music`/`sfx`
request compiles a role-muted copy of the timeline and measures that role alone, and integrated
loudness is measured per role through ffmpeg's `ebur128` against a delivery target. Asking for a
role no track carries fails closed with the missing label as the fix, rather than returning quiet.

## Remaining professional audio scope

Automation lanes exist for `gainDb` only; other audio parameters are deliberately not animatable
until each has a renderer that honours the curve. The capability registry is the authority on what
is advertised — it currently lists gain, frame fades, peak normalization, sidechain ducking, EQ,
compression, and gain automation.
