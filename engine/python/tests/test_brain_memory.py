"""Tests for the markdown memory tiers (plan B1.5 digest, B6.1 narrative, B6.4 caps).

Deterministic core module (100% coverage): the digest renders purely over the
store's rows — honest "not analyzed" lines for missing analyses, newest-row-wins
for repeated ones — and the narrative tiers are append-only, traceable to patch
ids, and capped oldest-first. Every write is atomic into ``<brain dir>/memory/``.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from framepilot_engine.brain import (
    BrainStore,
    MemoryEntry,
    MemoryTier,
    append_memory_entry,
    bin_summary_path,
    fit_entries,
    latest_session_note,
    parse_entries,
    read_tier,
    render_bin_summary,
    render_entry,
    render_tier_file,
    tail_entries,
    tier_path,
    write_bin_summary,
)
from framepilot_engine.safety import PathTraversalError


def fixed_clock(step_seconds: float = 1.0) -> Callable[[], datetime]:
    """A deterministic clock that advances by ``step_seconds`` per call."""
    state = {"now": datetime(2026, 7, 14, 12, 0, 0, tzinfo=UTC)}

    def _clock() -> datetime:
        current = state["now"]
        state["now"] = current + timedelta(seconds=step_seconds)
        return current

    return _clock


@pytest.fixture
def store(tmp_path: Path) -> Iterator[BrainStore]:
    with BrainStore.open(tmp_path / "brain.sqlite", clock=fixed_clock()) as s:
        yield s


_PROBE: dict[str, Any] = {
    "path": "media/a.mp4",
    "duration_seconds": 10.0,
    "streams": [
        {"index": 0, "codec_type": "video", "width": 1920, "height": 1080},
        {"index": 1, "codec_type": "audio"},
    ],
}


def _record(store: BrainStore, kind: str, result: dict[str, Any], params_hash: str = "h1") -> None:
    store.record_analysis(
        "a1", kind=kind, depth="standard", params_hash=params_hash, result=result, tool=f"{kind}@v1"
    )


# --- rendering ----------------------------------------------------------------


def test_empty_brain_renders_honest_placeholder(store: BrainStore) -> None:
    text = render_bin_summary(store)
    assert "# Media bin summary" in text
    assert "No assets analyzed yet." in text
    assert text.endswith("\n")


def test_fully_analyzed_asset_renders_every_line(store: BrainStore) -> None:
    store.upsert_asset("a1", path="media/a.mp4", probe=_PROBE)
    _record(store, "loudness", {"integratedLufs": -16.25, "loudnessRangeLu": 4.0})
    _record(store, "scenes", {"cuts": [{"time": 2.0}, {"time": 5.0}]})
    _record(
        store,
        "silence",
        {
            "ranges": [
                {"start": 0.0, "end": 1.0, "duration": 1.0},
                {"start": 8.0, "end": 9.5, "duration": 1.5},
            ]
        },
    )
    _record(
        store,
        "transcription",
        {
            "words": [
                {"word": "hello", "start": 0, "end": 1},
                {"word": "world", "start": 1, "end": 2},
            ]
        },
    )

    text = render_bin_summary(store)
    assert "## a1 (media/a.mp4)" in text
    assert "- duration: 10.0s" in text
    assert "- resolution: 1920x1080" in text
    assert "- loudness: -16.2 LUFS" in text
    assert "- scenes: 2 scene cuts" in text
    assert "- silence: 25% silent (2 silent ranges)" in text
    assert '- transcript: "hello world"' in text


def test_unanalyzed_asset_renders_honest_not_analyzed_lines(store: BrainStore) -> None:
    store.upsert_asset("a1", path="media/a.mp4", probe=None)
    text = render_bin_summary(store)
    assert "- duration: unknown" in text
    assert "- resolution: no video" in text
    assert text.count("not analyzed") == 3  # loudness, scenes, silence
    assert "- transcript: not transcribed" in text


def test_resolution_skips_non_video_and_malformed_streams(store: BrainStore) -> None:
    store.upsert_asset(
        "a1",
        path="a.mp4",
        probe={
            "streams": [
                {"index": 0, "codec_type": "audio"},
                "junk",
                {"index": 1, "codec_type": "video", "width": "wide", "height": 720},
                {"index": 2, "codec_type": "video", "width": 1280, "height": 720},
            ]
        },
    )
    assert "- resolution: 1280x720" in render_bin_summary(store)


def test_singulars_and_missing_duration_fall_back_to_range_count(store: BrainStore) -> None:
    # No probe duration → silence cannot honestly report a percentage.
    store.upsert_asset("a1", path="a.wav", probe={"streams": []})
    _record(store, "scenes", {"cuts": [{"time": 1.0}]})
    _record(store, "silence", {"ranges": [{"start": 0.0, "end": 1.0, "duration": 1.0}]})
    text = render_bin_summary(store)
    assert "- scenes: 1 scene cut" in text
    assert "- silence: 1 silent range" in text
    assert "%" not in text


def test_malformed_rows_never_fabricate_values(store: BrainStore) -> None:
    store.upsert_asset("a1", path="a.mp4", probe={"duration_seconds": "ten", "streams": "nope"})
    _record(store, "loudness", {"integratedLufs": "loud"})
    _record(store, "scenes", {"cuts": "many"})
    _record(store, "silence", {"ranges": [{"duration": "long"}, "junk"]})
    _record(store, "transcription", {"words": [{"word": 42}, "junk"]})
    text = render_bin_summary(store)
    assert "- duration: unknown" in text
    assert "- resolution: no video" in text
    assert "- loudness: not analyzed" in text
    assert "- scenes: 0 scene cuts" in text
    assert "- silence: 1 silent range" not in text  # 2 malformed rows counted, 0 seconds
    assert "- transcript: no speech detected" in text


def test_transcript_snippet_is_bounded_and_ellipsized(store: BrainStore) -> None:
    store.upsert_asset("a1", path="a.mp4", probe=_PROBE)
    words = [{"word": f"word{i}", "start": i, "end": i + 1} for i in range(40)]
    _record(store, "transcription", {"words": words})
    text = render_bin_summary(store)
    line = next(ln for ln in text.splitlines() if ln.startswith("- transcript:"))
    assert line.endswith('…"')
    assert len(line) < 110


def test_newest_row_wins_when_a_kind_was_reanalyzed(store: BrainStore) -> None:
    store.upsert_asset("a1", path="a.mp4", probe=_PROBE)
    _record(store, "scenes", {"cuts": []}, params_hash="old")
    _record(
        store, "scenes", {"cuts": [{"time": 1.0}, {"time": 2.0}, {"time": 3.0}]}, params_hash="new"
    )
    assert "- scenes: 3 scene cuts" in render_bin_summary(store)


def test_rendering_is_deterministic(store: BrainStore) -> None:
    store.upsert_asset("a1", path="a.mp4", probe=_PROBE)
    store.upsert_asset("a2", path="b.mp4", probe=None)
    _record(store, "loudness", {"integratedLufs": -14.0})
    assert render_bin_summary(store) == render_bin_summary(store)


# --- writing ------------------------------------------------------------------


def test_write_bin_summary_creates_memory_dir_and_matches_render(
    store: BrainStore, tmp_path: Path
) -> None:
    store.upsert_asset("a1", path="a.mp4", probe=_PROBE)
    target = write_bin_summary(store, tmp_path)
    assert target == bin_summary_path(tmp_path)
    assert target.parent.name == "memory"
    assert target.read_text(encoding="utf-8") == render_bin_summary(store)
    # No temp-file droppings left behind by the atomic write.
    assert list(target.parent.iterdir()) == [target]


def test_write_bin_summary_overwrites_stale_digest(store: BrainStore, tmp_path: Path) -> None:
    target = bin_summary_path(tmp_path)
    target.parent.mkdir(parents=True)
    target.write_text("stale", encoding="utf-8")
    write_bin_summary(store, tmp_path)
    assert "No assets analyzed yet." in target.read_text(encoding="utf-8")


def test_write_bin_summary_cleans_up_when_rename_fails(
    store: BrainStore, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(self: Path, _target: Path) -> Path:
        raise OSError("disk full")

    monkeypatch.setattr(Path, "replace", boom)
    with pytest.raises(OSError, match="disk full"):
        write_bin_summary(store, tmp_path)
    assert not bin_summary_path(tmp_path).exists()
    assert list(bin_summary_path(tmp_path).parent.iterdir()) == []


# --- narrative tiers (B6.1) ---------------------------------------------------


def entry(
    tier: MemoryTier = MemoryTier.CORRECTIONS,
    *,
    title: str = "Rejected: tighten the intro",
    body: str = "Cut felt abrupt.",
    patch_id: str | None = "p_abc123",
    ts: str = "2026-07-15T12:00:00Z",
) -> MemoryEntry:
    return MemoryEntry(tier=tier, title=title, body=body, patch_id=patch_id, ts=ts)


def test_tier_path_maps_each_tier_to_its_file(tmp_path: Path) -> None:
    corrections = tier_path(tmp_path, MemoryTier.CORRECTIONS)
    decisions = tier_path(tmp_path, MemoryTier.DECISIONS)
    note = tier_path(tmp_path, MemoryTier.SESSION_NOTES, ts="2026-07-15T12:00:00Z")
    assert corrections == tmp_path / "memory" / "corrections.md"
    assert decisions == tmp_path / "memory" / "decisions.md"
    assert note == tmp_path / "memory" / "session_notes" / "2026-07-15.md"


@pytest.mark.parametrize(
    "hostile_ts",
    [
        "/etc/cron.d/x",  # absolute: pathlib silently resets the join
        "../../../ab",  # exactly 10 chars, so it survives session_note_date()
    ],
)
def test_session_note_path_refuses_a_ts_that_escapes_the_brain_dir(
    tmp_path: Path, hostile_ts: str
) -> None:
    # Security regression (plan B7.2): `ts` becomes a path segment via
    # session_note_date(). The routes generate it server-side, but this public API
    # accepts any string — an escape must raise, not write outside the sandbox.
    with pytest.raises(PathTraversalError):
        tier_path(tmp_path, MemoryTier.SESSION_NOTES, ts=hostile_ts)


def test_session_note_path_requires_a_timestamp_to_date_it(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="per-day"):
        tier_path(tmp_path, MemoryTier.SESSION_NOTES)


def test_render_entry_includes_heading_patch_and_body() -> None:
    text = render_entry(entry())
    assert text.startswith("## 2026-07-15T12:00:00Z — Rejected: tighten the intro")
    assert "patch: p_abc123" in text
    assert "Cut felt abrupt." in text


def test_render_entry_omits_patch_and_body_when_absent() -> None:
    text = render_entry(entry(patch_id=None, body="   "))
    assert "patch:" not in text
    assert text.strip() == "## 2026-07-15T12:00:00Z — Rejected: tighten the intro"


def test_parse_entries_round_trips_render_and_drops_the_header() -> None:
    entries = [render_entry(entry(ts=f"2026-07-1{i}T00:00:00Z")) for i in range(1, 4)]
    file_text = render_tier_file(MemoryTier.CORRECTIONS, entries, truncated=False)
    assert parse_entries(file_text) == entries
    assert parse_entries("") == []


def test_append_creates_the_file_with_header_and_entry(tmp_path: Path) -> None:
    target = append_memory_entry(tmp_path, entry())
    text = target.read_text(encoding="utf-8")
    assert target == tier_path(tmp_path, MemoryTier.CORRECTIONS)
    assert text.startswith("# Corrections")
    assert "patch: p_abc123" in text
    assert "Cut felt abrupt." in text


def test_append_preserves_prior_entries_oldest_first(tmp_path: Path) -> None:
    append_memory_entry(tmp_path, entry(title="first", ts="2026-07-15T12:00:00Z"))
    append_memory_entry(tmp_path, entry(title="second", ts="2026-07-15T13:00:00Z"))
    text = read_tier(tmp_path, MemoryTier.CORRECTIONS)
    assert text.index("first") < text.index("second")
    assert len(parse_entries(text)) == 2


def test_session_notes_land_in_per_day_files(tmp_path: Path) -> None:
    append_memory_entry(tmp_path, entry(MemoryTier.SESSION_NOTES, ts="2026-07-14T09:00:00Z"))
    append_memory_entry(tmp_path, entry(MemoryTier.SESSION_NOTES, ts="2026-07-15T09:00:00Z"))
    notes = sorted((tmp_path / "memory" / "session_notes").glob("*.md"))
    assert [p.name for p in notes] == ["2026-07-14.md", "2026-07-15.md"]


def test_latest_session_note_reads_the_newest_day(tmp_path: Path) -> None:
    append_memory_entry(
        tmp_path, entry(MemoryTier.SESSION_NOTES, title="old", ts="2026-07-14T09:00:00Z")
    )
    append_memory_entry(
        tmp_path, entry(MemoryTier.SESSION_NOTES, title="new", ts="2026-07-15T09:00:00Z")
    )
    assert "new" in latest_session_note(tmp_path)
    assert "old" not in latest_session_note(tmp_path)


def test_latest_session_note_is_empty_without_notes(tmp_path: Path) -> None:
    assert latest_session_note(tmp_path) == ""
    (tmp_path / "memory" / "session_notes").mkdir(parents=True)
    assert latest_session_note(tmp_path) == ""


def test_read_tier_is_empty_for_missing_or_undatable_files(tmp_path: Path) -> None:
    assert read_tier(tmp_path, MemoryTier.DECISIONS) == ""
    # Session notes with no ts cannot resolve a file — honest empty, never a raise.
    assert read_tier(tmp_path, MemoryTier.SESSION_NOTES) == ""


# --- hygiene / caps (B6.4) ----------------------------------------------------


def test_fit_entries_keeps_everything_under_budget() -> None:
    entries = ["## a\n", "## b\n"]
    assert fit_entries(entries, 1000) == (entries, False)


def test_fit_entries_drops_oldest_first_until_it_fits() -> None:
    entries = [f"## {c}\n" for c in "abcd"]  # 5 bytes each
    kept, truncated = fit_entries(entries, 10)
    assert kept == ["## c\n", "## d\n"]
    assert truncated is True


def test_fit_entries_always_keeps_the_newest_entry() -> None:
    # The newest entry alone busts the budget: keep it anyway — the thing the
    # user just said is the last thing to forget.
    kept, truncated = fit_entries(["## old\n", "## a very long newest entry\n"], 5)
    assert kept == ["## a very long newest entry\n"]
    assert truncated is True


def test_fit_entries_handles_the_empty_file() -> None:
    assert fit_entries([], 10) == ([], False)


def test_append_truncates_oldest_first_and_says_so(tmp_path: Path) -> None:
    for i in range(40):
        append_memory_entry(
            tmp_path,
            entry(title=f"entry-{i:02d}", body="x" * 200, ts=f"2026-07-15T12:{i:02d}:00Z"),
            max_bytes=2048,
        )
    text = read_tier(tmp_path, MemoryTier.CORRECTIONS)
    assert len(text.encode("utf-8")) <= 2048
    assert "_Older entries were dropped to respect the size cap._" in text
    assert "entry-00" not in text  # oldest dropped
    assert "entry-39" in text  # newest kept


def test_untruncated_file_carries_no_truncation_notice(tmp_path: Path) -> None:
    append_memory_entry(tmp_path, entry())
    assert "size cap" not in read_tier(tmp_path, MemoryTier.CORRECTIONS)


def test_tail_entries_bounds_what_session_context_injects() -> None:
    entries = [render_entry(entry(title=f"e{i}", ts=f"2026-07-15T12:0{i}:00Z")) for i in range(4)]
    text = render_tier_file(MemoryTier.CORRECTIONS, entries, truncated=False)
    tail = tail_entries(text, 2)
    assert "# Corrections" not in tail  # headerless
    assert "e0" not in tail and "e1" not in tail
    assert "e2" in tail and "e3" in tail


def test_tail_entries_is_empty_for_no_entries_or_zero_limit() -> None:
    assert tail_entries("", 5) == ""
    assert tail_entries(render_tier_file(MemoryTier.DECISIONS, [], truncated=False), 5) == ""
    assert tail_entries(render_entry(entry()), 0) == ""
