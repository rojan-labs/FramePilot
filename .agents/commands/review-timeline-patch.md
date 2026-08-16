---
description: Review a proposed timeline patch for validity, reversibility, and correctness before apply (PRD §8.5, §8.6)
---

Review a proposed timeline patch before it is applied.

Run the correctness-verification flow (`.agents/skills/correctness-verification/SKILL.md`):

1. **Validate** (PRD §8.5): patch schema valid; references exist; no negative duration;
   valid layer order; no missing asset; supported effect; no broken audio link; no overlap;
   engine supports each op; every op is reversible.
2. **Reversibility**: each editing op has an `invert`; `invert(apply(t, op)) == t`.
3. **Diff**: confirm the before/after change matches the stated reason (what/why).
4. **Determinism**: same input → same result; no wall-clock/unseeded randomness.
5. **If it implies a render**: confirm render validation will run (PRD §9.4) and outline
   critic checks (duration vs target, caption alignment, safe-area, clipping, black frames).
6. Report concrete findings; do NOT approve a patch that fails any check.

Reference `.agents/rules/timeline-patch-engine.mdc` and `.agents/rules/correctness.mdc`.
Note findings in `plan/PLAN.md`/`docs/` as needed.
