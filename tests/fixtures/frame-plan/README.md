# Frame-plan parity vectors (PX0.1 / PX1.3)

The feature-matrix timelines from
[`09-PREVIEW-EXPORT-PARITY.md`](../../../plan/background-removal-ai/09-PREVIEW-EXPORT-PARITY.md),
one file per matrix area. Each `cases[]` entry is:

| field          | meaning                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `row`    | Stable case id and the matrix row it covers (the PX0 inventory keys on `row`).                                                                    |
| `project`      | A project **without** its `schemaVersion` envelope. Loaders wrap it with the imported `SCHEMA_VERSION` constant; never hard-code the number here. |
| `probe.fps`    | Probed source frame rate per video asset. The schema does not carry it, and the engine's reverse mapping and frame index need it.                 |
| `burnCaptions` | Whether the export burns captions in for this case.                                                                                               |
| `samples`      | Sequence times (seconds) to evaluate the frame plan at.                                                                                           |
| `expected`     | Written by the engine (`pnpm frame-plan:vectors`), one plan per sample. Never edit by hand.                                                       |

Assets carry probed `media.width/height` and a `proxyPath` (except the deliberately unproxied
original), so the preview-renderer selectors see what they see on the desktop. No media files
are needed: the plan is derived from the timeline alone, and pixels are PX4's job.
