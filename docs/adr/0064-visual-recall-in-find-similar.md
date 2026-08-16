# ADR 0064 — Do NOT blend visual recall into `find_similar` (keep it in `search_visual`)

- **Status:** Accepted (no-ship)
- **Date:** 2026-07-18
- **Plan:** `plan/PLAN.md` MI7.3 (Media Intelligence eval gate; §3.5 deferred this)
- **Relates to:** ADR 0058 (Project Brain substrate), MI5.1/MI5.2 (`search_visual`
  RRF fusion), MI3.2 (caption TEXT embedded into the `find_similar` space)
- **Packages:** `engine/python/framepilot_engine/brain/` (`similar.py`,
  `visual_search.py`), eval `engine/python/tests/test_brain_similar_visual_eval.py`

## Context

Plan §3.5 shipped visual search as its **own** tool — `search_visual`, which fuses
three recall modalities by reciprocal-rank fusion (nemotron image-vector KNN + FTS over
captions/transcript + ONNX text-vector search) and returns evidence packets with
timeline projection and transcript overlap. It deliberately deferred one question to an
evaluation gate: should the raw **image-vector** signal ALSO be folded into
`find_similar`?

`find_similar` today = `blend_hits(semantic, keyword)`: a normalized weighted merge of
brute-force cosine over stored **text** embeddings (utterances + asset digests + **caption
text**, which MI3.2 already embeds into the same space) and FTS keyword hits. So
`find_similar` already benefits from captions in text form. What it does not have is the
cross-modal image vector — recall that fires when a moment is *visually distinctive but
thin in text*.

The §3.5 rule was explicit: **ship the blend only if it measurably improves on a golden
set; otherwise keep the tools separate and document why.**

## What we measured

A deterministic, network-free eval (`test_brain_similar_visual_eval.py`) builds two
honest vector spaces — a **text** bag-of-words space (what `find_similar` ranks today)
and a **cross-modal** visual-concept space (query text + the image's ground-truth
content, what the visual lane gives `search_visual`). Relevance is ground truth by
construction. Five golden cases mix three regimes: dialogue, good-caption b-roll, and
*thin-caption* b-roll (a VLM caption so generic it drops the subject — "a shot of an
object"). A prototype 3-way blend (`blend_hits_with_visual`, `VISUAL_WEIGHT = 0.5`,
reusing `similar._normalized`/`_merge_key`) folds the image lane in as a `CAPTION` hit
keyed to the span, so image and caption recall reinforce on identity.

Two biases were chosen to be **generous to the visual signal**, so the conclusion is
robust: bag-of-words understates real text recall (no synonyms), and thin captions are
weighted at 2/5 (40%) though in production they are a rare tail.

| set                        | metric | baseline | +visual | delta |
| -------------------------- | ------ | -------- | ------- | ----- |
| ALL (5 cases)              | P@1    | 0.600    | 1.000   | +0.400 |
| ALL (5 cases)              | MRR    | 0.600    | 1.000   | +0.400 |
| good-caption + dialogue    | MRR    | 1.000    | 1.000   | **+0.000** |
| thin-caption (tail)        | MRR    | 0.000    | 1.000   | **+1.000** |

Reading: the aggregate lift is real, but it is **entirely** in the caption-failure tail.
On well-captioned + dialogue footage — the common case — the visual lane adds *exactly
zero*, because the caption text already carried the concept into `find_similar`'s space.
On the thin-caption tail, text recall is helpless and the image lane is the sole
recovery — which is precisely the case `search_visual` was built to serve.

## Decision

**Do not blend the visual-vector signal into `find_similar`. Keep the two tools
separate.** `similar.py` is unchanged; the prototype blend and the eval live in the test
module only.

Rationale, on the evidence:

1. **The win is confined to the caption-failure tail, and that tail is already served —
   better — by `search_visual`.** For the thin-caption case, `search_visual` returns not
   just the span but an evidence packet (fused multi-source agreement, scene caption,
   transcript overlap, timeline projection). Folding a weaker version of that into
   `find_similar` duplicates a dedicated capability with less context.
2. **Zero benefit on the common case.** Because captions are embedded as text (MI3.2),
   well-captioned footage already surfaces in `find_similar`; the image lane is pure
   redundancy there.
3. **Heavy new dependency on a pure text function.** `find_similar` in `service.py` needs
   only stored text embeddings + FTS. Wiring visual in would require the sqlite-vec
   vector store, the loaded cross-modal (nemotron) embedder, `visual_spans` rows, and the
   project's clips for timeline projection — the full `search_visual` stack — grafted
   onto a function whose value is its simplicity.
4. **Result-ordering/shape change for existing callers.** Injecting `CAPTION` hits from
   the image lane reorders `find_similar` results; per the MI7.3 constraint, that is a
   reason to lean no-ship unless the win is large, and here the realistic win (a rare
   tail already covered elsewhere) is not.
5. **Semantic ambiguity.** Blending image recall silently changes what "moments like X"
   means. Users who want visual recall should reach for it explicitly (`search_visual`);
   users asking `find_similar` a text/dialogue question should not have b-roll promoted by
   an image match they never asked for (guarded by `VISUAL_MIN_COSINE`: a text-only query
   injects no visual hits).

## Consequences

- The eval is committed as a **guard**: it pins the numbers above, so this decision is
  reproducible and revisitable. If caption quality regresses, or a real cross-modal
  encoder shows a win on the *good-caption* regime (semantic gap the bag-of-words proxy
  cannot model), re-run the eval — a nonzero good-caption delta would reopen this ADR.
- `search_visual` remains the single home for image-vector recall.
- No schema change, no public-surface change, no behaviour change to `find_similar`.
