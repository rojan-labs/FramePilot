---
description: Export the project at a chosen resolution / frame rate / quality / codec / format through the deterministic render engine, with validation (PRD §9)
---

Export the current project. Export is **quality-driven, never platform-driven**: the frame
follows the project's own aspect ratio and the editor chooses resolution, frame rate,
quality, codec and container (the way CapCut and every NLE present it).

1. Read `plan/PLAN.md`. Confirm the timeline is valid. Take the settings from the request
   (defaults: 1080p · project fps · Recommended · H.264 · MP4); the engine caps resolution
   at what the sources hold and reports `effective_resolution` / `capped_to_source` on the
   job — never upscale silently.
2. Use the `export_video` tool → the **Python render engine** (MoviePy + FFmpeg). The UI
   preview is NOT the export path. The job must have a timeout and be cancellable.
3. Render job lifecycle: queued → preparing_assets → rendering_frames → encoding →
   validating_output → completed/failed.
4. **Validate the render** (PRD §9.4): file exists & non-zero, duration matches expected,
   video stream present, audio present if expected, black-frame & audio-clipping checks.
5. Write the output to the project `exports/` folder only; never overwrite originals.
6. Report the validated output metadata (frame, fps, codec, container, size) to the user.

Reference `.agents/skills/media-pipeline/SKILL.md` and
`engine/python/framepilot_engine/render/export_settings.py`. Update `plan/PLAN.md`,
`docs/`, and `CHANGELOG.md`.
