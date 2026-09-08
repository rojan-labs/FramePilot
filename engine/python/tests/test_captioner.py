"""Tests for the hosted structured describer (brain.captioner, plan VU6.3).

Deterministic core module: every request is respx-mocked — no test tier ever calls a live
vision API — so both wire formats, the schema they carry, the frame cap and every failure
branch are exercised directly. A recurring assertion proves the API key never reaches the
logs.

**The free-text path is gone.** ``CAPTION_INSTRUCTION`` and ``SceneCaptioner.caption_scene``
were deleted with the prose tier; the tests that covered them were deleted with it, and the
ones here replace them. A test asserting that a caption is "≤2 sentences of prose" would be
a test for a contract this codebase no longer has.
"""

from __future__ import annotations

import base64
import json
from typing import Any

import httpx
import pytest
import respx

from framepilot_engine.brain.captioner import (
    ANTHROPIC_TOOL_NAME,
    ANTHROPIC_VERSION,
    NO_VISION_PROVIDER_REASON,
    CaptionProviderConfig,
    DescribeError,
    SceneDescriber,
    is_informative_caption,
    resolve_describer,
)
from framepilot_engine.brain.described import (
    DESCRIBE_INSTRUCTION,
    DESCRIBED_JSON_SCHEMA,
    DESCRIBED_SCHEMA_NAME,
)
from framepilot_engine.brain.ledger_models import (
    TIER2_VERSION,
    CameraMovement,
    ShotSize,
)

KEY = "sk-secret-key-123456"
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
OPENAI_URL = "https://api.openai.com/v1/chat/completions"

JPEG_A = b"\xff\xd8jpeg-bytes-a\xff\xd9"
JPEG_B = b"\xff\xd8jpeg-bytes-b\xff\xd9"
JPEG_C = b"\xff\xd8jpeg-bytes-c\xff\xd9"
JPEG_D = b"\xff\xd8jpeg-bytes-d\xff\xd9"


def description(**overrides: Any) -> dict[str, Any]:
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


def anthropic_config(base_url: str | None = None) -> CaptionProviderConfig:
    return CaptionProviderConfig(
        kind="anthropic", model="claude-x", api_key=KEY, base_url=base_url
    )


def openai_config(base_url: str | None = None) -> CaptionProviderConfig:
    return CaptionProviderConfig(kind="openai", model="gpt-x", api_key=KEY, base_url=base_url)


def make_describer(config: CaptionProviderConfig, **kwargs: Any) -> SceneDescriber:
    return SceneDescriber(config, http=httpx.Client(), **kwargs)


def anthropic_response(payload: dict[str, Any]) -> dict[str, Any]:
    """A well-formed Messages response with a leading non-tool block to skip."""
    return {
        "content": [
            {"type": "text", "text": "ignored preamble"},
            {"type": "tool_use", "name": ANTHROPIC_TOOL_NAME, "id": "t1", "input": payload},
        ],
        "model": "claude-x",
    }


def openai_response(payload: dict[str, Any] | str) -> dict[str, Any]:
    content = payload if isinstance(payload, str) else json.dumps(payload)
    return {"choices": [{"message": {"role": "assistant", "content": content}}]}


def request_body(call_index: int = 0) -> dict[str, Any]:
    body: dict[str, Any] = json.loads(respx.calls[call_index].request.content)
    return body


# --- resolution (honest-unavailable) ---------------------------------------------


def test_resolve_without_config_is_honestly_unavailable() -> None:
    resolution = resolve_describer(None)
    assert resolution.describer is None
    assert resolution.reason == NO_VISION_PROVIDER_REASON


def test_resolve_with_config_builds_a_describer() -> None:
    resolution = resolve_describer(anthropic_config(), http=httpx.Client())
    assert isinstance(resolution.describer, SceneDescriber)
    assert resolution.reason is None


def test_resolve_defaults_to_a_real_http_client() -> None:
    resolution = resolve_describer(openai_config())
    assert isinstance(resolution.describer, SceneDescriber)


@pytest.mark.parametrize("bound", ["max_frames", "max_tokens", "timeout_seconds"])
def test_non_positive_bounds_are_refused(bound: str) -> None:
    with pytest.raises(ValueError, match=f"{bound} must be > 0"):
        make_describer(anthropic_config(), **{bound: 0})


# --- anthropic wire format --------------------------------------------------------


@respx.mock
def test_anthropic_forces_a_tool_call_against_the_shared_schema(
    caplog: pytest.LogCaptureFixture,
) -> None:
    respx.post(ANTHROPIC_URL).respond(200, json=anthropic_response(description()))
    describer = make_describer(anthropic_config())
    with caplog.at_level("DEBUG"):
        facts = describer.describe_scene([JPEG_A])

    request = respx.calls[0].request
    assert request.headers["x-api-key"] == KEY
    assert request.headers["anthropic-version"] == ANTHROPIC_VERSION
    body = request_body()
    assert body["system"] == DESCRIBE_INSTRUCTION
    # Structure is not a request the model may decline: the tool is named in tool_choice.
    assert body["tool_choice"] == {"type": "tool", "name": ANTHROPIC_TOOL_NAME}
    assert body["tools"][0]["input_schema"] == DESCRIBED_JSON_SCHEMA
    image_block = body["messages"][0]["content"][0]
    assert image_block["source"]["media_type"] == "image/jpeg"
    assert image_block["source"]["data"] == base64.b64encode(JPEG_A).decode("ascii")

    assert facts.tier2_version == TIER2_VERSION
    assert facts.model == "claude-x"
    assert facts.summary.startswith("A man in a grey jacket")
    assert facts.camera.shot_size is ShotSize.MS
    assert facts.camera.movement is CameraMovement.STATIC
    assert facts.on_screen_text == ["SHIP IT"]
    assert facts.p == 0.9
    # The key must never reach the logs.
    assert KEY not in caplog.text


@respx.mock
def test_anthropic_prose_answer_is_refused_rather_than_stored() -> None:
    respx.post(ANTHROPIC_URL).respond(
        200, json={"content": [{"type": "text", "text": "A man at a desk."}]}
    )
    with pytest.raises(DescribeError, match="no description tool call"):
        make_describer(anthropic_config()).describe_scene([JPEG_A])


@respx.mock
def test_anthropic_tool_call_without_an_object_is_refused() -> None:
    respx.post(ANTHROPIC_URL).respond(
        200,
        json={"content": [{"type": "tool_use", "name": ANTHROPIC_TOOL_NAME, "input": "text"}]},
    )
    with pytest.raises(DescribeError, match="no input object"):
        make_describer(anthropic_config()).describe_scene([JPEG_A])


@respx.mock
def test_anthropic_custom_base_url_is_honored() -> None:
    respx.post("https://proxy.internal/v1/messages").respond(
        200, json=anthropic_response(description())
    )
    describer = make_describer(anthropic_config(base_url="https://proxy.internal/"))
    assert describer.describe_scene([JPEG_A]).subject == "man in grey jacket"


# --- openai-compatible wire format ------------------------------------------------


@respx.mock
def test_openai_requests_a_strict_json_schema_and_data_uris() -> None:
    respx.post("https://nim.local/v1/chat/completions").respond(
        200, json=openai_response(description())
    )
    describer = make_describer(openai_config(base_url="https://nim.local/v1"))
    facts = describer.describe_scene([JPEG_A, JPEG_B])

    body = request_body()
    assert body["response_format"]["type"] == "json_schema"
    assert body["response_format"]["json_schema"]["name"] == DESCRIBED_SCHEMA_NAME
    assert body["response_format"]["json_schema"]["strict"] is True
    assert body["response_format"]["json_schema"]["schema"] == DESCRIBED_JSON_SCHEMA
    assert body["messages"][0]["content"] == DESCRIBE_INSTRUCTION
    parts = body["messages"][1]["content"]
    assert parts[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
    assert len(parts) == 3
    assert respx.calls[0].request.headers["Authorization"] == f"Bearer {KEY}"
    assert facts.model == "gpt-x"


@respx.mock
def test_openai_non_json_content_is_refused() -> None:
    respx.post(OPENAI_URL).respond(200, json=openai_response("A man at a desk."))
    with pytest.raises(DescribeError, match="did not return JSON"):
        make_describer(openai_config()).describe_scene([JPEG_A])


@respx.mock
def test_openai_json_that_is_not_an_object_is_refused() -> None:
    respx.post(OPENAI_URL).respond(200, json=openai_response("[1, 2]"))
    with pytest.raises(DescribeError, match="not an object"):
        make_describer(openai_config()).describe_scene([JPEG_A])


@respx.mock
def test_openai_non_text_content_is_refused() -> None:
    respx.post(OPENAI_URL).respond(
        200, json={"choices": [{"message": {"content": [{"type": "text"}]}}]}
    )
    with pytest.raises(DescribeError, match="non-text content"):
        make_describer(openai_config()).describe_scene([JPEG_A])


@respx.mock
def test_openai_unreadable_body_is_refused() -> None:
    respx.post(OPENAI_URL).respond(200, json={"unexpected": True})
    with pytest.raises(DescribeError, match="Could not read a description"):
        make_describer(openai_config()).describe_scene([JPEG_A])


# --- shared behaviour --------------------------------------------------------------


@respx.mock
def test_only_the_first_max_frames_are_sent() -> None:
    respx.post(ANTHROPIC_URL).respond(200, json=anthropic_response(description()))
    describer = make_describer(anthropic_config(), max_frames=2)
    describer.describe_scene([JPEG_A, JPEG_B, JPEG_C, JPEG_D])
    content = request_body()["messages"][0]["content"]
    assert sum(1 for block in content if block["type"] == "image") == 2


def test_an_empty_frame_list_is_refused() -> None:
    with pytest.raises(DescribeError, match="at least one frame"):
        make_describer(anthropic_config()).describe_scene([])


@respx.mock
def test_a_non_200_response_carries_its_status(caplog: pytest.LogCaptureFixture) -> None:
    respx.post(ANTHROPIC_URL).respond(429, text="rate limited")
    with caplog.at_level("DEBUG"), pytest.raises(DescribeError, match="HTTP 429"):
        make_describer(anthropic_config()).describe_scene([JPEG_A])
    assert KEY not in caplog.text


@respx.mock
def test_a_summaryless_answer_is_not_a_description() -> None:
    respx.post(OPENAI_URL).respond(200, json=openai_response(description(summary="  ")))
    with pytest.raises(DescribeError, match="not a shot description"):
        make_describer(openai_config()).describe_scene([JPEG_A])


@respx.mock
def test_status_metadata_in_the_summary_is_refused() -> None:
    # Observed on real OpenAI-compatible vision endpoints: a moderation preamble returned
    # as content. It is a successful HTTP response with zero visual evidence.
    respx.post(OPENAI_URL).respond(
        200, json=openai_response(description(summary="User Safety: safe"))
    )
    with pytest.raises(DescribeError, match="status metadata"):
        make_describer(openai_config()).describe_scene([JPEG_A])


@respx.mock
def test_out_of_vocabulary_values_are_dropped_not_stored() -> None:
    respx.post(OPENAI_URL).respond(
        200,
        json=openai_response(
            description(
                camera={"shotSize": "unknown", "angle": "sideways", "movement": "unknown"},
                quality=["cinematic"],
                confidence="unsure",
            )
        ),
    )
    facts = make_describer(openai_config()).describe_scene([JPEG_A])
    assert facts.camera.shot_size is None
    assert facts.camera.angle is None
    assert facts.camera.movement is None
    assert facts.quality == []
    assert facts.p == 0.7


def test_the_model_id_is_the_row_provenance() -> None:
    assert make_describer(openai_config()).model == "gpt-x"


# --- legacy caption rows -----------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "informative"),
    [
        ("A man at a desk.", True),
        ("Person outdoors", True),
        ("User Safety: safe", False),
        ("safety: blocked", False),
        ("   ", False),
    ],
)
def test_is_informative_caption_still_screens_legacy_rows(text: str, informative: bool) -> None:
    # `visual_captions` still holds rows the deleted prose path wrote; readers treat an
    # uninformative one as missing, which is what makes describing such an asset resumable.
    assert is_informative_caption(text) is informative
