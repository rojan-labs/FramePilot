# Python Engine API (Sidecar + CLI)

The Python render engine (`engine/python`) is reachable two ways, sharing the same
deterministic engine code:

- a **FastAPI sidecar** the desktop shell spawns and supervises, and
- a **`framepilot` CLI** used in CI and for local debugging.

See [../architecture/render-engine.md](../architecture/render-engine.md) for the engine
internals and [../architecture/desktop-shell.md](../architecture/desktop-shell.md) for
sidecar lifecycle.

> Asset and output paths are resolved through the path sandbox (PRD §18.1); a
> render rejects assets that escape the project directory. Per-ffmpeg-call
> timeouts are honored today; full mid-encode cancellation/resume (PRD §18.3) is
> handled by the async render queue (below) for `POST /render` as of plan H1.3.

---

## FastAPI sidecar

Bound to `FRAMEPILOT_PYTHON_API_URL` (default `http://127.0.0.1:8765`, loopback only).
Request/response bodies are the pydantic models in `framepilot_engine.service`;
field names are `snake_case`. `POST /render` (final export) is **asynchronous**:
it submits to the `RenderQueue` and returns `202` immediately with a job id to
poll (plan H1.3, ADR 0050). `POST /render/preview` stays **synchronous** and
still returns the finished job directly — previews are cheap (downscaled,
short) and callers want an immediate result. **`apps/desktop` and
`apps/web-editor` do not yet consume the new polling contract** — that's a
tracked follow-up (plan H1.3b); see CHANGELOG.md.

### `GET /health`

Liveness/readiness probe used by the shell before routing work.

```json
// 200
{ "status": "ok", "version": "0.0.0" }
```

### `POST /render`

Submit a final export of a project timeline to the async `RenderQueue` (plan
H1.3, ADR 0050). Returns immediately — it does **not** wait for FFmpeg.

```json
// request
{ "project_path": "demo/project.fp.json", "preset": "reels" }
// 202 — queued, not yet run
{ "jobId": "f3a9…", "status": "queued" }
```

A bad/unreadable project path returns `400` before the job is even submitted.
Poll the job with the two routes below.

### `GET /render/jobs/{job_id}`

Poll a submitted render's status/result.

```json
// 200 — still running
{ "id": "f3a9…", "status": "rendering_frames", "attempts": 1, "error": null, "result": null }
// 200 — finished; `result` is the same RenderJob shape the old synchronous
// POST /render response used, so a completed poll is a drop-in replacement
{
  "id": "f3a9…", "status": "completed", "attempts": 1, "error": null,
  "result": {
    "id": "f3a9…", "project_id": "p1", "state": "completed", "progress": 1.0,
    "output_path": "demo/exports/p1.mp4", "error": null,
    "validation": { "output_path": "demo/exports/p1.mp4", "ok": true, "checks": [ … ] }
  }
}
```

Unknown `job_id` returns `404`.

### `POST /render/jobs/{job_id}/cancel`

Cancel a queued or running render. Idempotent: cancelling an already-terminal
job (completed/failed/cancelled) is a no-op that returns its unchanged final
state, not an error. Unknown `job_id` returns `404`.

### `POST /render/preview`

Fast, downscaled preview of a project timeline. Deliberately kept
**synchronous**, unlike `POST /render`: previews are downscaled (half
resolution) and used for short-lived scrub/inspect flows where the caller
wants an immediate result rather than a job to poll. The job runs the full
lifecycle (queued → preparing_assets → rendering_frames → encoding →
validating_output → completed/failed) and is render-validated before
`completed`.

```json
// request
{ "project_path": "demo/project.fp.json", "preset": "reels" }
// 200 — the completed (or failed) RenderJob
{
  "id": "f3a9…", "project_id": "p1", "state": "completed", "progress": 1.0,
  "output_path": "demo/exports/p1.mp4", "error": null,
  "validation": { "output_path": "demo/exports/p1.mp4", "ok": true, "checks": [ … ] }
}
```

A bad/unreadable project path returns `400`; a render that fails any stage
returns `200` with `state: "failed"` and an `error` string (and `validation` when
the failure was a validation check).

**Known gap (not silent):** `apps/desktop/electron/render/export-client.ts` and
`apps/web-editor` still expect `POST /render`'s old synchronous 200+`RenderJob`
contract; they were not touched in this slice and will get a `202`+`jobId` body
they don't yet know how to poll. Wiring them to the new contract is plan H1.3b.

### `POST /validate-render`

Run render validation on an existing file (PRD §9.4).

```json
// request
{ "output_path": "renders/final.mp4", "expected_duration_seconds": 45.0,
  "expect_audio": true, "expect_video": true }
// 200
{
  "output_path": "renders/final.mp4",
  "ok": true,
  "checks": [
    { "name": "file_exists", "status": "pass", "detail": null },
    { "name": "non_empty", "status": "pass", "detail": "1048576 bytes" },
    { "name": "video_stream", "status": "pass", "detail": null },
    { "name": "audio_stream", "status": "pass", "detail": null },
    { "name": "duration", "status": "pass", "detail": "actual=45.000s expected=45.000s" },
    { "name": "black_frames", "status": "pass", "detail": "black_ratio=0.000" },
    { "name": "audio_clipping", "status": "pass", "detail": "max_volume=-3.0 dBFS" }
  ]
}
```

`status` is one of `pass` / `fail` / `skip`; `ok` is true iff no check is `fail`.

### `POST /inspect-media`

ffprobe-backed media inspection used on import. Returns the typed `MediaInfo`
(`404` if the file is missing, `422` if ffprobe cannot parse it).

```json
// request
{ "input_path": "assets/input.mp4" }
// 200
{ "path": "assets/input.mp4", "duration_seconds": 62.4, "format_name": "mov,mp4,m4a",
  "size_bytes": 8123456,
  "streams": [
    { "index": 0, "codec_type": "video", "codec_name": "h264",
      "width": 1920, "height": 1080, "fps": 30.0, "duration_seconds": 62.4 },
    { "index": 1, "codec_type": "audio", "codec_name": "aac",
      "sample_rate": 48000, "channels": 2 }
  ] }
```

### `POST /analyze-silence` · `POST /detect-scenes`

ffmpeg-backed **analysis** (plan Phase 9.2). Each loads the project, resolves the target
asset's media inside the sandbox, and runs `framepilot_engine.analysis` — `silencedetect`
for silence, the `scene` score + `showinfo` for cuts. They return data only and never
mutate the timeline. `asset_id` is optional (defaults to the first audio-bearing / video
asset); `404` if no matching asset, `400` on a bad project, `422` on an ffmpeg failure.
Every subprocess is bounded by `FRAMEPILOT_ASSET_MEDIA_TIMEOUT_SECONDS`.

```json
// POST /analyze-silence request
{ "project_path": "demo.project.fp.json", "asset_id": "a1",
  "noise_floor_db": -30.0, "min_silence_seconds": 0.5 }
// 200
{ "assetId": "a1", "ranges": [ { "start": 3.2, "end": 5.8, "duration": 2.6 } ] }

// POST /detect-scenes request
{ "project_path": "demo.project.fp.json", "asset_id": "a1", "threshold": 0.4 }
// 200
{ "assetId": "a1", "cuts": [ { "time": 0.0 }, { "time": 12.35 } ] }
```

---

## `framepilot` CLI

Run via `uv run framepilot <command>` (see [../guides/getting-started.md](../guides/getting-started.md)).

| Command                                   | Purpose                                                        |
| ----------------------------------------- | -------------------------------------------------------------- |
| `framepilot serve`                        | Start the FastAPI sidecar (bound to the configured host/port). |
| `framepilot render <project.fp.json>`     | Render/export a project to a file.                             |
| `framepilot validate-render <output.mp4>` | Run render validation on a file.                               |
| `framepilot inspect-media <input.mp4>`    | Print media metadata (duration/fps/resolution/streams).        |

Examples (PRD §15.3):

```bash
uv run framepilot render fixtures/basic/project.fp.json
uv run framepilot validate-render renders/output.mp4
uv run framepilot inspect-media assets/input.mp4
```

CI uses `render` + `validate-render` on a fixture project as a quality gate on every PR
(see [../runbooks/ci-cd.md](../runbooks/ci-cd.md)). Because the CLI and the sidecar share
the same deterministic compiler, CI, the app, and local runs all render identically.
