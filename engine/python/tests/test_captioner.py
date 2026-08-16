"""Tests for the per-scene VLM captioner (brain.captioner, plan MI3.1).

Deterministic core module (100% branch coverage): every request is respx-mocked
— no test tier ever calls a live vision API (plan §6) — so both wire formats,
the frame cap, trimming/capping, and every failure branch are exercised
directly. A recurring assertion proves the API key never reaches the logs.
"""

from __future__ import annotations

import base64
import json
from typing import Any

import httpx
import pytest
import respx

from framepilot_engine.brain.captioner import (
    ANTHROPIC_VERSION,
    CAPTION_INSTRUCTION,
    NO_VISION_PROVIDER_REASON,
    CaptionError,
    CaptionProviderConfig,
    SceneCaptioner,
    resolve_captioner,
)

KEY = "sk-secret-key-123456"
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
OPENAI_URL = "https://api.openai.com/v1/chat/completions"

JPEG_A = b"\xff\xd8jpeg-bytes-a\xff\xd9"
JPEG_B = b"\xff\xd8jpeg-bytes-b\xff\xd9"


def anthropic_config(base_url: str | None = None) -> CaptionProviderConfig:
    return CaptionProviderConfig(
        kind="anthropic", model="claude-x", api_key=KEY, base_url=base_url
    )


def openai_config(base_url: str | None = None) -> CaptionProviderConfig:
    return CaptionProviderConfig(kind="openai", model="gpt-x", api_key=KEY, base_url=base_url)


def make_captioner(config: CaptionProviderConfig, **kwargs: Any) -> SceneCaptioner:
    return SceneCaptioner(config, http=httpx.Client(), **kwargs)


def anthropic_response(text: str) -> dict[str, Any]:
    """A well-formed Messages response with a leading non-text block to skip."""
    return {
        "content": [
            {"type": "thinking", "thinking": "ignored"},
            {"type": "text", "text": text},
        ],
        "model": "claude-x",
    }


def openai_response(text: str) -> dict[str, Any]:
    return {"choices": [{"message": {"role": "assistant", "content": text}}]}


def request_body(call_index: int = 0) -> dict[str, Any]:
    body: dict[str, Any] = json.loads(respx.calls[call_index].request.content)
    return body


# --- resolution (honest-unavailable) ---------------------------------------------


def test_resolve_without_config_is_honestly_unavailable() -> None:
    resolution = resolve_captioner(None)
    assert resolution.captioner is None
    assert resolution.reason == NO_VISION_PROVIDER_REASON


def test_resolve_with_config_builds_a_captioner() -> None:
    resolution = resolve_captioner(anthropic_config(), http=httpx.Client())
    assert isinstance(resolution.captioner, SceneCaptioner)
    assert resolution.reason is None


def test_resolve_defaults_to_a_real_http_client() -> None:
    resolution = resolve_captioner(openai_config())
    assert isinstance(resolution.captioner, SceneCaptioner)


# --- anthropic wire format --------------------------------------------------------


@respx.mock
def test_anthropic_request_shape_and_base64_encoding(
    caplog: pytest.LogCaptureFixture,
) -> None:
    respx.post(ANTHROPIC_URL).respond(200, json=anthropic_response("A whiteboard with a diagram."))
    captioner = make_captioner(anthropic_config())
    with caplog.at_level("DEBUG"):
        caption = captioner.caption_scene([JPEG_A])
    assert caption == "A whiteboard with a diagram."

    request = respx.calls[0].request
    assert request.headers["x-api-key"] == KEY
    assert request.headers["anthropic-version"] == ANTHROPIC_VERSION
    body = request_body()
    assert body["model"] == "claude-x"
    assert body["system"] == CAPTION_INSTRUCTION
    content = body["messages"][0]["content"]
    image_block = content[0]
    assert image_block["type"] == "image"
    assert image_block["source"]["type"] == "base64"
    assert image_block["source"]["media_type"] == "image/jpeg"
    assert image_block["source"]["data"] == base64.b64encode(JPEG_A).decode("ascii")
    assert content[-1]["type"] == "text"
    # The key must never reach the logs.
    assert KEY not in caplog.text


@respx.mock
def test_anthropic_custom_base_url_is_honored() -> None:
    respx.post("https://proxy.internal/v1/messages").respond(
        200, json=anthropic_response("Two people at a desk.")
    )
    captioner = make_captioner(anthropic_config(base_url="https://proxy.internal/"))
    assert captioner.caption_scene([JPEG_A]) == "Two people at a desk."


# --- openai-compatible wire format ------------------------------------------------


@respx.mock
def test_openai_request_shape_and_data_uri() -> None:
    respx.post("https://nim.local/v1/chat/completions").respond(
        200, json=openai_response("A product dashboard on a laptop screen.")
    )
    captioner = make_captioner(openai_config(base_url="https://nim.local/v1"))
    caption = captioner.caption_scene([JPEG_A])
    assert caption == "A product dashboard on a laptop screen."

    request = respx.calls[0].request
    assert request.headers["Authorization"] == f"Bearer {KEY}"
    body = request_body()
    assert body["model"] == "gpt-x"
    messages = body["messages"]
    assert messages[0] == {"role": "system", "content": CAPTION_INSTRUCTION}
    content = messages[1]["content"]
    assert content[0] == {"type": "text", "text": "Caption this scene."}
    image_part = content[1]
    assert image_part["type"] == "image_url"
    expected_uri = "data:image/jpeg;base64," + base64.b64encode(JPEG_A).decode("ascii")
    assert image_part["image_url"]["url"] == expected_uri


@respx.mock
def test_openai_default_base_url_hits_the_public_host() -> None:
    respx.post(OPENAI_URL).respond(200, json=openai_response("A city street at night."))
    captioner = make_captioner(openai_config())
    assert captioner.caption_scene([JPEG_A]) == "A city street at night."


# --- multi-frame strip ------------------------------------------------------------


@respx.mock
def test_multi_frame_strip_sends_every_frame_up_to_the_cap() -> None:
    respx.post(OPENAI_URL).respond(200, json=openai_response("A sequence of motion."))
    captioner = make_captioner(openai_config(), max_frames=4)
    captioner.caption_scene([JPEG_A, JPEG_B])
    content = request_body()["messages"][1]["content"]
    image_parts = [c for c in content if c["type"] == "image_url"]
    assert len(image_parts) == 2


@respx.mock
def test_frame_count_is_capped_at_max_frames() -> None:
    respx.post(ANTHROPIC_URL).respond(200, json=anthropic_response("Busy scene."))
    captioner = make_captioner(anthropic_config(), max_frames=2)
    captioner.caption_scene([JPEG_A, JPEG_B, JPEG_A, JPEG_B, JPEG_A])
    content = request_body()["messages"][0]["content"]
    image_blocks = [c for c in content if c["type"] == "image"]
    assert len(image_blocks) == 2


# --- trimming / capping -----------------------------------------------------------


@respx.mock
def test_caption_whitespace_is_collapsed() -> None:
    respx.post(OPENAI_URL).respond(
        200, json=openai_response("  A   messy\n\tcaption  \n with   gaps.  ")
    )
    captioner = make_captioner(openai_config())
    assert captioner.caption_scene([JPEG_A]) == "A messy caption with gaps."


@respx.mock
def test_long_caption_is_hard_capped() -> None:
    respx.post(OPENAI_URL).respond(200, json=openai_response("word " * 100))
    captioner = make_captioner(openai_config(), max_caption_chars=20)
    caption = captioner.caption_scene([JPEG_A])
    assert len(caption) <= 20
    assert caption == "word word word word"


@respx.mock
def test_provider_safety_status_is_rejected_as_nonvisual_metadata() -> None:
    # Regression from a real indexed image: an OpenAI-compatible endpoint returned
    # its moderation preamble as message.content and it was persisted as the scene
    # caption, leaving the orchestrator with "User Safety: safe" instead of pixels.
    respx.post(OPENAI_URL).respond(200, json=openai_response("User Safety: safe"))
    captioner = make_captioner(openai_config())
    with pytest.raises(CaptionError, match="status metadata"):
        captioner.caption_scene([JPEG_A])


# --- failure branches -------------------------------------------------------------


@respx.mock
def test_http_error_raises_caption_error_without_rotating(
    caplog: pytest.LogCaptureFixture,
) -> None:
    respx.post(ANTHROPIC_URL).respond(500, text="upstream boom")
    captioner = make_captioner(anthropic_config())
    with caplog.at_level("DEBUG"), pytest.raises(CaptionError, match="HTTP 500"):
        captioner.caption_scene([JPEG_A])
    assert len(respx.calls) == 1  # best-effort: no retry, no key rotation
    assert KEY not in caplog.text


@respx.mock
def test_malformed_anthropic_body_raises_caption_error() -> None:
    respx.post(ANTHROPIC_URL).respond(200, json={"unexpected": "shape"})
    captioner = make_captioner(anthropic_config())
    with pytest.raises(CaptionError, match="anthropic response body"):
        captioner.caption_scene([JPEG_A])


@respx.mock
def test_malformed_openai_body_raises_caption_error() -> None:
    respx.post(OPENAI_URL).respond(200, json={"choices": []})
    captioner = make_captioner(openai_config())
    with pytest.raises(CaptionError, match="openai response body"):
        captioner.caption_scene([JPEG_A])


@respx.mock
def test_openai_non_text_content_raises_caption_error() -> None:
    respx.post(OPENAI_URL).respond(
        200, json={"choices": [{"message": {"content": None}}]}
    )
    captioner = make_captioner(openai_config())
    with pytest.raises(CaptionError, match="non-text content"):
        captioner.caption_scene([JPEG_A])


@respx.mock
def test_empty_caption_raises_caption_error() -> None:
    respx.post(OPENAI_URL).respond(200, json=openai_response("   \n  "))
    captioner = make_captioner(openai_config())
    with pytest.raises(CaptionError, match="empty caption"):
        captioner.caption_scene([JPEG_A])


def test_empty_frame_list_raises_caption_error() -> None:
    captioner = make_captioner(openai_config())
    with pytest.raises(CaptionError, match="at least one frame"):
        captioner.caption_scene([])


# --- construction guards ----------------------------------------------------------


@pytest.mark.parametrize(
    ("kwargs", "match"),
    [
        ({"max_frames": 0}, "max_frames"),
        ({"max_caption_chars": 0}, "max_caption_chars"),
        ({"max_tokens": 0}, "max_tokens"),
        ({"timeout_seconds": 0.0}, "timeout_seconds"),
    ],
)
def test_non_positive_bounds_are_rejected(kwargs: dict[str, Any], match: str) -> None:
    with pytest.raises(ValueError, match=match):
        make_captioner(openai_config(), **kwargs)
