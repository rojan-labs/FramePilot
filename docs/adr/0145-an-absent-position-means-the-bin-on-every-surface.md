# ADR 0145 — An absent position means the bin, on every surface

**Status:** accepted
**Date:** 2026-08-26
**Related:** ADR 0140 (stock is a cutaway, not an overlay), ADR 0083 (fail closed
rather than report an edit that did not happen), ADR 0032 (type-agnostic layers),
`plan/SCENE-UNDERSTANDING-AND-COMPOSITING.md` §0.2 (`SUC-P1`)

## Context

Captured run `8e717596` was asked for a 30-second Reel. It called `add_stock`
five times in one turn. The first succeeded in 4.4s. The other four failed in
under 70ms each, with:

> There is already picture on the timeline between 0.0s and 13.0s. Stock cannot
> sit on top of existing footage yet — pick an empty stretch.

None of the five calls passed `atSeconds`. Under ADR 0140 plus the bin-gather
mode added alongside it, that is precisely the supported way to collect
candidates before choosing a running order — the tool description says so, and
the b-roll skill tells the model to do exactly this. The model followed the
contract and was refused four times for it.

The bin-gather mode was added in three of the four places it lives:
`buildStockBinOps` in `editor-core`, the `atSeconds === undefined` branch in
`stockOpsFromPayload`, and the tool description. The fourth — the desktop host in
`main.ts`, a three-thousand-line file with no test for this closure — kept the
older reading:

```ts
const start = Math.max(0, atSeconds ?? 0);
```

That one `?? 0` did two things. It ran the ADR 0140 occupancy gate against a span
nobody had asked for, so every gather after the first clip landed was refused
against that clip. And it echoed `atSeconds: 0` back unconditionally, so even a
gather that got past the gate arrived at the orchestrator looking like a
placement request — `stockOpsFromPayload` never saw `undefined`, and the
bin-gather branch was unreachable on the desktop app end to end.

The refusal itself made the stall worse. "Pick an empty stretch" is actionable
for a person, who can scrub the timeline and see the gaps. The agent cannot see
the timeline. It was told what was wrong and never where to go instead.

## Decision

**An absent `atSeconds` means the media bin at every layer of the path, and a
refused placement names a moment that would be accepted.**

1. The desktop host's `add_stock` moves out of `main.ts` into
   `apps/desktop/electron/ai/stock-host.ts`, behind an injected `StockHostIO`, so
   the rule can be tested against the orchestrator's matching rule. Absent stays
   absent: no occupancy probe (there is no span to probe), and no echoed
   position.
2. `firstFreePictureStart` joins `picturePlacementConflict` in
   `picture-occupancy.ts`, computed from the same merged spans, so a suggestion
   can never name a moment the predicate would then refuse.
3. Every stock refusal — the agent's, the host's pre-download one, and the Stock
   panel's disabled **Add** — names that moment. The agent gets a number it can
   pass straight back as `atSeconds`; the person gets a place to move the
   playhead to.
4. The orchestrator returns the refusal as data (`StockPlacementRefusal`:
   requested span, suggested start) as well as prose, both built from the same
   numbers.

**ADR 0140 is unchanged.** Stock still does not stack. What changed is that
declining to place a clip no longer declines to download it, and a decline now
carries its own remedy.

## Why not the alternatives

**Let the placement auto-layer, as `placeAssetPatch` does for a dragged file.**
This is what the run's operator expected, and it is what the manual
drag-and-drop path really does (ADR 0032) — so the expectation was not
unreasonable. It is still wrong here for the reason ADR 0140 gives: the preview
flattens picture clips from every layer into one chain while the export
composites them, so a stacked cutaway previews differently from how it renders.
A person who drags a file onto an occupied lane chose to stack and can see what
they did; a one-click **Add** and an agent placement did not choose it. Lifting
the constraint means finishing `SUC-P1`, which is a compositing project, not a
bug fix.

**Fix the `?? 0` in place and leave the closure in `main.ts`.** It is a
two-character change and it would have shipped the same behavior. It would also
leave the decision in the one file in the path that nothing tests — which is how
the mode came to be half-implemented in the first place. The extraction is the
part that keeps it fixed.

**Have the host resolve a free moment and place the clip there itself.** It
guesses at intent the model never expressed, and it puts a placement decision in
the process that is forbidden to make one (AGENTS.md invariant 5). Naming the
free moment and letting the caller decide keeps the authority where it belongs.
