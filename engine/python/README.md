# FramePilot Render Engine (`framepilot-engine`)

The deterministic Python engine behind FramePilot — a "Cursor for video editing"
desktop app. This package is **render + media + timeline infrastructure**; the AI
layer sits on top of it and may only edit through validated patches (PRD §8.3).

See **PRD §9 (Render Engine)** and **`plan/PLAN.md` Phase 2** for the contract
this package implements.

## What it does

- **Deterministic render** — compiles a `project.fp.json` timeline into a
  MoviePy + FFmpeg composition for `render_preview` (fast/low-res) and final
  `export_video` (PRD §9.1–§9.3).
- **Media inspection** — ffprobe-style `inspect-media`: duration, fps,
  resolution, streams (PRD §9.1, plan 2.1).
- **Proxy / waveform / frame extraction** — preview media, audio waveforms, and
  thumbnail frames for the desktop UI.
- **Object tracking & masking** — face / bounding-box tracking and
  rectangle/ellipse/polygon + subject masks (PRD §6.4–§6.6, plan Phase 5).
- **Render validation** — every render is automatically checked: file exists,
  non-zero, duration tolerance, streams present, black frames, audio clipping
  (PRD §9.4, plan 2.3).
- **FastAPI sidecar** — a local HTTP service the desktop shell talks to over IPC
  (PRD §10.2, plan 2.4).
- **CLI** — `framepilot render | validate-render | inspect-media | serve`.

> Status: **scaffold only.** Modules are importable, typed stubs that raise
> `NotImplementedError` with a pointer to the relevant `plan/PLAN.md` phase.

## Quick start

```bash
# From the repo root (uv workspace) or this directory:
uv sync --extra dev        # install runtime + dev dependencies
uv run pytest              # run the test suite (green: parser/config/safety/models)
uv run framepilot --help   # inspect the CLI
```

## Layout

```
framepilot_engine/
  cli.py            # argparse CLI entrypoint (`framepilot`)
  config.py         # pydantic Settings read from FRAMEPILOT_* env vars
  service.py        # FastAPI app factory + uvicorn serve()
  safety.py         # path-sandbox primitives (PRD §18.1/§18.2)
  timeline/         # Project/Timeline/Track/Clip/Effect models + operations
  render/           # render job lifecycle + export presets
  effects/          # keyframe easing + interpolation
  audio/            # mixing (normalize/duck/fade/noise reduction)
  tracking/         # object/face tracking
  masking/          # shape + subject masks, text-behind-object
  validation/       # render + patch validation
  ai_tools/         # AI tool registry (schema-validated, patch-returning)
```
