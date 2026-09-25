"""The engine's shape catalogue and shape-param rules (schema v25, plan/elements EL4a).

The engine is the only shape rasteriser, so it must read the exact catalogue the Shapes tab and
the AI tools publish, and refuse exactly what they refuse, in the same words. Three contracts:

* the packaged ``shape_catalog.json`` is byte-for-byte the TS-generated one;
* ``shape_params_problem`` returns the sentence ``tests/fixtures/shape-params.json`` records for
  every row (the TS test reads the same table);
* the Pydantic ``ShapeParams`` declares the fields and enum members of ``$defs.ShapeParams`` in
  the committed project JSON Schema.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from framepilot_engine.render.shape_catalog import (
    featured_shape_preset_ids,
    load_shape_catalog,
    preset_shape_params,
    shape_descriptor,
    shape_params_problem,
    shape_preset_ids,
)
from framepilot_engine.timeline.models import ShapeCap, ShapeParams, ShapeStrokeStyle

REPO = Path(__file__).resolve().parents[3]
PACKAGED = (
    Path(__file__).resolve().parents[1] / "framepilot_engine" / "render" / "shape_catalog.json"
)
GENERATED = REPO / "packages" / "timeline-schema" / "schema" / "shape-catalog.json"
PROJECT_SCHEMA = REPO / "packages" / "timeline-schema" / "schema" / "project.schema.json"
VECTORS: list[dict[str, Any]] = json.loads(
    (REPO / "tests" / "fixtures" / "shape-params.json").read_text(encoding="utf-8")
)["cases"]


def test_the_packaged_catalogue_is_the_generated_one() -> None:
    assert PACKAGED.read_text(encoding="utf-8") == GENERATED.read_text(encoding="utf-8")


def test_the_catalogue_loads_every_shape() -> None:
    catalog = load_shape_catalog()
    # The EL4a staples keep their ids (persisted in projects); the catalogue grows around them.
    assert {"rounded-rect", "ellipse", "marker-highlight", "line-arrow", "underline-marker"} <= set(
        catalog
    )
    assert len(catalog) >= 100
    arrow = shape_descriptor("line-arrow")
    assert arrow is not None and arrow.frame == "segment"
    assert arrow.knob("headSize") is not None


@pytest.mark.parametrize("row", VECTORS, ids=lambda row: str(row["name"]))
def test_refuses_exactly_what_typescript_refuses(row: dict[str, Any]) -> None:
    assert shape_params_problem(row["params"]) == row["problem"]


@pytest.mark.parametrize(
    "row", [row for row in VECTORS if row["problem"] is None], ids=lambda row: str(row["name"])
)
def test_a_valid_shape_parses_as_the_pydantic_twin(row: dict[str, Any]) -> None:
    params = ShapeParams.model_validate(row["params"])
    assert params.shape == row["params"]["shape"]


def _enum(node: dict[str, Any]) -> set[str]:
    """The members of an enum node, looking through a nullish ``anyOf``."""
    if "enum" in node:
        return set(node["enum"])
    return {member for option in node.get("anyOf", []) for member in option.get("enum", [])}


def test_the_pydantic_twin_declares_the_schema_fields_and_enums() -> None:
    schema = json.loads(PROJECT_SCHEMA.read_text(encoding="utf-8"))["$defs"]["ShapeParams"]
    fields = {field.alias or name for name, field in ShapeParams.model_fields.items()}
    assert fields == set(schema["properties"])
    assert {member.value for member in ShapeStrokeStyle} == _enum(
        schema["properties"]["strokeStyle"]
    )
    assert {member.value for member in ShapeCap} == _enum(schema["properties"]["endCap"])
    # Required on both sides: the shape id and the stroke's width and style. Colours, caps and
    # the frame keys are nullish (null reads as absent); which frame keys a shape needs is the
    # catalogue's call (``shape_params_problem``).
    required = {
        field.alias or name
        for name, field in ShapeParams.model_fields.items()
        if field.is_required()
    }
    assert required == set(schema["required"])


@pytest.mark.parametrize(
    ("name", "preset_id", "at"),
    [
        ("a highlight box", "rounded-rect/highlight", (50.0, 50.0)),
        ("an arrow", "line-arrow/red", (50.0, 50.0)),
        ("a marker", "marker-highlight/yellow", (20.0, 80.0)),
        ("an underline", "underline-marker/yellow", (50.0, 90.0)),
        ("an ellipse", "ellipse/outline", (10.0, 10.0)),
    ],
)
def test_preset_params_are_the_typescript_ones(
    name: str, preset_id: str, at: tuple[float, float]
) -> None:
    # The vector table's valid rows were written by TypeScript's presetShapeParams.
    expected = next(row["params"] for row in VECTORS if row["name"] == name)
    assert preset_shape_params(preset_id, at) == expected


def test_preset_ids_list_every_preset_in_catalogue_order() -> None:
    assert shape_preset_ids()[:2] == ("rounded-rect/highlight", "rounded-rect/filled")
    generated = json.loads(GENERATED.read_text(encoding="utf-8"))
    assert shape_preset_ids() == tuple(
        preset["id"] for shape in generated["shapes"] for preset in shape["presets"]
    )
    assert preset_shape_params("nope/none") is None


def test_the_featured_presets_are_the_screen_recording_staples() -> None:
    assert featured_shape_preset_ids() == (
        "rounded-rect/highlight",
        "rounded-rect/filled",
        "ellipse/outline",
        "marker-highlight/yellow",
        "line-arrow/red",
        "underline-marker/yellow",
    )


def test_an_icon_id_is_its_own_preset_in_white() -> None:
    assert preset_shape_params("icon/check", (20, 30)) == {
        "shape": "icon/check",
        "x": 20,
        "y": 30,
        "width": 24,
        "height": 24,
        "fill": None,
        "stroke": "#FFFFFF",
        "strokeWidth": 1,
        "strokeStyle": "solid",
    }
    assert preset_shape_params("icon/not-an-icon") is None
