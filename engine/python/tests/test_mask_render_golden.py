"""Render goldens for the v22 mask stack (MK2.4). See ``tests/mask_render_goldens.py``."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from tests import mask_render_goldens as goldens


@pytest.fixture(scope="module")
def rendered(tmp_path_factory: pytest.TempPathFactory) -> dict[str, list[list[list[float]]]]:
    root: Path = tmp_path_factory.mktemp("mask-golden")
    goldens.make_source(root)
    return {case["id"]: goldens.render_case(case, root) for case in goldens.CASES}


def test_the_golden_covers_every_kind_mode_and_target() -> None:
    stored = json.loads(goldens.GOLDEN.read_text(encoding="utf-8"))
    assert set(stored["cases"]) == {case["id"] for case in goldens.CASES}
    kinds = {mask["kind"] for case in goldens.CASES for mask in case["masks"]}
    modes = {mask.get("mode", "add") for case in goldens.CASES for mask in case["masks"]}
    targets = {
        mask.get("target", {"kind": "alpha"})["kind"]
        for case in goldens.CASES
        for mask in case["masks"]
    }
    assert kinds == {"rectangle", "ellipse", "path", "linear", "band", "gradient", "layer"}
    channels = {
        mask["channel"] for case in goldens.CASES for mask in case["masks"] if "channel" in mask
    }
    assert channels == {"alpha", "luma", "inverted-alpha", "inverted-luma"}
    assert modes == {"add", "subtract", "intersect", "difference", "lighten", "darken"}
    assert targets == {"alpha", "effect"}


@pytest.mark.usefixtures("require_ffprobe")
@pytest.mark.parametrize("case_id", [case["id"] for case in goldens.CASES])
def test_mask_renders_match_the_golden(
    case_id: str, rendered: dict[str, list[list[list[float]]]]
) -> None:
    stored = json.loads(goldens.GOLDEN.read_text(encoding="utf-8"))
    expected = np.asarray(stored["cases"][case_id])
    actual = np.asarray(rendered[case_id])
    worst = float(np.abs(actual - expected).max())
    assert worst <= stored["tolerance"], f"{case_id}: block mean off by {worst}"


@pytest.mark.usefixtures("require_ffprobe")
def test_masks_change_the_picture(rendered: dict[str, list[list[list[float]]]]) -> None:
    """Guard against a golden of nothing: different stacks render different pictures."""
    pictures = {case_id: np.asarray(frames) for case_id, frames in rendered.items()}
    assert float(np.abs(pictures["mode-add"] - pictures["mode-subtract"]).max()) > 20.0
    assert float(np.abs(pictures["mode-intersect"] - pictures["mode-add"]).max()) > 20.0
    assert float(np.abs(pictures["effect-target-grade"] - pictures["invert-opacity"]).max()) > 20.0
    # MK8.4: the analytic kinds and every track matte channel draw different pictures.
    assert float(np.abs(pictures["layer-alpha"] - pictures["layer-inverted-alpha"]).max()) > 20.0
    assert float(np.abs(pictures["layer-luma"] - pictures["layer-inverted-luma"]).max()) > 20.0
    assert float(np.abs(pictures["layer-alpha"] - pictures["layer-luma"]).max()) > 5.0
    assert (
        float(np.abs(pictures["analytic-gradient-linear"] - pictures["analytic-split-soft"]).max())
        > 20.0
    )
