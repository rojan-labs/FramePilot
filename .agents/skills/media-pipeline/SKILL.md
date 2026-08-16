# Skill: Media Pipeline

Work on video, audio, masks, and render internals in `engine/python`. (PRD §14.5, §9, §16.)

## When to use

- Building or changing render compilation, effects, audio, tracking, masking, proxy/waveform/frame extraction, or render validation.

## Rules / steps

1. **Deterministic fixtures** — small, committed/generated fixture media; fixed seeds; stable ordering. Same input → same output.
2. **Golden output tests** — store expected output metadata (duration, resolution, fps, streams, caption timing) and compare.
3. **Perceptual tolerances for video** — compare frames with a frame-hash / similarity tolerance, not exact bytes (encoders vary).
4. **Exact tests for JSON patches** — patch/timeline behavior is deterministic; assert exactly.
5. **Stream checks** — verify duration, video stream, audio stream (when expected), no zero-byte output, black-frame detection, audio-clipping detection (PRD §9.4).
6. **Determinism in code** — no wall-clock, no unseeded randomness, explicit layer order (e.g. text-behind-object).
7. **No render change without a golden-test update.**

## Definition of done

- New/changed pipeline code is deterministic and typed (mypy strict, ruff clean).
- Golden + perceptual tests added/updated; render validation passes.
- The `validation/` module's behavior and failure paths are covered.
- `plan/PLAN.md`, `docs/`, and `CHANGELOG.md` updated.
