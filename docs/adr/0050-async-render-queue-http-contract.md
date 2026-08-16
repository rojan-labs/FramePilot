# ADR 0050: Async submit+poll HTTP contract for `POST /render`

- **Status:** Accepted
- **Date:** 2026-07-11
- **Deciders:** Engine sidecar maintainers
- **Relates to:** PRD §18.3 (cancellation/resume), `plan/PLAN.md` H1.3,
  `engine/python/framepilot_engine/render/queue.py` (`RenderQueue`, pre-existing
  and fully tested in `test_render_queue.py`), ADR 0023 (precedent for treating an
  HTTP/IPC contract change as ADR-worthy, not just schema migrations)

## Context

`POST /render` (final export) ran synchronously: the HTTP handler called the
render driver directly and did not return until FFmpeg finished (or failed),
then replied `200` with the completed/failed `RenderJob`. A full export can run
for minutes. This meant:

- The request (and the desktop/CLI caller's socket) was held open for the
  entire encode, with no way to check progress except waiting on that one
  response.
- There was no way to cancel a render already in flight — PRD §18.3 requires
  real mid-encode cancellation (a hung or unwanted encode must be killable),
  which a purely synchronous request/response cannot express.
- A prior engine slice already built and fully tested `RenderQueue`
  (`render/queue.py`) — a subprocess-executor-backed queue supporting submit/
  get/cancel with retry and timeout — specifically to solve this, but it was
  never wired to the HTTP surface. `POST /render` still called `render()`
  directly.

This task (plan H1.3) is the slice that wires that existing, tested queue to
the HTTP route.

## Decision

`POST /render` becomes **asynchronous**: it submits the job to `RenderQueue`
and returns immediately.

- **`POST /render`** → `202 Accepted`, body `{ "jobId": "<task id>", "status":
  "queued" }` (`RenderAcceptedResponse`, camelCase alias for the wire format).
  A bad/unreadable project path still returns `400` synchronously, before
  anything is queued.
- **`GET /render/jobs/{job_id}`** (new) → polls a submitted render's status.
  Returns a `RenderTask` (id/status/attempts/error/result); `result` carries
  the same `RenderJob` shape the old synchronous response used, so a
  completed poll is a drop-in replacement for the old `200` body. `404` if the
  job id is unknown.
- **`POST /render/jobs/{job_id}/cancel`** (new) → cancels a queued/running
  render. Idempotent: cancelling an already-terminal job (completed/failed/
  cancelled) is a no-op that returns its unchanged final state, not an error.
  `404` if unknown.
- **`POST /render/preview` is deliberately left synchronous** — unchanged
  contract, still `200` + completed/failed `RenderJob`. Previews are
  downscaled to half resolution and used for short-lived scrub/inspect flows,
  where the caller wants an immediate result rather than a job to poll. There
  is no unbounded-duration problem to solve for previews the way there is for
  a full export, so moving them to the queue would only add poll-loop
  overhead for no benefit.

Nothing about the render *pipeline* itself (stages, validation, output
determinism) changes — this is purely the HTTP contract around an
already-tested queue.

## Consequences

- **Real cancellation is now possible over HTTP.** A hung or unwanted FFmpeg
  encode can be killed via `POST /render/jobs/{job_id}/cancel`, closing the
  PRD §18.3 gap the synchronous route could not address.
- **The HTTP request for `/render` no longer blocks on FFmpeg.** The sidecar
  can accept and track multiple in-flight/queued renders without tying up a
  request thread per job.
- **Breaking change for existing callers, explicitly not fixed here.**
  `apps/desktop/electron/render/export-client.ts` and `apps/web-editor` were
  built against the old synchronous `200`+`RenderJob` contract. They were
  **not** touched in this slice: today they will receive a `202`+`jobId`
  body and have no code path to poll it. This is a known, tracked gap — not
  a regression discovered later — mirroring how H1.2's schema→engine→UI
  slices were each shipped and flagged honestly as not-yet-end-to-end until
  the next slice landed (see `plan/PLAN.md` H1.2b/H1.2d/H1.2f/H1.2i).
  Follow-up: **plan H1.3b** — wire the desktop export dialog (and
  web-editor's equivalent) to submit, poll, show progress from, and offer
  cancel against the new contract.
  - **Closed 2026-07-11 (`plan/PLAN.md` H1.3b).** `exportViaSidecar` now
    submits + polls `/render/jobs/{job_id}` (750ms interval) and calls
    `/render/jobs/{job_id}/cancel` on abort; a new `ExportHub`
    (`apps/desktop/electron/render/export-hub.ts`, mirroring `AiStreamHub`)
    pushes progress to the renderer over a new IPC channel
    (`exportVideoStart`/`exportVideoCancel`/`onExportProgress`), and
    `ExportDialog.tsx` shows real queued/running/cancel states. The "long-poll
    vs. plain poll" question below was *not* revisited — plain poll proved
    sufficient for the UI's needs.
- **Engine-internal risk is low.** `RenderQueue` itself shipped and was fully
  unit-tested in a prior slice (`test_render_queue.py`); this change only
  wires HTTP routes to its existing `submit`/`get`/`cancel` API and adds no
  new queue behavior.

## Alternatives Considered

- **Keep `/render` synchronous and add cancellation via a side-channel (e.g.
  a separate "kill last render" route keyed by project).** Rejected: it
  cannot express multiple concurrent/queued renders or per-job status, and
  still holds the HTTP connection open for the whole encode.
- **Long-polling / WebSocket push instead of client poll.** Rejected for this
  slice: adds transport complexity (a persistent connection, reconnect
  handling) the sidecar doesn't otherwise need; plain poll matches the
  existing sidecar request/response style used by every other route and is
  sufficient for the desktop app's realistic render durations. Can be
  revisited in H1.3b if UI responsiveness demands it.
- **Version the route (`/render/v2`) instead of changing `/render` in
  place.** Rejected: the sidecar is a private, versioned-together local
  process (desktop shell + engine ship as one app build), not a public API
  with independent deployment lifecycles — there is no external consumer to
  protect via versioning, and it would leave a permanently-orphaned `/render`
  contract to maintain.
