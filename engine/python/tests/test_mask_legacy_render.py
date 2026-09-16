"""Legacy migration gate (MK2.4): v21 mask effects export byte-identically on the v22 stack.

``tests/fixtures/mask-render/legacy-v21.json`` holds v21 clips with ``mask`` effects, and
``legacy-v21.migrated.json`` holds what the app's TypeScript migration turns them into (pinned
by ``packages/timeline-schema/src/mask-legacy-render-fixture.test.ts``). For every case and
sample, the alpha the v21 compiler attached (``rasterize_mask`` of the effect's spec at
clip time) must EQUAL, bit for bit, the alpha the v22 stack attaches for the migrated clip,
at the full cropped frame and at a decode-capped frame. ``_attach_mask`` multiplies this
alpha by the clip opacity exactly as v21 did, so equal alpha is an identical export.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from framepilot_engine.render.mask_stack import clip_mask_stacks
from framepilot_engine.render.masks import (
    has_mask_keyframes,
    mask_spec_at,
    mask_spec_from_params,
    rasterize_mask,
)
from framepilot_engine.timeline.models import Clip, Effect

_FIXTURES = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "mask-render"
_INPUT = json.loads((_FIXTURES / "legacy-v21.json").read_text(encoding="utf-8"))
_MIGRATED = {
    case["id"]: case["clip"]
    for case in json.loads((_FIXTURES / "legacy-v21.migrated.json").read_text(encoding="utf-8"))[
        "cases"
    ]
}


def _v21_alpha(effect: Effect, t: float, width: int, height: int) -> np.ndarray:
    spec = (
        mask_spec_at(effect, t)
        if has_mask_keyframes(effect)
        else mask_spec_from_params(effect.params)
    )
    return rasterize_mask(spec, width, height)


def _frame_sizes(clip: dict[str, Any]) -> list[tuple[int, int]]:
    media = _INPUT["media"]
    crop = clip.get("crop") or {"width": 1.0, "height": 1.0}
    full = (round(crop["width"] * media["width"]), round(crop["height"] * media["height"]))
    return [full, (full[0] // 2, full[1] // 2)]


def test_every_fixture_case_was_migrated() -> None:
    assert sorted(_MIGRATED) == sorted(case["id"] for case in _INPUT["cases"])
    assert len(_MIGRATED) >= 9


#: Cases the v21 -> v22 migration cannot carry byte-identically, with the reason. NOT a lowered
#: gate: each is a recorded miss (strict xfail, so a fix flips it to a failure to remove here).
_KNOWN_MISSES = {
    "ramped-keyframed": (
        "MK1 migration: keyframes linear on the timeline clock are re-timed through the speed "
        "ramp but keep their easing, so between keyframes the source-clock curve differs from "
        "the v21 motion (exact at the keyframes). Needs resampled keyframes in the migration."
    ),
}


def _cases() -> list[Any]:
    return [
        pytest.param(case, id=case["id"], marks=pytest.mark.xfail(strict=True, reason=reason))
        if (reason := _KNOWN_MISSES.get(case["id"])) is not None
        else pytest.param(case, id=case["id"])
        for case in _INPUT["cases"]
    ]


@pytest.mark.parametrize("case", _cases())
def test_migrated_masks_rasterise_byte_identically_to_v21(case: dict[str, Any]) -> None:
    v21_clip = {**_INPUT["clipTemplate"], **case["clip"]}
    first_mask = next(effect for effect in v21_clip["effects"] if effect["type"] == "mask")
    effect = Effect.model_validate(first_mask)
    migrated = Clip.model_validate(_MIGRATED[case["id"]])
    media = case.get("media", _INPUT["media"])
    media_size = None if media is None else (media["width"], media["height"])
    stacks = clip_mask_stacks(migrated, media_size)
    assert stacks is not None and len(stacks.alpha) == 1
    for width, height in _frame_sizes(v21_clip):
        for t in _INPUT["samples"]:
            if t >= v21_clip["end"] - v21_clip["start"]:
                continue
            expected = _v21_alpha(effect, t, width, height)
            actual = stacks.alpha_at(t, width, height)
            assert actual is not None
            assert actual.dtype == expected.dtype
            assert actual.tobytes() == expected.tobytes(), (case["id"], width, height, t)
