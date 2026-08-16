# FramePilot example projects

Two ready-to-open `*.fp.json` sample projects. They are **schema-valid**: each
mirrors the on-disk `project.fp.json` envelope (`schemaVersion` + the `Project`
shape) defined by `packages/timeline-schema` and exercised by the canonical
fixture (`packages/timeline-schema/src/__fixtures__/demo.project.fp.json`).

> Why ship samples? A new user (or a new contributor) can open something real in
> seconds instead of building a project from scratch, and the editor's
> open/import path gets a known-good input to validate against.

---

## The samples

| File                                                         | Resolution       | Demonstrates                                                                                                                           |
| ------------------------------------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [`hello-world.fp.json`](./hello-world.fp.json)               | 1920×1080        | The smallest valid project: one video track, one clip, the empty audio/caption/overlay lanes.                                          |
| [`product-demo-short.fp.json`](./product-demo-short.fp.json) | 1080×1920 (9:16) | A richer multi-track edit: a graded + punch-in video clip, a mixed music bed, a caption, a title overlay, and a word-level transcript. |

### `hello-world.fp.json`

The minimal "from zero to a timeline" project. A single 8-second video clip on
`video_1`, trimmed from the first 8 seconds of its source. The `audio`,
`caption`, and `overlay` tracks exist but are empty — the same four-track layout
the editor creates for a new project. Use it to confirm a clean open and a first
export.

### `product-demo-short.fp.json`

A vertical (9:16) SaaS-demo short — FramePilot's first niche — that touches most
of the timeline model:

- **`video_1`** — two clips. The hook clip carries a `color_grade` **effect**
  (warm grade) and two `scale` **keyframes** for a slow punch-in (`ease-in-out`,
  `1.0 → 1.15`). A second walkthrough clip follows it.
- **`audio_1`** — a background-music clip with an `adjust_audio` effect (gain
  `-12 dB`, fade in/out) so the bed sits under the voice.
- **`caption_1`** — a caption clip spanning the hook. Caption text is
  reconstructed from `transcript` by time overlap (the same rule the editor
  preview and the render engine use), so the project also includes a word-level
  `transcript`.
- **`overlay_1`** — a `text_overlay` title that shows for the first 4 seconds.

> The `params` on each effect are **free-form** (`Effect.params` is
> `Record<string, unknown>` in the schema), so these values illustrate intent;
> the engine reads the keys it understands per effect type. The structural
> envelope — `id`/`type`/`params`/`keyframes` on every effect, `id`/`time`/
> `property`/`value`/`easing` on every keyframe — is exactly the schema shape.

---

## How to open one

### In the editor (web or desktop)

1. Start the editor — `pnpm --filter @framepilot/web-editor dev` (browser) or
   `pnpm desktop:dev` (Electron). See the
   [onboarding guide](../docs/guides/onboarding.md).
2. Use **File → Open** and pick a file from this folder.

> Media paths in these samples (e.g. `/media/intro.mp4`) are **placeholders** —
> the timeline opens and validates without them, but a _render/export_ needs the
> referenced media to exist. Point the asset paths at real files (or re-import
> media) before exporting.

### From the Python engine CLI

The deterministic engine can load and inspect any of these directly:

```bash
# from engine/python (use python 3.13 + uv — see the onboarding guide)
uv run framepilot render ../../examples/hello-world.fp.json
```

(Rendering requires the referenced media to exist on disk.)

---

## Keeping these valid

These files are part of the documented surface. If the project schema changes
(`packages/timeline-schema`), update these samples in the **same change** and add
a migration — a schema bump that breaks these would also break real user
projects. See [`docs/api/timeline-schema.md`](../docs/api/timeline-schema.md).
