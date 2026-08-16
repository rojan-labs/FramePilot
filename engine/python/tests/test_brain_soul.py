"""Tests for the cross-project soul (plan B6.2).

Deterministic core module (100% coverage). The load-bearing behaviour is the
promotion heuristic: one project's correction must stay in that project, the
SAME correction in two projects becomes a standing preference — and promotion
must fire exactly once, never again as more projects repeat it.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from framepilot_engine.brain.soul import (
    PROMOTION_MIN_PROJECTS,
    SoulDoc,
    append_soul_note,
    corrections_index_path,
    normalize_correction,
    note_correction,
    read_corrections_index,
    read_soul_doc,
    record_sighting,
    soul_digest,
    soul_doc_path,
    soul_root,
    write_corrections_index,
)

TS = "2026-07-15T12:00:00Z"


@pytest.fixture
def root(tmp_path: Path) -> Path:
    return soul_root(tmp_path)


# --- layout -------------------------------------------------------------------


def test_soul_root_lives_under_the_home_dotdir(tmp_path: Path) -> None:
    assert soul_root(tmp_path) == tmp_path / ".framepilot" / "soul"


def test_soul_root_defaults_to_the_real_home() -> None:
    assert soul_root() == Path.home() / ".framepilot" / "soul"


def test_each_doc_maps_to_its_markdown_file(root: Path) -> None:
    assert soul_doc_path(root, SoulDoc.WORKING_STYLE) == root / "working_style.md"
    assert (
        soul_doc_path(root, SoulDoc.LEARNED_FROM_CORRECTIONS)
        == root / "learned_from_corrections.md"
    )
    assert soul_doc_path(root, SoulDoc.PERSPECTIVE) == root / "perspective.md"


# --- normalization ------------------------------------------------------------


def test_normalization_folds_case_punctuation_and_whitespace() -> None:
    assert normalize_correction("Don't  cut on the BEAT!") == "dont cut on the beat"
    assert normalize_correction("dont cut on the beat") == normalize_correction(
        "Don't cut on the beat."
    )


def test_normalization_of_empty_and_punctuation_only_text() -> None:
    assert normalize_correction("   ") == ""
    assert normalize_correction("!?!") == ""


# --- promotion heuristic ------------------------------------------------------


def test_first_sighting_does_not_promote() -> None:
    index, promoted = record_sighting({}, "no captions over faces", "proj-a")
    assert promoted is False
    assert index == {"no captions over faces": ["proj-a"]}


def test_second_distinct_project_promotes() -> None:
    index, _ = record_sighting({}, "no captions over faces", "proj-a")
    index, promoted = record_sighting(index, "No captions over faces!", "proj-b")
    assert promoted is True
    assert index["no captions over faces"] == ["proj-a", "proj-b"]


def test_same_project_repeating_itself_never_promotes() -> None:
    index, _ = record_sighting({}, "tighten the intro", "proj-a")
    for _ in range(5):
        index, promoted = record_sighting(index, "tighten the intro", "proj-a")
        assert promoted is False
    assert index["tighten the intro"] == ["proj-a"]


def test_promotion_fires_exactly_once_across_further_projects() -> None:
    index: dict[str, list[str]] = {}
    promotions = []
    for project in ("a", "b", "c", "d"):
        index, promoted = record_sighting(index, "cut on the beat", project)
        promotions.append(promoted)
    assert promotions == [False, True, False, False]


def test_empty_correction_is_never_indexed() -> None:
    index, promoted = record_sighting({"x": ["p"]}, "  !!  ", "proj-a")
    assert promoted is False
    assert index == {"x": ["p"]}


def test_record_sighting_does_not_mutate_the_input_index() -> None:
    original = {"cut on the beat": ["proj-a"]}
    snapshot = json.dumps(original, sort_keys=True)
    record_sighting(original, "cut on the beat", "proj-b")
    assert json.dumps(original, sort_keys=True) == snapshot


# --- index persistence --------------------------------------------------------


def test_index_round_trips(root: Path) -> None:
    write_corrections_index(root, {"a": ["p1", "p2"]})
    assert read_corrections_index(root) == {"a": ["p1", "p2"]}


def test_missing_index_reads_as_empty(root: Path) -> None:
    assert read_corrections_index(root) == {}


def test_corrupt_index_degrades_to_empty_instead_of_raising(root: Path) -> None:
    corrections_index_path(root).parent.mkdir(parents=True)
    corrections_index_path(root).write_text("{not json", encoding="utf-8")
    assert read_corrections_index(root) == {}


def test_index_of_the_wrong_shape_degrades_to_empty(root: Path) -> None:
    write_corrections_index(root, {})
    corrections_index_path(root).write_text("[1, 2]", encoding="utf-8")
    assert read_corrections_index(root) == {}


def test_index_drops_malformed_entries_but_keeps_good_ones(root: Path) -> None:
    corrections_index_path(root).parent.mkdir(parents=True)
    corrections_index_path(root).write_text(
        json.dumps({"good": ["p1", 7], "bad": "not-a-list", "8": ["p2"]}), encoding="utf-8"
    )
    assert read_corrections_index(root) == {"good": ["p1"], "8": ["p2"]}


# --- notes --------------------------------------------------------------------


def test_append_soul_note_writes_header_body_and_project_trace(root: Path) -> None:
    target = append_soul_note(
        root,
        SoulDoc.WORKING_STYLE,
        title="Cuts on the beat",
        ts=TS,
        body="Always beat-syncs montages.",
        project_id="proj-a",
    )
    text = target.read_text(encoding="utf-8")
    assert text.startswith("# Working style")
    assert f"## {TS} — Cuts on the beat" in text
    assert "project: proj-a" in text
    assert "Always beat-syncs montages." in text


def test_append_soul_note_accumulates_oldest_first(root: Path) -> None:
    append_soul_note(root, SoulDoc.PERSPECTIVE, title="first", ts="2026-07-14T00:00:00Z")
    append_soul_note(root, SoulDoc.PERSPECTIVE, title="second", ts="2026-07-15T00:00:00Z")
    text = read_soul_doc(root, SoulDoc.PERSPECTIVE)
    assert text.index("first") < text.index("second")


def test_append_soul_note_truncates_oldest_first(root: Path) -> None:
    for i in range(40):
        append_soul_note(
            root,
            SoulDoc.PERSPECTIVE,
            title=f"note-{i:02d}",
            ts=f"2026-07-15T12:{i:02d}:00Z",
            body="y" * 200,
            max_bytes=2048,
        )
    text = read_soul_doc(root, SoulDoc.PERSPECTIVE)
    assert len(text.encode("utf-8")) <= 2048
    assert "note-00" not in text
    assert "note-39" in text
    assert "size cap" in text


def test_read_soul_doc_is_empty_when_absent(root: Path) -> None:
    assert read_soul_doc(root, SoulDoc.WORKING_STYLE) == ""


# --- note_correction (index + promotion together) -----------------------------


def test_note_correction_stays_silent_for_a_single_project(root: Path) -> None:
    assert note_correction(root, "no captions over faces", "proj-a", ts=TS) is False
    assert read_soul_doc(root, SoulDoc.LEARNED_FROM_CORRECTIONS) == ""
    assert read_corrections_index(root) == {"no captions over faces": ["proj-a"]}


def test_note_correction_promotes_on_the_second_project(root: Path) -> None:
    note_correction(root, "no captions over faces", "proj-a", ts=TS)
    assert note_correction(root, "No captions over faces.", "proj-b", ts=TS) is True
    text = read_soul_doc(root, SoulDoc.LEARNED_FROM_CORRECTIONS)
    assert "No captions over faces." in text
    assert "project: proj-b" in text
    assert f"Seen in {PROMOTION_MIN_PROJECTS} different projects" in text


def test_note_correction_writes_the_soul_note_only_once(root: Path) -> None:
    for project in ("a", "b", "c", "d"):
        note_correction(root, "cut on the beat", project, ts=TS)
    text = read_soul_doc(root, SoulDoc.LEARNED_FROM_CORRECTIONS)
    assert text.count("## ") == 1


def test_promoted_title_is_bounded_to_the_first_line(root: Path) -> None:
    correction = "x" * 200 + "\nsecond line"
    note_correction(root, correction, "proj-a", ts=TS)
    note_correction(root, correction, "proj-b", ts=TS)
    heading = next(
        line
        for line in read_soul_doc(root, SoulDoc.LEARNED_FROM_CORRECTIONS).splitlines()
        if line.startswith("## ")
    )
    assert "second line" not in heading
    assert len(heading) < 160


# --- digest -------------------------------------------------------------------


def test_digest_is_empty_for_a_first_run_user(root: Path) -> None:
    assert soul_digest(root) == ""


def test_digest_concatenates_every_doc_that_exists(root: Path) -> None:
    append_soul_note(root, SoulDoc.WORKING_STYLE, title="style-note", ts=TS)
    append_soul_note(root, SoulDoc.PERSPECTIVE, title="taste-note", ts=TS)
    digest = soul_digest(root)
    assert "style-note" in digest
    assert "taste-note" in digest


def test_digest_is_bounded_and_keeps_the_newest_notes(root: Path) -> None:
    for i in range(20):
        append_soul_note(
            root,
            SoulDoc.PERSPECTIVE,
            title=f"note-{i:02d}",
            ts=f"2026-07-15T12:{i:02d}:00Z",
            body="z" * 100,
        )
    digest = soul_digest(root, max_chars=300)
    assert len(digest) <= 302  # the bound plus the "…\n" elision marker
    assert digest.startswith("…\n")
    assert "note-19" in digest
