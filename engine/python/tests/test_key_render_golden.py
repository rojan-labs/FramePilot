"""MK6.3: green-screen render goldens for the ``key`` mask. See ``tests/key_render_goldens.py``."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from tests import key_render_goldens as goldens


@pytest.fixture(scope="module")
def rendered(tmp_path_factory: pytest.TempPathFactory) -> dict[str, list[list[list[float]]]]:
    root: Path = tmp_path_factory.mktemp("key-golden")
    goldens.make_source(root)
    return {case["id"]: goldens.render_case(case, root) for case in goldens.CASES}


def test_the_golden_covers_every_model_and_control() -> None:
    stored = json.loads(goldens.GOLDEN.read_text(encoding="utf-8"))
    assert set(stored["cases"]) == {case["id"] for case in goldens.CASES}
    masks = [mask for case in goldens.CASES for mask in case["masks"] if mask["kind"] == "key"]
    assert {mask["model"] for mask in masks} == {"hsl", "3d"}
    assert any(mask.get("despill") == "green" for mask in masks)
    assert any(mask.get("shadowRetention") for mask in masks)
    assert any(mask.get("invert") for mask in masks)
    assert any(mask.get("target", {}).get("kind") == "effect" for mask in masks)
    finesse = [mask.get("finesse", {}) for mask in masks]
    assert any(entry.get("morphOpenPx") for entry in finesse)
    assert any(entry.get("blurPx") for entry in finesse)
    assert any(entry.get("cleanBlack") for entry in finesse)


@pytest.mark.usefixtures("require_ffprobe")
@pytest.mark.parametrize("case_id", [case["id"] for case in goldens.CASES])
def test_key_renders_match_the_golden(
    case_id: str, rendered: dict[str, list[list[list[float]]]]
) -> None:
    stored = json.loads(goldens.GOLDEN.read_text(encoding="utf-8"))
    expected = np.asarray(stored["cases"][case_id])
    actual = np.asarray(rendered[case_id])
    worst = float(np.abs(actual - expected).max())
    assert worst <= stored["tolerance"], f"{case_id}: block mean off by {worst}"


@pytest.mark.usefixtures("require_ffprobe")
def test_every_control_changes_the_picture(
    rendered: dict[str, list[list[list[float]]]],
) -> None:
    """Guard against a golden of nothing: each control has to move pixels of its own."""
    pictures = {case_id: np.asarray(frames) for case_id, frames in rendered.items()}

    def apart(a: str, b: str) -> float:
        return float(np.abs(pictures[a] - pictures[b]).max())

    # Inverting the key is the difference between keeping the backing and keeping the subject.
    assert apart("select-the-backing", "cut-the-subject-out") > 100.0
    assert apart("cut-out-with-despill", "cut-the-subject-out") > 5.0
    assert apart("cut-out-keeping-the-shadow", "cut-the-subject-out") > 2.0
    assert apart("cut-out-finessed", "cut-the-subject-out") > 5.0
    # Measured against the SAME wide qualifier without the levels, so the number is the levels.
    assert apart("cut-out-cleaned", "cut-out-hazy") > 2.0
    assert apart("sampled-backing", "cut-the-subject-out") > 5.0
    assert apart("key-under-a-shape", "cut-the-subject-out") > 5.0
    # A grade limited to the backing must not be the grade applied everywhere.
    assert apart("grade-limited-to-the-backing", "select-the-backing") > 100.0


@pytest.mark.usefixtures("require_ffprobe")
def test_despill_leaves_the_blue_prop_alone(
    rendered: dict[str, list[list[list[float]]]],
) -> None:
    """The limiter caps green at the average of red and blue, so a blue prop is untouched.

    Measured on the block the prop occupies: despill changes the subject's green rim, and that
    block is inside the prop, away from the rim.
    """
    plain = np.asarray(rendered["cut-the-subject-out"])[0]
    despilled = np.asarray(rendered["cut-out-with-despill"])[0]
    # Blocks are 12x12; the prop's interior sits in row 4, column 3 of the 8x6 grid.
    block = 4 * goldens.BLOCKS[0] + 3
    assert float(np.abs(despilled[block] - plain[block]).max()) < 6.0
