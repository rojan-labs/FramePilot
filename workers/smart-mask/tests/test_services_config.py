"""BR7.4: the eval-only environment knobs are parsed strictly and default to the shipped pipeline."""

from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("numpy")

from framepilot_smart_mask.memory import WINDOW_SECONDS_PER_FRAME
from framepilot_smart_mask.services import pipeline_config


def test_defaults_are_the_shipped_pipeline() -> None:
    config = pipeline_config({})
    assert config.band_alpha and config.stabilise and config.eval_dump is None
    assert config.window_seconds_per_frame == WINDOW_SECONDS_PER_FRAME


def test_ablations_deadline_and_dump_come_from_the_environment(tmp_path: Path) -> None:
    config = pipeline_config(
        {
            "FRAMEPILOT_SMART_MASK_ABLATE": "band_alpha, stabilise",
            "FRAMEPILOT_SMART_MASK_WINDOW_SECONDS_PER_FRAME": "600",
            "FRAMEPILOT_SMART_MASK_EVAL_DUMP": str(tmp_path),
            "FRAMEPILOT_SMART_MASK_MATTING_TILE": "2048",
        }
    )
    assert not config.band_alpha and not config.stabilise
    assert config.window_seconds_per_frame == 600.0 and config.eval_dump == tmp_path
    assert config.matting_tile == 2048


def test_an_unknown_ablation_is_refused_not_ignored() -> None:
    with pytest.raises(ValueError, match="unknown stage"):
        pipeline_config({"FRAMEPILOT_SMART_MASK_ABLATE": "band-alpha"})
