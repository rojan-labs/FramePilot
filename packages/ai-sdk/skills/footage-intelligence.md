---
name: footage-intelligence
description: Retrieve grounded visual evidence, compare candidate moments, and turn a large or unfamiliar media set into citable editorial choices without guessing.
tools: [map_footage, describe_footage, search_visual, index_media, propose_edits, detect_scenes, analyze_silence]
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

- Map once for global shape; describe only promising spans; search for specific content.
- Index when available and needed; otherwise use transcript/scene evidence honestly.
- Compare candidates by story value, visual clarity, motion completion, composition, novelty, and cost.
- Treat `propose_edits` as candidate generation, not editorial authority.

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
