# Skill: Render Debugging

Diagnose and fix failed or wrong MoviePy/FFmpeg renders in `engine/python`. (PRD §14.2, §9.)

## When to use

- A render job fails, hangs, produces a zero-byte/short file, or output doesn't match the timeline.
- Render validation (PRD §9.4) flags a duration mismatch, missing stream, black frames, or audio clipping.

## Rules / steps

1. **Reproduce deterministically** — render the offending project (or a minimal fixture) via `uv run framepilot render <project.fp.json>`. Capture the render logs.
2. **Check the project JSON** — valid schema, references resolve, no negative/overlapping durations, expected timeline duration.
3. **Check asset paths** — files exist, inside the project sandbox (no traversal), correct case; proxies vs originals.
4. **Check codec / format availability** — FFmpeg has the needed encoders/decoders; container/codec compatibility; pixel format and fps.
5. **Check duration mismatch** — compare expected timeline duration to output duration within tolerance.
6. **Check audio** — missing audio streams, sample-rate/channel mismatch, clipping, broken audio links.
7. **Read render logs** — find the first error, not the last symptom. Surface a clear, typed error with context.
8. **Add a regression test** — a golden-media or unit test that fails on the bug and passes on the fix.

## Definition of done

- Root cause fixed (not just symptom); render produces a correct, validated output.
- Render validation passes (file/duration/streams/black-frame/clipping).
- A regression test is added; no render change without a golden-test update.
- `plan/PLAN.md`, `docs/runbooks/`, and `CHANGELOG.md` updated as relevant.
