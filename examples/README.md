# FramePilot example projects

The ready-to-open sample project is the canonical schema fixture
`packages/timeline-schema/src/__fixtures__/demo.project.fp.json`. It is **schema-valid** and
mirrors the on-disk `project.fp.json` envelope (`schemaVersion` + the `Project` shape)
defined by `packages/timeline-schema`.

> Why ship a sample? A new user (or a new contributor) can open something real in seconds
> instead of building a project from scratch, and the editor's open/import path gets a
> known-good input to validate against.

---

## The sample

| File                                                                                              | Resolution | Demonstrates                                    |
| ------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------- |
| [`demo.project.fp.json`](../packages/timeline-schema/src/__fixtures__/demo.project.fp.json)    | 1920×1080  | The smallest valid project: one video track, one clip, the empty audio/caption/overlay lanes. |

The fixture is itself the canonical reference used by the schema test suite, so it never
drifts from the current `Project` shape: a schema change that breaks it fails CI in the same
change.

---

## How to open one

### In the editor (web or desktop)

1. Start the editor — `pnpm --filter @framepilot/web-editor dev` (browser) or
   `pnpm desktop:dev` (Electron). See the [onboarding guide](../docs/guides/onboarding.md).
2. Use **File → Open** and pick the fixture file.

> Media paths in the fixture (e.g. `/media/intro.mp4`) are **placeholders** — the timeline
> opens and validates without them, but a _render/export_ needs the referenced media to
> exist. Point the asset paths at real files (or re-import media) before exporting.

### From the Python engine CLI

The deterministic engine can load and inspect the fixture directly:

```bash
# from engine/python (use python 3.13 + uv — see the onboarding guide)
uv run framepilot render ../../packages/timeline-schema/src/__fixtures__/demo.project.fp.json
```

(Rendering requires the referenced media to exist on disk.)

---

## Keeping this valid

The fixture is part of the documented surface. If the project schema changes
(`packages/timeline-schema`), update the fixture in the **same change** and add a migration —
a schema bump that breaks it would also break real user projects. See
[`docs/api/timeline-schema.md`](../docs/api/timeline-schema.md).
