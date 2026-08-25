# Timeline Schema (Data Model)

The canonical project document is `project.fp.json` (PRD §10.3, §11). It is the single
source of truth for a project and is what both the editor (`packages/editor-core`,
`packages/timeline-schema`) and the Python render engine (`engine/python`) read and
write. The schema is mirrored in **Zod (TypeScript)** and **Pydantic (Python)**, kept in
sync via a shared JSON Schema, so the same document round-trips identically through both.

See [../architecture/timeline-and-patch-engine.md](../architecture/timeline-and-patch-engine.md)
for how the model is used, and [patch-format.md](patch-format.md) for how it is mutated.

---

## Project (PRD §11.1)

```json
{
  "id": "project_001",
  "name": "Demo Video",
  "version": 1,
  "fps": 30,
  "resolution": { "width": 1920, "height": 1080 },
  "assets": [],
  "timeline": {},
  "transcript": [],
  "capabilityPacks": [],
  "aiMemory": {},
  "history": []
}
```

| Field             | Type                | Notes                                                                                     |
| ----------------- | ------------------- | ----------------------------------------------------------------------------------------- |
| `id`              | string              | Stable project identifier.                                                                |
| `name`            | string              | Display name.                                                                             |
| `version`         | number              | User-facing project revision. File migration uses the top-level `schemaVersion` envelope. |
| `fps`             | number              | Project frame rate (timeline time base).                                                  |
| `resolution`      | `{width,height}`    | Canvas resolution.                                                                        |
| `assets`          | Asset[]             | Imported media references (originals live in `assets/`, never modified).                  |
| `timeline`        | Timeline            | Tracks + clips (below).                                                                   |
| `transcript`      | TranscriptWord[]    | Word-level timestamps from transcription.                                                 |
| `capabilityPacks` | CapabilityPackPin[] | Optional immutable logical on-demand pack releases used by this project (schema v19).     |
| `aiMemory`        | object              | Per-project AI memory (style, pacing, accepted/rejected edits — see ai-engine.md).        |
| `history`         | Patch[]             | Applied patches; backs undo/redo and crash recovery.                                      |

### Capability Pack pins (schema v19)

`capabilityPacks` records logical release identities, not local installations. Each pin contains
`id`, semantic `version`, canonical signed-release `releaseDigest`, the consumed `capabilities`, and
whether absence affects `render`, `edit`, or only `analysis`. It never stores a platform artifact,
filesystem path, download URL, or credential, so projects remain portable between macOS and
Windows. See [capability-packs.md](capability-packs.md) and ADR 0114.

### Asset provenance (schema v20)

An `Asset` fetched from a third-party media provider carries an optional `source` recording
where it came from and what crediting it obliges. Assets the user imported themselves have no
`source` — absent means "nothing to credit", never "unknown".

```json
{
  "id": "asset_bed",
  "path": "media/calm_lofi_bed.mp3",
  "kind": "audio",
  "source": {
    "provider": "openverse",
    "remoteId": "ov-12345",
    "license": "cc-by",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "attributionRequired": true,
    "attribution": "\"Calm Lofi Bed\" by Ada Lovelace is licensed under CC BY 4.0.",
    "creator": "Ada Lovelace",
    "creatorUrl": "https://example.test/ada",
    "sourceUrl": "https://openverse.org/audio/ov-12345",
    "fetchedAt": "2026-08-23T12:00:00.000Z"
  }
}
```

| Field                 | Type    | Notes                                                                 |
| --------------------- | ------- | --------------------------------------------------------------------- |
| `provider`            | string  | Provider roster name, e.g. `openverse`.                               |
| `remoteId`            | string  | Provider-local id. Download dedupe, and finding the item again later. |
| `license`             | string  | Licence identifier verbatim from the provider.                        |
| `licenseUrl`          | string? | Canonical licence text, so the user can read the actual terms.        |
| `attributionRequired` | boolean | **Required.** Stored, not derived — see below.                        |
| `attribution`         | string? | The ready-to-paste credit line, carried verbatim from the provider.   |
| `creator`             | string? | Creator name.                                                         |
| `creatorUrl`          | string? | Creator page on the provider.                                         |
| `sourceUrl`           | string? | Landing page for the item.                                            |
| `fetchedAt`           | string  | ISO-8601. What the terms were understood to be, and when.             |

`attributionRequired` is **stored rather than derived** from `license`: licence vocabularies
differ per provider and change over time, and a project written today must still know what it
agreed to then. It is required rather than defaulted, because defaulting it to `false` would
silently downgrade a credit obligation to none.

The engine models this field (`AssetSource` in `timeline/models.py`) but reads nothing from it
— provenance cannot affect a render. It exists on the Python side so an engine round-trip does
not strip the one durable record of an obligation.

The editor reads it back in the export dialog's **Credits** section. See ADR 0138.

---

## Timeline & Track (PRD §11.2)

A timeline is a set of typed tracks; each track holds clips.

```json
{
  "tracks": [
    { "id": "video_1", "type": "video", "clips": [] },
    { "id": "audio_1", "type": "audio", "clips": [] },
    { "id": "caption_1", "type": "caption", "clips": [] },
    { "id": "overlay_1", "type": "overlay", "clips": [] }
  ]
}
```

Track `type` is one of: `video` | `audio` | `caption` | `overlay`. Track order encodes
compositing layer order (important for text-behind-object; validated by the patch
validator).

---

## Clip (PRD §11.3)

```json
{
  "id": "clip_001",
  "assetId": "asset_001",
  "trackId": "video_1",
  "start": 0,
  "end": 12.5,
  "sourceStart": 4.0,
  "sourceEnd": 16.5,
  "effects": [],
  "keyframes": []
}
```

| Field                       | Meaning                                                  |
| --------------------------- | -------------------------------------------------------- |
| `start` / `end`             | Position on the **timeline** (seconds).                  |
| `sourceStart` / `sourceEnd` | The in/out points within the **source media** (seconds). |
| `effects`                   | Effect[] applied to this clip.                           |
| `keyframes`                 | Keyframe[] animating clip-level properties.              |
| `captionStyle`              | Optional persisted caption style (schema v5, below).     |
| `speed`                     | Optional constant playback rate (schema v6, below).      |

**Non-destructive trimming:** trimming changes `sourceStart`/`sourceEnd` (and/or
`start`/`end`), never the underlying file. The original is always fully recoverable.

---

## Caption style (schema v5)

`Clip.captionStyle` is an optional, structured object — meaningful on caption-kind
clips (created by `add_caption_layer`, `assetId === '__caption__'`), but modeled as
a plain clip field rather than nested inside the caption `Effect`'s free-form
`params`. Set/cleared with the `set_caption_style` operation (`packages/editor-core`).

```json
{
  "fontFamily": "Inter",
  "fontScale": 1.25,
  "textColor": "#ffffff",
  "outlineColor": "#000000",
  "outlineWidth": 2,
  "position": "bottom",
  "highlight": { "enabled": true, "color": "#ffe600", "animation": "karaoke-fill" },
  "presetId": "bold-pop"
}
```

| Field                 | Meaning                                                                              |
| --------------------- | ------------------------------------------------------------------------------------ |
| `fontFamily`          | CSS-style font family name.                                                          |
| `fontScale`           | Font size multiplier relative to the caption track's base size (`> 0`).              |
| `textColor`           | Caption text color (any CSS color string).                                           |
| `outlineColor`        | Text outline/stroke color.                                                           |
| `outlineWidth`        | Outline/stroke width (`>= 0`).                                                       |
| `position`            | Vertical anchor: `top` \| `middle` \| `bottom`.                                      |
| `highlight.enabled`   | Whether the active spoken word is highlighted.                                       |
| `highlight.color`     | Highlight color.                                                                     |
| `highlight.animation` | `none` \| `pop` \| `karaoke-fill`.                                                   |
| `presetId`            | Id of a built-in style preset (e.g. a `CAPTION_TEMPLATES` entry) it was seeded from. |

All fields are optional/defaulted so a v4 caption clip (no `captionStyle` at all)
migrates cleanly to an unstyled v5 clip. See ADR 0045 for why this is structured
data on `Clip` rather than a free-form effect param bag.

---

## Speed / time-remap (schema v6)

`Clip.speed` is an optional constant playback rate (`> 0`). Absent (or `1`) is
today's implicit 1x behavior — timeline duration equals source duration. A
`speed != 1` **decouples** them under this invariant, enforced by the patch
validator (`speed_duration_mismatch`):

```
end - start === (sourceEnd - sourceStart) / speed
```

`sourceStart`/`sourceEnd` keep meaning "the asset range this clip consumes";
`end` is derived from the source range and `speed`. E.g. `speed: 2` (2x)
consumes the same footage in half the timeline time; `speed: 0.5` (slow-mo)
stretches it to twice the timeline time.

Set/reset with the `set_clip_speed` operation (`packages/editor-core`):

```ts
{ type: 'set_clip_speed', clipId: 'clip_001', speed: 2 } // or `null` to reset to 1x
```

`1x` is canonicalized as an **absent** `speed` field (not stored as `speed: 1`).
This is a **constant rate**, not a speed curve (multiple rates over one clip) —
see ADR 0046 for why a curve was deferred to a later, additive v6.x step
(reusing `Clip.keyframes` once an integrator exists) rather than shipped now.

---

## Effect (PRD §11.4)

```json
{
  "id": "effect_001",
  "type": "transform",
  "params": { "scale": 1.1, "x": 0, "y": 0, "rotation": 0, "opacity": 1 },
  "keyframes": []
}
```

`type` examples: `transform`, `crop`, `blur`, `color_grade`, `mask`. `params` are
type-specific; `keyframes` animate those params over time.

---

## Keyframe

A keyframe is a `(time, value, easing)` triple attached to a clip or an effect param.

```json
{
  "id": "kf_001",
  "time": 1.5,
  "param": "scale",
  "value": 1.25,
  "easing": "ease-in-out"
}
```

Easing types (PRD §6.3): `linear`, `ease-in`, `ease-out`, `ease-in-out`, `hold`,
`bezier` (bezier carries control-point params).

---

## Schema versioning & migration

- `Project.version` is the schema version. It is **bumped only with a migration**.
- **No breaking schema change without a migration** (CI/agent rule; see
  [../runbooks/ci-cd.md](../runbooks/ci-cd.md) and `.codex/AGENTS.md`).
- On load, a project below the current version is run through the migration chain (v→v+1
  steps) before use; loads are validated against the schema.
- Round-trip and golden-schema fixtures guard against accidental schema drift (Phase 1).
- Because the schema is consumed by both TS and Python, migrations must be applied
  consistently on both sides (shared JSON Schema is the contract).
