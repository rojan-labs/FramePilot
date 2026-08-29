# ADR 0161 — A child process is registered, or it is not ours

**Status:** accepted
**Date:** 2026-08-29
**Schema:** unchanged
**Related:** plan/system-mission P5.3 / P5.5, ADR 0156 (the sidecar sandbox-root outage)

## Context

FramePilot spawns real operating-system processes — the Python engine, and through it
ffmpeg and ffprobe. Cleanup was owned by whichever module happened to spawn each one:
`sidecar.stop()` on `will-quit`, `exportHub.abortAll()` on `before-quit`,
`killProcessGroup` inside the spawn helper. Every one of those is correct, and together
they still leave two holes:

1. **A quit path added later cannot know what to clean up.** Nothing forces a new kind of
   child to be visible to shutdown; forgetting is silent, and the symptom — an ffmpeg
   holding four cores and a port the next launch cannot bind — appears long after.
2. **A crash runs none of them.** The handlers that would have cleaned up are exactly the
   code that did not execute.

## Decision

**Registration is how a child becomes visible to shutdown.** `electron/process-registry.ts`
holds every child with owner, purpose, started-at, an optional timeout and a cancel handle,
moving through `created → ready → running → idle → failed → recovering → terminated`.
`will-quit` walks the registry as a **backstop behind** the existing owners, not as a
replacement for them.

`recovering` is a state of its own rather than a flavour of `failed`, because the engine
restarts itself and a reader has to be able to tell "coming back" from "gone".

For the crash case, a **pidfile** in `userData` records every live child. It is written
**synchronously** — the only sync write there — because its entire job is to be readable
after a process died without running a single handler. The next launch sweeps it,
liveness-checking each pid first: pids are reused, and killing a stranger's process because
it inherited a number is a worse failure than leaving an orphan.

## The corollary this ADR exists to record

**Watching a process is not the same as watching a service.** The engine launches as
`uv run framepilot serve`, so the manager's direct child is the _wrapper_ and the server
that answers requests is its _grandchild_. Kill the server and the wrapper lives on: no
`exit` event, and a manager that only watches processes reports `ready` forever while every
request fails.

Six unit tests covered the process-exit path and all six passed. A desktop e2e that
SIGKILLed the real engine is what found it. So the manager also probes liveness: three
consecutive failed health checks mean the engine is gone, whatever its process table says.

## Consequences

- Adding a new kind of child means registering it; the registry is the list quit walks.
- The liveness probe is **opt-in**, because its cadence comes from the injected clock and a
  test injecting an instant sleep would otherwise spin. Production sets it in `main.ts`.
- A unit test proving a recovery path is evidence about the path, not about the system.
  The e2e row is what settles whether the app recovers, and at the time of writing it does
  not yet pass — recorded openly in P5.5 rather than closed on the unit tests.
