# Skill: Correctness Verification (PRIORITY)

How to verify a FramePilot edit is actually correct, deterministic, and reversible.
(PRD §3, §8, §9, §20.)

## When to use

- Before declaring any timeline edit, AI tool, or render change "done".
- Reviewing a patch or a PR for correctness.

## Verification flow (do in order)

1. **Validate the patch** — schema-valid; references exist; no negative duration; valid layer order; no missing asset; supported effect; no broken audio link; no overlap; engine supports op; op reversible (PRD §8.5).
2. **Apply** — transactional, all-or-nothing, immutable; the project state is well-formed afterward.
3. **Diff** — compute before/after; confirm the change matches the intent (what/why).
4. **Preview** — generate the preview render / diff for human review.
5. **Render validation** — file exists & non-zero, duration matches expected, video stream present, audio present if expected, black-frame & audio-clipping checks (PRD §9.4).
6. **Critic checks** (when agent edits): output matches request, duration matches target, captions aligned, overlays in safe area, no clipping, no black frames, no missing assets, correct export settings (PRD §8.6).

## Determinism & reversibility checks

- Re-run the same input → identical output (no wall-clock/unseeded randomness).
- `invert(apply(t, op)) == t` for every editing op; undo/redo round-trips cleanly.

## Definition of Done checklist (PRD §20)

- [ ] Works manually AND via AI tool (if applicable).
- [ ] Operation reversible (apply + invert tested).
- [ ] Schema documented (+ migration if changed).
- [ ] Unit + integration tests; e2e for critical flow.
- [ ] Core deterministic modules meaningfully covered (behavior + error paths); no vanity coverage.
- [ ] Render output validated.
- [ ] Typed, clear user-facing errors.
- [ ] `plan/PLAN.md`, `docs/`, `CHANGELOG.md` updated.
