"""The structured contract itself: a schema strict enough for every producer."""

from __future__ import annotations

from typing import Any

from framepilot_visual_describe.schema import (
    CAMERA_ANGLES,
    CAMERA_MOVEMENTS,
    CONFIDENCE_LEVELS,
    DESCRIBE_INSTRUCTION,
    DESCRIBED_JSON_SCHEMA,
    QUALITY_VOCABULARY,
    SHOT_SIZES,
    UNKNOWN,
)


def _properties(node: dict[str, Any]) -> dict[str, Any]:
    return dict(node["properties"])


def test_every_property_is_required_at_every_level() -> None:
    # OpenAI's strict json_schema mode and llama.cpp's grammar conversion both need this;
    # optionality is expressed with the `unknown` sentinel, never by omitting a key.
    assert sorted(DESCRIBED_JSON_SCHEMA["required"]) == sorted(_properties(DESCRIBED_JSON_SCHEMA))
    camera = _properties(DESCRIBED_JSON_SCHEMA)["camera"]
    assert sorted(camera["required"]) == sorted(_properties(camera))


def test_additional_properties_are_closed_at_every_level() -> None:
    assert DESCRIBED_JSON_SCHEMA["additionalProperties"] is False
    assert _properties(DESCRIBED_JSON_SCHEMA)["camera"]["additionalProperties"] is False


def test_every_closed_vocabulary_offers_an_explicit_unknown() -> None:
    camera = _properties(_properties(DESCRIBED_JSON_SCHEMA)["camera"])
    assert camera["shotSize"]["enum"] == [*SHOT_SIZES, UNKNOWN]
    assert camera["angle"]["enum"] == [*CAMERA_ANGLES, UNKNOWN]
    assert camera["movement"]["enum"] == [*CAMERA_MOVEMENTS, UNKNOWN]


def test_quality_has_no_unknown_because_an_empty_list_already_says_it() -> None:
    quality = _properties(DESCRIBED_JSON_SCHEMA)["quality"]
    assert quality["items"]["enum"] == list(QUALITY_VOCABULARY)
    assert UNKNOWN not in quality["items"]["enum"]


def test_confidence_is_three_words_not_a_float() -> None:
    assert _properties(DESCRIBED_JSON_SCHEMA)["confidence"]["enum"] == list(CONFIDENCE_LEVELS)


def test_the_instruction_keeps_the_visible_only_discipline() -> None:
    # The rule the deleted free-text CAPTION_INSTRUCTION carried, and the two the
    # structure adds. Asserted so a rewrite cannot quietly drop them.
    assert "only what is visibly on screen" in DESCRIBE_INSTRUCTION
    assert "VERBATIM" in DESCRIBE_INSTRUCTION
    assert "no narration" in DESCRIBE_INSTRUCTION
