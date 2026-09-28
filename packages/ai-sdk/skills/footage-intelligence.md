---
name: footage-intelligence
description: Retrieve grounded visual evidence, compare candidate moments, and turn a large or unfamiliar media set into citable editorial choices without guessing.
tools: [map_footage, describe_footage, search_visual, search_media, get_frame, read_edit_signals, detect_scenes, analyze_silence]
---

# Footage intelligence

## Purpose

Bridge “what footage exists?” to “which exact moment best serves this edit?”

## When to use

Raw/unfamiliar footage, large bins, open-ended edits, visual placement, or selecting among alternatives.

## When not to use

Skip broad mapping when the active run briefing already establishes the needed span; do not use visual tools for facts they cannot observe.

## Required inputs

Editorial objective, index status, target range, and the evidence gap that must be closed.

## Expected outputs

A bounded map, cited candidate spans, a committed selection decision, and the next craft skill to apply.

## Core philosophy

Retrieve before assuming, then decide. Evidence gathering is valuable only when it ends in a choice.

## Professional heuristics

- When the request names the clip for a slot, retrieval narrows to that clip: find its best
  moment (peak motion, clean focus, best light) rather than re-opening which clip to use.
- Map once for global shape; describe only promising spans; search for specific content
  (`search_visual` for what is on screen, `search_media` for words, markers and asset names).
- Index when available and needed; otherwise use transcript/scene evidence honestly.
- A clip the index has not reached can still be LOOKED at: `get_frame { assetId, sourceSeconds }`
  shows the source as shot, whether or not it is on the timeline. A few frames across it (start,
  middle, end) are enough to judge focus, exposure, shake and where the subject sits.
- Compare candidates by story value, visual clarity, motion completion, composition, novelty, and cost.
- `read_edit_signals` reports what is measurably there; choosing the move is yours. A signal it echoes back is only as real as the evidence you passed in.
- Check `timeBase` before you act on a map time. `timeline` is directly actionable; `asset` is that footage's own source seconds, and so is any asset named in `unplacedAssets` — those are still in the bin, so place them before cutting to one. `describe_footage` and `search_visual` always answer in asset seconds; `map_time` converts.

## Decision framework

Name the missing fact → choose the narrowest retrieval → compare at least two viable moments → record the winning evidence and WHY → hand off to execution.

## Common mistakes

Re-mapping every turn, inferring visuals from dialogue, using filenames as proof, or choosing the first returned span.

## Verification checklist

- Every content claim cites returned evidence.
- The selected source span includes its action/payoff.
- Alternatives were rejected for stated reasons.
- No unavailable capability was retried.

## Recovery advice

Recall existing evidence by handle when detail was compacted. If vision is unavailable, narrow the edit to supported transcript/scene facts or ask the editor.

## Related skills

`edit-prep`, `broll-and-layering`, `beat-synced-editing`, `story-structure`.
