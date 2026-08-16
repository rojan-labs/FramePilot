"""Tests for the unlocked QC analysis primitives (plan B1.1).

Covers, to 100%: the pure ``blackdetect``/``freezedetect``/``ebur128`` log
parsers (fed sample ffmpeg stderr) and the detection wrappers (injected runner
asserts the argv and returns canned logs) — the whole matrix runs without the
ffmpeg binary. Also pins that render QC shares the black parser instead of
duplicating it.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

import pytest

from framepilot_engine.analysis.black import (
    DEFAULT_MIN_BLACK_SECONDS,
    DEFAULT_PICTURE_THRESHOLD,
    DEFAULT_PIXEL_THRESHOLD,
    BlackRange,
    detect_black,
    detect_black_seconds,
    parse_black_ranges,
    parse_black_seconds,
)
from framepilot_engine.analysis.freeze import (
    DEFAULT_FREEZE_NOISE_DB,
    DEFAULT_MIN_FREEZE_SECONDS,
    FrozenRange,
    detect_freezes,
    parse_frozen_ranges,
)
from framepilot_engine.analysis.loudness import (
    LoudnessAnalysis,
    measure_loudness,
    parse_loudness_summary,
)

# --- Sample ffmpeg stderr ----------------------------------------------------

_BLACK_LOG = (
    "[blackdetect @ 0x1] black_start:0 black_end:1.5 black_duration:1.5\n"
    "[blackdetect @ 0x1] black_start:10.25 black_end:12 black_duration:1.75\n"
)

_FREEZE_LOG = (
    "[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 4.504\n"
    "[freezedetect @ 0x1] lavfi.freezedetect.freeze_duration: 2.033\n"
    "[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 6.537\n"
)

_EBUR128_LOG = (
    "[Parsed_ebur128_0 @ 0x1] t: 1.0  TARGET:-23 LUFS  M: -21.1 S: -22.0 "
    "    I: -20.9 LUFS       LRA: 0.0 LU\n"
    "[Parsed_ebur128_0 @ 0x1] Summary:\n"
    "\n"
    "  Integrated loudness:\n"
    "    I:         -23.0 LUFS\n"
    "    Threshold: -33.6 LUFS\n"
    "\n"
    "  Loudness range:\n"
    "    LRA:         1.6 LU\n"
    "    Threshold: -43.0 LUFS\n"
    "    LRA low:   -23.7 LUFS\n"
    "    LRA high:  -22.1 LUFS\n"
    "\n"
    "  True peak:\n"
    "    Peak:      -2.4 dBFS\n"
)


# --- Black: pure parsers -------------------------------------------------------


def test_parse_black_ranges() -> None:
    assert parse_black_ranges(_BLACK_LOG) == [
        BlackRange(start=0.0, end=1.5, duration=1.5),
        BlackRange(start=10.25, end=12.0, duration=1.75),
    ]


def test_parse_black_ranges_none() -> None:
    assert parse_black_ranges("no black here") == []


def test_parse_black_ranges_clamps_negative_and_sorts() -> None:
    logs = (
        "black_start:5 black_end:6 black_duration:1\n"
        "black_start:-0.01 black_end:1 black_duration:1.01\n"
    )
    ranges = parse_black_ranges(logs)
    assert ranges[0] == BlackRange(start=0.0, end=1.0, duration=1.01)
    assert ranges[1].start == 5.0


def test_parse_black_seconds_sums_durations() -> None:
    assert parse_black_seconds(_BLACK_LOG) == pytest.approx(3.25)
    assert parse_black_seconds("nothing") == 0.0


def test_render_validation_shares_black_parser() -> None:
    # QC and analysis must agree on what "black" means (plan B1.1) — the
    # validation module re-exports the analyzer's functions, not a copy.
    from framepilot_engine.validation import render_validation

    assert render_validation.parse_black_seconds is parse_black_seconds
    assert render_validation.detect_black_seconds is detect_black_seconds


# --- Black: injected runner -----------------------------------------------------


def test_detect_black_builds_expected_argv() -> None:
    captured: list[Sequence[str]] = []

    def runner(argv: Sequence[str]) -> str:
        captured.append(argv)
        return _BLACK_LOG

    ranges = detect_black(Path("/media/clip.mp4"), runner=runner)
    assert len(ranges) == 2
    argv = list(captured[0])
    assert "-i" in argv and "/media/clip.mp4" in argv
    assert (
        f"blackdetect=d={DEFAULT_MIN_BLACK_SECONDS}"
        f":pic_th={DEFAULT_PICTURE_THRESHOLD}:pix_th={DEFAULT_PIXEL_THRESHOLD}" in argv
    )
    assert "-an" in argv and argv[-3:] == ["-f", "null", "-"]


def test_detect_black_honours_custom_thresholds() -> None:
    captured: list[Sequence[str]] = []

    def runner(argv: Sequence[str]) -> str:
        captured.append(argv)
        return ""

    assert (
        detect_black(
            Path("/m.mp4"),
            min_black_seconds=1.0,
            picture_threshold=0.9,
            pixel_threshold=0.2,
            runner=runner,
        )
        == []
    )
    assert "blackdetect=d=1.0:pic_th=0.9:pix_th=0.2" in list(captured[0])


def test_detect_black_seconds_uses_qc_window() -> None:
    captured: list[Sequence[str]] = []

    def runner(argv: Sequence[str]) -> str:
        captured.append(argv)
        return _BLACK_LOG

    total = detect_black_seconds(Path("/out.mp4"), runner=runner)
    assert total == pytest.approx(3.25)
    assert "blackdetect=d=0.05:pic_th=0.98:pix_th=0.10" in list(captured[0])


# --- Freeze: pure parser --------------------------------------------------------


def test_parse_frozen_ranges_pairs_start_end() -> None:
    ranges = parse_frozen_ranges(_FREEZE_LOG)
    assert len(ranges) == 1
    assert ranges[0].start == 4.504
    assert ranges[0].end == 6.537
    assert ranges[0].duration == pytest.approx(2.033)


def test_parse_frozen_ranges_none() -> None:
    assert parse_frozen_ranges("no freezes") == []


def test_parse_frozen_ranges_clamps_negative_start() -> None:
    logs = "freeze_start: -0.01\nfreeze_end: 3.0\n"
    assert parse_frozen_ranges(logs) == [FrozenRange(start=0.0, end=3.0, duration=3.0)]


def test_parse_frozen_trailing_open_closed_with_total_duration() -> None:
    logs = "freeze_start: 8.0\n"  # frozen through EOF: no closing lines
    assert parse_frozen_ranges(logs, total_duration=10.0) == [
        FrozenRange(start=8.0, end=10.0, duration=2.0)
    ]


def test_parse_frozen_trailing_open_dropped_without_duration() -> None:
    assert parse_frozen_ranges("freeze_start: 8.0\n") == []
    assert parse_frozen_ranges("freeze_start: 8.0\n", total_duration=8.0) == []


# --- Freeze: injected runner -----------------------------------------------------


def test_detect_freezes_builds_expected_argv() -> None:
    captured: list[Sequence[str]] = []

    def runner(argv: Sequence[str]) -> str:
        captured.append(argv)
        return _FREEZE_LOG

    ranges = detect_freezes(Path("/media/clip.mp4"), runner=runner)
    assert len(ranges) == 1
    argv = list(captured[0])
    assert f"freezedetect=n={DEFAULT_FREEZE_NOISE_DB}dB:d={DEFAULT_MIN_FREEZE_SECONDS}" in argv
    assert "-an" in argv and argv[-3:] == ["-f", "null", "-"]


def test_detect_freezes_honours_custom_params() -> None:
    captured: list[Sequence[str]] = []

    def runner(argv: Sequence[str]) -> str:
        captured.append(argv)
        return "freeze_start: 1.0\n"

    ranges = detect_freezes(
        Path("/m.mp4"),
        noise_db=-50.0,
        min_freeze_seconds=1.0,
        total_duration=4.0,
        runner=runner,
    )
    assert ranges == [FrozenRange(start=1.0, end=4.0, duration=3.0)]
    assert "freezedetect=n=-50.0dB:d=1.0" in list(captured[0])


# --- Loudness: pure parser --------------------------------------------------------


def test_parse_loudness_summary_extracts_final_figures() -> None:
    analysis = parse_loudness_summary(_EBUR128_LOG)
    assert analysis == LoudnessAnalysis(
        integrated_lufs=-23.0, loudness_range_lu=1.6, true_peak_dbfs=-2.4
    )


def test_parse_loudness_summary_none_without_integrated() -> None:
    # No audio decoded → no I: figure → honest None, never a fabricated number.
    assert parse_loudness_summary("no ebur128 output") is None


def test_parse_loudness_summary_partial_figures() -> None:
    analysis = parse_loudness_summary("  I: -19.5 LUFS\n")
    assert analysis is not None
    assert analysis.integrated_lufs == -19.5
    assert analysis.loudness_range_lu is None
    assert analysis.true_peak_dbfs is None


def test_parse_loudness_lra_does_not_match_lra_low_high() -> None:
    logs = "  LRA low:   -23.7 LUFS\n  LRA high:  -22.1 LUFS\n  I: -23.0 LUFS\n"
    analysis = parse_loudness_summary(logs)
    assert analysis is not None
    assert analysis.loudness_range_lu is None


def test_loudness_camelcase_serialization() -> None:
    analysis = LoudnessAnalysis(integrated_lufs=-14.0, loudness_range_lu=5.0, true_peak_dbfs=-1.0)
    assert analysis.model_dump(by_alias=True) == {
        "integratedLufs": -14.0,
        "loudnessRangeLu": 5.0,
        "truePeakDbfs": -1.0,
    }


# --- Loudness: injected runner -------------------------------------------------------


def test_measure_loudness_builds_expected_argv() -> None:
    captured: list[Sequence[str]] = []

    def runner(argv: Sequence[str]) -> str:
        captured.append(argv)
        return _EBUR128_LOG

    analysis = measure_loudness(Path("/media/clip.mp4"), runner=runner)
    assert analysis is not None and analysis.integrated_lufs == -23.0
    argv = list(captured[0])
    assert "ebur128=peak=true" in argv
    assert "-vn" in argv and argv[-3:] == ["-f", "null", "-"]


def test_measure_loudness_returns_none_for_silent_source() -> None:
    assert measure_loudness(Path("/m.mp4"), runner=lambda argv: "") is None
