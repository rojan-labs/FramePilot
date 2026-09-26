"""``add_shape`` in the engine (schema v25, plan/elements EL4a): the Python twin of the TS op.

Same id, same clip, same refusals in the same words, and a ``set_effect_params`` that would leave
a shape undrawable is refused here as it is in TypeScript.
"""

from __future__ import annotations

from typing import Any

import pytest

from framepilot_engine.timeline.models import Timeline
from framepilot_engine.timeline.operations import (
    AddShape,
    OperationError,
    SetEffectParams,
    apply_operation,
    invert_operation,
    shape_clip_id,
    shape_effect_id,
)
from framepilot_engine.timeline.synthetic_assets import SHAPE_ASSET_ID

BOX: dict[str, Any] = {
    "shape": "rounded-rect",
    "x": 50,
    "y": 50,
    "width": 48,
    "height": 27,
    "fill": None,
    "stroke": "#FFD400",
    "strokeWidth": 0.8,
    "strokeStyle": "solid",
    "cornerRadius": 12,
}


def _timeline() -> Timeline:
    return Timeline.model_validate({"tracks": [{"id": "o1", "type": "overlay", "clips": []}]})


def _add(params: dict[str, Any] | None = None) -> AddShape:
    return AddShape.model_validate(
        {"type": "add_shape", "trackId": "o1", "start": 2, "end": 5, "params": params or BOX}
    )


def test_adds_a_shape_clip_with_one_shape_effect() -> None:
    after = apply_operation(_timeline(), _add())
    clip = after.tracks[0].clips[0]
    assert clip.id == shape_clip_id("o1", 2) == "shape__o1_2000"
    assert clip.asset_id == SHAPE_ASSET_ID
    assert (clip.source_start, clip.source_end) == (0.0, 3.0)
    assert [(e.id, e.type, e.params) for e in clip.effects] == [
        (shape_effect_id(clip.id), "shape", BOX)
    ]


def test_inverts_to_the_timeline_before() -> None:
    before = _timeline()
    after = apply_operation(before, _add())
    restored = after
    for inverse in invert_operation(before, _add()):
        restored = apply_operation(restored, inverse)
    assert restored == before


def test_refuses_an_undrawable_shape_in_the_typescript_words() -> None:
    with pytest.raises(OperationError) as refused:
        apply_operation(_timeline(), _add({**BOX, "stroke": None}))
    assert refused.value.code == "invalid_style"
    assert (
        str(refused.value) == "A shape needs a fill or a stroke — with both off it draws nothing."
    )


def test_set_effect_params_keeps_a_shape_drawable() -> None:
    with_shape = apply_operation(_timeline(), _add())
    clip_id = shape_clip_id("o1", 2)
    turn_off = SetEffectParams.model_validate(
        {
            "type": "set_effect_params",
            "clipId": clip_id,
            "effectId": shape_effect_id(clip_id),
            "params": {"stroke": None},
        }
    )
    with pytest.raises(OperationError, match="draws nothing"):
        apply_operation(with_shape, turn_off)
    restyle = turn_off.model_copy(update={"params": {"stroke": "#FF3B30", "fill": "#FFFFFF"}})
    params = apply_operation(with_shape, restyle).tracks[0].clips[0].effects[0].params
    assert params["stroke"] == "#FF3B30" and params["fill"] == "#FFFFFF"
