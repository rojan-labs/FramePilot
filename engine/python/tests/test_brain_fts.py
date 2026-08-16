"""Tests for the brain FTS ingest + search substrate (plan B2.1/B2.2).

The segmentation and match-expression helpers are pure deterministic core
(100% coverage); the store-level FTS methods run against real SQLite so the
MATCH grammar, ranking, and injection-safety claims are exercised for real.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from framepilot_engine.brain import (
    BrainStore,
    SearchHitType,
    TranscriptUtterance,
    VisualCaptionRow,
    fts_match_expression,
    segment_utterances,
)
from framepilot_engine.brain import migrations as brain_migrations
from framepilot_engine.timeline.models import Marker, TranscriptWord

from .test_brain_store import fixed_clock


@pytest.fixture
def store(tmp_path: Path) -> Iterator[BrainStore]:
    with BrainStore.open(tmp_path / "brain.sqlite", clock=fixed_clock()) as s:
        yield s


def words(*triples: tuple[str, float, float]) -> list[TranscriptWord]:
    return [TranscriptWord(word=w, start=s, end=e) for w, s, e in triples]


# --- segment_utterances (mirrors semantic-index.ts#deriveDialogue) ---------------


def test_segment_empty_transcript_yields_nothing() -> None:
    assert segment_utterances([]) == []


def test_segment_groups_contiguous_words_into_one_utterance() -> None:
    result = segment_utterances(words(("hello", 0.0, 0.4), ("world", 0.5, 0.9)))
    assert result == [TranscriptUtterance(start=0.0, end=0.9, text="hello world")]


def test_segment_splits_on_gaps_larger_than_dialogue_gap() -> None:
    result = segment_utterances(
        words(("intro", 0.0, 0.5), ("outro", 1.2, 1.6), ("credits", 1.7, 2.0))
    )
    assert [u.text for u in result] == ["intro", "outro credits"]
    assert result[0].end == 0.5 and result[1].start == 1.2


def test_segment_gap_exactly_at_threshold_stays_one_utterance() -> None:
    # 0.6 is "same utterance" (TS uses a strict > comparison); mirror it exactly.
    # 0.6 - 0.0 is exact in floats — TS computes the identical difference.
    result = segment_utterances(words(("a", 0.0, 0.0), ("b", 0.6, 0.9)))
    assert len(result) == 1


def test_segment_overlapping_shorter_word_never_shrinks_the_end() -> None:
    result = segment_utterances(words(("long", 0.0, 2.0), ("uh", 0.5, 0.7)))
    assert result == [TranscriptUtterance(start=0.0, end=2.0, text="long uh")]


# --- fts_match_expression (plan B7.2 — MATCH injection is impossible) -------------


def test_match_expression_quotes_every_token() -> None:
    assert fts_match_expression("find the take") == '"find" "the" "take"'


def test_match_expression_strips_fts_operators_and_syntax() -> None:
    # Column filters, NEAR, prefix stars, parens, quotes: all reduced to terms.
    assert fts_match_expression('text:secret OR x NEAR("a" "b") *') == (
        '"text" "secret" "OR" "x" "NEAR" "a" "b"'
    )


def test_match_expression_cannot_escape_quoting() -> None:
    assert fts_match_expression('"; DROP TABLE assets; --') == '"DROP" "TABLE" "assets"'


def test_match_expression_empty_and_symbol_only_queries_yield_nothing() -> None:
    assert fts_match_expression("") == ""
    assert fts_match_expression("!?…—") == ""


def test_match_expression_keeps_unicode_word_characters() -> None:
    assert fts_match_expression("café θάλασσα") == '"café" "θάλασσα"'


# --- reindex + search over real SQLite (B2.1/B2.2) --------------------------------


def utterance(start: float, end: float, text: str) -> TranscriptUtterance:
    return TranscriptUtterance(start=start, end=end, text=text)


def test_reindex_transcript_is_drop_and_rebuild(store: BrainStore) -> None:
    assert store.reindex_transcript([utterance(0.0, 1.0, "old line about cats")]) is True
    assert store.reindex_transcript([utterance(2.0, 3.0, "new line about dogs")]) is True
    assert store.search_transcript("cats") == []
    hits = store.search_transcript("dogs")
    assert len(hits) == 1
    assert hits[0].type is SearchHitType.TRANSCRIPT
    assert hits[0].start == 2.0 and hits[0].end == 3.0
    assert "[dogs]" in hits[0].snippet
    assert hits[0].score > 0.0  # negated bm25: higher is better


def test_search_transcript_ranks_better_matches_first(store: BrainStore) -> None:
    store.reindex_transcript(
        [
            utterance(0.0, 1.0, "budget budget budget review"),
            utterance(5.0, 6.0, "a passing mention of the budget among many other words here"),
        ]
    )
    hits = store.search_transcript("budget")
    assert [h.start for h in hits] == [0.0, 5.0]
    assert hits[0].score > hits[1].score


def test_search_transcript_requires_all_terms(store: BrainStore) -> None:
    store.reindex_transcript(
        [utterance(0.0, 1.0, "ship the release"), utterance(2.0, 3.0, "ship the beta")]
    )
    assert [h.start for h in store.search_transcript("ship release")] == [0.0]


def test_search_transcript_hostile_query_matches_literally_not_syntactically(
    store: BrainStore,
) -> None:
    store.reindex_transcript([utterance(0.0, 1.0, 'she said "NEAR the text: secret*"')])
    # The same hostile string as a query round-trips as terms — no MATCH error.
    assert len(store.search_transcript('NEAR the text: secret* "')) == 1


def test_reindex_and_search_markers(store: BrainStore) -> None:
    assert (
        store.reindex_markers(
            [
                Marker(id="m1", time=12.5, label="hook candidate"),
                Marker(id="m2", time=40.0, label=None),
            ]
        )
        is True
    )
    hits = store.search_markers("hook")
    assert len(hits) == 1
    assert hits[0].type is SearchHitType.MARKER
    assert hits[0].marker_id == "m1"
    assert hits[0].start == 12.5 and hits[0].end == 12.5
    assert store.search_markers("nothing") == []


def test_search_assets_matches_id_and_path_case_insensitively(store: BrainStore) -> None:
    store.upsert_asset("intro_a", path="media/Interview_Day1.MP4")
    store.upsert_asset("broll_b", path="media/beach.mp4")
    hits = store.search_assets("interview")
    assert [h.asset_id for h in hits] == ["intro_a"]
    assert hits[0].type is SearchHitType.ASSET
    assert hits[0].snippet == "media/Interview_Day1.MP4"
    assert hits[0].score == 0.0
    assert [h.asset_id for h in store.search_assets("day1 interview")] == ["intro_a"]


def test_search_assets_requires_all_tokens_and_neutralizes_wildcards(store: BrainStore) -> None:
    store.upsert_asset("a1", path="clips/beach_day.mp4")
    store.upsert_asset("a2", path="clips/city_day.mp4")
    assert [h.asset_id for h in store.search_assets("day beach")] == ["a1"]
    # LIKE wildcards can never act as wildcards: the tokenizer treats them as
    # separators, so a bare '%' or '_' query is unsearchable, not match-all.
    assert store.search_assets("%") == []
    assert store.search_assets("_") == []


def test_search_limit_is_honored(store: BrainStore) -> None:
    store.reindex_transcript([utterance(float(i), float(i) + 0.5, "word") for i in range(30)])
    assert len(store.search_transcript("word", limit=5)) == 5


def test_empty_query_searches_nothing(store: BrainStore) -> None:
    store.reindex_transcript([utterance(0.0, 1.0, "content")])
    store.upsert_asset("a1", path="a.mp4")
    assert store.search_transcript("…") == []
    assert store.search_markers("") == []
    assert store.search_assets("  ") == []


def test_fts_methods_degrade_honestly_without_fts5(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(brain_migrations, "fts5_available", lambda _conn: False)
    with BrainStore.open(tmp_path / "brain.sqlite", clock=fixed_clock()) as store:
        assert store.reindex_transcript([utterance(0.0, 1.0, "text")]) is False
        assert store.reindex_markers([Marker(id="m", time=1.0, label="x")]) is False
        assert store.reindex_captions([caption("a1", 0, 0.0, 2.0, "text")]) is False
        assert store.search_transcript("text") == []
        assert store.search_markers("x") == []
        assert store.search_captions("text") == []
        # Asset search never needed FTS — it keeps working.
        store.upsert_asset("a1", path="a.mp4")
        assert [h.asset_id for h in store.search_assets("a1")] == ["a1"]


# --- caption FTS (plan MI3.2) -----------------------------------------------------


def caption(
    asset_id: str, scene_index: int, t0: float, t1: float, text: str
) -> VisualCaptionRow:
    return VisualCaptionRow(
        asset_id=asset_id, scene_index=scene_index, t0=t0, t1=t1, text=text, model="vlm:test"
    )


def test_reindex_captions_round_trips_with_span_metadata(store: BrainStore) -> None:
    assert (
        store.reindex_captions(
            [
                caption("a1", 0, 0.0, 4.0, "a whiteboard covered in sketches"),
                caption("a1", 1, 4.0, 9.0, "a person typing at a laptop"),
            ],
            asset_id="a1",
        )
        is True
    )
    hits = store.search_captions("whiteboard")
    assert len(hits) == 1
    assert hits[0].type is SearchHitType.CAPTION
    assert hits[0].asset_id == "a1"
    assert hits[0].start == 0.0 and hits[0].end == 4.0
    assert "[whiteboard]" in hits[0].snippet
    assert hits[0].score > 0.0  # negated bm25: higher is better


def test_reindex_captions_is_drop_and_rebuild_per_asset(store: BrainStore) -> None:
    store.reindex_captions([caption("a1", 0, 0.0, 2.0, "old cats scene")], asset_id="a1")
    store.reindex_captions([caption("a2", 0, 0.0, 2.0, "dogs scene")], asset_id="a2")
    # Re-indexing a1 drops only a1's rows; a2's caption survives.
    store.reindex_captions([caption("a1", 0, 0.0, 2.0, "new birds scene")], asset_id="a1")
    assert store.search_captions("cats") == []
    assert [h.asset_id for h in store.search_captions("birds")] == ["a1"]
    assert [h.asset_id for h in store.search_captions("dogs")] == ["a2"]


def test_search_captions_hostile_query_matches_literally(store: BrainStore) -> None:
    store.reindex_captions(
        [caption("a1", 0, 0.0, 2.0, 'a sign reading "NEAR the text: secret*"')], asset_id="a1"
    )
    assert len(store.search_captions('NEAR the text: secret* "')) == 1


def test_search_captions_empty_query_searches_nothing(store: BrainStore) -> None:
    store.reindex_captions([caption("a1", 0, 0.0, 2.0, "content")], asset_id="a1")
    assert store.search_captions("…") == []


def test_reindex_transcript_and_captions_are_independent(store: BrainStore) -> None:
    # Caption ingest must not disturb the transcript index (no regression).
    store.reindex_transcript([utterance(0.0, 1.0, "spoken words here")])
    store.reindex_captions([caption("a1", 0, 0.0, 2.0, "visible scene here")], asset_id="a1")
    assert [h.type for h in store.search_transcript("spoken")] == [SearchHitType.TRANSCRIPT]
    assert [h.type for h in store.search_captions("visible")] == [SearchHitType.CAPTION]
