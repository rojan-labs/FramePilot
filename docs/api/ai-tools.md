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

| Tool                      | Purpose                                                        | Kind             | Available? |
| ------------------------- | -------------------------------------------------------------- | ---------------- | ---------- |
| `get_project_state`       | Current editable state (no undo history; media bin as a tally) | read             | yes        |
| `get_timeline`            | Current tracks/clips                                           | read             | yes        |
| `get_transcript`          | Word-level transcript (optional `start`/`end` window)          | read             | yes        |
| `get_timeline_summary`    | Compact per-track overview (counts + spans, no clip bodies)    | read             | yes        |
| `get_clips`               | Windowed, paginated compact clip listing                       | read             | yes        |
| `get_clip`                | One clip in full detail + its `trackId`                        | read             | yes        |
| `get_selected_range`      | The user's current selection                                   | read             | yes        |
| `list_assets`             | Media-bin assets + folders (kind/folder filterable)            | read             | yes        |
| `discover_caption_styles` | Bundled caption fonts, templates and composition fields        | read             | yes        |
| `trim_clip`               | Trim a clip (non-destructive)                                  | write            | yes        |
| `split_clip`              | Split a clip at a time                                         | write            | yes        |
| `delete_range`            | Delete a time range on a track                                 | write            | yes        |
| `ripple_delete`           | Delete a range and close the gap                               | write            | yes        |
| `delete_clip`             | Delete one clip by id (optional ripple)                        | write            | yes        |
| `delete_clips`            | Delete up to 50 clips by id in one call                        | write            | yes        |
| `move_clip`               | Move a clip to a new track/start                               | write            | yes        |
| `add_track`               | Create a new empty track/layer (`add_layer` op)                | write            | yes        |
| `remove_track`            | Remove a track and its clips (`remove_layer` op, wipe-guarded) | write            | yes        |
| `move_track`              | Reorder a track's z-slot (`move_layer` op)                     | write            | yes        |
| `add_clip`                | Add a clip from an existing asset                              | write            | yes        |
| `add_clips`               | Place a whole sequence on one track in a single call           | write            | yes        |
| `add_text_layer`          | Add a text overlay (`add_text_overlay` op)                     | write            | yes        |
| `add_caption_layer`       | Add one short mapped caption cue (never a full-song block)     | write            | yes        |
| `auto_emphasize_captions` | Ground AI-selected anchors and compose a caption track         | write            | yes        |
| `set_track_caption_style` | Set/clear the complete shared caption composition              | write            | yes        |
| `set_caption_style`       | Set/clear one cue's composition override                       | write            | yes        |
| `add_keyframes`           | Add animation keyframes (e.g. zoom)                            | write            | yes        |
| `apply_color_grade`       | Apply a color grade                                            | write            | yes        |
| `adjust_audio`            | Volume/gain (dB)                                               | write            | yes        |
| `add_transition`          | Transition onto a clip                                         | write            | yes        |
| `add_mask`                | Add a mask shape (rect/ellipse/polygon)                        | write            | yes        |
| `track_object`            | Attach a face/bbox tracker to a clip                           | write            | yes        |
| `transcribe`              | Run host-owned ASR and propose a transcript patch              | analysis + write | yes        |
| `render_preview`          | Produce a low-res preview render                               | action           | yes        |
| `export_video`            | Final export (after approval)                                  | action           | yes        |
| `analyze_silence`         | Detect silent gaps (ffmpeg silencedetect)                      | analysis         | yes        |
| `detect_scenes`           | Detect scene cuts (ffmpeg scene score)                         | analysis         | yes        |
| `detect_subjects`         | Detect people/objects in frames (Subject Intelligence pack)    | analysis         | yes        |
| `generate_mask`           | Produce a subject mask                                         | write            | **no\***   |

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

\* `generate_mask` is registered for discoverability but stays `available: false`, and for a
reason that will not be resolved by shipping a model: a segmentation produces a **bitmap**,
while a timeline mask steers by **rectangle bounds**. The measured path that does exist is
`track_subject_automatically` with `subject="silhouette"`, which segments inside a drawn mask
and animates that mask to follow the silhouette's bounding box. The orchestrator refuses to
invoke an unavailable tool rather than fabricate a result — no AI feature pretends to use an
engine that has not been built (build-order invariant,
[ADR 0004](../adr/0004-timeline-patch-engine-before-ai.md)).

`detect_faces` was the other entry here. It is **gone**, not renamed to `available: false`:
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
