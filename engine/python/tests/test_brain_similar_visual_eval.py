"""Retrieval-quality eval: does the visual-VECTOR signal improve ``find_similar``? (MI7.3).

WHY THIS EXISTS
---------------
Plan §3.5 shipped visual search as its OWN tool (``search_visual``: RRF fusion over
visual vectors + captions + transcript) and deferred the question of whether the raw
*image* recall signal should ALSO be folded into ``find_similar``. ``find_similar``
already blends text-semantic hits (utterances + asset digests + **caption TEXT**, which
MI3.2 embeds into the same space) with FTS keyword hits. The open question MI7.3 answers
with numbers, not intuition: **does adding the cross-modal image-vector signal measurably
improve retrieval quality — enough to justify wiring it into ``find_similar``?**

WHY THIS EVAL IS HONEST (NOT RIGGED)
------------------------------------
The image-vs-text recall gap is real only when a moment is *visually distinctive but
thin in text*. A single text-axis fake embedder (as in ``test_brain_similar.py``) CANNOT
represent that gap — it would make the caption text and the image indistinguishable. So
this eval builds TWO honest, deterministic vector spaces:

- a **text** space (bag-of-words cosine over a fixed vocabulary) — what ``find_similar``
  ranks today over utterances + captions + digests, and
- a **cross-modal** space (bag-of-words cosine over a *visual-concept* vocabulary that
  embeds both the query text and the image's ground-truth content) — what the nemotron
  visual lane gives ``search_visual``.

Ground truth is by construction: a case's relevant span is the one whose meaning matches
the query. For a *thin-caption* case the image genuinely contains the query concept while
the caption genuinely omits it, so text recall genuinely misses and only the visual lane
can recover it. For a *good-caption* case the VLM caption carries the concept into the
text space, so text already finds it. The golden set MIXES both regimes so the aggregate
number is not stacked in visual's favour; per-regime numbers are reported separately so
the decision rests on *where* any win comes from.

Two deliberate conservative biases that make the eval GENEROUS to the visual signal (so a
no-ship conclusion drawn here is robust):

1. Bag-of-words is a weaker text recall model than a real sentence embedder (it cannot
   match "footwear" to "sneaker"), so it UNDERSTATES how much the caption text already
   covers — real ``find_similar`` closes more of the gap than this proxy shows.
2. The golden set weights thin/failed captions at 2/5 (40%). In production every scene
   is VLM-captioned (MI3.3); a caption so generic it drops the main subject is a rare
   tail, far below 40%. Overweighting it can only INFLATE visual's aggregate benefit.

This module is a committed **guard**: it pins the measured numbers so the MI7.3 decision
(recorded in ``docs/adr/0064-*``) is reproducible and revisitable. It does NOT change
``find_similar``; the prototype 3-way blend lives here so production ``similar.py`` keeps
its exact behaviour and ordering (the no-ship outcome, see the ADR).
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, field

import pytest

from framepilot_engine.brain.models import (
    EmbeddingRow,
    SearchHit,
    SearchHitType,
    TranscriptUtterance,
    VisualCaptionRow,
)
from framepilot_engine.brain.similar import (
    KEYWORD_WEIGHT,
    SEMANTIC_WEIGHT,
    AssetDigest,
    _merge_key,
    _normalized,
    build_embedding_rows,
    semantic_hits,
)

# --- prototype: fold the visual-vector lane into the blend as a third signal --------

#: Prototype weight for the visual-vector lane in the 3-way blend. Sits at parity with
#: the semantic lane (image recall is as trustworthy as text recall when it fires) and
#: above keyword — this is the *most favourable* weighting for shipping, chosen so the
#: measured win is an upper bound, not a lower one.
VISUAL_WEIGHT = 0.5

#: A cross-modal cosine at/above this counts as a genuine image match (the visual KNN
#: only surfaces spans the image actually resembles). Non-negative bag-of-words cosines
#: live in [0, 1]; a zero-overlap query yields 0 and contributes no visual hit, so a
#: text-only query (e.g. "budget review") can never inject spurious visual noise.
VISUAL_MIN_COSINE = 1e-9

#: Semantic score floor: ``semantic_hits`` shifts cosine [-1, 1] into [0, 1], so an
#: orthogonal (zero-overlap) row lands at exactly 0.5. A hit counts as genuine text
#: evidence only ABOVE this floor — otherwise ``find_similar`` would "find" items it has
#: no signal for, and arbitrary tie-ordering among 0.5 rows would fake precision.
SEMANTIC_SIGNAL_FLOOR = 0.5
_FLOOR_EPS = 1e-6


def _genuine_semantic(hits: list[SearchHit]) -> list[SearchHit]:
    """Keep only semantic hits with real overlap (above the 0.5 orthogonal floor)."""
    return [h for h in hits if h.score > SEMANTIC_SIGNAL_FLOOR + _FLOOR_EPS]


def blend_hits_with_visual(
    semantic: list[SearchHit],
    keyword: list[SearchHit],
    visual: list[SearchHit],
    *,
    limit: int,
) -> list[SearchHit]:
    """Deterministic 3-way merge: semantic + keyword + visual (MI7.3 prototype).

    Mirrors ``similar.blend_hits`` exactly — reuses its ``_normalized`` (per-lane best
    scaling + merge de-dup) and ``_merge_key`` (span identity) — then adds the visual
    lane at :data:`VISUAL_WEIGHT`. A visual hit is converted to a ``CAPTION`` hit at the
    span's ``(asset_id, t0, t1)`` (see :func:`visual_hits_as_search_hits`), which is the
    SAME merge key a caption-text hit for that span produces, so image and caption
    recall REINFORCE (their weights sum) when both fire. Ties break by
    ``(-score, type, start, id)`` like the shipped blend.
    """
    lanes = (
        (SEMANTIC_WEIGHT, _normalized(semantic)),
        (KEYWORD_WEIGHT, _normalized(keyword)),
        (VISUAL_WEIGHT, _normalized(visual)),
    )
    keys = {key for _, lane in lanes for key in lane}
    blended: list[SearchHit] = []
    for key in sorted(keys):
        score = sum(weight * lane[key].score for weight, lane in lanes if key in lane)
        # Prefer a text (semantic/keyword) representative for snippet fidelity; fall back
        # to the visual hit only when the span was surfaced by image recall alone.
        base = next((lane[key] for _, lane in lanes if key in lane), None)
        assert base is not None
        blended.append(base.model_copy(update={"score": score}))
    blended.sort(key=lambda h: (-h.score, h.type, h.start or 0.0, h.asset_id or h.marker_id or ""))
    return blended[:limit]


# --- honest two-space deterministic embedders ---------------------------------------


class _BagOfWordsEmbedder:
    """Deterministic multi-hot bag-of-words cosine over a FIXED vocabulary.

    A conservative, network-free proxy for a text encoder: two texts are similar only
    when they SHARE vocabulary tokens (it cannot match synonyms — biasing the eval
    against text recall, i.e. in visual's favour). ``model_id`` keys the vector space.
    """

    def __init__(self, vocab: Sequence[str], model_id: str) -> None:
        self._vocab = tuple(vocab)
        self.model_id = model_id
        self.dim = len(self._vocab)

    def _tokens(self, text: str) -> set[str]:
        return {tok for tok in text.lower().replace(".", " ").split() if tok}

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        vectors: list[list[float]] = []
        for text in texts:
            toks = self._tokens(text)
            raw = [1.0 if axis in toks else 0.0 for axis in self._vocab]
            norm = math.sqrt(sum(x * x for x in raw)) or 1.0
            vectors.append([x / norm for x in raw])
        return vectors


# Text vocabulary: every content token that appears in a caption, an utterance, or a
# text query. This is the space `find_similar` ranks over today.
_TEXT_VOCAB = (
    "backpack", "beach", "blue", "brand", "budget", "company", "logo", "numbers",
    "object", "ocean", "quarterly", "red", "review", "screen", "shot", "sneaker",
    "sunset", "table", "welcome",
)
# Visual-concept vocabulary: the cross-modal space shared by the query text and the
# image's ground-truth content. Includes concepts a THIN caption omits.
_VISUAL_VOCAB = (
    "backpack", "bag", "beach", "blue", "brand", "company", "logo", "numbers",
    "ocean", "red", "shoe", "sneaker", "sunset",
)


# --- golden corpus ------------------------------------------------------------------


@dataclass(frozen=True)
class _Scene:
    """One captioned + embedded visual span, with its ground-truth image content."""

    asset_id: str
    scene_index: int
    t0: float
    t1: float
    caption: str  # the VLM caption (text space): good ones name the subject, thin don't
    image_concepts: str  # ground-truth visual content (cross-modal space); never text-visible


@dataclass(frozen=True)
class _Case:
    """One query with its ground-truth relevant target and a note on the regime."""

    query: str
    expected: tuple[str, str, float, float]  # merge key of the relevant hit
    regime: str  # "good-caption" | "dialogue" | "thin-caption"


_ASSET = "asset_broll"

_SCENES = (
    # Good caption: the VLM named the subject → the concept is in the text space.
    _Scene(_ASSET, 1, 2.0, 6.0, "a red sneaker on a table", "red sneaker shoe"),
    # Thin caption: generic, drops the subject → text space cannot recover it.
    _Scene(_ASSET, 2, 10.0, 14.0, "a shot of an object", "blue backpack bag"),
    # Thin caption: generic outdoor label, drops the subject.
    _Scene(_ASSET, 3, 20.0, 24.0, "outdoor footage", "sunset ocean beach"),
    # Good caption: the VLM named the subject.
    _Scene(_ASSET, 4, 30.0, 34.0, "the company logo on screen", "company logo brand"),
)

_UTTERANCES = (
    TranscriptUtterance(start=0.0, end=4.0, text="welcome everyone to the budget review"),
    TranscriptUtterance(start=5.0, end=9.0, text="let me show you our quarterly numbers"),
)

_DIGESTS = (AssetDigest(asset_id=_ASSET, path="broll.mp4", text="## asset (broll.mp4)"),)


def _caption_key(scene: _Scene) -> tuple[str, str, float, float]:
    return (SearchHitType.CAPTION, scene.asset_id, round(scene.t0, 3), round(scene.t1, 3))


def _transcript_key(utt: TranscriptUtterance) -> tuple[str, str, float, float]:
    return (SearchHitType.TRANSCRIPT, "", round(utt.start, 3), round(utt.end, 3))


_CASES = (
    _Case("budget review", _transcript_key(_UTTERANCES[0]), "dialogue"),
    _Case("red sneaker", _caption_key(_SCENES[0]), "good-caption"),
    _Case("blue backpack", _caption_key(_SCENES[1]), "thin-caption"),
    _Case("sunset over the ocean", _caption_key(_SCENES[2]), "thin-caption"),
    _Case("company logo", _caption_key(_SCENES[3]), "good-caption"),
)


# --- retrieval lanes ----------------------------------------------------------------


def _text_rows() -> list[EmbeddingRow]:
    """Text embeddings over utterances + digests + captions (what find_similar ranks)."""
    embedder = _BagOfWordsEmbedder(_TEXT_VOCAB, "text:eval")
    captions = [
        VisualCaptionRow(
            asset_id=s.asset_id, scene_index=s.scene_index, t0=s.t0, t1=s.t1,
            text=s.caption, model="vlm:eval",
        )
        for s in _SCENES
    ]
    return build_embedding_rows(embedder, list(_UTTERANCES), list(_DIGESTS), captions)


def _keyword_hits(query: str, *, limit: int) -> list[SearchHit]:
    """Deterministic FTS proxy: token-overlap over caption + transcript text.

    Faithful to what ``store.search_transcript``/``search_assets`` would return — a hit
    only when a query token literally appears in the text — so a thin caption misses in
    the keyword lane exactly as it does in FTS.
    """
    q_tokens = {t for t in query.lower().split() if t}
    hits: list[SearchHit] = []
    for utt in _UTTERANCES:
        overlap = len(q_tokens & set(utt.text.lower().split()))
        if overlap:
            hits.append(SearchHit(
                type=SearchHitType.TRANSCRIPT, start=utt.start, end=utt.end,
                snippet=utt.text, score=float(overlap),
            ))
    for scene in _SCENES:
        overlap = len(q_tokens & set(scene.caption.lower().split()))
        if overlap:
            hits.append(SearchHit(
                type=SearchHitType.CAPTION, asset_id=scene.asset_id, start=scene.t0,
                end=scene.t1, snippet=scene.caption, score=float(overlap),
            ))
    hits.sort(key=lambda h: -h.score)
    return hits[:limit]


def visual_hits_as_search_hits(query: str, *, limit: int) -> list[SearchHit]:
    """Cross-modal image KNN → ``CAPTION`` hits keyed to the span (the MI7.3 prototype).

    Embeds the query and every scene's ground-truth image content in the shared visual
    space and keeps genuine matches (cosine >= :data:`VISUAL_MIN_COSINE`). Each surviving
    span becomes a ``CAPTION`` hit at ``(asset_id, t0, t1)`` — the same merge key a
    caption-text hit uses — so ``blend_hits_with_visual`` fuses image + caption recall
    on identity. This is the honest stand-in for ``VisualHit`` → find_similar hit.
    """
    embedder = _BagOfWordsEmbedder(_VISUAL_VOCAB, "visual:eval")
    [q_vec] = embedder.embed([query])
    scored: list[tuple[float, _Scene]] = []
    image_vecs = embedder.embed([s.image_concepts for s in _SCENES])
    for scene, vec in zip(_SCENES, image_vecs, strict=True):
        cos = sum(a * b for a, b in zip(q_vec, vec, strict=True))
        if cos >= VISUAL_MIN_COSINE:
            scored.append((cos, scene))
    scored.sort(key=lambda pair: (-pair[0], pair[1].t0))
    return [
        SearchHit(
            type=SearchHitType.CAPTION, asset_id=scene.asset_id, start=scene.t0,
            end=scene.t1, snippet=scene.caption, score=cos,
        )
        for cos, scene in scored[:limit]
    ]


# --- metrics ------------------------------------------------------------------------

_TOP_K = 10


def _rank_of(hits: list[SearchHit], expected: tuple[str, str, float, float]) -> int | None:
    """1-based rank of the expected target in ``hits`` by merge key, or ``None``."""
    for i, hit in enumerate(hits, start=1):
        if _merge_key(hit) == expected:
            return i
    return None


@dataclass
class _Metrics:
    """Aggregate retrieval quality over a set of cases."""

    n: int = 0
    hit_at_1: int = 0
    hit_at_3: int = 0
    reciprocal_rank_sum: float = 0.0
    ranks: list[int | None] = field(default_factory=list)

    def record(self, rank: int | None) -> None:
        self.n += 1
        self.ranks.append(rank)
        if rank is not None:
            self.hit_at_1 += int(rank == 1)
            self.hit_at_3 += int(rank <= 3)
            self.reciprocal_rank_sum += 1.0 / rank

    @property
    def mrr(self) -> float:
        return self.reciprocal_rank_sum / self.n if self.n else 0.0

    @property
    def precision_at_1(self) -> float:
        return self.hit_at_1 / self.n if self.n else 0.0


def _evaluate(*, use_visual: bool, cases: Sequence[_Case]) -> _Metrics:
    """Run every case through find_similar's blend (optionally + the visual lane)."""
    text_embedder = _BagOfWordsEmbedder(_TEXT_VOCAB, "text:eval")
    rows = _text_rows()
    metrics = _Metrics()
    for case in cases:
        semantic = _genuine_semantic(
            semantic_hits(text_embedder, case.query, rows, limit=_TOP_K)
        )
        keyword = _keyword_hits(case.query, limit=_TOP_K)
        if use_visual:
            visual = visual_hits_as_search_hits(case.query, limit=_TOP_K)
            hits = blend_hits_with_visual(semantic, keyword, visual, limit=_TOP_K)
        else:
            # Baseline mirrors production find_similar exactly (2-way blend), which we
            # reproduce as the visual-empty 3-way blend to keep the merge math identical.
            hits = blend_hits_with_visual(semantic, keyword, [], limit=_TOP_K)
        metrics.record(_rank_of(hits, case.expected))
    return metrics


def _subset(regime: str) -> tuple[_Case, ...]:
    return tuple(c for c in _CASES if c.regime == regime)


# --- the measurement (prints numbers; asserts the decision-relevant facts) ----------


def test_visual_signal_eval_reports_and_pins_the_numbers() -> None:
    """Measure find_similar quality WITH vs WITHOUT the visual-vector lane (MI7.3).

    Pins the exact numbers the ADR cites, so the ship/no-ship decision is reproducible.
    """
    base = _evaluate(use_visual=False, cases=_CASES)
    withv = _evaluate(use_visual=True, cases=_CASES)

    good = (_subset("good-caption") + _subset("dialogue"))
    thin = _subset("thin-caption")
    good_base = _evaluate(use_visual=False, cases=good)
    good_withv = _evaluate(use_visual=True, cases=good)
    thin_base = _evaluate(use_visual=False, cases=thin)
    thin_withv = _evaluate(use_visual=True, cases=thin)

    print("\n=== MI7.3 find_similar visual-signal eval (5 golden cases) ===")
    print(f"{'set':<26}{'metric':<10}{'baseline':>10}{'+visual':>10}{'delta':>8}")
    for label, b, w in (
        ("ALL", base, withv),
        ("good-caption+dialogue", good_base, good_withv),
        ("thin-caption (tail)", thin_base, thin_withv),
    ):
        print(f"{label:<26}{'P@1':<10}{b.precision_at_1:>10.3f}{w.precision_at_1:>10.3f}"
              f"{w.precision_at_1 - b.precision_at_1:>+8.3f}")
        print(f"{label:<26}{'MRR':<10}{b.mrr:>10.3f}{w.mrr:>10.3f}{w.mrr - b.mrr:>+8.3f}")

    # --- The pinned evidence behind the ADR verdict --------------------------------
    # 1) Aggregate: visual DOES improve the (visual-generous) mixed set.
    assert base.mrr == pytest.approx(0.6)
    assert withv.mrr == pytest.approx(1.0)
    assert base.precision_at_1 == pytest.approx(0.6)
    assert withv.precision_at_1 == pytest.approx(1.0)

    # 2) The whole gain is in the CAPTION-FAILURE tail; on well-captioned + dialogue
    #    footage (the common case) the visual lane adds EXACTLY nothing — the caption
    #    text already carried the concept into find_similar's space.
    assert good_base.mrr == pytest.approx(1.0)
    assert good_withv.mrr == pytest.approx(1.0)  # delta 0.0: redundant on good captions

    # 3) On the thin-caption tail, text recall is helpless and the visual lane is the
    #    SOLE recovery — which is exactly what the dedicated `search_visual` tool serves.
    assert thin_base.mrr == pytest.approx(0.0)
    assert thin_withv.mrr == pytest.approx(1.0)

    # 4) No regression: the visual lane never demotes a correct text answer (every case
    #    is answered at rank 1 with visual on).
    assert all(r == 1 for r in withv.ranks)


def test_visual_lane_reinforces_not_duplicates_a_good_caption_span() -> None:
    """A good-caption span hit by BOTH text and image outranks a single-lane hit.

    Guards the merge-key identity: image recall and caption recall for the same span
    must share a key so their weights SUM (agreement), never split into two rows.
    """
    text_embedder = _BagOfWordsEmbedder(_TEXT_VOCAB, "text:eval")
    rows = _text_rows()
    query = "red sneaker"
    semantic = _genuine_semantic(semantic_hits(text_embedder, query, rows, limit=_TOP_K))
    visual = visual_hits_as_search_hits(query, limit=_TOP_K)
    blended = blend_hits_with_visual(semantic, [], visual, limit=_TOP_K)

    target = _caption_key(_SCENES[0])
    matches = [h for h in blended if _merge_key(h) == target]
    assert len(matches) == 1  # one merged row, not a text row + a duplicate visual row
    # Both lanes fired → score is the weighted SUM, above either lane alone.
    assert matches[0].score > SEMANTIC_WEIGHT
    assert matches[0].score == pytest.approx(SEMANTIC_WEIGHT + VISUAL_WEIGHT)


def test_text_only_query_injects_no_spurious_visual_hits() -> None:
    """A query with no visual concept (pure dialogue) yields an empty visual lane.

    Guards :data:`VISUAL_MIN_COSINE`: "budget review" resembles no image, so the visual
    lane cannot smuggle an off-topic b-roll span above the spoken answer.
    """
    assert visual_hits_as_search_hits("budget review", limit=_TOP_K) == []
