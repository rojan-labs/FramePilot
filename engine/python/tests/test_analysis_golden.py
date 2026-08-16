"""Golden-media tests for the B1.1 analyzers (plan B7.4).

WHY these exist alongside the parser unit tests: ``test_analysis_loudness.py`` /
``test_analysis_black.py`` feed canned ffmpeg logs to the pure parsers, which
proves the regex reduction but says nothing about the *argv* we build — a wrong
filter option, a dropped ``peak=true``, or an ffmpeg upgrade that renames a
summary label would leave those green while the real analyzer silently returned
``None`` (honest-unavailable) or a fabricated-looking zero. These run the real
binary end-to-end against deterministic ``lavfi`` sources whose measurements are
known, so argv + parse are pinned together.

Sources and expectations live in ``fixtures/golden/analysis_lavfi.json``; see its
``description`` for how to regenerate.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any, cast

import pytest

from framepilot_engine.analysis.black import detect_black
from framepilot_engine.analysis.loudness import measure_loudness

_GOLDEN = Path(__file__).parent / "fixtures" / "golden" / "analysis_lavfi.json"


@pytest.fixture(scope="module")
def golden() -> dict[str, Any]:
    return cast(dict[str, Any], json.loads(_GOLDEN.read_text()))


def _synthesize(ffmpeg_bin: str, target: Path, lavfi: str, *extra_args: str) -> Path:
    """Render one deterministic lavfi graph to ``target``."""
    subprocess.run(
        [ffmpeg_bin, "-y", "-f", "lavfi", "-i", lavfi, *extra_args, str(target)],
        check=True,
        capture_output=True,
    )
    return target


# --- loudness (EBU R128) -----------------------------------------------------


def test_measure_loudness_matches_golden_r128_figures(
    ffmpeg_bin: str, tmp_project_dir: Path, golden: dict[str, Any]
) -> None:
    spec = golden["loudness"]
    source = _synthesize(
        ffmpeg_bin,
        tmp_project_dir / f"tone{spec['source']['suffix']}",
        spec["source"]["lavfi"],
        "-c:a",
        spec["source"]["codec"],
    )

    result = measure_loudness(source)

    assert result is not None, "a 1kHz tone must yield an integrated loudness"
    tol = spec["lufs_tolerance"]
    assert result.integrated_lufs == pytest.approx(spec["integrated_lufs"], abs=tol)
    assert result.loudness_range_lu == pytest.approx(spec["loudness_range_lu"], abs=tol)
    # Pins `peak=true` in the argv: without it ffmpeg omits the Peak line entirely
    # and this silently becomes None. Its tolerance is wider than the LUFS one:
    # the AAC encoder's peak overshoot varies by ffmpeg build (see the fixture).
    assert result.true_peak_dbfs is not None, "true peak requires peak=true in the argv"
    assert result.true_peak_dbfs == pytest.approx(
        spec["true_peak_dbfs"], abs=spec["true_peak_tolerance"]
    )


def test_halving_amplitude_measures_exactly_six_lu_quieter(
    ffmpeg_bin: str, tmp_project_dir: Path, golden: dict[str, Any]
) -> None:
    # The absolute figures above can drift with an ffmpeg upgrade; this relation
    # is physics (a 6.02 dB amplitude halving), so it holds across versions and
    # catches a scaling/units error the absolute check could rationalize away.
    spec = golden["loudness"]
    full = _synthesize(
        ffmpeg_bin,
        tmp_project_dir / "full.m4a",
        spec["source"]["lavfi"],
        "-c:a",
        spec["source"]["codec"],
    )
    half = _synthesize(
        ffmpeg_bin,
        tmp_project_dir / "half.m4a",
        spec["source"]["attenuated_lavfi"],
        "-c:a",
        spec["source"]["codec"],
    )

    loud, quiet = measure_loudness(full), measure_loudness(half)

    assert loud is not None and quiet is not None
    delta = loud.integrated_lufs - quiet.integrated_lufs
    assert delta == pytest.approx(spec["attenuation_lu"], abs=spec["attenuation_tolerance"])


def test_silent_track_measures_at_the_floor_and_reports_no_true_peak(
    ffmpeg_bin: str, tmp_project_dir: Path, golden: dict[str, Any]
) -> None:
    # A silent-but-present audio track is measurable, and ebur128 floors it at
    # -70 LUFS rather than reporting nothing. Two things worth pinning:
    #  - it is NOT fabricated as 0 LUFS, which downstream would read as a
    #    perfectly-normalized mix rather than silence;
    #  - ffmpeg prints "Peak: -inf dBFS" here, which the numeric regex declines
    #    to match, so true peak comes back None (honest) instead of parsing as 0.
    spec = golden["loudness"]
    source = _synthesize(
        ffmpeg_bin,
        tmp_project_dir / "silent.m4a",
        "anullsrc=r=48000:cl=mono:d=3",
        "-c:a",
        spec["source"]["codec"],
    )

    result = measure_loudness(source)

    assert result is not None
    assert result.integrated_lufs == pytest.approx(-70.0, abs=0.1)
    assert result.true_peak_dbfs is None


# --- black detection ---------------------------------------------------------


def test_detect_black_finds_the_golden_leading_black_span(
    ffmpeg_bin: str, tmp_project_dir: Path, golden: dict[str, Any]
) -> None:
    spec = golden["black"]
    source = _synthesize(
        ffmpeg_bin,
        tmp_project_dir / f"black_then_bars{spec['source']['suffix']}",
        spec["source"]["lavfi"],
        "-pix_fmt",
        spec["source"]["pix_fmt"],
    )

    ranges = detect_black(
        source,
        min_black_seconds=spec["min_duration_seconds"],
        picture_threshold=spec["picture_threshold"],
    )

    expected = spec["expected_ranges"]
    assert len(ranges) == len(expected), f"expected {len(expected)} black span(s), got {ranges}"
    tol = spec["time_tolerance_seconds"]
    for got, want in zip(ranges, expected, strict=True):
        assert got.start == pytest.approx(want["start"], abs=tol)
        assert got.end == pytest.approx(want["end"], abs=tol)


def test_detect_black_finds_nothing_in_a_fully_lit_source(
    ffmpeg_bin: str, tmp_project_dir: Path
) -> None:
    # The negative case: testsrc2 is never black, so an empty list is the correct
    # answer. Guards against a parser that reports a phantom whole-file span.
    source = _synthesize(
        ffmpeg_bin,
        tmp_project_dir / "bars.mp4",
        "testsrc2=s=160x120:d=2:r=15",
        "-pix_fmt",
        "yuv420p",
    )
    assert detect_black(source) == []
