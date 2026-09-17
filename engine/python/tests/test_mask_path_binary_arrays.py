"""MK4.6: path keyframe arrays saved in the exact ``f64le:`` form load bit for bit."""

from __future__ import annotations

import base64
import struct

import pytest
from pydantic import ValidationError

from framepilot_engine.timeline.models import MaskPathKeyframe, decode_float64_array


def _encode(values: list[float]) -> str:
    return "f64le:" + base64.b64encode(struct.pack(f"<{len(values)}d", *values)).decode()


def test_decodes_what_the_editor_writes() -> None:
    # The TS codec's golden output for [1, -2] (float-array-codec.test.ts).
    assert decode_float64_array("f64le:AAAAAAAA8D8AAAAAAAAAwA==") == [1.0, -2.0]


def test_path_keyframe_accepts_both_forms_exactly() -> None:
    values = [812.3700000000001, 0.1 + 0.2, -0.0, 5e-324, 1.7976931348623157e308, 3.25]
    encoded = MaskPathKeyframe.model_validate(
        {
            "id": "k",
            "sourceTime": 0,
            "points": _encode(values),
            "vertexTypes": [0],
            "featherPx": _encode([2.5]),
        }
    )
    plain = MaskPathKeyframe.model_validate(
        {"id": "k", "sourceTime": 0, "points": values, "vertexTypes": [0], "featherPx": [2.5]}
    )
    assert encoded.points == plain.points
    assert all(
        struct.pack("<d", a) == struct.pack("<d", b)
        for a, b in zip(encoded.points, values, strict=True)
    )
    assert encoded.feather_px == [2.5]


@pytest.mark.parametrize("bad", ["f64le:AAAA", "f64le:!!!!", "points"])
def test_refuses_malformed_encodings(bad: str) -> None:
    with pytest.raises(ValidationError):
        MaskPathKeyframe.model_validate(
            {"id": "k", "sourceTime": 0, "points": bad, "vertexTypes": [0]}
        )
