---
description: Export the project for Reels (9:16) through the deterministic render engine with validation (PRD §9)
---

Export the current project for Instagram Reels (9:16) — or another requested preset.

1. Read `plan/PLAN.md`. Confirm the timeline is valid and the export preset (default 9:16
   Reels; also 1:1, 16:9 LinkedIn, custom).
2. Use the `export_video` tool → the **Python render engine** (MoviePy + FFmpeg). The UI
   preview is NOT the export path. The job must have a timeout and be cancellable.
3. Render job lifecycle: queued → preparing_assets → rendering_frames → encoding →
   validating_output → completed/failed.
4. **Validate the render** (PRD §9.4): file exists & non-zero, duration matches expected,
   video stream present, audio present if expected, black-frame & audio-clipping checks.
5. Write the output to the project `renders/` folder only; never overwrite originals.
6. Report the validated output metadata to the user.

Reference `.agents/skills/media-pipeline/SKILL.md`. Update `plan/PLAN.md`, `docs/`, and `CHANGELOG.md`.
