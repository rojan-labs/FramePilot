# Skill: E2E Testing

Create and maintain Playwright end-to-end tests in `tests/e2e`. (PRD §14.3, §16.)

## When to use

- Adding or changing a critical user flow.
- A flow lacks e2e coverage, or a bug escaped because no e2e exercised it.

## Rules / steps

1. **Cover every critical flow** (PRD §16.1): create project, import video, generate transcript, add captions, trim clip, add text overlay, use AI edit command, review timeline diff, apply patch, undo patch, render preview, export final video, validate output.
2. **Use fixture videos** — deterministic, committed small fixtures (or generated locally). The AI provider is `mock` for deterministic patches.
3. **No network** — tests run offline; stub/seed everything.
4. **Assert real outcomes** — UI state, the resulting patch, and (for export) the validated render metadata (duration/streams).
5. **Record screenshots/video on failure** for debugging.
6. **No skipped tests** without a linked issue in the annotation.

## Definition of done

- The critical flow has a passing, deterministic Playwright test that runs offline.
- Failure artifacts (screenshot/video) are captured.
- Test is wired into `pnpm test:e2e` and CI smoke.
- `plan/PLAN.md` and `docs/` updated.
