"""Render goldens for ``matte`` masks (BR2.4). See ``tests/matte_render_goldens.py``."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from tests import matte_render_goldens as goldens
from tests.mask_render_goldens import block_means

pytestmark = pytest.mark.usefixtures("require_ffprobe")


@pytest.fixture(scope="module")
def media(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, dict[str, Any]]:
    root: Path = tmp_path_factory.mktemp("matte-golden")
    return root, goldens.make_media(root)


@pytest.fixture(scope="module")
def rendered(media: tuple[Path, dict[str, Any]]) -> dict[str, list[np.ndarray]]:
    root, artifact = media
    return {
        case["id"]: goldens.render_frames(case["tracks"], root) for case in goldens.cases(artifact)
    }


def _frame_index(t: float) -> int:
    return int(goldens.FPS * t + 1e-5)


def test_the_golden_covers_every_case() -> None:
    stored = json.loads(goldens.GOLDEN.read_text(encoding="utf-8"))
    assert set(stored["cases"]) == {case["id"] for case in goldens.cases({"key": "k"})}


@pytest.mark.parametrize("case_id", [case["id"] for case in goldens.cases({"key": "k"})])
def test_matte_renders_match_the_golden(
    case_id: str, rendered: dict[str, list[np.ndarray]]
) -> None:
    stored = json.loads(goldens.GOLDEN.read_text(encoding="utf-8"))
    expected = np.asarray(stored["cases"][case_id])
    actual = np.asarray(
        [block_means(frame.astype(np.float64)) for frame in rendered[case_id]]
    )
    worst = float(np.abs(actual - expected).max())
    assert worst <= stored["tolerance"], f"{case_id}: block mean off by {worst}"


def test_text_sits_exactly_behind_the_subject(
    media: tuple[Path, dict[str, Any]], rendered: dict[str, list[np.ndarray]]
) -> None:
    """Inside the matte the subject covers the words exactly; outside, the copy is absent."""
    root, artifact = media
    mattes = goldens.matte_frames()
    pictures = goldens.pictures(mattes)
    tracks = goldens.cases(artifact)[0]["tracks"]
    without_copy = goldens.render_frames(tracks[1:], root)
    for sample, frame, under in zip(
        goldens.SAMPLES, rendered["text-behind-subject"], without_copy, strict=True
    ):
        alpha = mattes[_frame_index(sample)]
        solid = alpha == 255
        clear = alpha == 0
        assert solid.sum() > 400 and clear.sum() > 3000
        assert np.array_equal(frame[solid], pictures[_frame_index(sample)][solid])
        assert np.array_equal(frame[clear], under[clear])
        # The words really are under the subject: without the copy they show there.
        assert float(np.abs(under[solid].astype(int) - frame[solid].astype(int)).max()) > 100


def test_decontamination_changes_only_the_soft_band(
    rendered: dict[str, list[np.ndarray]],
) -> None:
    mattes = goldens.matte_frames()
    for sample, clean, dirty in zip(
        goldens.SAMPLES,
        rendered["text-behind-subject"],
        rendered["text-behind-subject-no-decontamination"],
        strict=True,
    ):
        alpha = mattes[_frame_index(sample)]
        band = (alpha > 0) & (alpha < 255)
        assert np.array_equal(clean[~band], dirty[~band])
        assert float(np.abs(clean[band].astype(int) - dirty[band].astype(int)).max()) > 10


def test_edge_controls_change_the_picture(rendered: dict[str, list[np.ndarray]]) -> None:
    """Guard against a golden of nothing: growing the edge hides more of the words.

    The copy is the same video as the track under the words, so a grown edge only shows where it
    now covers letters.
    """
    base = np.asarray(rendered["text-behind-subject-no-decontamination"], dtype=np.int64)
    grown = np.asarray(rendered["text-behind-subject-sharp-grown"], dtype=np.int64)
    assert int((np.abs(base - grown).max(axis=-1) > 30).sum()) > 20
