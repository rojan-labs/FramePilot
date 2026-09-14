# Labelled fixture set (plan/visual-understanding VU0.2)

These four files are what VU0.3's answer cases — `which-clips-show-host`, `whats-on-screen-at`,
`find-dark-clips` — are judged against by a person. A rubric cannot score prose, so the
harness scores only that those runs answered without editing and without rendering a frame
(`packages/ai-sdk/src/eval/perception-metrics.ts`); whether the answer is _right_ is read off
these labels by the operator.

**A proposed label is not ground truth.** Everything in `tier0.json` was produced by running
the shipped tier-0 pass over the fixture media and then naming its numbers with the shipped
word functions — the machine describing its own output. Every row says so
(`"source": "proposed"`, `"verified": false`), and the raw measurement sits beside the word so
a human can see what the machine saw. Confirming or correcting a row is a human pass with the
contact sheet (`node packages/ai-sdk/scripts/contact-sheet.mjs`), after which that row's
`source` becomes `confirmed` or `corrected` and `verified` becomes `true`. The rule that
follows, and the reason the provenance is written into every row rather than into this
paragraph alone: **never tune a threshold against a label the machine proposed.** An exposure
band checked against classes that band produced agrees with itself perfectly and has measured
nothing — and it would agree just as perfectly if the band were wrong.

## The files

| file         | what it holds                                                                                                                             | state                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `tier0.json` | one row per shot of every fixture asset: exposure / warmth / motion / sharpness class, black, freeze, plus the measurement each came from | **proposed**, unverified                                                          |
| `tier1.json` | shot size, subject kind, setting, screen content, face count, person cluster, duplicate-of                                                | **scaffold** — every field `null`, EXCEPT `mission-montage`'s 5 assets (7 shots), which are **proposed**: real output from the installed `framepilot.visual-embed` pack (TRACKING.md Q4b, 2026-09-14) |
| `tier2.json` | subject, setting, on-screen text for the first 50 shots                                                                                   | **scaffold** — every field `null`                                                 |
| `cuts.json`  | the cuts of `mission-montage`: measured luma/warmth deltas and whether the cut changes source                                             | structure and deltas derived; `sameSetting` and `expectedTransitionReason` now **proposed** from the real tier-1 run above — every one of the four cuts changes location |

`tier1.json` and `tier2.json` are scaffolds rather than proposals because nothing here can
propose them: shot size and subject need the tier-1 embedding pack, on-screen text needs a
tier-2 captioner, and neither runs in this repo without a capability pack. A generated guess
would be read as a label by the next person, which is worse than an empty field.

**`mission-montage` is the one exception**, and it is why `transitions-where-they-belong`
(`packages/ai-sdk/src/eval/golden-cases.ts`) can score at all: without a real `setting` label
`sameSetting` is `null` at every cut and the transition policy correctly refuses to guess
(ADR 0175), so the case could never pass. Run live on 2026-09-14 —

```
POST /brain/visual/index  {"projectId":"mission-montage","assetIds":["asset_001"..."asset_005"],
  "visualEmbedPack":<the installed pack's handle>,"tiers":["measured","labelled"]}
```

— against a sidecar (`uv run framepilot serve`) rooted at this fixture's own
`projects/` directory, using the pack registered by
`scripts/dev-register-visual-embed.sh` (SigLIP2 ONNX,
`framepilot/siglip2-base-patch16-224-onnx`, tier1Version 1). Unverified by a human — same
`"proposed"`/`"verified": false` contract as `tier0.json` — but it is the product's own
pack, not a script's guess, which is the distinction ADR 0175 draws. `propose-fixture-labels.mjs`
preserves these rows across a regeneration (`preserveRealTier1`) instead of blanking them.

`tier0.json` also carries an `unmeasured` list. An asset is in it when ffmpeg could not run
the tier-0 pass over it at all, which is a different fact from an asset with nothing to say,
and the file must never make the two look alike.

## Regenerating

```bash
node packages/ai-sdk/scripts/propose-fixture-labels.mjs   # needs ffmpeg and uv
```

This **overwrites** all four files, so do the human pass after a fixture change, not before
one. The shot boundaries come from the same tier-0 code the product runs, so a fixture swap
changes the shot list and the old labels no longer address anything.
