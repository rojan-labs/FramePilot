"""Unit tests for the pure visual-search fusion + span math (plan MI5.1/MI5.2).

This is the deterministic core (plan §6): reciprocal-rank fusion, span→timeline
projection, and transcript overlap are exercised here to 100% branch coverage
with hand-built inputs — no NVIDIA, no SQLite, no ffmpeg.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest

from framepilot_engine.brain.fts import segment_utterances
from framepilot_engine.brain.models import (
    SearchHit,
    SearchHitType,
    VisualCaptionRow,
    VisualSpanRow,
)
from framepilot_engine.brain.vector_store import VisualHit
from framepilot_engine.brain.visual_search import (
    RRF_K,
    SOURCE_CAPTION_FTS,
    SOURCE_SEMANTIC,
    SOURCE_TRANSCRIPT,
    SOURCE_VISUAL,
    WORD_EDGE_TOLERANCE_SECONDS,
    EvidencePacket,
    RankedList,
    build_evidence_packets,
    project_span_to_timeline,
    reciprocal_rank_fusion,
    transcript_overlap,
)

MODEL = "nvidia/llama-nemotron-embed-vl-1b-v2"
_SAMPLER = 1


@dataclass(frozen=True)
class _Clip:
    """Minimal SupportsClip stand-in (mirrors timeline.models.Clip fields)."""

    asset_id: str
    start: float
    end: float
    source_start: float = 0.0
    source_end: float | None = None
    speed: float | None = None


def _span(asset_id: str, t0: float, t1: float, *, scene: int = 0) -> VisualSpanRow:
    return VisualSpanRow(
        asset_id=asset_id,
        model=MODEL,
        sampler_version=_SAMPLER,
        t0=t0,
        t1=t1,
        scene_index=scene,
        keyframe_t=t0,
        phash=1,
        content_hash=f"sha-{asset_id}",
        frame_count=1,
    )


def _vhit(asset_id: str, t0: float, t1: float, score: float, *, scene: int = 0) -> VisualHit:
    return VisualHit(asset_id=asset_id, t0=t0, t1=t1, scene_index=scene, score=score)


def _caption_hit(asset_id: str, t0: float, t1: float, score: float) -> SearchHit:
    return SearchHit(
        type=SearchHitType.CAPTION, asset_id=asset_id, start=t0, end=t1, snippet="cap", score=score
    )


def _transcript_hit(start: float, end: float, score: float, text: str = "hi") -> SearchHit:
    return SearchHit(
        type=SearchHitType.TRANSCRIPT, start=start, end=end, snippet=text, score=score
    )


# --- reciprocal_rank_fusion -----------------------------------------------------


def test_rrf_empty_returns_empty() -> None:
    assert reciprocal_rank_fusion([]) == []


def test_rrf_single_list_ranks_by_position() -> None:
    fused = reciprocal_rank_fusion(
        [RankedList(SOURCE_VISUAL, [("a", 0.0), ("a", 1.0)])]
    )
    assert [f.key for f in fused] == [("a", 0.0), ("a", 1.0)]
    assert fused[0].score == 1.0 / (RRF_K + 1)
    assert fused[1].score == 1.0 / (RRF_K + 2)
    assert fused[0].sources == [SOURCE_VISUAL]


def test_rrf_collapses_repeats_to_best_rank() -> None:
    # The span appears twice in one list; it must be counted once, at rank 1.
    fused = reciprocal_rank_fusion(
        [RankedList(SOURCE_CAPTION_FTS, [("a", 0.0), ("a", 0.0), ("b", 1.0)])]
    )
    by_key = {f.key: f for f in fused}
    assert by_key[("a", 0.0)].score == 1.0 / (RRF_K + 1)
    assert by_key[("b", 1.0)].score == 1.0 / (RRF_K + 2)


def test_rrf_accumulates_across_lists_and_dedupes_sources() -> None:
    fused = reciprocal_rank_fusion(
        [
            RankedList(SOURCE_VISUAL, [("a", 0.0)]),
            RankedList(SOURCE_CAPTION_FTS, [("a", 0.0)]),
            RankedList(SOURCE_VISUAL, [("a", 0.0)]),  # same source label again
        ]
    )
    assert len(fused) == 1
    assert fused[0].score == 3.0 / (RRF_K + 1)
    # Sources dedupe, order of first appearance preserved.
    assert fused[0].sources == [SOURCE_VISUAL, SOURCE_CAPTION_FTS]


def test_rrf_sorts_by_score_then_key() -> None:
    # ("b",0) hit by two lists outranks ("a",0) hit by one, despite key order.
    fused = reciprocal_rank_fusion(
        [
            RankedList(SOURCE_VISUAL, [("a", 0.0), ("b", 0.0)]),
            RankedList(SOURCE_CAPTION_FTS, [("b", 0.0)]),
        ]
    )
    assert [f.key for f in fused] == [("b", 0.0), ("a", 0.0)]


# --- project_span_to_timeline ---------------------------------------------------


def test_projection_identity_clip() -> None:
    # source_end derived from timeline duration at speed 1: window [0, 5).
    clips = [_Clip("a", start=0.0, end=5.0)]
    assert project_span_to_timeline(1.0, 2.0, clips) == [(1.0, 2.0)]


def test_projection_offset_and_source_window() -> None:
    # Clip plays source [10, 20) at timeline [100, 110). Span [12, 14) → [102, 104).
    clips = [_Clip("a", start=100.0, end=110.0, source_start=10.0, source_end=20.0)]
    assert project_span_to_timeline(12.0, 14.0, clips) == [(102.0, 104.0)]


def test_projection_respects_speed() -> None:
    # 2x speed: source [0, 10) compresses to timeline [0, 5). Span [4, 6) → [2, 3).
    clips = [_Clip("a", start=0.0, end=5.0, source_start=0.0, source_end=10.0, speed=2.0)]
    assert project_span_to_timeline(4.0, 6.0, clips) == [(2.0, 3.0)]


def test_projection_clips_span_to_window_edges() -> None:
    # Span [8, 25) partly outside the clip window [10, 20) → clamped to [10, 20).
    clips = [_Clip("a", start=0.0, end=10.0, source_start=10.0, source_end=20.0)]
    assert project_span_to_timeline(8.0, 25.0, clips) == [(0.0, 10.0)]


def test_projection_span_outside_window_is_skipped() -> None:
    clips = [_Clip("a", start=0.0, end=5.0, source_start=100.0, source_end=105.0)]
    assert project_span_to_timeline(1.0, 2.0, clips) == []


def test_projection_multiple_clips_sorted() -> None:
    clips = [
        _Clip("a", start=50.0, end=55.0, source_start=0.0, source_end=5.0),
        _Clip("a", start=0.0, end=5.0, source_start=0.0, source_end=5.0),
    ]
    assert project_span_to_timeline(1.0, 2.0, clips) == [(1.0, 2.0), (51.0, 52.0)]


def test_projection_point_span_image() -> None:
    # Image span [0, 0): a point, mapped to a point range.
    clips = [_Clip("a", start=3.0, end=8.0, source_start=0.0, source_end=5.0)]
    assert project_span_to_timeline(0.0, 0.0, clips) == [(3.0, 3.0)]


def test_projection_no_clips() -> None:
    assert project_span_to_timeline(1.0, 2.0, []) == []


# --- transcript_overlap ---------------------------------------------------------


@dataclass(frozen=True)
class _Word:
    """Shaped like ``timeline.models.TranscriptWord`` (the ``SupportsWord`` protocol)."""

    word: str
    start: float
    end: float


def _w(start: float, end: float, text: str) -> _Word:
    return _Word(word=text, start=start, end=end)


#: A fast talker: a 0.22 s word every 0.3 s for 50 s, never pausing the 0.6 s that
#: `segment_utterances` needs to start a new utterance — the captured run's narration.
_WORD_STRIDE = 0.3
_WORD_LENGTH = 0.22
_MONOLOGUE = [
    _w(i * _WORD_STRIDE, i * _WORD_STRIDE + _WORD_LENGTH, f"w{i}")
    for i in range(int(50.0 / _WORD_STRIDE))
]


def test_overlap_empty_ranges() -> None:
    assert transcript_overlap([], [_w(0.0, 1.0, "hi")]) == ""


def test_overlap_empty_words() -> None:
    assert transcript_overlap([(0.0, 1.0)], []) == ""


def test_overlap_joins_in_transcript_order() -> None:
    words = [_w(0.0, 1.0, "hello"), _w(5.0, 6.0, "world")]
    assert transcript_overlap([(0.0, 6.0)], words) == "hello world"


def test_overlap_excludes_non_overlapping() -> None:
    words = [_w(0.0, 1.0, "hello"), _w(50.0, 51.0, "later")]
    assert transcript_overlap([(0.0, 2.0)], words) == "hello"


def test_overlap_counts_word_once_across_ranges() -> None:
    words = [_w(0.0, 10.0, "spanning")]
    assert transcript_overlap([(1.0, 2.0), (8.0, 9.0)], words) == "spanning"


def test_overlap_is_the_words_under_a_short_placement_not_the_whole_utterance() -> None:
    """THE DEFECT: a 1.1 s stock placement over a monologue got all 50 seconds of it.

    The narration is ONE utterance (the precondition that made the old
    utterance-level overlap return everything). A clip placed for 1.1 s must read
    back only the words spoken in that 1.1 s, plus the two that straddle its edges.
    """
    assert len(segment_utterances(_MONOLOGUE)) == 1
    clip = _Clip("stock", start=20.0, end=21.1, source_start=0.5, source_end=1.6)
    ranges = project_span_to_timeline(0.0, 8.0, [clip])
    assert ranges == [pytest.approx((20.0, 21.1))]
    # w66 [19.8, 20.02] and w70 [21.0, 21.22] straddle the edges and are kept; w65 ends
    # 0.28 s before the cut and w71 starts 0.2 s after it — both past the tolerance.
    assert transcript_overlap(ranges, _MONOLOGUE) == "w66 w67 w68 w69 w70"


def test_overlap_keeps_an_edge_word_within_the_tolerance() -> None:
    near = _w(19.9 - WORD_EDGE_TOLERANCE_SECONDS, 19.95, "near")  # ends 0.05 s early
    far = _w(19.0, 20.0 - WORD_EDGE_TOLERANCE_SECONDS - 0.05, "far")  # ends 0.2 s early
    inside = _w(20.2, 20.5, "inside")
    assert transcript_overlap([(20.0, 21.0)], [far, near, inside]) == "near inside"


def test_overlap_marks_a_gap_between_disjoint_runs() -> None:
    # The same footage placed twice: the two moments must not read as one sentence.
    words = [_w(0.0, 0.4, "first"), _w(5.0, 5.4, "between"), _w(10.0, 10.4, "second")]
    assert transcript_overlap([(0.0, 1.0), (10.0, 11.0)], words) == "first … second"


def test_overlap_trims_and_skips_blank_words() -> None:
    words = [_w(0.0, 0.2, " hello"), _w(0.3, 0.4, "  "), _w(0.5, 0.7, "world ")]
    assert transcript_overlap([(0.0, 1.0)], words) == "hello world"


# --- build_evidence_packets -----------------------------------------------------


def _packets(**kwargs: Any) -> list[EvidencePacket]:
    base: dict[str, Any] = {
        "visual_hits": [],
        "caption_fts_hits": [],
        "transcript_fts_hits": [],
        "semantic_hits": [],
        "spans": [],
        "captions": [],
        "clips": [],
        "words": [],
        "k": 8,
    }
    base.update(kwargs)
    return build_evidence_packets(**base)


def test_packets_k_zero_returns_empty() -> None:
    result = _packets(visual_hits=[_vhit("a", 0.0, 1.0, 0.9)], spans=[_span("a", 0.0, 1.0)], k=0)
    assert result == []


def test_packets_visual_only() -> None:
    spans = [_span("a", 0.0, 1.0, scene=0), _span("a", 1.0, 2.0, scene=1)]
    hits = [_vhit("a", 0.0, 1.0, 0.9, scene=0), _vhit("a", 1.0, 2.0, 0.5, scene=1)]
    packets = _packets(visual_hits=hits, spans=spans)
    assert [(p.asset_id, p.t0, p.scene_index) for p in packets] == [("a", 0.0, 0), ("a", 1.0, 1)]
    assert packets[0].sources == [SOURCE_VISUAL]
    assert packets[0].score > packets[1].score
    assert packets[0].caption is None
    assert packets[0].transcript_overlap == ""


def test_packets_visual_hit_without_span_row_resolves_from_hit_meta() -> None:
    # spans list empty, but the visual hit is self-sufficient (carries t1/scene).
    packets = _packets(visual_hits=[_vhit("a", 2.0, 3.0, 0.9, scene=4)], spans=[])
    assert len(packets) == 1
    assert packets[0].t1 == 3.0 and packets[0].scene_index == 4


def test_packets_caption_fts_lifts_scene_spans_and_attaches_caption() -> None:
    spans = [_span("a", 0.0, 1.0, scene=0)]
    captions = [
        VisualCaptionRow(
            asset_id="a", scene_index=0, t0=0.0, t1=1.0, text="A dog runs.", model="claude-x"
        )
    ]
    packets = _packets(
        caption_fts_hits=[_caption_hit("a", 0.0, 1.0, 3.0)], spans=spans, captions=captions
    )
    assert len(packets) == 1
    assert packets[0].sources == [SOURCE_CAPTION_FTS]
    assert packets[0].caption == "A dog runs."


def test_packets_caption_fts_ignores_other_assets_and_non_overlapping_spans() -> None:
    # Caption hit for asset "a" span [0,1); the pool also has a different asset
    # ("b") and a non-overlapping "a" span [10,11) — both must be skipped.
    spans = [_span("a", 0.0, 1.0, scene=0), _span("a", 10.0, 11.0, scene=1), _span("b", 0.0, 1.0)]
    packets = _packets(caption_fts_hits=[_caption_hit("a", 0.0, 1.0, 3.0)], spans=spans)
    assert [(p.asset_id, p.t0) for p in packets] == [("a", 0.0)]


def test_packets_transcript_lane_needs_clips_for_projection() -> None:
    spans = [_span("a", 1.0, 2.0, scene=0)]
    clips = [_Clip("a", start=0.0, end=5.0)]  # identity → span [1,2) at timeline [1,2)
    words = [_w(1.0, 1.4, "spoken"), _w(1.5, 2.0, "here")]
    packets = _packets(
        transcript_fts_hits=[_transcript_hit(1.0, 2.0, 2.0)],
        spans=spans,
        clips=clips,
        words=words,
    )
    assert len(packets) == 1
    assert packets[0].sources == [SOURCE_TRANSCRIPT]
    assert packets[0].transcript_overlap == "spoken here"


def test_packets_transcript_lane_no_clips_yields_no_transcript_hits() -> None:
    # Without clips a transcript hit cannot project onto any span → no fusion.
    spans = [_span("a", 1.0, 2.0)]
    packets = _packets(transcript_fts_hits=[_transcript_hit(1.0, 2.0, 2.0)], spans=spans)
    assert packets == []


def test_packets_semantic_lane_caption_and_transcript_types() -> None:
    spans = [_span("a", 0.0, 1.0, scene=0)]
    clips = [_Clip("a", start=0.0, end=1.0)]
    # A semantic caption-type hit AND a semantic transcript-type hit, plus an
    # ASSET-type hit that must be skipped (carries no span).
    semantic = [
        _caption_hit("a", 0.0, 1.0, 0.9),
        _transcript_hit(0.0, 1.0, 0.8),
        SearchHit(type=SearchHitType.ASSET, asset_id="a", snippet="a.mp4", score=0.1),
    ]
    packets = _packets(
        semantic_hits=semantic, spans=spans, clips=clips, words=[_w(0.0, 1.0, "hey")]
    )
    assert len(packets) == 1
    assert packets[0].sources == [SOURCE_SEMANTIC]
    assert packets[0].transcript_overlap == "hey"


def test_packets_multi_source_agreement_outranks_single() -> None:
    spans = [_span("a", 0.0, 1.0, scene=0), _span("a", 1.0, 2.0, scene=1)]
    visual = [_vhit("a", 0.0, 1.0, 0.6, scene=0), _vhit("a", 1.0, 2.0, 0.9, scene=1)]
    # Caption search agrees with the FIRST span only; RRF should lift it above
    # the visually-stronger-but-caption-less second span.
    captions_fts = [_caption_hit("a", 0.0, 1.0, 3.0)]
    packets = _packets(visual_hits=visual, caption_fts_hits=captions_fts, spans=spans)
    assert packets[0].t0 == 0.0
    assert set(packets[0].sources) == {SOURCE_VISUAL, SOURCE_CAPTION_FTS}


def test_packets_asset_ids_filter_excludes_other_assets() -> None:
    spans = [_span("a", 0.0, 1.0), _span("b", 0.0, 1.0)]
    hits = [_vhit("a", 0.0, 1.0, 0.9), _vhit("b", 0.0, 1.0, 0.9)]
    packets = _packets(visual_hits=hits, spans=spans, asset_ids=["a"])
    assert {p.asset_id for p in packets} == {"a"}


def test_packets_time_range_filter_real_and_point_spans() -> None:
    spans = [_span("a", 0.0, 1.0), _span("a", 10.0, 11.0), _span("b", 5.0, 5.0)]
    hits = [
        _vhit("a", 0.0, 1.0, 0.9),
        _vhit("a", 10.0, 11.0, 0.9),
        _vhit("b", 5.0, 5.0, 0.9),  # point span in range
    ]
    packets = _packets(visual_hits=hits, spans=spans, time_range=(0.5, 6.0))
    got = {(p.asset_id, p.t0) for p in packets}
    # Real span [0,1) overlaps [0.5,6]; [10,11) excluded; point [5,5] included.
    assert got == {("a", 0.0), ("b", 5.0)}


def test_packets_caption_hit_missing_times_defaults() -> None:
    # A caption hit with no start/end still lifts spans (defaults to 0.0 window).
    spans = [_span("a", 0.0, 1.0, scene=0)]
    hit = SearchHit(type=SearchHitType.CAPTION, asset_id="a", snippet="cap", score=1.0)
    packets = _packets(caption_fts_hits=[hit], spans=spans)
    assert len(packets) == 1


def test_packets_caption_hit_without_asset_id_skipped() -> None:
    hit = SearchHit(
        type=SearchHitType.CAPTION, asset_id=None, start=0.0, end=1.0, snippet="c", score=1.0
    )
    assert _packets(caption_fts_hits=[hit], spans=[_span("a", 0.0, 1.0)]) == []


def test_packets_transcript_hit_missing_end_defaults_to_start() -> None:
    spans = [_span("a", 1.0, 2.0)]
    clips = [_Clip("a", start=0.0, end=5.0)]
    hit = SearchHit(type=SearchHitType.TRANSCRIPT, start=1.5, end=None, snippet="x", score=1.0)
    packets = _packets(transcript_fts_hits=[hit], spans=spans, clips=clips)
    assert len(packets) == 1


def test_packets_respects_k_limit() -> None:
    spans = [_span("a", float(i), float(i) + 1.0, scene=i) for i in range(5)]
    hits = [_vhit("a", float(i), float(i) + 1.0, 1.0 - i * 0.1, scene=i) for i in range(5)]
    packets = _packets(visual_hits=hits, spans=spans, k=2)
    assert len(packets) == 2
