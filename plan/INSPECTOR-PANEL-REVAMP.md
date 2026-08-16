# Inspector Panel Revamp

Status: complete on `feat/industry-inspector-panel`

## Goal

Turn the web editor inspector into a consistent professional editing surface across clip, multi-clip, text, transform, color, speed, audio, crop, blend, transition, mask, effects, and effect-layer states.

## Constraints

- Preserve all typed patch workflows and undo behavior.
- Preserve registry ordering, applicability rules, and persisted disclosure state.
- Preserve accessibility labels used by keyboard users and tests.
- Add no dependency and make no timeline schema change.
- Keep the right rail usable at narrow desktop widths.

## Completed

- [x] Added a sticky inspector header with compact whole-selection actions.
- [x] Added a selection context card for clip type, track, timeline span, and source span.
- [x] Added icon-led, card-based section disclosures for every registered inspector type.
- [x] Unified select rows, scrub numbers, fields, notes, reset controls, and empty states.
- [x] Added a dedicated effect-layer inspector header and multi-effect state treatment.
- [x] Added responsive behavior for narrow inspector rails.
- [x] Kept existing patch builders, section modules, and selection logic unchanged.

## Verification

The pull request must pass the existing web-editor typecheck, lint, component tests, and visual checks in GitHub Actions before merge.
