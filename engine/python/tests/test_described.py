"""The structured shot-description contract (brain.described, plan VU6.2/VU6.3).

One schema, three producers. Everything a producer returns funnels through
:func:`parse_described`, so this is where the honesty rules of tier 2 are enforced and
tested: unknown vocabulary is dropped rather than mapped, a field nobody described stays
empty, and ``p`` is a bucket rather than a number the model invented.
"""

from __future__ import annotations

from typing import Any

import pytest

from framepilot_engine.brain.described import (
    CAMERA_ANGLES,
    CONFIDENCE_BUCKETS,
    DESCRIBE_INSTRUCTION,
    DESCRIBED_JSON_SCHEMA,
    MAX_ON_SCREEN_TEXT_ITEMS,
    MAX_QUALITY_ITEMS,
    MAX_SUMMARY_CHARS,
    QUALITY_VOCABULARY,
    UNKNOWN,
    DescribedParseError,
    described_from_summary,
    keyframe_times,
    parse_described,
)
from framepilot_engine.brain.ledger_models import (
    TIER2_VERSION,
    CameraMovement,
    ShotSize,
)


def answer(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "summary": "A man in a grey jacket speaks to camera at a desk.",
        "subject": "man in grey jacket",
        "action": "speaking to camera",
        "setting": "office desk with a laptop",
        "camera": {"shotSize": "MS", "angle": "eye-level", "movement": "static"},
        "mood": "neutral, bright",
        "onScreenText": ["SHIP IT"],
        "quality": ["well-lit"],
        "confidence": "high",
    }
    payload.update(overrides)
    return payload


# --- the schema itself ------------------------------------------------------------


def test_every_property_is_required_at_every_level() -> None:
    # OpenAI's strict json_schema mode and llama.cpp's grammar conversion both need this;
    # optionality is expressed with the `unknown` sentinel, never by omitting a key.
    assert sorted(DESCRIBED_JSON_SCHEMA["required"]) == sorted(DESCRIBED_JSON_SCHEMA["properties"])
    camera = DESCRIBED_JSON_SCHEMA["properties"]["camera"]
    assert sorted(camera["required"]) == sorted(camera["properties"])
    assert camera["additionalProperties"] is False
    assert DESCRIBED_JSON_SCHEMA["additionalProperties"] is False


def test_the_ledger_enums_are_the_schema_enums() -> None:
    # Tier 2's shot size must be directly comparable with tier 1's, so it is the SAME
    # ladder rather than a second vocabulary that could drift from it.
    camera = DESCRIBED_JSON_SCHEMA["properties"]["camera"]["properties"]
    assert camera["shotSize"]["enum"] == [size.value for size in ShotSize] + [UNKNOWN]
    assert camera["movement"]["enum"] == [m.value for m in CameraMovement] + [UNKNOWN]
    assert camera["angle"]["enum"] == [*CAMERA_ANGLES, UNKNOWN]


def test_confidence_is_three_words_not_a_float() -> None:
    assert DESCRIBED_JSON_SCHEMA["properties"]["confidence"]["enum"] == list(CONFIDENCE_BUCKETS)
    assert set(CONFIDENCE_BUCKETS.values()) == {0.5, 0.7, 0.9}


def test_the_instruction_keeps_the_visible_only_discipline() -> None:
    # The one rule the deleted free-text CAPTION_INSTRUCTION carried, plus the two the
    # structure adds. Asserted so a rewrite cannot quietly drop them.
    assert "only what is visibly on screen" in DESCRIBE_INSTRUCTION
    assert "VERBATIM" in DESCRIBE_INSTRUCTION
    assert "no narration" in DESCRIBE_INSTRUCTION


# --- parsing ----------------------------------------------------------------------


def test_a_well_formed_answer_becomes_a_ledger_row() -> None:
    facts = parse_described(answer(), model="claude-x")
    assert facts.tier2_version == TIER2_VERSION
    assert facts.model == "claude-x"
    assert facts.camera.shot_size is ShotSize.MS
    assert facts.camera.movement is CameraMovement.STATIC
    assert facts.camera.angle == "eye-level"
    assert facts.on_screen_text == ["SHIP IT"]
    assert facts.quality == ["well-lit"]
    assert facts.p == 0.9


def test_unknown_camera_values_become_absent_not_a_nearest_match() -> None:
    facts = parse_described(
        answer(camera={"shotSize": UNKNOWN, "angle": "sideways", "movement": UNKNOWN}),
        model="m",
    )
    assert facts.camera.shot_size is None
    assert facts.camera.angle is None
    assert facts.camera.movement is None


def test_out_of_vocabulary_quality_is_dropped_and_deduplicated() -> None:
    facts = parse_described(answer(quality=["well-lit", "cinematic", "well-lit", "dim"]), model="m")
    assert facts.quality == ["well-lit", "dim"]


def test_quality_and_on_screen_text_are_bounded() -> None:
    facts = parse_described(
        answer(
            quality=list(QUALITY_VOCABULARY),
            onScreenText=[f"line {i}" for i in range(40)],
        ),
        model="m",
    )
    assert len(facts.quality) == MAX_QUALITY_ITEMS
    assert len(facts.on_screen_text) == MAX_ON_SCREEN_TEXT_ITEMS


def test_on_screen_text_is_verbatim_apart_from_whitespace() -> None:
    facts = parse_described(answer(onScreenText=["  SALE   50%  ", "", 7]), model="m")
    assert facts.on_screen_text == ["SALE 50%"]


def test_a_runaway_summary_is_capped() -> None:
    facts = parse_described(answer(summary="x " * 500), model="m")
    assert len(facts.summary) <= MAX_SUMMARY_CHARS


def test_free_text_fields_default_to_empty_not_to_a_sentence() -> None:
    facts = parse_described({"summary": "A shot."}, model="m")
    assert (facts.subject, facts.action, facts.setting, facts.mood) == ("", "", "", "")
    assert facts.on_screen_text == [] and facts.quality == []


def test_an_unreadable_confidence_falls_back_to_the_middle_bucket() -> None:
    assert parse_described(answer(confidence="very sure"), model="m").p == 0.7
    assert parse_described(answer(confidence=" LOW "), model="m").p == 0.5


@pytest.mark.parametrize("payload", ["prose", ["a"], None, 7])
def test_a_non_object_answer_is_refused(payload: Any) -> None:
    with pytest.raises(DescribedParseError, match="must be a JSON object"):
        parse_described(payload, model="m")


def test_a_summaryless_answer_is_not_a_description() -> None:
    with pytest.raises(DescribedParseError, match="non-empty summary"):
        parse_described(answer(summary="   "), model="m")


def test_extra_keys_are_ignored_rather_than_fatal() -> None:
    # A loose model is not a protocol violation; a missing summary is.
    assert parse_described(answer(extra="junk"), model="m").summary


# --- the TwelveLabs arm -----------------------------------------------------------


def test_twelvelabs_prose_fills_only_the_summary() -> None:
    # Parsing a sentence into `subject`/`camera` would manufacture facts with a provenance
    # nobody could check. One schema, three producers — and one of them fills one field.
    facts = described_from_summary("  Two hikers on a  ridge.  ", model="tl:pegasus")
    assert facts.summary == "Two hikers on a ridge."
    assert facts.model == "tl:pegasus"
    assert (facts.subject, facts.action, facts.setting, facts.mood) == ("", "", "", "")
    assert facts.camera.shot_size is None
    assert facts.quality == []


def test_empty_twelvelabs_prose_is_refused() -> None:
    with pytest.raises(DescribedParseError):
        described_from_summary("   ", model="tl:pegasus")


# --- keyframe choice --------------------------------------------------------------


def test_a_long_span_is_described_from_first_middle_and_last() -> None:
    times = keyframe_times(10.0, 20.0)
    assert len(times) == 3
    assert times == sorted(times)
    assert all(10.0 <= t < 20.0 for t in times)
    assert times[1] == pytest.approx(15.0)


def test_a_short_span_gets_one_frame_at_its_midpoint() -> None:
    assert keyframe_times(4.0, 4.2) == [pytest.approx(4.1)]


def test_every_time_stays_strictly_inside_the_span() -> None:
    for t0, t1 in [(0.0, 0.6), (0.0, 0.51), (1.0, 100.0)]:
        assert all(t0 <= t < t1 for t in keyframe_times(t0, t1))


@pytest.mark.parametrize(("t0", "t1", "frames"), [(0.0, 1.0, 0), (0.0, 1.0, 4), (2.0, 2.0, 3)])
def test_impossible_requests_are_programming_errors(t0: float, t1: float, frames: int) -> None:
    with pytest.raises(ValueError):
        keyframe_times(t0, t1, max_frames=frames)
