# ADR 0002: Electron for the desktop shell

- **Status:** Accepted
- **Date:** 2026-06-18

## Context

FramePilot is a **desktop** app: it needs local filesystem access for project folders,
must spawn and supervise a Python render sidecar, and must host a rich React editor with
HTML/canvas/proxy-based preview (PRD §10). The PRD (§10.1) names two candidate shells:
**Tauri** (Rust-based, lean) and **Electron** (Chromium + Node, heavier). The PRD's own
recommendation: use Electron for the fastest MVP, use Tauri for a leaner long-term app,
and — crucially — **keep the Python render engine isolated so the shell choice can change
later.**

Our team is a pure JS/TS + Python team with no Rust expertise, and time-to-working-editor
is the dominant constraint for Phase 0–4.

## Decision

We will use **Electron** for the desktop shell for the MVP, on the fastest pure-JS/TS
path. To preserve optionality, the render engine stays a **standalone Python sidecar**
(FastAPI + `framepilot` CLI) talking over a typed IPC/HTTP contract — _not_ embedded in
the shell. The shell's responsibilities are kept thin (windows, secure IPC, process
supervision, file safety) so it could be replaced by Tauri later with minimal blast
radius.

## Consequences

- **Positive:** fastest path to a working editor; the entire renderer + engine
  integration is JS/TS we already know; mature ecosystem for packaging/signing/auto-update.
- **Positive:** because the engine is isolated (see
  [0003](0003-python-render-engine-moviepy-ffmpeg.md)), a future migration to Tauri
  touches only `apps/desktop`.
- **Negative:** larger binaries and higher memory footprint than Tauri; we must actively
  harden the renderer (`contextIsolation`, no `nodeIntegration`, minimal preload bridge —
  see [../architecture/desktop-shell.md](../architecture/desktop-shell.md) and
  [../runbooks/security-hardening.md](../runbooks/security-hardening.md)).
- **Follow-up:** revisit Tauri after MVP if footprint/perf becomes a real constraint.

## Alternatives Considered

- **Tauri (now)** — leaner and more secure by default, but requires Rust sidecar
  integration we are not yet set up for; deferred, not rejected.
- **Web app only** — rejected: no reliable local filesystem/project-folder model and no
  way to run the Python render engine locally.
- **Native (Qt/SwiftUI/etc.)** — rejected: throws away the React/TS UI investment and
  multiplies platform effort.
