# Render Engine

The render engine turns an _applied_ timeline into actual video files, **deterministically
and verifiably**. It is the Python layer of FramePilot: **MoviePy + FFmpeg**, managed by
`uv`, exposed as a **FastAPI sidecar** and a **`framepilot` CLI**.

Code lives in `engine/python`. See
[ADR 0003](../adr/0003-python-render-engine-moviepy-ffmpeg.md) for the decision and
[../api/python-engine-api.md](../api/python-engine-api.md) for the API/CLI surface.

---

## 1. Render vs. preview — the most important rule (PRD §9.2)

> **MoviePy is the RENDER engine, not the realtime UI preview engine.**

| Concern | Realtime UI preview                    | Render / export                |
| ------- | -------------------------------------- | ------------------------------ |
| Tech    | HTML `<video>` + canvas/WebGL overlays | MoviePy + FFmpeg               |
| Media   | low-res **proxy** media                | full-resolution originals      |
| Goal    | smooth scrubbing, instant feedback     | accurate, deterministic output |
| Where   | frontend (renderer process)            | Python sidecar / render worker |

Why: MoviePy is too slow for frame-accurate realtime scrubbing, but it is exactly right
for a deterministic, reproducible final render. Mixing the two would make preview janky
_and_ renders non-reproducible. The Python engine also produces accurate **preview
renders** (`render_preview`, low-res but engine-accurate) when the user wants to verify a
patch before committing.

---

## 2. What the Python engine does (PRD §9.1)

MoviePy supplies composable Python editing logic; FFmpeg handles encoding and low-level
media ops. Python workers handle:

- render preview and final export,
- waveform generation,
- frame extraction / thumbnails,
- mask rendering,
- object-tracking jobs,
- proxy creation,
- media inspection (ffprobe).

The compiler step is deterministic: the same timeline + assets always produce the same
composition, which is what makes golden-media tests possible.

---

## 3. Render job lifecycle (PRD §9.3)

```
queued ──► preparing_assets ──► rendering_frames ──► encoding
       ──► validating_output ──► completed
                            └──► failed
```

- **queued** — job accepted into the background queue.
- **preparing_assets** — resolve/verify assets, masks, proxies.
- **rendering_frames** — MoviePy composition is rendered.
- **encoding** — FFmpeg encodes to the target codec/container.
- **validating_output** — automatic render validation (§4).
- **completed / failed** — terminal. Failures must emit useful logs (see
  [../runbooks/render-debugging.md](../runbooks/render-debugging.md)).

Render jobs are **resumable/retryable**, run under a hard timeout
(`FRAMEPILOT_RENDER_TIMEOUT_SECONDS`), and are **cancellable** (PRD §18.2–§18.3).

---

## 4. Render validation (PRD §9.4)

**Every** render is validated before being presented to the user — a render that
"succeeded" but produced a black or silent file is a failure:

- file exists and is **non-zero bytes**,
- **duration** is present and matches the expected timeline duration (within tolerance),
- **video stream** present,
- **audio stream** present if expected,
- **black-frame** detection,
- **audio-clipping** detection,
- expected-vs-actual duration comparison.

Validation output feeds the AI Critic ([ai-engine.md](ai-engine.md) §7) and is also
runnable standalone via `framepilot validate-render`. Validation modules are held to 100%
coverage; render changes require a golden-test update
([../guides/writing-tests.md](../guides/writing-tests.md)).

---

## 5. Export presets

Final exports use named presets so platform targets are reproducible:

- **9:16 Reels/Shorts/TikTok** (1080×1920)
- **1:1 square** (1080×1080)
- **16:9 LinkedIn/YouTube** (1920×1080)
- **custom** (explicit resolution/fps/codec/bitrate)

Presets fix resolution, fps, codec, container, and loudness target so the same project
exports identically for a given platform.

---

## 6. Python sidecar + CLI

The engine is reachable two ways (full reference:
[../api/python-engine-api.md](../api/python-engine-api.md)):

- **FastAPI sidecar** — local HTTP at `FRAMEPILOT_PYTHON_API_URL`
  (default `http://127.0.0.1:8765`): `/health`, `/render`, `/render/jobs/{job_id}`,
  `/render/jobs/{job_id}/cancel`, `/render/preview`, `/validate-render`,
  `/inspect-media`. `/render` submits to an async render queue and returns a job
  id to poll instead of blocking (plan H1.3, [ADR 0050](../adr/0050-async-render-queue-http-contract.md));
  `/render/preview` stays synchronous. The desktop shell spawns and supervises this
  process ([desktop-shell.md](desktop-shell.md)).
- **`framepilot` CLI** — `render`, `validate-render`, `inspect-media`, `serve`. Used in
  CI to render and validate the fixture project on every PR (see
  [../runbooks/ci-cd.md](../runbooks/ci-cd.md)).

Both paths share the same engine code and the same deterministic compiler, so CLI, CI,
and the desktop app render identically. The engine is sandboxed to the projects root and
uses safe path resolution (PRD §18.1).
