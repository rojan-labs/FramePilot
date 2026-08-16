---
name: 'source-command-write-tests'
description: 'Add the tests required by the Definition of Done — unit, integration, e2e, golden media (PRD §16)'
---

# source-command-write-tests

Use this skill when the user asks to run the migrated source command `write-tests`.

## Command Template

Write the tests required to bring a feature to the Definition of Done.

1. Read `plan/PLAN.md` and identify what is under-tested.
2. Add the right test types (PRD §16.2):
   - **Unit**: timeline operations (apply + invert), patch validator, schemas, AI tool input.
   - **Integration**: import → proxy → transcript → apply patch → render preview → export.
   - **E2E** (Playwright): the critical flow, deterministic, offline, `mock` provider,
     screenshots/video on failure.
   - **Golden media**: duration/resolution/fps/streams, frame-hash tolerance, caption timing,
     black-frame & clipping checks.
3. Cover core deterministic modules **meaningfully** — behavior and error paths, not a
   coverage percentage; no vanity coverage; no skipped tests without a linked issue.
4. Run the affected suites and `pnpm verify`.

Reference `.agents/skills/e2e-testing/SKILL.md` and `.agents/skills/media-pipeline/SKILL.md`.
Update `plan/PLAN.md` and `docs/`.
