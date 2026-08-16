---
name: edit-prep
description: Establish a reliable project inventory, transcript, footage map, and select markers before structural editing without reorganizing work that is already prepared.
tools: [get_project_state, list_assets, add_asset, manage_assets, transcribe, map_footage, detect_scenes, analyze_silence, add_marker]
---

# Edit prep

## Purpose

Turn raw media into trustworthy editing evidence so later decisions do not rediscover or invent the project.

## When to use

New raw projects, unfamiliar footage, missing transcript/index evidence, or disorganized multi-asset bins.

## When not to use

Skip completed prep in an active edit; do not spend a run reorganizing a tiny usable bin.

## Required inputs

Project state, asset inventory, target deliverable, and current transcript/index status.

## Expected outputs

A usable inventory, transcript where needed, broad footage/scene/silence evidence, and labeled selects.

## Core philosophy

Log once, retrieve many times. Preparation reduces later tool calls only when its outputs are concrete and reusable.

## Professional heuristics

- Inventory before planning; never assume an asset exists.
- Organize larger bins by editorial role (A-roll, B-roll, Music, SFX, Graphics), not merely extension.
- Transcribe dialogue before hook, cleanup, or caption work.
- Map long footage broadly, then mark only high-value selects and problems.
- `add_asset` registers media; it does not place it on the timeline.

## Decision framework

Check existing state → fill only missing prerequisites → run broad low-cost analysis → mark useful selects → hand off to structure.

## Common mistakes

Repeating prep each turn, inventing visual content from filenames, over-foldering four assets, marking every moment, or treating scene detection as story understanding.

## Verification checklist

- Assets and roles are known.
- Transcript/index availability is explicit.
- Select markers have actionable labels.
- No original media changed.
- The next structural action can proceed without another full inventory.

## Recovery advice

If analysis is unavailable, preserve the inventory, use transcript/scene evidence that exists, and report the missing capability. Never loop analysis hoping for a preferred answer.

## Related skills

`footage-intelligence`, `story-structure`, `podcast-editing`, `hook-crafting`.
