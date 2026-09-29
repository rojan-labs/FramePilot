---
name: audio-polish
description: Mixing reference — balancing dialogue, music, ambience and effects; fades, gain rides, EQ, compression and ducking with the real audio controls; measuring LUFS and true peak against a delivery target; sourcing a music bed or sound effects.
tools: [get_timeline, get_clips, list_assets, adjust_audio, professional_audio, set_track_flags, measure_loudness, analyze_silence, search_music, add_music, detect_beats]
---

# Audio polish

**Levels, ducks and fades the editor specifies are the targets** ("bed at -18 dB", "duck the
music 6 dB under the SFX", "2 s fade to black"). Build them with the controls below, and say
plainly where a spec cannot be met exactly (an attack time). The defaults here
are for mixes nobody specified.

## Purpose

Make speech effortless to understand and the mix emotionally supportive, using only the controls FramePilot actually exposes.

## When to use

Dialogue leveling, music balance, scratch-track muting, fades, ducking, cleanup EQ/compression, final audio review, or sourcing a music bed when the project has none.

## When not to use

Do not use this for structural silence removal, unsupported spectral repair, or invented loudness measurements.

## Required inputs

Current timeline, the role of each audio source, speech spans, the intended listening context, and any levels the request names.

## Expected outputs

Motivated level, fade and duck changes, intentional track flags and roles, and a preview-based assessment with a short WHY.

## Core philosophy

Dialogue is the reference. Music and ambience earn level only after every word remains clear.

## The controls

- `adjust_audio` sets one flat gain on a clip, or on every clip of a track in one call.
- `professional_audio` (clip ids from `get_clips`) does the shapes: `level` with
  `fadeInFrames`/`fadeOutFrames` (and `fadeCurve`), `muted` or peak `normalize`;
  `automate_gain` for a ride over time — an automation lane replaces the static gain, so author
  one or the other; `eq` and `compress` for cleanup; and ducking.
- Ducking by role: label each sound's track with `set_track_flags` `role` (`dialogue`, `music`,
  `sfx`; a video track counts when its camera audio is the sound), then `professional_audio`
  `duck_roles` with `bedRole`, `sidechainRole` and `reductionDb`. Roles come from labels you set,
  never from track or file names. The duck ramps in and out over a fixed ~0.15 s; a requested
  attack/release time cannot be set, so say so.

## Professional heuristics

- Level-match adjacent takes before shaping music.
- Absent a spec, start music under speech around -18 dB and adjust from evidence; speech-free passages may rise.
- Fades are fades, not stepped splits: a frame-based fade on the clip is smoother and undoes in one step.
- Preserve ambience across cuts when it hides discontinuity. Mute alternates; do not delete them.
- A LUFS or true-peak target is measured, never estimated: `measure_loudness` with the request's `targetLufs` / `maxTruePeakDbtp` reads the mix and names the move. A flat `adjust_audio` gain on every track moves integrated loudness by the same dB and keeps the balance; compress (`professional_audio`) before raising when the true peak would cross the ceiling; peak `normalize` sets a peak, not loudness. Re-measure after each change and report the measured figures.
- Sound effects come from the same library as music: `search_music` with the effect's name
  ("whoosh", "camera shutter", "waves") returns effects too, and `add_music` with `atSeconds`
  places one at its moment for its own short length on its own track. Keep effects under the
  music (`adjust_audio`). Search each sound the request names (a door, keys, footsteps): a
  sound has no match only once its own search came back with nothing usable — say which.

## Sourcing a bed the project does not have

When the edit wants music and the bin has none, `search_music` finds one and `add_music` places it. Both reach a third-party catalogue, so treat them as costly: one search, then commit.

- **Search by mood or instrument, not by title.** "calm piano", "driving synth", "warm acoustic". The catalogue is openly-licensed production music; asking for a named song returns nothing useful.
- **Read the duration before you pick.** A 40-second track under a 3-minute edit means a visible restart or a hard stop. Prefer one long enough to cover the section, and pick a shorter one only when you intend it to end.
- **Say what the credit obligation is.** Every result reports `attributionRequired`. When you place a track that needs one, tell the editor in your summary and name where it lives — the credit is saved with the project and appears under Export → Credits.
- **Duck it in the same breath.** `add_music` takes `duckUnderTrackId`; pass the id of the track carrying the sound the bed must stay out of the way of. Usually that is dialogue. On a project with no voice — action footage, a wind-and-engine POV — the sound to duck is on the picture track, and a video track is a valid target. A bed laid at full level over the thing it is scoring is not a finished mix.
- **Do not search for music the project already has.** Check `list_assets` first — an existing audio asset is free, and a downloaded one is already in the bin.
- **Nothing is monetization-unsafe.** Non-commercial tracks are refused before you ever see them, so a result is safe to use in a sponsored video.
- For beat-aligned cutting against a fetched track, hand its asset id to `detect_beats` and see `beat-synced-editing`.

## Decision framework

Identify the dominant voice → match dialogue clips → set the bed → label roles and duck where
needed → shape fades and rides → measure against any stated loudness target → preview at normal and low volume. Any step the request
specifies takes its values from the request.

## Common mistakes

Boosting everything, ducking every breath, splitting clips to fake a fade or duck, abrupt one-frame level steps, deleting scratch sources, claiming clean audio without listening, claiming a LUFS value nothing measured, adding a bed and leaving it unducked over speech, or placing a credit-required track without saying so.

## Verification checklist

- Words stay intelligible under music.
- No level jump distracts at a cut.
- Open and close do not blast; requested fades are on the clips.
- Muted/solo states and track roles are intentional.
- A rendered preview was listened to; otherwise report “applied, not auditioned.”
- A fetched bed is on a `music`-role track, ducked under dialogue, and its credit obligation was stated if it has one.

## Recovery advice

If a duck sounds obvious, lower `reductionDb`. If source noise or clipping cannot be fixed with gain, EQ or compression, preserve the least-damaged result and report the limitation.

## Related skills

`silence-and-filler-cutting`, `podcast-editing`, `finishing-and-delivery`, `beat-synced-editing`.
