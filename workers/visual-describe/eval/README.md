# Caption quality — what is measured, and what is still not

`plan/visual-understanding/05` §VU6.5 asks for caption quality on 50 labelled shots.
`tests/fixtures/mission/labels/tier2.json` is a **scaffold whose every field is `null`**, so
that target cannot be scored yet, and a generated label set would score the model against
itself.

This directory answers a smaller question that needs no human labeller: for each fixture, a
specific claim is true or false **by how the frame was drawn**.

```sh
uv run --extra cv python eval/make_fixtures.py     # deterministic; fixed seed, fixed geometry
uv run --extra cv python eval/caption_quality.py   # exits 1 if any check fails
```

`caption_quality.py` drives the **signed worker entrypoint** — one subprocess per fixture
speaking the real JSON-line protocol, exactly as the host does — so it measures the shipped
path end to end: schema, grammar, keyframe choice, normalisation, model.

## Result, 2026-09-08 · SmolVLM2-2.2B-Instruct-Q4_K_M · M-series, CPU+Metal

**9/9 checks pass**, ~11 s per shot.

| fixture | check | result |
| --- | --- | --- |
| flat-grey | `declines_cleanly` | declines with no summary, **not retryable** |
| colour-bars | `no_person` · `no_false_text` · `schema_valid` | pass |
| noise | `no_person` · `no_false_text` · `schema_valid` | pass |
| slate | `reads_text` · `schema_valid` | `onScreenText == ["SCENE 4 TAKE 2"]` |

It found three real defects on its first run, all now fixed:

1. **`onScreenText` came back as sixteen identical copies** of the slate's line — exactly
   `MAX_ON_SCREEN_TEXT_ITEMS`. Bounding the array stopped the decoder running away; it did
   not stop it filling the bound with one repeated line. Deduplicated now, in the pack and
   in the engine mirror, first occurrence winning.
2. **A featureless frame failed its whole batch.** SmolVLM2 returns a parseable object
   with an empty summary for flat grey, every time. That failed the whole request — up to
   16 shots — so one fade to black denied tier 2 to fifteen describable shots beside it,
   and it was marked retryable, so it did so again on every pass. Now the declined shot is
   skipped and its neighbours still describe; only an all-declined request fails, and it
   fails **not retryable**.
3. The eval itself: scoring the decline as a failure would have made a correct refusal look
   like a bug. A frame with nothing in it is allowed to produce nothing.

## What this does NOT say

- **Nothing about description quality on real footage.** Passing means the model does not
  invent people or text on a blank frame and can read a title card. That is a floor.
- The model **collapses fields**: `subject`, `action` and `setting` all came back as
  `"the image content"` on the abstract fixtures and `"scene 4 take 2"` on the slate.
  Recorded, not scored — filler is not the same failure as a hallucination, and no
  threshold here would be anything but taste.
- VU6.5's ≥80% subject/setting agreement still needs the human labelling pass
  (`packages/ai-sdk/scripts/contact-sheet.mjs` exists to make it possible in one sitting).

The fixtures are committed as source (`make_fixtures.py`), not as media — regenerate them.
