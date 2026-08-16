# apps/desktop/src

The desktop **renderer** is provided by [`@framepilot/web-editor`](../../web-editor),
not by this directory. The Electron main/preload processes live in
[`../electron`](../electron).

In production, the web-editor build output is copied into `apps/desktop/renderer/`
and loaded by `electron/main.ts`. This wiring is implemented in
[`plan/PLAN.md`](../../../plan/PLAN.md) Phase 3.1 (Electron shell).

This folder is intentionally minimal for now (see `.gitkeep`).
