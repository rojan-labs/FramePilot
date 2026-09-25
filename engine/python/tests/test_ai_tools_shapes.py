"""The engine's mirror of the agent's shape tools (plan/elements EL4a).

Same arguments and the same ops as the TypeScript ``add_shape`` / ``set_shape_style`` over
editor-core's placement builder: a preset's params with the model's box, ends and colours, on an
overlay lane with room; a refusal in the validator's words for a shape that would draw nothing.
"""

from __future__ import annotations

from typing import Any

import pytest

from framepilot_engine.ai_tools import ToolContext, ToolInputError, ToolSemanticError, run_tool
from framepilot_engine.render.shape_catalog import preset_shape_params
from framepilot_engine.timeline.models import SCHEMA_VERSION, Project
from framepilot_engine.timeline.operations import AddShape, apply_operation


def _project(overlay_clips: list[dict[str, Any]] | None = None) -> Project:
    return Project.model_validate(
        {
            "id": "p",
            "name": "p",
            "version": SCHEMA_VERSION,
            "fps": 30,
            "resolution": {"width": 1280, "height": 720},
            "assets": [],
            "timeline": {
                "tracks": [
                    {"id": "o1", "type": "overlay", "clips": overlay_clips or []},
                    {"id": "v1", "type": "video", "clips": []},
                ]
            },
        }
    )


def _ops(name: str, args: dict[str, Any], project: Project) -> list[dict[str, Any]]:
    result = run_tool(name, args, ToolContext(project=project))
    assert result.operations is not None
    return result.operations


def test_add_shape_places_the_preset_on_the_overlay_lane() -> None:
    ops = _ops("add_shape", {"shape": "rounded-rect/highlight", "start": 2, "end": 5}, _project())
    assert ops == [
        {
            "type": "add_shape",
            "trackId": "o1",
            "start": 2,
            "end": 5,
            "params": preset_shape_params("rounded-rect/highlight"),
            "clipId": "shape__o1_2000",
        }
    ]


def test_add_shape_takes_the_models_box_and_colour_words() -> None:
    ops = _ops(
        "add_shape",
        {
            "shape": "rounded-rect/highlight",
            "start": 1,
            "end": 3,
            "box": {"x": 62, "y": 40, "width": 18, "height": 9},
            "stroke": "red",
            "strokeWidth": 1.2,
        },
        _project(),
    )
    assert ops[-1]["params"] | {} == {
        **preset_shape_params("rounded-rect/highlight"),  # type: ignore[dict-item]
        "x": 62,
        "y": 40,
        "width": 18,
        "height": 9,
        "stroke": "#FF3B30",
        "strokeWidth": 1.2,
    }


def test_add_shape_opens_a_new_overlay_lane_when_the_span_is_busy() -> None:
    busy = _project(
        [
            {
                "id": "t",
                "assetId": "__text__",
                "trackId": "o1",
                "start": 0,
                "end": 10,
                "sourceStart": 0,
                "sourceEnd": 10,
            }
        ]
    )
    ops = _ops("add_shape", {"shape": "ellipse/outline", "start": 2, "end": 4}, busy)
    assert ops[0] == {
        "type": "add_layer",
        "layerId": "layer_overlay_3",
        "layerType": "overlay",
        "atIndex": 0,
    }
    assert ops[1]["trackId"] == "layer_overlay_3"


def test_add_shape_refuses_a_shape_that_draws_nothing() -> None:
    with pytest.raises(ToolSemanticError, match="draws nothing"):
        _ops(
            "add_shape",
            {"shape": "rounded-rect/highlight", "start": 0, "end": 2, "stroke": "none"},
            _project(),
        )


def test_add_shape_refuses_an_unknown_shape_at_the_schema() -> None:
    with pytest.raises(ToolInputError):
        _ops("add_shape", {"shape": "dodecahedron", "start": 0, "end": 2}, _project())


def test_set_shape_style_restyles_a_shape_and_refuses_anything_else() -> None:
    project = _project()
    (op,) = _ops("add_shape", {"shape": "rounded-rect/highlight", "start": 0, "end": 3}, project)
    project = project.model_copy(
        update={"timeline": apply_operation(project.timeline, AddShape.model_validate(op))}
    )
    ops = _ops("set_shape_style", {"clipId": "shape__o1_0", "stroke": "#0A84FF"}, project)
    assert ops == [
        {
            "type": "set_effect_params",
            "clipId": "shape__o1_0",
            "effectId": "shape__o1_0__shape",
            "params": {"stroke": "#0a84ff"},
        }
    ]
    with pytest.raises(ToolSemanticError, match="is not a shape"):
        _ops("set_shape_style", {"clipId": "nope", "stroke": "red"}, project)
    with pytest.raises(ToolSemanticError, match="draws nothing"):
        _ops("set_shape_style", {"clipId": "shape__o1_0", "stroke": "none"}, project)
