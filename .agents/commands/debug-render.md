---
description: Diagnose and fix a failed or incorrect render, then add a regression test (PRD §9, §14.2)
---

Debug a failed or wrong render.

Delegate to the **render-debugger** subagent / `.agents/skills/render-debugging/SKILL.md`:

1. Read `plan/PLAN.md`. Reproduce deterministically with a minimal fixture; capture render logs.
2. Check: project JSON validity, asset paths (sandboxed, exist), codec availability,
   duration mismatch, missing/invalid audio streams. Find the first error, not the last symptom.
3. Fix the root cause; keep code deterministic and typed (ruff clean, mypy strict).
4. Confirm render validation passes (PRD §9.4): file/duration/streams/black-frame/clipping.
5. **Add a regression test** (golden-media or unit). No render change without a golden-test update.

Reference `.agents/rules/python-engine.mdc`. Update `plan/PLAN.md`, `docs/runbooks/`, and `CHANGELOG.md`.
