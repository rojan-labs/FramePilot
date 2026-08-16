# Runbook: Render Debugging

Operational checklist for when a render fails or produces bad output. A render that
"succeeded" but is black, silent, truncated, or the wrong length is a **failure** — render
validation (PRD §9.4) should catch these, but use this runbook to diagnose root cause.

Companion: the `render-debugging` skill (`.agents/skills/render-debugging/`). Engine
internals: [../architecture/render-engine.md](../architecture/render-engine.md). API/CLI:
[../api/python-engine-api.md](../api/python-engine-api.md).

---

## First, reproduce deterministically

```bash
uv run framepilot render <project.fp.json>
uv run framepilot validate-render <output.mp4>
uv run framepilot inspect-media <input-or-output.mp4>
```

The CLI uses the same deterministic compiler as the app, so a failure should reproduce
outside Electron. Capture the failing project and assets.

---

## Checklist (work top to bottom)

1. **Project JSON** — does `project.fp.json` load and validate against the schema
   ([../api/timeline-schema.md](../api/timeline-schema.md))? Look for invalid clip ranges
   (negative/zero duration), dangling `assetId`/`trackId`, bad layer order. The patch
   validator should have rejected these — if it didn't, that's a validator bug.
2. **Asset paths** — do all referenced assets exist under the project `assets/` folder?
   Are paths within the sandbox (`FRAMEPILOT_PROJECTS_ROOT`)? A missing asset is the most
   common cause.
3. **Codecs / FFmpeg** — is FFmpeg on `PATH` and recent enough? Is the source codec
   decodable and the target codec encodable? Run `ffmpeg -version` and
   `framepilot inspect-media` on the source.
4. **Duration mismatch** — does the output duration match the expected timeline duration
   (within tolerance)? A mismatch points at trim/ripple/keyframe math or a transition that
   shortened/lengthened the composition.
5. **Missing audio stream** — if audio was expected but the output has none, check the
   audio track clips, `adjust_audio` ops, and that the source actually has audio
   (`inspect-media`).
6. **Black frames** — black-frame detection tripped? Check clip `start`/`end` vs.
   `sourceStart`/`sourceEnd`, gaps left by `delete_range`, and mask/compositing layer
   order (text-behind-object).
7. **Audio clipping** — clipping detected? Check `adjust_audio` volumes, music ducking,
   and overlapping audio clips summing too hot.
8. **Render logs** — read `logs/` in the project folder for the failing job. Failures must
   emit useful logs (PRD §18.3); note the lifecycle stage it failed at (preparing_assets /
   rendering_frames / encoding / validating_output).
9. **Timeout / cancellation** — did it hit `FRAMEPILOT_RENDER_TIMEOUT_SECONDS`? Large
   renders may need the ceiling raised or the job split.

---

## After you fix it

- **Add a regression test** — capture the failing project as a fixture and add a
  golden-media or unit test so it can't regress (PRD §16; the
  `render-debugging` skill requires this).
- **Update the golden fixture** if intended output changed (and only then).
- Note recurring failure modes here so the next person is faster.

## Recurring failure mode: "applies but doesn't render"

A distinct class of bug from the checklist above — the op **validates and applies** (it
lands in the timeline, survives save/undo), but `compile_timeline`'s clip-kind dispatch loop
(`framepilot_engine/render/compiler.py`) has no branch for that clip kind, or an effect type
is parsed/accepted but never actually applied to the frames. This is silent: the render
"succeeds" and passes validation (duration/streams/black-frame/clipping all look fine), it
just doesn't show the edit. `unsupported_track_types` is the compiler's own audit for the
first half (undispatched clip kinds) — a clip kind should never be missing from both the
render loop *and* that function's `rendered` set.

Two examples fixed 2026-07-10 (see `CHANGELOG.md`): text/title overlays (`add_text_overlay`,
clip kind `text`) were skipped entirely in the dispatch loop; a `lut` color-grade effect
(`apply_color_grade` with `type: "lut"`) was schema-valid and applied to the timeline, but
`_apply_color_grade` only ever read the `color_grade` effect — the LUT parser/applier already
existed in `render/color.py`, nothing called it. Both needed a golden test that renders the
timeline and samples pixels (not just "compile didn't raise") to actually prove the edit
reaches the frame — see `test_compile_burns_in_text_overlay` and
`test_compile_applies_lut_from_sandboxed_cube_file` in
`engine/python/tests/test_render_compiler.py` for the pattern. The LUT fix also sandboxes the
effect's `path` param the same way asset paths are sandboxed (`safety.resolve_within` against
the asset index's `base_dir`) — a LUT file is disk I/O like any other, so it gets the same
traversal guard.

See [writing-tests.md](../guides/writing-tests.md) and
[ci-cd.md](ci-cd.md) (CI renders + validates the fixture project on every PR).
