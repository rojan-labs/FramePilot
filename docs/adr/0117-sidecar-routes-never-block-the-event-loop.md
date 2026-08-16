# 0117. Sidecar routes never block the event loop

- Status: Accepted
- Date: 2026-08-14

## Context

A 20-second, 30-cut beat-synced montage came back as thirty-three identically-spaced
clips cycling the asset list in library order. Nothing errored. The run reported success.

The sidecar log explains it:

```
POST /brain/visual/footage-map → 200 (409026 ms)
```

and, in the same window, no line at all for `/detect-beats` or `/brain/visual/search`.
Those requests were never received. The client killed them at 120s and reported
`"detect_beats" timed out after 120s`.

37 routes were declared `async def`. **34 of them contained no `await` anywhere** — their
bodies were ordinary blocking code (ffmpeg, sqlite, a synchronous TwelveLabs SDK) running
directly on the event loop. While the footage map spent 409 seconds inside Pegasus, the
loop could not run, so uvicorn could not read another socket. The sidecar was a
single-request server that looked like a concurrent one.

That starved even correctly-written routes: `/review/temporal-evidence` already offloads
via `run_in_threadpool`, and it _still_ sat unread until the map finished, then completed
102s later — after the reviewer had given up at 120s.

So one long call did not merely take a long time. It made every other analysis in the run
fail, the planner routed around each "failure", and the edit proposer, handed no beat grid
and no word that one was missing, invented an even one.

## Decision

A route either awaits, or it is `def`. Never `async def` around blocking work.

FastAPI runs a sync route in the threadpool, which is precisely right for bodies that
decode media or call a synchronous SDK. All 34 offenders are now `def`. The three genuinely
async routes are unchanged.

A structural test (`test_no_route_blocks_the_event_loop`) parses the service module and
fails on any `async def` route with no `await` in it. This has to be structural: the
failure is invisible to a single-request test, because the route returns the correct
answer — just at every other request's expense.

Two hazards that real concurrency exposes are closed with it:

- `BrainStore.open` sets `PRAGMA busy_timeout = 5000`. Each request already opens its own
  connection, and WAL allows concurrent readers, but a second _writer_ previously failed
  immediately instead of waiting.
- The process-wide embedder gate takes a lock, so two requests cannot both load the model.

## Consequences

Long understanding-model work no longer blocks anything else, so the per-tool timeouts in
the AI SDK now measure the work rather than the queue.

Route bodies are now genuinely concurrent. Anything they touch must be safe under
threads — per-request connections and locked process-wide caches, as above. New shared
mutable state in this module is a correctness question, not a style one.

The threadpool is bounded (40 by default). A pathological number of simultaneous 400-second
calls would exhaust it and queue again — far better than the previous behaviour, where
_one_ call did, but worth knowing.
