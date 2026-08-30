# Phase 6 — Memory and resources: after

Every fix below is linked to its commit and its root cause. The phase's shape is worth
stating first: **most of what was audited turned out not to be leaking**, and saying so is
the result. Three real defects were found, and one of them was in the measurement criterion
rather than the code.

## What was actually leaking

| # | Defect | Root cause | Commit |
| --- | --- | --- | --- |
| 1 | ffmpeg pipes left open at the end of every render | MoviePy's `FFMPEG_VideoReader.close()` / `FFMPEG_AudioReader.close()` close `stdout`/`stderr` **only while the process is still running**. A reader whose ffmpeg exited on its own — how every render ends — sets `proc = None` and the descriptors survive until `__del__`. | `a50e42a` |
| 2 | Detached `<canvas>` and decoded full-res images surviving preview dispose | `webcodecs-preview-engine.dispose()` was documented as clearing its image map and did not: `images` and `heldFrame` outlived it — a detached canvas is exactly the shape P6.1's heap criterion rules out. | `8ff1f8a` |
| 3 | Drag listeners outliving the text-overlay box | `PreviewTextEditor` attached pointer listeners it never released on unmount. | `d97a9ef` |
| 4 | 588 test sandbox directories on one machine, +56 per suite run | `packages/mcp-server`'s `makeSandboxProject` `mkdtemp`s a root and nothing removed it. Not a product leak — a harness that litters the developer's machine. | `70d156f` |

## What was audited and found clean

Stated because "we looked and it was fine" is a result, and the next person should not
have to re-derive it:

- `setInterval`/`clearInterval` balance file-by-file; every non-one-shot `requestAnimationFrame`
  has its cancel in the same cleanup; every `setTimeout` imbalance resolves to a ref cleared
  from an unmount effect.
- The only `new Worker` terminates from `DecodeWorkerClient.dispose()`; both `AudioContext`s
  close; all three `matchMedia` listeners detach.
- `URL.createObjectURL` / `revokeObjectURL` pair up; store subscriptions unsubscribe.
- **Engine temp files**: after nine real exports, **zero** `framepilot-audio-*`,
  `framepilot-asr-*` or `fp-loudness-*` directories and zero stray render artifacts. The
  production paths clean up (`_StreamingAudioWorkspace` released by `close_clip_tree` after
  the clip graph; the master-audio temp `Path.replace`d; everything else a
  `with TemporaryDirectory`).
- **IPC**: every contract channel is handled at most once and nothing declared goes
  unserved — asserted by a test that scans the main-process sources. Its first run found
  `referencesAnalyze` declared everywhere and handled nowhere.

## The criterion that was wrong

P6.4's "sidecar RSS after 5 exports ≈ after 1 (±10 %)" is not measurable as written. Nine
consecutive in-process exports of the 4K fixture gave:

**171 · 192 · 197 · 171 · 199 · 228 · 228 · 204 · 104 MB**

— non-monotonic, ending *below* where it started, with peak plateauing at 258 MB. Two
samples out of that series can be made to read **+17 %, +30 % or −39 %** depending on which
two you pick. The honest question is whether it grows without bound over N runs, and it
does not.

`get_frame` is the clean counter-example of a measurement that *does* work: 100 consecutive
calls gave 84.2 → 86.4 MB, a 1.8 % spread, plateaued from frame 50.

## The gate

`RESOURCE_GATE=1` began as six inline `expect`s at the end of a ten-minute Electron
session — which meant it could not be shown to work without seeding a leak into a real app
run. It is now a pure function over a resource trace, so it is proven in both directions in
0.4 s: it **holds** on the real measured session, **fails** on seeded heap, listener, node,
file-handle and orphan-encoder leaks, and **holds** on ordinary variance. That last one
matters most: a gate that fires on noise gets switched off, and then it catches nothing.

Bounds come from the 2026-08-29 baseline — heap 43.7–48.7 MB, listeners 933–935, nodes
2,913–2,967 over 376 loops.

## Still open

- **P6.1's counter/heap evidence** — "counters flat across open → edit → close ×3" needs
  the desktop harness driving a scripted session. The unit tests prove each primitive
  releases; they do not prove the aggregate. The measurement lives with P6.6's gate.
- The `main.ts` split (P6.3) was deliberately not attempted — 127 KB, "no behaviour
  change", and three workstreams editing the tree concurrently. A mechanical move that size
  is impossible to review honestly in that company.
