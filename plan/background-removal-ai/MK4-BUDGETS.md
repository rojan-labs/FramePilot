# MK4 budgets: measured numbers

Budgets from [`06`](./06-PRECISION-AND-EVAL.md). Measured 2026-09-17 on the maintainer's machine
(Apple M1 Pro, 16 GB, Node 24.13) unless a row says CI. Neither budget was lowered; the save budget
missed at first and was met by optimising the file format (below).

## Save/autosave with 1,000 path keyframes × 200 vertices (≤ 250 ms)

`packages/timeline-schema/src/save-budget.perf.test.ts`: the document work of the desktop
autosave (`projectSaveDefault` in `apps/desktop/electron/main.ts`) on a structured clone of the
IPC payload: validate (`parseProject`), serialise for the revision fingerprint and the watcher
self-write mark, the atomic write (serialise, fsync, rename), and the recovery snapshot write.
Best of 5.

| Version                                                                                  | Save (ms)                                                               | File size    |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------ |
| Before MK4.6 (pretty decimal JSON, three serialisations)                                 | 412–488 (parse 60 · serialise ×2 160–180 · write 60 · recovery 130–160) | 55.3 MB      |
| Inline number arrays, one cached serialisation                                           | ~420 (formatting 1.2 M decimals is ~120 ms by itself)                   | 23.1 MB      |
| **Shipped:** binary `f64le:` path arrays, cached serialisation, recovery reuses the text | **172 best (172–215 over 5 runs)**                                      | **13.44 MB** |

Size budget: the file must stay ≤ 14 MB for this document (asserted). The remaining time is Zod
validation of the payload (~60 ms), the fsync'd 13 MB write (~55 ms) and the recovery write
(~20 ms). Not measured here: the renderer → main structured clone of the IPC payload (outside the
document code; a structured clone of this project takes ~30 ms in Node).

What changed and why is in ADR 0178's MK4 amendment. Values survive bit for bit (tested in TS and
Python); short paths and ordinary projects keep their decimal layout.

## Pointer-to-paint editing a 200-vertex path on 4K footage (≤ 16 ms p95)

Instrumented in the monitor (`apps/web-editor/src/components/preview/mask-tool-telemetry.ts`):
from the pointer event's timestamp to the animation frame after the overlay commit that draws the
moved geometry. The composited mask raster runs asynchronously, latest wins, and is recorded as
the separate `composite` channel, so a slow raster cannot hold the handle back.

| Where                                                                                | Gesture                                               | p95                         |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------- | --------------------------- |
| jsdom, `MaskCanvasTools.perf.test.tsx` (local)                                       | point drag with snapping + whole-path move, 476 moves | **0.93 ms**                 |
| Chrome, `tests/e2e/specs/mask-tools.spec.ts` (CI, `MK4.6 pointer-to-paint` log line) | whole-path drag, 120 moves                            | recorded by CI (see PR run) |

The jsdom figure excludes browser style/layout/paint, which the Chrome spec includes; both assert
the 16 ms budget. The design choices that keep the per-move cost flat at 200 vertices: the
outline and all point handles are single SVG paths (not an element per handle), hit testing is
arithmetic in source pixels rather than DOM events, and the SVG group transform maps source to
frame pixels once, so nothing is re-projected per vertex in JavaScript.
