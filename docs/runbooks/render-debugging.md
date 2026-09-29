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
   order (text-behind-object). "Black" means every channel is at or under 10% of full scale:
   `analysis/black.py` feeds `blackdetect` max(R, G, B) (via `format=gbrp`, two `lighten`
   blends and `setparams=range=pc`), not luma, so a saturated blue or red card is never black
   (#154). If a coloured frame is flagged, check the graph in `blackdetect_argv` first.
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

## Recurring failure mode: a migrated (v21) mask is a pixel off on some frames

Symptom: a project upgraded from schema v21 exports with a mask edge one pixel off on a few
frames compared with the v21 reference (E2E.5 saw 1 frame in 30 on a clip starting at 4 s). The
cause is the float round trip, not the rasteriser. v21 drew `x * width` from frame fractions, and
the v22 mask stores a centre and a size in pixels, which is not one-to-one with those fractions
(x = 0.2 and 0.19999999999999996 store the same centre). Check that the mask has `legacySpec`
(written by the migration since MK2.5) and that `_stored_v21_spec` in `render/mask_stack.py`
returned it for that frame. `None` means the stored geometry no longer maps from it (edited mask,
or a different media size at render than at upgrade) and the frame used the best-effort recovery.
Reproduce with `test_mask_legacy_render.py` (add the clip's start/fps to `timings` in
`tests/fixtures/mask-render/legacy-v21.json`, then regenerate with
`vitest -u src/mask-legacy-render-fixture.test.ts` in `packages/timeline-schema`).

## Recurring failure mode: one clip's colours a level or three off the rest

Symptom: on one machine, a variable-frame-rate clip (or a cut-out's matte) is a few levels off in
colour against the monitor while constant-rate clips match; on CI it matches. The cause is two
ffmpeg builds inside one export: MoviePy decodes with `moviepy.config.FFMPEG_BINARY`
(imageio-ffmpeg's bundled build), and anything that called `find_ffmpeg()` got
`FRAMEPILOT_FFMPEG`, then whatever `ffmpeg` is on `PATH` (Homebrew's, on a Mac). Builds convert
YUV to RGB differently (the bundled macOS arm64 7.1 uses libswscale's C tables). Every decode the
export does outside MoviePy - `PtsVideoReader` (VFR), the matte cursor, the matte tier's master
decode, the encoder probe - must call `find_export_ffmpeg()` in `media/ffmpeg.py` (BR2.8).
`FRAMEPILOT_FFMPEG` does not move the export; set MoviePy's `FFMPEG_BINARY` (or imageio's
`IMAGEIO_FFMPEG_EXE`) to change it, which moves every export decode together. Check which binary
ran with `ps -o args` during a render, or `test_media_ffmpeg.py` /
`test_render_pts_reader.py::test_variable_rate_decode_runs_moviepys_ffmpeg_not_path_or_override`.

## Recurring failure mode: a solved colour grade lands short (or long) by a steady fraction

Symptom: `match_color` / `apply_look` produce the right direction but the export measures a
fixed fraction off what the solver promised (#107: "warmer" delivered 70-83% of its +0.10).
Do not fit a constant from float-RGB previews: the ledger's facts are `signalstats` codes of a
LIMITED-range BT.709 file, and a reconstruction through an assumed matrix cannot tell a wrong
matrix from a wrong renderer. Measure the export with the ledger's own graph:

    cd engine/python
    uv run python -m tests.color_response_measure --work <scratch dir> \
        --media <short real clips, 2-3 s each> --json fit.json --raw raw.json
    uv run python -m tests.color_response_measure --refit raw.json   # re-fit, no renders

It exports 25 grade cells per clip at 480p through `export_video` (one at a time, well under
1 GB), measures each with `shot_stats.measure_asset`, and first exports a pure-red probe to name
the encode chain from evidence. Read `temperature_curve_efficiency` first: near 1.0 means the
renderer does what `render/color.py` says and any miss is the solver's model; below 1.0 is
clipping. Media goes into the scratch sandbox; never point `--work` at a real project folder.

Exports (final and preview renders alike) encode **BT.709 limited range, tagged**
(`encoders.BT709_OUTPUT_ARGS`, #154): the probe reads 61.9/103.0/238.8 against BT.709's
63/102/240 (distance 1.5 codes; BT.601 is 23 away). Before 2026-09-29 they were BT.601
limited and untagged (probe 81/90/239), so a raw file from that era is in another chain than
its sources; re-express it as the script does. The leftover ~1-code drift is the DECODE, not
the encode: the bundled imageio ffmpeg 7.1 (the one MoviePy reads with) turns red 63/102/240
into R 253, where Homebrew's 8.1 gives 255. An exact-RGB input (a PNG) encodes to 63/102/240
exactly (`tests/test_render_colour_encoding.py`). If an export's colours look shifted, run
`ffprobe -show_entries stream=color_space,color_range,color_primaries,color_transfer` first:
anything `unknown` means the tags were lost (a `-c:v copy` remux keeps them; a re-encode
without these arguments does not). ffmpeg 7.1 copies the encoder's colour fields from the
frames, so the `-color_*` flags alone leave primaries/transfer unknown; the `setparams`
filter is what sets them.
Black QC and black analysis judge the brightest channel, not luma. BT.709 luma of pure blue
(0,0,255) is 7% (Y=32), under `pix_th=0.10`, so plain `blackdetect` failed an export ending on a
pure-blue card with "ends on black" (navy 0,0,128 too, at Y=24). `blackdetect_argv` now converts
to RGB through the file's own tags (`format=gbrp`; untagged files take BT.601, which is what
pre-#154 exports used), takes max(R, G, B) with two `lighten` blends, and tags that plane
`range=pc` so `pix_th=0.10` cuts at code 25 of 255. Tagged `tv`, blackdetect would cut at
16 + 0.1 * 219 = code 37 instead. Real black, near-black 20/20/20, fades to black and thin
white text on black keep their verdict (`tests/test_black_brightest_channel.py`). The pass
costs about 2x plain `blackdetect` (63 s 1080p export: 1.2-2.1 s before, 2.9-3.3 s after, the
two blends being the difference). Do not downscale to win that back: it changes the verdict
on thin text.

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

## Recurring failure mode: text spacing differs between the editor and the export

Symptom: tracked text (a `letterSpacing` title or caption) wraps, centres or spaces its words
differently in the export than in the editor, e.g. "THE CLIMB" exported as "THECLIMB" (AL32).

Why: the preview draws CSS `letter-spacing`, which adds the spacing after EVERY character: the
space between words and the last letter of a line included. The export's caption rasterizer
(`render/captions.py`) builds the same box: `_token_width` gives every glyph its spacing, the
last one included, and `_tracked_space_width` is the space plus its spacing, so two words sit
`space + 2 x spacing` apart and a chip ends one spacing past its last letter, as the CSS box
does. The AI layer's title fit (`overlay-fit.ts` `typedTitleWidthsPx`) reads the same box.

Check: `uv run pytest tests/test_text_overlay_typography.py tests/test_title_metrics.py
tests/test_title_fit.py`, once plainly and once with `DYLD_LIBRARY_PATH=/opt/homebrew/lib`
(libraqm on, like Linux CI). If the rule changes on either side, change both renderers and the
fit together, then regenerate the fit's reference widths with
`uv run python -m framepilot_engine.render.title_metrics`.
