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

Instrumented in the monitor (`apps/web-editor/src/components/preview/mask-tool-telemetry.ts`),
three channels, all started at the pointer event's own timestamp:

- **`commit`** — to the instant the overlay's DOM commit is finished and the moved geometry is
  paintable: input delay (how long the event waited for the main thread), the gesture math,
  snapping, the store update, and React's commit of the 200-point outline and its handles. **The
  16 ms budget is asserted on this**, in both the jsdom test and the Playwright spec.
- **`pointerToPaint`** — the same, plus the animation frame that follows that commit. Reported.
- **`composite`** — the mask raster the layer engine runs for the live geometry, latest-wins with
  one present in flight. Reported.

| Where                                                                                     | Gesture                                               | `commit` p95 |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------ |
| jsdom, `MaskCanvasTools.perf.test.tsx` (local, M1 Pro)                                    | point drag with snapping + whole-path move, 476 moves | **0.79 ms**  |
| jsdom, same file on the CI runner (`MK4.6 budgets` step, uninstrumented, run 35274471046) | same, 476 moves                                       | **1.97 ms**  |
| Chrome, `tests/e2e/specs/mask-tools.spec.ts` (CI, `MK4.6 pointer-to-paint` log line)      | whole-path drag, 120 moves                            | see below    |

The save budget on the same CI run: best **162.5 ms** of `[190, 238, 217, 175, 163]`, file
**13,443,017 bytes** — the local numbers reproduce on the runner.

The design choices that keep the per-move cost flat at 200 vertices: the outline and all point
handles are single SVG paths (not an element per handle), hit testing is arithmetic in source
pixels rather than DOM events, and the SVG group transform maps source to frame pixels once, so
nothing is re-projected per vertex in JavaScript. That is why jsdom, which does no style or
layout, measures 2 ms — and why the Chrome number below is *not* about the geometry work.

### The Chrome miss: the live raster was starving the pointer

Chrome, CI run 35274471046 (E2E smoke), three attempts, before the fix:

| Attempt | `commit` p95 | `pointerToPaint` p95 | `composite` p95 |
| ------- | ------------ | -------------------- | --------------- |
| 1       | 20.7 ms      | 21.1 ms              | 18.6 ms         |
| 2       | 18.3 ms      | 18.5 ms              | 20.1 ms         |
| 3       | 19.7 ms      | 19.9 ms              | 20.8 ms         |

Two things fall out of that table. First, `pointerToPaint` sits only **0.2–0.4 ms** above
`commit`, so the animation frame costs nothing here — an earlier reading of these numbers as a
vsync floor was wrong, and this table is the refutation. Second, `commit` tracks `composite`
almost exactly, which is the actual mechanism: both run on the main thread, the live re-composite
was started synchronously in the effect the pointer move had just triggered, and the *next*
pointer event then waited behind a ~19 ms raster. The measured latency was mostly input delay,
not the monitor's geometry work.

The fix (MK4.6, `WebCodecsPreviewPlayer.tsx`) defers the live present to the next animation frame,
still latest-wins with one present in flight. The move handler returns the thread immediately, so
queued input is delivered before the raster starts; the raster itself is unchanged and still
re-composites at roughly frame rate. The budget was not lowered, and the deeper options
(incremental raster of the edited region, worker raster) remain available if a future measurement
needs them.

**Measured after the fix:** see the E2E smoke log line of the run recorded in the PR.
