# 0111. Audio track roles are authored, never inferred

- Status: Accepted
- Date: 2026-08-12

## Context

The professional audio controller can level, fade, normalize, and duck clips, but it
could not reason about what a track _is_. "Duck the music under the dialogue" — one of
the most common mixing instructions there is — had no authoritative referent, so
selection-authored ducking was the only honest implementation: the primary selected
clip's track is the bed, and exactly one other selected audio-capable track is the
sidechain.

That works, but it cannot express role-based intent, role-isolated evidence
(`dialogue`/`music`/`sfx` measurement requests are rejected by the engine today), or
per-role loudness targets.

The tempting shortcut is inference. Track names, file names, and content heuristics all
look like signal: a lane called `music`, a file called `vo_final.wav`. Every one of them
is wrong often enough to matter. Editors routinely park a voice-over on a lane named
"music", drop temp score into a lane named "sfx", and rename nothing. Acting on a guess
here is uniquely bad because the failure is silent and audible only later: the agent
ducks the wrong bed, or measures loudness against the wrong stem, and the project looks
correct in the timeline.

## Decision

Add an optional `role` (`dialogue | music | sfx`) to `Track` in schema v17, mirrored in
the Python Pydantic model, with a migration that is deliberately a no-op.

1. **Roles are authored.** They come from the editor in the UI or from an explicit
   instruction. Nothing derives a role from a track name, a file name, an asset path, or
   content analysis.
2. **Absent means unknown, and stays unknown.** The v16 → v17 migration back-fills
   nothing. Every existing project keeps role-less tracks until someone labels them.
   "Unknown" is a usable state: the existing selection-authored ducking continues to work
   without any role at all.
3. **Meaningful on `audio` tracks; harmless elsewhere.** Nothing reads it on other track
   types — the same permissive posture `captionStyle` already takes.

## Consequences

Role-based intent, role-isolated temporal evidence, and per-role loudness become
expressible on top of an authoritative field rather than a heuristic. Until a project's
tracks are labelled, role-dependent operations must fail closed with a request for the
missing label rather than falling back to a guess — the same ambiguity policy the target
resolver already uses.

The cost is that roles do not appear by magic on existing projects. That is the intended
trade: a labelling prompt is recoverable, a silently mis-ducked mix is not.
