# AI Tool Registry

The **Tool Registry** is the _only_ surface through which the AI may act (PRD §8.3). Two
hard rules:

1. **The AI may only edit via registered, schema-validated tools.** No arbitrary code, no
   shell, no direct filesystem writes (PRD §18.2).
2. **Write tools return a patch, never a mutation.** A tool that changes the timeline emits
   a [patch](patch-format.md); that patch then flows through validate → diff → preview →
   apply. Tools never touch `project.fp.json` directly (PRD §8.3).

This is what makes AI edits as safe, reviewable, and reversible as manual ones. See
[../architecture/ai-engine.md](../architecture/ai-engine.md).

---

## Tool contract

Every tool declares:

- a **name** (stable identifier the model calls),
- an **input schema** — a Zod schema in TS / a Pydantic model in Python. It validates the
  arguments (invalid input is rejected, not coerced) **and** is the source the advertised
  JSON Schema is derived from, so validation and the model-facing contract cannot drift.
  Schemas are strict: unknown arguments are rejected.
- a **kind**: `read` (returns state), `mutate`/`write` (returns operations), `action`
  (runs the render engine), or `analysis` (runs an ffmpeg analysis on the engine and
  returns data),
- an **availability** flag — a tool whose engine does not exist yet is registered but
  `available: false`, and the orchestrator refuses to invoke it (build-order invariant).

Read tools gather context; write tools propose edits by returning typed **operations** that
the orchestrator assembles into a single reviewable `Patch` (the provider never returns a
patch — see [ADR 0012](../adr/0012-ai-tool-boundary-and-orchestrator.md)). The orchestrator
decides which tools a given mode may use (e.g. `plan` mode may call read tools but applies
nothing; `edit` offers only write tools).

### Execution contract: caching, cancellation, and the analysis budget

Beyond the schema, every tool resolves a typed **execution contract**
(`packages/ai-sdk/src/tool-contract.ts`) that the runtime — not the caller — obeys.

- **Caching.** A host tool's result is memoized for the run only when its answer is
  `revision_independent`: source material and provider catalogues, which no edit can
  change (invariant 1: originals are never mutated). Anything that reads the timeline, the
  asset bin or the transcript runs fresh every time, because a run changes all three
  underneath its own questions. There is deliberately no revision-keyed tier — see the
  2026-08-30 amendment in
  [ADR 0107](../adr/0107-ai-tool-and-edit-contract-authority.md).
- **Cancellation.** `AbortSignal` is the only channel. The run's signal reaches the model
  provider, the host executor and the sidecar's HTTP request; Stop aborts the in-flight
  call and the outcome settles as `cancelled`, never as a checkmark.
- **Analysis budget.** Each run carries a per-run ceiling on the expensive host work
  (`kernel/cost/analysis-caps.ts`): `maxTranscriptionMinutes` (default 60) over minutes of
  audio actually transcribed, and `maxFfmpegSeconds` (default 900) over wall-clock seconds
  of ffmpeg-backed analysis — the silence/scene/beat analyzers, `get_frame`,
  `measure_color`. The host seam checks the budget before dispatch and records the real
  consumption after, so a call over the ceiling **fails honestly and never runs**; its
  summary names the resource and the totals. Callers that thread no budget (a one-off MCP
  call) are uncapped, as before.

### Optional arguments at the untrusted boundary

Strict validation is about _rejecting_ input the tool cannot honor. It is not about taking
a model's filler literally. Three tolerances are applied before validation, in both the TS
and Python registries, because models emit these shapes constantly and each one otherwise
turns a correct call into a wrong answer:

- a **string-encoded number** (`"start": "5.0"`) is read as a number,
- the **string booleans** `"true"` / `"false"` are read as booleans,
- a **blank optional string selector** (`"folderId": ""`) is read as _not provided_,
  and a padded one is trimmed. No id, query, or category in this schema is ever the empty
  string, so `""` can only be filler — but taken literally it is an _active_ filter that
  nothing matches. That is how `list_assets {"kind":"video","folderId":""}` reported an
  empty media bin for a full one, and the agent asked the user to import footage that was
  already imported.

Genuinely bad input is still rejected: an unknown key, an out-of-enum `kind`, or a
non-numeric string all fail validation as before.

A read whose **filters** excluded everything must also not read as "this does not exist":
`list_assets` returns a `note` naming what the bin actually holds whenever a filter matched
nothing in a non-empty bin.

---

## Core tools (PRD §8.3)

| Tool                                | Purpose                                                        | Kind             | Available? |
| ----------------------------------- | -------------------------------------------------------------- | ---------------- | ---------- |
| `get_project_state`                 | Current editable state (no undo history; media bin as a tally) | read             | yes        |
| `get_timeline`                      | Current tracks/clips                                           | read             | yes        |
| `get_transcript`                    | Word-level transcript (optional `start`/`end` window)          | read             | yes        |
| `get_timeline_summary`              | Compact per-track overview (counts + spans, no clip bodies)    | read             | yes        |
| `get_clips`                         | Windowed, paginated compact clip listing                       | read             | yes        |
| `get_clip`                          | One clip in full detail + its `trackId`                        | read             | yes        |
| `get_selected_range`                | The user's current selection                                   | read             | yes        |
| `list_assets`                       | Media-bin assets + folders (kind/folder filterable)            | read             | yes        |
| `discover_caption_styles`           | Bundled caption fonts, templates and composition fields        | read             | yes        |
| `trim_clip`                         | Trim a clip (non-destructive)                                  | write            | yes        |
| `split_clip`                        | Split a clip at a time                                         | write            | yes        |
| `delete_range`                      | Delete a time range on a track                                 | write            | yes        |
| `ripple_delete`                     | Delete a range and close the gap                               | write            | yes        |
| `delete_clip`                       | Delete one clip by id (optional ripple)                        | write            | yes        |
| `delete_clips`                      | Delete up to 50 clips by id in one call                        | write            | yes        |
| `move_clip`                         | Move a clip to a new track/start                               | write            | yes        |
| `add_track`                         | Create a new empty track/layer (`add_layer` op)                | write            | yes        |
| `remove_track`                      | Remove a track and its clips (`remove_layer` op)               | write            | yes        |
| `move_track`                        | Reorder a track's z-slot (`move_layer` op)                     | write            | yes        |
| `add_clip`                          | Add a clip from an existing asset                              | write            | yes        |
| `add_clips`                         | Place a whole sequence on one track in a single call           | write            | yes        |
| `add_text_layer`                    | Add a text overlay (`add_text_overlay` op)                     | write            | yes        |
| `discover_text_overlay_styles`      | Text overlay styles by category, each with a one-line look     | read             | yes        |
| `set_text_style`                    | Restyle a placed text overlay (`set_effect_params`)            | write            | yes        |
| `search_elements`                   | Find shapes, icons or stickers by words (kind, collection)     | read             | yes        |
| `add_shape`                         | Draw a catalogue shape or icon on an overlay (`add_shape`)     | write            | yes        |
| `set_shape_style`                   | Restyle or move a shape (`set_effect_params`)                  | write            | yes        |
| `add_sticker`                       | Copy a library sticker in and place it (desktop host)          | host (desktop)   | yes        |
| `set_element_animation`             | In / Out (layer transitions) and Loop (keyframes) on a graphic | write            | yes        |
| `add_caption_layer`                 | Add one short mapped caption cue (never a full-song block)     | write            | yes        |
| `auto_emphasize_captions`           | Ground AI-selected anchors and compose a caption track         | write            | yes        |
| `set_track_caption_style`           | Set/clear the complete shared caption composition              | write            | yes        |
| `set_caption_style`                 | Set/clear one cue's composition override                       | write            | yes        |
| `add_keyframes`                     | Add animation keyframes (e.g. zoom)                            | write            | yes        |
| `apply_color_grade`                 | Apply a color grade                                            | write            | yes        |
| `adjust_audio`                      | Volume/gain (dB)                                               | write            | yes        |
| `add_transition`                    | Transition onto a clip                                         | write            | yes        |
| `track_object`                      | Attach a face/bbox tracker to a clip                           | write            | yes        |
| `transcribe`                        | Run host-owned ASR and propose a transcript patch              | analysis + write | yes        |
| `render_preview`                    | Produce a low-res preview render                               | action           | yes        |
| `export_video`                      | Final export (after approval)                                  | action           | yes        |
| `analyze_silence`                   | Detect silent gaps (ffmpeg silencedetect)                      | analysis         | yes        |
| `detect_scenes`                     | Detect scene cuts (ffmpeg scene score)                         | analysis         | yes        |
| `detect_subjects`                   | Detect people/objects in frames (Subject Intelligence pack)    | analysis         | yes        |
| `find_mask_targets` … `delete_mask` | The masking domain — see [ai-masking.md](./ai-masking.md)      | analysis / write | yes        |

**Elements** (`plan/elements`, EL8). Each sticker and shape row in the timeline the model reads
names the element and where it sits in its own tool's units (`sticker "Fire" at 75%, 25%, 30% high
· in: pop`, `shape rounded-rect · outline #FFD400 · box 50, 50, 48×27`), about fifteen tokens an
element. `add_sticker` without `sizePercent` places the art at 30% of the frame height, or at the
largest whole percent that stays within 1.5× its pixels on a tall or 4K frame. An edit that
leaves an element off the frame for its whole span is refused (`element_off_frame`). The critic
adds `element_faces`, `element_safe_area`, `element_busy_frame` and `sticker_sharp`
(advisories). Whether the request asked for a sticker or a callout is the model's own plan to
carry, not a check read out of the request's words (ADR 0196 amendment, issue #136). Where the host cannot place stickers (`placesStickers: false`, the MCP server),
`search_elements` returns shapes only with a `note`.

Placement and loops (issue #150). `add_shape` and `set_shape_style` move a box shape just far
enough that what it draws (outline and stroke, by `shapeBounds`) is inside the frame; an axis the
shape is larger than, and a line's or arrow's ends, stay as asked. Shapes are not held to the 10%
safe margin: a callout sits on its target, which is why `element_safe_area` exempts them.
`add_sticker` moves a sticker that would be partly off the frame in the same way. When the
placed sticker is outside the Critic's `SAFE_AREA_INSET`, its result says so and gives the
`xPercent`/`yPercent` ranges that keep this sticker inside. The text `safe_area` check no longer
reads shape params, whose x/y are percentages. It had been reading them as 0–1 fractions, so it
flagged every positioned shape. `set_element_animation` refuses a loop its clip is too short to
move with numbers computed from the loop table: the clip's length, the least the requested loop
needs, the slowest period of that loop that fits, the other loops that fit and their periods, and
the longest In/Out. It never substitutes a different loop. A spin moves on a clip of any length,
because it is two keyframes across the clip.

`get_project_state` returns the media bin as a **tally**, not a listing:

```jsonc
// before
{ "assets": [ { "id": "a1", "kind": "video", ... }, ... ] }
// now
{ "assetSummary": { "total": 61, "byKind": { "image": 60, "audio": 1 },
                    "note": "Asset ids are not listed here — call list_assets for them." } }
```

The `assets` array is **absent**, not renamed — call `list_assets` for the ids. A run that
called both tools paid for the same ~5,000 tokens of asset ids twice and filed two evidence
handles for one fact. What `get_project_state` adds over `list_assets` is everything else:
fps, resolution, the timeline, the transcript, markers, project memory.

`add_clips` places many clips on one track in one call and is exactly equivalent to the
`add_clip` calls it replaces — same derived `sourceEnd`, same validation, one reversible
patch. Entries are rejected individually and the rejection names the offending index, so a
batch is fixed and re-sent rather than unrolled into single calls. The whole batch still
counts against the per-turn operation cap.

`add_clip` intentionally has only one authoritative duration. `start`/`end`
define the timeline span; `sourceStart` chooses the asset in-point (default 0),
and the host derives `sourceEnd = sourceStart + (end - start)` because this tool
places at 1× speed. A legacy `sourceEnd` argument is accepted for compatibility
but cannot override that invariant. Speed changes happen afterward through the
typed `set_clip_speed` operation.

No tool is registered `available: false` today. `generate_mask` was the last: it existed
because a segmentation produces a **bitmap** while a v21 timeline mask steered by **rectangle
bounds**. Schema v22 gave masks a raster `matte` kind and the Smart Mask pack a measured one, so
`create_mask` replaced it ([ai-masking.md](./ai-masking.md)). The model-facing `add_mask` (a
whole-frame shape) and the unadvertised `add_mask_advanced` (model-authored bounds and polygon
points) were deleted with it, because the AI never authors mask geometry. The `unavailable` kind
and the orchestrator's refusal of one remain — no AI feature pretends to use an engine that has
not been built (build-order invariant,
[ADR 0004](../adr/0004-timeline-patch-engine-before-ai.md)) — and the suites prove that refusal
with a test-only tool (`packages/ai-sdk/src/__fixtures__/unbuilt-tool.ts`).

`detect_faces` went the same way earlier. It is **gone**, not renamed to `available: false`:
the Subject Intelligence pack superseded it with `detect_subjects`, which returns
person/object labels rather than face boxes alone.

`render_preview` and `export_video` are **actions** (they run the render engine — see
[python-engine-api.md](python-engine-api.md)) rather than read or write tools; `export_video`
runs only after human approval (PRD §3.4).

`analyze_silence` and `detect_scenes` are **analysis** tools: their ffmpeg engine
(`framepilot_engine.analysis`, exposed by the sidecar `/analyze-silence` and `/detect-scenes`
routes) exists, so they are `available: true`. Like actions, the in-process orchestrator does
not run them (the render engine is Python-only — render-vs-preview rule); the host/sidecar
computes the result and returns it. Each takes an optional `assetId` (defaulting to the first
audio-bearing / video asset) plus tuning parameters (`noiseFloorDb`/`minSilenceSeconds` for
silence, `threshold` for scenes). They return data only and never mutate the timeline.

`transcribe` (plan H0.1/T0) accepts only an optional `assetId`; the model cannot supply
`TranscriptWord[]`. The trusted host resolves that asset, invokes the configured ASR provider
(local `whisper-cli`, TwelveLabs, Groq, or NVIDIA; see
[transcription.md](../guides/transcription.md)), validates the returned word timestamps, and
turns a non-empty result into a reversible `set_transcript` operation. Empty, unavailable, or
malformed provider output is a failed tool outcome and preserves the current transcript.

This is intentionally a host-backed mutation: audio and credentials never enter model arguments,
while the resulting edit still passes through validate → review/apply → undo. Desktop manual
transcription, the in-app agent, and MCP all converge on that operation boundary.

### Caption design tools

`discover_caption_styles` returns the canonical bundled font families, their weight ranges,
filterable production templates, and the fields the agent may compose. It is static catalog data,
so an AI can choose a font/template without guessing or depending on locally installed fonts.

`auto_emphasize_captions` requires `trackId` plus 1–12 exact spoken `keywords`. The calling AI is
the semantic analyzer: it first reads `get_mapped_transcript`, selects sparse anchors from meaning,
delivery, contrast and payoff, then invokes the tool. The tool normalizes case/punctuation, rejects
terms absent from caption/transcript text, and writes `captionStyle.accent.mode = "keywords"`
through one `set_track_caption_style` operation. It may also receive a partial `style`, `color`, and
`fontScale`, allowing one call to set emphasis, template, bundled font, x/y placement, rotation,
width, alignment, spacing, background, animation and safe-area behavior while preserving omitted
track fields.

`set_track_caption_style` is the AI/manual parity boundary for the shared look;
`set_caption_style` applies the same `CaptionStyle` contract to one cue and wins over the track.
Both accept `null` to clear their layer. Unknown template ids and unbundled font families are
rejected at the tool boundary so DOM preview and deterministic export cannot silently diverge.

### Text overlay tools

`add_text_layer` takes an optional `style`: an id from the text overlay style catalog
(`@framepilot/timeline-schema/text-overlay-styles`), validated as an enum of catalog ids. The
style's whole look is written into the overlay's `text` effect params with the same
`textOverlayLookParams` the Text panel uses (family, weight, colour, size, alignment, box width,
position, chip colour, `typography`, `templateId`), so one style id is one patch whichever host
applied it. Every other styling arg (`sizePercent`, `color`, `background`, `align`,
`boxWidthPercent`, `xPercent`, `yPercent`, `fontFamily`, `fontWeight`) overrides only the field
it names. `fontFamily` is an enum of the bundled caption fonts; a family named over a style has
the style's weight held inside the weights that family ships.

Typography args, each written over its one field of `params.typography`
(`TextOverlayTypographySchema`, #135): `letterSpacing` (em, 0–0.6; both renderers draw a style's
negative tracking, down to -0.2, but the agent's own range still starts at 0), `fontStyle`
(`italic` only in a family that ships an italic file, else refused — neither renderer
synthesises a slant), `lineHeight` (0.7–3), `textTransform`, `textOpacity`
(0–1), `outlineColor`, `outlineWidth` (sixteenths of the size, 0–8; 0 is no outline) and
`shadow` (`{color, blur, offsetX, offsetY}` in em, or `"none"` to drop the style's). An overlay
with no typography yet starts from `PLAIN_TEXT_OVERLAY_TYPOGRAPHY`, as the Inspector's first
edit does, so one field does not also drop the plain overlay's black stroke. The chip's shape
comes with a style.

Words that would run out of the frame are fitted, not refused: the box is widened first (up to
92% of the width, recentred so it stays inside the frame), then the size comes down. The fit
measures what the renderer draws (`overlay-fit.ts`): the overlay's own face and weight, the case
a capitalising style draws and, for an overlay with typography (drawn by the caption
rasterizer), the tracking between glyphs, the italic file, the stroke and the chip padding the
wrap keeps. `tests/test_title_metrics.py` checks that arithmetic against the rasterizer. A
style's size and box are fitted the same way as explicit ones. Per-letter and per-word reveals
do not exist for text overlays yet (#152).

`set_text_style` (`clipId` plus any of `text`, `style` and the same styling and typography args) restyles an
overlay already on the timeline in one `set_effect_params`. A `style` is applied the way the
Text panel's Apply does (`applyTextOverlayStylePatch`): its whole look except `xPercent`,
`yPercent` and `boxWidthPercent`, so the overlay stays where it was placed. The result is
fitted like a new overlay, and a call that changes nothing is refused. `adjust_effect` given a
clip's own effect id (`<clipId>__text`) points here instead of failing as an unknown layer.

`discover_text_overlay_styles` (`query`, `category`) lists the styles grouped by category, each
with a look line derived from the catalog data (typeface and weight, colour, size, where it
sits, chip/outline/glow/shadow), so the model can choose without the full looks in every
request. It is static catalog data (`guidance`, revision-independent), in the `effects` domain.
The Python twin mirrors `add_text_layer` from the packaged catalog copy
(`framepilot_engine/ai_tools/text_overlay_styles.json`) and delegates discovery to the host.

### The agent's plan: `update_plan`

`update_plan` is a session tool (like `load_tools`): it changes no timeline and returns no patch.
The model writes its plan for the request as a list and keeps it current. Each call replaces the
whole list.

```ts
update_plan({
  items: [
    { task: 'Build the 24-shot montage from the shot list', status: 'done' },
    { task: 'Warm teal-orange grade', status: 'in_progress' },
    { task: 'Voice-over', status: 'blocked', note: 'There is no text-to-speech tool.' },
  ],
});
// → "Plan saved (1 in progress, 1 done, 1 blocked). Next: “Warm teal-orange grade”. …"
```

- **Schema:** 1–40 items; `task` 1–160 characters; `status` is `pending`, `in_progress`, `done`
  or `blocked`; `note` is at most 240 characters and is **required** when `blocked` (why no
  available tool can do it). Strict: unknown keys are refused.
- **Surface:** core (always advertised in agent mode, including the action-recovery turn); not
  offered on the read-only question route. `hostUiOnly` and `serialOnly`: the plan lives in a TS
  orchestrator run, so neither the Python sidecar nor the MCP server mirrors it.
- **What the loop does with it** (`kernel/conductor.ts`, `kernel/model-plan.ts`): a reply with no
  tool call ends the run only when no item is `pending` or `in_progress`. While one is open, the
  run continues with the next item (the one in progress, else the first pending). This is bounded
  by progress: each continuation records a mark (applied turns, applied ops, and every item's task
  and status). A second reply with the same mark settles the run through verification. `blocked`
  is not open. `maxSteps` (widened to fit the plan, as a drafted plan widens it), wall time and
  cost still bound everything. Nothing reads the model's prose or the request.
- **What the editor sees:** the existing `plan` event, one checklist node per run. `done` maps to
  `completed`, `in_progress` to `running`, `pending` to `pending`, and `blocked` to `failed`
  with the note. Once the model owns the plan, the positional drafted ledger (`planFirst`) never
  draws over it. When the run ends, open items settle as failed ("Not done — the run ended
  first"), a warning names them, and the completion report lists each unfinished item under
  **Not done** (`— not done` or `— blocked: <note>`).
- **Across a run boundary (AL5, #149):** the plan used to live in conductor state only, so a
  resumed run and a follow-up on the same request re-planned from the brief and could redo
  finished work. Now:
  - **Resume.** A cancelled run's `checkpoint` event carries `modelPlan` (the items). The host
    hands it back as `AgentOptions.resume.modelPlan`, and the resumed run starts with it.
  - **Continuation.** Every plan event the model's list produces carries
    `modelPlan: { objectiveKey, items }`. `objectiveKey` is a fingerprint of the request the run
    works toward (`modelPlanObjectiveKey`), so a "continue" run files its plan under the brief it
    continues. Hosts pass `AgentOptions.priorPlans = modelPlanRecordsFromEvents(conversation.events)`.
    `streamAuto` reads them only when the router's grounded `continues` names an earlier
    request. It seeds `RequestReading.continuedPlan` with that request's newest plan, items as
    they were: open stays open, done and blocked stay as they are.
  - **New request.** A new request never inherits a plan.
  - **Validation.** A carried plan is drawn as the run's first `plan` event, briefed as YOUR
    PLAN, and held by the same continuation rule. `parseModelPlan` / `parseModelPlanRecords`
    validate whatever comes back off disk or over IPC (desktop `parseAgentOptions`). Anything
    malformed is dropped, and the run plans again.
- **What the model sees:** a `YOUR PLAN` section in the run briefing, with every item, and
  `DO THIS NOW` pointing at the next open item.

### Looking at many sources: `get_frame { sources }`

`get_frame` has three exclusive modes: `timeSeconds` (a moment of the edit), `assetId`
(+ `sourceSeconds`, one source file as shot), and `sources` (several source files on one sheet).

```ts
get_frame({
  sources: [{ assetId: 'asset_passenger' }, { assetId: 'asset_car', sourceSeconds: 2 }],
});
// → one image: a numbered grid, each tile the whole uncropped source frame, labelled
//   "1  passenger.mp4  9.5s". data.tiles = [{ tile: 1, assetId, name, sourceSeconds,
//   durationSeconds, error? }, …] in the same order.
```

- **Schema:** 1-12 entries; `assetId` non-empty; `sourceSeconds` ≥ 0 and optional (omitted =
  the middle of the source; a still shows its one frame). Strict: unknown keys are refused. It
  cannot be combined with `timeSeconds`, `assetId` or `sourceSeconds`. `maxDimension` bounds the
  **whole sheet** (default 1024 for a sheet, 512 for one frame).
- **Why:** run `d8d2e445` saw 3 of 20 sources, one picture per call. It is one call and one
  image for the whole bin, so the model can compare shots and see where each subject sits
  before it cuts or crops. It then uses single-source `get_frame` for a close look.
- **Errors:** an unknown or audio-only asset refuses the whole sheet and names every bad id. A
  tile that fails to render is drawn as a labelled error, the rest still answer, and the result
  summary names the failed tile.
- **Engine:** `framepilot_engine/render/source_sheet.py`. Each tile is
  `frame_grab.source_view_project` through the export's compiler, composited uncached four at a
  time. The grid is fixed arithmetic (`ceil(sqrt(n))` columns), so the same sources give the
  same pixels. The Python registry and its strict contract override mirror the schema. The MCP
  server does not forward `sources` yet.

### A punch-in on a panned clip: `punch_in` over `reframe_pan`

`reframe_pan` fills the frame with `scale` keyframes (the cover zoom, about 3.16 for a 16:9
source in a 9:16 frame) plus `x`/`y` offsets. `punch_in` used to write absolute `scale` values
(1.0 → 1.2), which replaced that zoom and letterboxed the shot (issue #139). Run 4 of the travel
brief removed 22 pans by hand before it could punch in.

- **Rule:** if the clip already has `scale` keyframes, the punch **multiplies** them:
  `result(t) = existing(t) × punch(t)`. The punch curve holds `fromScale` before its window and
  `toScale` after it, like any keyframe curve. On a clip with no scale animation this is the
  same as the plain punch, which still writes a single `add_keyframes`. `x`/`y` are not
  touched, so the pan keeps moving while the punch zooms in.
- **Ops:** `remove_keyframes { property: "scale" }`, then `add_keyframes` with the composed
  curve. Keyframes outside the window are rescaled by the held factor and keep their easing and
  handles. Inside the window, the result is sampled at both window edges and at every existing
  keyframe between them. The result is exact when the existing zoom is constant across the
  window, which is always true for `reframe_pan`. Both ops invert to a snapshot of the clip's
  track, so undo restores the old keyframes exactly.
- **Errors:** a factor below 1 that would take a clip that fills the frame below its cover
  zoom is refused with "keep fromScale and toScale at 1 or above". A zoom-out that stays at or
  above the cover is allowed.
- **Mirror:** `engine/python/framepilot_engine/ai_tools/handlers.py` `punch_in` builds the same
  operations.

### How far a zoom magnifies the source: `magnificationNote`

A zoom's `scale` is relative to the fit, not to the source's pixels. A `reframe_pan` of a
1920×1080 source into a 1080×1920 frame already draws each source pixel 1.78 output pixels
wide, and a 1.2 punch on top makes it 2.13. Harness run 8's road shot at 17 s was visibly soft
for that reason, and nothing in the result said so.

- **Rule:** after `punch_in` or `reframe_pan` lands, the result states the clip's peak
  magnification: output pixels per source pixel, on the more magnified axis. It uses
  `framePlanAt` geometry (fit, crop, keyframed scale and stretch) at the project resolution,
  against the asset's measured display size. The peak is sampled at the clip's edges and at
  every size keyframe. Between keyframes a named easing stays inside their values, so the
  peak is at one of them.
- **Above `SOFT_UPSCALE_THRESHOLD` (1)** the note says plainly that the picture is upscaled
  and will look soft. For a punch it also says what helps. If the clip was below 1 before the
  punch, a smaller `toScale` keeps it sharp. If the clip was already above 1 (a pan of a
  1080p source), no punch is sharp, and a smaller one softens it less. Nothing is refused: a
  soft push-in can be a deliberate choice.
- **Silent** when the source was never measured, because there is no honest number to give.
- **Where:** `packages/ai-sdk/src/domain-tools/magnification-note.ts`, appended to the result
  note in `orchestrator.ts` beside `verificationNote`. The Python registry returns operations
  only and has no result notes, so it has nothing to mirror.

### A reframe that follows a tracked subject: `reframe_to_subject`

`reframe_to_subject { clipId, maskId }` (masking domain, issue #137) moves a wide clip's window
in a narrower frame so that it follows a subject. The subject is marked by a tracked mask
(`create_mask` with `track: true`, or `track_mask`). The tool **bakes** the track into keyframes;
it does not link to it. A live link from a clip transform to a track needs a schema field
(MO-14), and nobody has approved one. So this adds no schema change. The result is ordinary
`x`/`y`/`scale` keyframes that validate, undo in one step, and render like any keyframed clip.

- **Host-measured**, like `track_mask`. The track is a digest-pinned file
  (`<project>/.framepilot-derived/tracks/<key>/track.json`) that only the desktop host reads.
  The host (`masking-executor.ts` → `subjectSamplesFromTrack`) reads it back through
  `readTrackArtifact`, which checks the digest. It then returns the subject's centre (the mask's
  geometry moved by the track, `T(t) · G(t)`) on a six-per-second grid of clip frames. Each
  sample is the mean of the confidently tracked frames around it, stamped at their mean frame.
  Frames outside the tracked range, or below `DEFAULT_TRACK_POLICY.minimumConfidence`, count
  as unseen (confidence 0).
- **Orchestrator** (`reframeToSubjectEdit`). It re-checks the measurement: same mask, the same
  pinned track (a re-track since then is refused), and no sample past the clip's length (a trim
  since then is refused). It then runs editor-core `planAutomaticReframe`, which computes the
  cover zoom and the clamped pan from the render compiler's placement formula, damped to
  24 px per frame. Keyframes are linear. A property that never changes (the cover `scale`, and
  `y` for a 16:9 → 9:16 reframe) gets one keyframe.
- **Ops:** the same tail as `reframe_pan`. `set_clip_crop { crop: null }` if the clip had a
  crop, `remove_keyframes` for the x/y/scale it owns, then `add_keyframes`. A second run after
  re-tracking replaces the first.
- **Result:** the number of pan keyframes, the span followed, the cover zoom, and the range the
  window centre travels as a percentage of the source. It says when the frame holds outside the
  span the track saw, and when damping slowed some steps. Data is `kind: "subject_reframe"`.
- **Refusals (preflight, before the host reads anything):** a mask that is not tracked (the
  remedy is `track_mask`), a cut-out (use a tracked shape mask), and a clip that already has the
  frame's shape (use `punch_in`). An unknown clip or mask names `get_clips` / `get_masks`. A
  track that is missing or changed on disk refuses with `track_unreadable` (track again).
- **Masking kill switch:** the tool is in `MASKING_TOOLS`, so `FRAMEPILOT_AI_MASKING=off` (the
  packaged default) withholds it. In the browser build it is unroutable, like every other
  host-measured masking tool. The Python registry excludes `hostUiOnly` tools.

---

## When a patch is rejected

A rejected call reaches the model as a single sentence, so that sentence has to say WHICH
operation was refused:

```
op 49 of 126 (add_caption_layer, 18.067s–18.067s): add_caption_layer.end must be greater
than start: both are 18.0667s, so it would occupy no time.
```

Batch tools propose one operation per cue or per entry, so an unlocated reason is the same
sentence for every one of them. A captured run reissued the same `caption_the_edit` call
four times — about ten of its eighteen model calls — because 63 near-identical cues all
produced the identical rejection and nothing said which cue was bad.

The position is 1-based and phrased "of N". The operation type and time range are appended
only when the reason does not already name them. The location comes from
`ValidationIssue.operationIndex`, which both gates populate: the semantic operation
contract (replayed one operation at a time in `assembleEdit`) and the structural patch
validator.

---

## When a placement is refused

Two refusals guard `add_clip` / `add_clips` / `move_clip` beyond schema validation, both
from run `137d8fd0` (a 60s highlight that finished with 37 of its 48 picture clips never
visible):

- **`hides_a_cutaway`.** ADR 0169 lifts a legal full-frame placement onto a layer in FRONT
  of the picture it covers. That is right when what it covers is the base A-roll — a
  cutaway covers the A-roll by definition. It is wrong when the thing underneath is itself
  a cutaway whose whole span the new placement would swallow: nothing of it would ever be
  seen. The refusal names the buried clip, its lane and its span, and the three moves
  (`remove_clip`, place it elsewhere, `trim_clip`). A clip that was ALREADY fully hidden
  before the call does not trigger it — an inherited defect is an advisory, not a reason to
  refuse the next edit. The cause is arrangement-DEPENDENT, so a landed patch clears the
  run's memory of it.
- **The same frames at the same moment.** Two placements of one asset are the same
  placement when their PIN (`sourceStart - start`) matches within a frame and their spans
  overlap by more than a frame — the span itself need not match. A different pin is a
  different moment of the file and is allowed. Audio goes through the same path, where the
  defect is audible rather than invisible: the same bed on two lanes plays over itself.

The Critic's `hidden_picture` check reports the same condition on a finished project. It
`warn`s and never `fail`s, because buried picture can be inherited from the project the run
was handed.

---

## Tool authoring requirements

When adding or changing a tool (see also the `ai-safety` skill,
`.agents/skills/ai-safety/`):

- **Schema** — a strict input schema; reject invalid input, never silently coerce.
- **Validation** — a write tool's emitted operation must pass the patch validator
  ([patch-format.md](patch-format.md)).
- **Reversibility** — any operation a write tool emits must have an `invert` (undo).
- **Tests** — unit tests for the schema and behavior, covering the real branches and
  error paths (PRD §16.1). Use the `mock` provider for deterministic end-to-end tests
  ([../guides/ai-providers.md](../guides/ai-providers.md)).
- **Docs + plan** — update this table, [patch-format.md](patch-format.md), and
  [`../../plan/PLAN.md`](../../plan/PLAN.md).

For the full step-by-step of adding an operation and exposing it as a tool, see
[../guides/adding-a-timeline-operation.md](../guides/adding-a-timeline-operation.md).
