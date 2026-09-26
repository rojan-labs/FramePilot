"""A layer's exit that is not a closing mask plays its entrance backwards (plan/elements EL7).

A slide or a zoom leaving a sticker used to vanish at once: on an exit the compiler kept only the
kind's reveal mask, which for a geometric kind is the whole frame from the first instant. It now
plays the kind's entrance at ``1 - progress``: the frame the exit shows at ``p`` is the frame the
entrance showed at ``1 - p``, picture and alpha. A dissolve or a wipe exit is unchanged, and so is
the outgoing half of a cut, which the next shot animates over.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pytest
from moviepy import VideoClip

from framepilot_engine.render.compiler import _apply_catalog_transition
from framepilot_engine.render.frame_plan import exit_plays_reversed
from framepilot_engine.render.resources import close_clip_tree
from framepilot_engine.timeline.models import Clip

SIZE = (64, 48)
SECONDS = 4.0
RAMP = 1.0


def _picture() -> VideoClip:
    """A still with a left half and a right half, so a slide's direction shows in the pixels."""
    frame = np.zeros((SIZE[1], SIZE[0], 3), dtype=np.uint8)
    frame[:, : SIZE[0] // 2] = (230, 40, 40)
    frame[:, SIZE[0] // 2 :] = (40, 60, 230)
    return VideoClip(frame_function=lambda _t: frame, duration=SECONDS)


def _clip(effects: list[dict[str, Any]]) -> Clip:
    return Clip.model_validate(
        {
            "id": "sticker",
            "assetId": "png",
            "trackId": "o1",
            "start": 0,
            "end": SECONDS,
            "sourceStart": 0,
            "sourceEnd": SECONDS,
            "effects": effects,
            "keyframes": [],
        }
    )


def _entrance(kind: str, easing: str = "linear") -> Clip:
    return _clip(
        [
            {
                "id": "sticker__transition",
                "type": "transition",
                "params": {"kind": kind, "durationSeconds": RAMP, "easing": easing},
                "keyframes": [],
            }
        ]
    )


def _exit(kind: str, easing: str = "linear", **extra: Any) -> Clip:
    return _clip(
        [
            {
                "id": "sticker__transition_out",
                "type": "transition_out",
                "params": {
                    "kind": kind,
                    "durationSeconds": RAMP,
                    "alignment": "end",
                    "easing": easing,
                    **extra,
                },
                "keyframes": [],
            }
        ]
    )


def _frame(clip: Clip, t: float) -> tuple[np.ndarray, np.ndarray]:
    rendered = _apply_catalog_transition(_picture(), clip, use_legacy=False)
    try:
        rgb = np.asarray(rendered.get_frame(t), dtype=np.float64)
        alpha = np.asarray(rendered.mask.get_frame(t), dtype=np.float64)
        return rgb, alpha
    finally:
        close_clip_tree(rendered)


@pytest.mark.parametrize("kind", ["slide-left", "zoom-out", "slide-down"])
@pytest.mark.parametrize("easing", ["linear", "ease-out"])
@pytest.mark.parametrize("progress", [0.25, 0.5, 0.75])
def test_a_geometric_exit_is_its_entrance_played_backwards(
    kind: str, easing: str, progress: float
) -> None:
    # Backwards in time: what the exit shows p of the way through is what the entrance showed
    # 1 - p of the way through, so an entrance that eases to rest leaves by easing away.
    exit_rgb, exit_alpha = _frame(_exit(kind, easing), SECONDS - RAMP + progress * RAMP)
    entrance_rgb, entrance_alpha = _frame(_entrance(kind, easing), (1.0 - progress) * RAMP)
    assert np.abs(exit_alpha - entrance_alpha).max() < 1e-6
    assert np.abs(exit_rgb - entrance_rgb).max() <= 1.0


def test_a_slide_exit_leaves_rather_than_vanishing() -> None:
    _, early = _frame(_exit("slide-left"), SECONDS - RAMP + 0.1 * RAMP)
    _, late = _frame(_exit("slide-left"), SECONDS - RAMP + 0.9 * RAMP)
    # Still mostly there as it starts to leave, mostly gone as it finishes.
    assert early.mean() > 0.8
    assert late.mean() < 0.2


def test_a_mask_exit_and_a_cuts_outgoing_half_are_not_reversed() -> None:
    assert exit_plays_reversed(_exit("slide-left"), "slide")
    assert not exit_plays_reversed(_exit("cross-dissolve"), "dissolve")
    assert not exit_plays_reversed(_exit("slide-left", toClipId="next"), "slide")
    # A dissolve exit fades the layer by its mask, as before: half gone at half way.
    _, alpha = _frame(_exit("cross-dissolve"), SECONDS - RAMP + 0.5 * RAMP)
    assert alpha.mean() == pytest.approx(0.5, abs=0.02)
