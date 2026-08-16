# ADR 0003: Python render engine (MoviePy + FFmpeg), isolated as a sidecar

- **Status:** Accepted
- **Date:** 2026-06-18

## Context

Deterministic rendering is a core product principle (PRD §3.3): the AI proposes structured
operations and the **render engine executes them deterministically**. We need a render
engine that is (a) scriptable and composable, (b) able to do real media work
(compositing, masks, audio, encoding), and (c) **reproducible** so we can write
golden-media tests. We also need realtime, smooth preview in the editor — a _different_
problem (PRD §9.2).

## Decision

We will use **MoviePy + FFmpeg in Python 3.11** (managed by `uv`) as the deterministic
**render** engine, exposed as an isolated **FastAPI sidecar** plus a `framepilot` CLI
(`render`, `validate-render`, `inspect-media`, `serve`). MoviePy supplies composable
editing logic; FFmpeg handles encoding and low-level media ops.

**The realtime UI preview is explicitly NOT MoviePy** — it uses HTML `<video>` + canvas
overlays + low-res proxy media in the renderer. MoviePy is reserved for accurate preview
renders and final export. See
[../architecture/render-engine.md](../architecture/render-engine.md).

## Consequences

- **Positive:** deterministic, reproducible renders → golden-media tests are feasible
  (PRD §16); rich Python media ecosystem for tracking/masking/audio; the engine is
  language-isolated from the shell, so the shell can change (ADR
  [0002](0002-electron-desktop-shell.md)) without touching rendering.
- **Positive:** every render is auto-validated (PRD §9.4) before being surfaced — a
  silent or black "successful" render is treated as a failure.
- **Negative:** a second language/toolchain in the repo; an IPC/HTTP boundary to maintain;
  MoviePy is too slow for realtime scrubbing (accepted — hence the separate preview path).
- **Follow-up:** keep the Pydantic schema in sync with the TS Zod schema so the same
  `project.fp.json` renders identically in CLI, CI, and the app.

## Alternatives Considered

- **MoviePy as both preview and render** — rejected by PRD §9.2: too slow for realtime
  scrubbing; would make preview janky and renders non-reproducible if hacked for speed.
- **Pure FFmpeg filtergraphs** — extremely fast but unwieldy for complex, programmatic
  compositing (masks, tracked text, layered overlays); harder to test as structured ops.
- **A JS/WASM render engine in-process** — keeps one language but lacks the mature media
  ecosystem and would couple rendering to the shell, defeating the isolation goal.
