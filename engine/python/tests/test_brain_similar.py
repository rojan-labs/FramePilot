"""Tests for semantic ingest + similarity ranking + blending (plan B3.2/B3.3).

Pure-function coverage with an injected fake embedder — no model weights, no
optional extra, fully deterministic (100% coverage core module).
"""

from __future__ import annotations

import math
from collections.abc import Sequence

import pytest

from framepilot_engine.brain import (
    AssetDigest,
    SearchHit,
    SearchHitType,
    TranscriptUtterance,
    VisualCaptionRow,
    blend_hits,
    build_embedding_rows,
    semantic_hits,
)


class FakeEmbedder:
    """Keyword-axis embedder: deterministic, meaningful cosine geometry."""

    model_id = "fake:test"
    dim = 3

    _AXES = ("budget", "welcome", "clip")

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        vectors = []
        for text in texts:
            t = text.lower()
            raw = [float(axis in t) for axis in self._AXES]
            norm = math.sqrt(sum(x * x for x in raw)) or 1.0
            vectors.append([x / norm for x in raw])
        return vectors


def _utterances() -> list[TranscriptUtterance]:
    return [
        TranscriptUtterance(start=0.0, end=0.9, text="welcome everyone"),
        TranscriptUtterance(start=5.0, end=5.9, text="the budget review"),
    ]


def _digests() -> list[AssetDigest]:
    return [AssetDigest(asset_id="asset_1", path="clip.mp4", text="## asset_1 (clip.mp4)")]


def _captions() -> list[VisualCaptionRow]:
    return [
        VisualCaptionRow(
            asset_id="asset_1", scene_index=2, t0=8.0, t1=12.0, text="a budget spreadsheet",
            model="vlm:test",
        )
    ]


# --- build_embedding_rows (B3.2) ---------------------------------------------------


def test_build_embedding_rows_embeds_utterances_and_digests_in_one_batch() -> None:
    rows = build_embedding_rows(FakeEmbedder(), _utterances(), _digests())
    assert [(r.owner_type, r.owner_id) for r in rows] == [
        ("utterance", "utt:00000"),
        ("utterance", "utt:00001"),
        ("asset", "asset_1"),
    ]
    assert all(r.model == "fake:test" and r.dim == 3 for r in rows)
    assert rows[1].payload == {"start": 5.0, "end": 5.9, "text": "the budget review"}
    assert rows[2].payload == {"path": "clip.mp4"}
    assert rows[1].vector == [1.0, 0.0, 0.0]  # "budget" axis


def test_build_embedding_rows_empty_inputs_short_circuit() -> None:
    assert build_embedding_rows(FakeEmbedder(), [], []) == []


def test_build_embedding_rows_captions_are_optional_and_backcompat() -> None:
    # Existing callers pass no captions — the row set is unchanged.
    without = build_embedding_rows(FakeEmbedder(), _utterances(), _digests())
    assert all(r.owner_type != "caption" for r in without)


def test_build_embedding_rows_includes_caption_rows_in_one_batch() -> None:
    class CountingEmbedder(FakeEmbedder):
        calls = 0

        def embed(self, texts: Sequence[str]) -> list[list[float]]:
            CountingEmbedder.calls += 1
            return super().embed(texts)

    rows = build_embedding_rows(CountingEmbedder(), _utterances(), _digests(), _captions())
    # Utterances + digests + captions all embedded in a SINGLE batch call.
    assert CountingEmbedder.calls == 1
    caption_rows = [r for r in rows if r.owner_type == "caption"]
    assert len(caption_rows) == 1
    row = caption_rows[0]
    assert row.owner_id == "cap:asset_1:2:8.0"  # keyed to the visual_captions PK
    assert row.model == "fake:test"
    assert row.payload == {
        "assetId": "asset_1",
        "sceneIndex": 2,
        "t0": 8.0,
        "t1": 12.0,
        "text": "a budget spreadsheet",
    }
    assert row.vector == [1.0, 0.0, 0.0]  # "budget" axis


def test_semantic_hits_rebuilds_caption_hits() -> None:
    rows = build_embedding_rows(FakeEmbedder(), [], [], _captions())
    [hit] = semantic_hits(FakeEmbedder(), "budget", rows, limit=5)
    assert hit.type is SearchHitType.CAPTION
    assert hit.asset_id == "asset_1"
    assert hit.start == 8.0 and hit.end == 12.0
    assert hit.snippet == "a budget spreadsheet"


def test_semantic_hits_caption_without_asset_id_payload() -> None:
    [row] = build_embedding_rows(FakeEmbedder(), [], [], _captions())
    bare = row.model_copy(update={"payload": {"text": "a budget spreadsheet"}})
    [hit] = semantic_hits(FakeEmbedder(), "budget", [bare], limit=5)
    assert hit.type is SearchHitType.CAPTION
    assert hit.asset_id is None
    assert hit.start == 0.0 and hit.end == 0.0


# --- semantic_hits (B3.3) ----------------------------------------------------------


def test_semantic_hits_ranks_by_cosine_and_rebuilds_typed_hits() -> None:
    rows = build_embedding_rows(FakeEmbedder(), _utterances(), _digests())
    hits = semantic_hits(FakeEmbedder(), "budget", rows, limit=10)
    assert hits[0].type is SearchHitType.TRANSCRIPT
    assert hits[0].start == 5.0 and hits[0].end == 5.9
    assert hits[0].snippet == "the budget review"
    assert hits[0].score == 1.0  # (cos 1.0 + 1) / 2
    # The others are orthogonal to "budget" → 0.5 after the [0,1] shift.
    assert {h.score for h in hits[1:]} == {0.5}
    asset_hit = next(h for h in hits if h.type is SearchHitType.ASSET)
    assert asset_hit.asset_id == "asset_1" and asset_hit.snippet == "clip.mp4"


def test_semantic_hits_respects_limit_and_degenerate_inputs() -> None:
    rows = build_embedding_rows(FakeEmbedder(), _utterances(), _digests())
    assert len(semantic_hits(FakeEmbedder(), "budget", rows, limit=1)) == 1
    assert semantic_hits(FakeEmbedder(), "   ", rows, limit=5) == []
    assert semantic_hits(FakeEmbedder(), "budget", [], limit=5) == []


def test_semantic_hits_truncates_long_snippets() -> None:
    long_text = "budget " + "word " * 60
    rows = build_embedding_rows(
        FakeEmbedder(), [TranscriptUtterance(start=0.0, end=1.0, text=long_text)], []
    )
    [hit] = semantic_hits(FakeEmbedder(), "budget", rows, limit=1)
    assert hit.snippet.endswith("…") and len(hit.snippet) <= 121


def test_semantic_hits_tolerates_missing_payload() -> None:
    rows = build_embedding_rows(FakeEmbedder(), _utterances(), [])
    bare = [row.model_copy(update={"payload": None}) for row in rows]
    hits = semantic_hits(FakeEmbedder(), "budget", bare, limit=5)
    assert all(h.start == 0.0 and h.snippet == "" for h in hits)


# --- blend_hits (B3.3) ---------------------------------------------------------------


def _hit(
    hit_type: SearchHitType,
    score: float,
    *,
    start: float | None = None,
    end: float | None = None,
    asset_id: str | None = None,
    snippet: str = "s",
) -> SearchHit:
    return SearchHit(
        type=hit_type, start=start, end=end, asset_id=asset_id, snippet=snippet, score=score
    )


def test_blend_agreement_outranks_either_signal_alone() -> None:
    semantic = [
        _hit(SearchHitType.TRANSCRIPT, 1.0, start=5.0, end=5.9, snippet="the budget review"),
        _hit(SearchHitType.TRANSCRIPT, 0.9, start=0.0, end=0.9, snippet="welcome everyone"),
    ]
    keyword = [_hit(SearchHitType.TRANSCRIPT, 2.5, start=5.0, end=5.9, snippet="[budget]")]
    blended = blend_hits(semantic, keyword, limit=10)
    # 0.6*1.0 + 0.4*1.0 = 1.0 for the agreed hit; 0.6*0.9 for the other.
    assert blended[0].start == 5.0 and blended[0].score == 1.0
    assert blended[0].snippet == "the budget review"  # semantic snippet wins
    assert blended[1].score == pytest.approx(0.54)


def test_blend_keyword_only_and_semantic_only_hits_keep_their_weight() -> None:
    semantic = [_hit(SearchHitType.TRANSCRIPT, 0.8, start=1.0, end=2.0)]
    keyword = [_hit(SearchHitType.ASSET, 1.5, asset_id="a1")]
    blended = blend_hits(semantic, keyword, limit=10)
    scores = {(h.type, h.score) for h in blended}
    # Each list normalizes by its own best → both are 1.0 pre-weighting.
    assert (SearchHitType.TRANSCRIPT, 0.6) in scores
    assert (SearchHitType.ASSET, 0.4) in scores


def test_blend_deduplicates_within_one_list_keeping_the_best() -> None:
    keyword = [
        _hit(SearchHitType.TRANSCRIPT, 2.0, start=1.0, end=2.0, snippet="best"),
        _hit(SearchHitType.TRANSCRIPT, 1.0, start=1.0, end=2.0, snippet="worse"),
    ]
    blended = blend_hits([], keyword, limit=10)
    assert len(blended) == 1 and blended[0].snippet == "best"


def test_blend_zero_scores_do_not_divide_by_zero() -> None:
    keyword = [_hit(SearchHitType.ASSET, 0.0, asset_id="a1")]
    blended = blend_hits([], keyword, limit=10)
    assert blended[0].score == 0.0


def test_blend_respects_limit_and_is_deterministic_on_ties() -> None:
    keyword = [
        _hit(SearchHitType.ASSET, 1.0, asset_id="b"),
        _hit(SearchHitType.ASSET, 1.0, asset_id="a"),
    ]
    blended = blend_hits([], keyword, limit=2)
    assert [h.asset_id for h in blended] == ["a", "b"]
    assert len(blend_hits([], keyword, limit=1)) == 1
    assert blend_hits([], [], limit=5) == []
