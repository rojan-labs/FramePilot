"""Tests for the NVIDIA visual embedding client (brain.visual_embed, plan MI2.1).

Deterministic core module (100% branch coverage): every request is respx-mocked
— no test tier ever calls the live NVIDIA API (plan §6) — and the clock feeding
the key ring is a fake, so every failover branch is exercised exactly.
"""

from __future__ import annotations

import base64
import json
from typing import Any

import httpx
import pytest
import respx

from framepilot_engine.brain.keyring import KeyRing, KeyRingExhaustedError, KeyState
from framepilot_engine.brain.visual_embed import (
    EMBEDDINGS_URL,
    MODEL_ID,
    NO_API_KEY_REASON,
    VisualEmbedClient,
    VisualEmbedError,
    resolve_visual_embedder,
)

KEY_A = "nvapi-aaaa-secret-1111"
KEY_B = "nvapi-bbbb-secret-2222"

JPEG_A = b"\xff\xd8jpeg-bytes-a\xff\xd9"
JPEG_B = b"\xff\xd8jpeg-bytes-b\xff\xd9"

DIM = 4


def make_client(
    keys: list[str] | None = None,
    *,
    batch_size: int = 8,
    now: float = 0.0,
) -> VisualEmbedClient:
    """A client over a real ring, a real httpx client (respx intercepts), a fake clock."""
    ring = KeyRing(keys or [KEY_A])
    return VisualEmbedClient(ring, http=httpx.Client(), now=lambda: now, batch_size=batch_size)


def embeddings_response(count: int, *, dim: int = DIM) -> dict[str, Any]:
    """A well-formed response body; indices deliberately reversed to prove sorting."""
    return {
        "data": [
            {"index": i, "embedding": [float(i)] * dim} for i in reversed(range(count))
        ],
        "model": MODEL_ID,
        "usage": {"prompt_tokens": 0, "total_tokens": 0},
    }


def request_body(call_index: int = 0) -> dict[str, Any]:
    request = respx.calls[call_index].request
    body: dict[str, Any] = json.loads(request.content)
    return body


# --- payload shape (the one-place contract) --------------------------------------


@respx.mock
def test_passage_payload_shape_and_data_uri_prefix() -> None:
    respx.post(EMBEDDINGS_URL).respond(200, json=embeddings_response(2))
    client = make_client()
    result = client.embed_passages([JPEG_A, JPEG_B])
    body = request_body()
    assert body["model"] == MODEL_ID
    assert body["input_type"] == "passage"
    assert body["modality"] == ["image", "image"]
    assert body["encoding_format"] == "float"
    expected_uri = "data:image/jpeg;base64," + base64.b64encode(JPEG_A).decode("ascii")
    assert body["input"] == [
        expected_uri,
        "data:image/jpeg;base64," + base64.b64encode(JPEG_B).decode("ascii"),
    ]
    # Reversed indices in the body come back sorted into input order.
    assert result.vectors == [[0.0] * DIM, [1.0] * DIM]
    assert result.model == MODEL_ID


@respx.mock
def test_query_payload_shape_and_vector() -> None:
    respx.post(EMBEDDINGS_URL).respond(200, json=embeddings_response(1))
    client = make_client()
    vector = client.embed_query("whiteboard on screen")
    body = request_body()
    assert body["input"] == ["whiteboard on screen"]
    assert body["input_type"] == "query"
    assert body["modality"] == ["text"]
    assert vector == [0.0] * DIM


@respx.mock
def test_each_batched_input_has_a_matching_modality() -> None:
    """NVIDIA rejects a broadcast-style one-item modality list for batches."""
    respx.post(EMBEDDINGS_URL).respond(200, json=embeddings_response(3))
    client = make_client()
    client.embed_passages([JPEG_A, JPEG_B, JPEG_A])
    body = request_body()
    assert len(body["modality"]) == len(body["input"])
    assert body["modality"] == ["image", "image", "image"]


@respx.mock
def test_auth_header_carries_key_and_key_never_logged(
    caplog: pytest.LogCaptureFixture,
) -> None:
    respx.post(EMBEDDINGS_URL).respond(200, json=embeddings_response(1))
    client = make_client()
    with caplog.at_level("DEBUG"):
        client.embed_passages([JPEG_A])
    assert respx.calls[0].request.headers["Authorization"] == f"Bearer {KEY_A}"
    assert KEY_A not in caplog.text


# --- dim capture -------------------------------------------------------------------


@respx.mock
def test_dim_is_captured_from_first_response_never_hardcoded() -> None:
    respx.post(EMBEDDINGS_URL).respond(200, json=embeddings_response(1, dim=7))
    client = make_client()
    assert client.dim is None
    result = client.embed_passages([JPEG_A])
    assert client.dim == 7
    assert result.dim == 7


@respx.mock
def test_dim_mismatch_across_responses_is_rejected() -> None:
    route = respx.post(EMBEDDINGS_URL)
    route.side_effect = [
        httpx.Response(200, json=embeddings_response(1, dim=4)),
        httpx.Response(200, json=embeddings_response(1, dim=5)),
    ]
    client = make_client(batch_size=1)
    with pytest.raises(VisualEmbedError, match="does not match the captured dimension"):
        client.embed_passages([JPEG_A, JPEG_B])


@respx.mock
def test_query_also_captures_dim() -> None:
    respx.post(EMBEDDINGS_URL).respond(200, json=embeddings_response(1, dim=9))
    client = make_client()
    client.embed_query("query")
    assert client.dim == 9


# --- batching ----------------------------------------------------------------------


@respx.mock
def test_batching_splits_input_into_batch_size_requests() -> None:
    route = respx.post(EMBEDDINGS_URL)
    route.side_effect = [
        httpx.Response(200, json=embeddings_response(3)),
        httpx.Response(200, json=embeddings_response(3)),
        httpx.Response(200, json=embeddings_response(1)),
    ]
    client = make_client(batch_size=3)
    result = client.embed_passages([JPEG_A] * 7)
    assert len(result.vectors) == 7
    sizes = [len(request_body(i)["input"]) for i in range(3)]
    assert sizes == [3, 3, 1]


@respx.mock
def test_empty_input_makes_no_requests() -> None:
    route = respx.post(EMBEDDINGS_URL).respond(200, json=embeddings_response(1))
    client = make_client()
    result = client.embed_passages([])
    assert result.vectors == [] and result.dim is None
    assert not route.called


def test_constructor_rejects_bad_batch_size_and_timeout() -> None:
    with pytest.raises(ValueError, match="batch_size"):
        VisualEmbedClient(KeyRing([KEY_A]), http=httpx.Client(), batch_size=0)
    with pytest.raises(ValueError, match="timeout_seconds"):
        VisualEmbedClient(KeyRing([KEY_A]), http=httpx.Client(), timeout_seconds=0.0)


# --- 413 / payload-too-large splitting ----------------------------------------------


@respx.mock
def test_413_splits_batch_in_half_recursively_preserving_order() -> None:
    route = respx.post(EMBEDDINGS_URL)
    route.side_effect = [
        httpx.Response(413, text="payload too large"),  # batch of 4
        httpx.Response(200, json=embeddings_response(2, dim=1)),  # left half
        httpx.Response(200, json=embeddings_response(2, dim=1)),  # right half
    ]
    client = make_client(batch_size=4)
    result = client.embed_passages([JPEG_A, JPEG_A, JPEG_B, JPEG_B])
    assert len(result.vectors) == 4
    assert len(request_body(0)["input"]) == 4
    assert len(request_body(1)["input"]) == 2
    assert len(request_body(2)["input"]) == 2
    # Order preserved: halves carry the original inputs left-to-right.
    assert request_body(1)["input"] + request_body(2)["input"] == request_body(0)["input"]


@respx.mock
def test_400_payload_too_large_also_triggers_split() -> None:
    route = respx.post(EMBEDDINGS_URL)
    route.side_effect = [
        httpx.Response(400, text="Request body too large for this endpoint"),
        httpx.Response(200, json=embeddings_response(1)),
        httpx.Response(200, json=embeddings_response(1)),
    ]
    client = make_client(batch_size=2)
    result = client.embed_passages([JPEG_A, JPEG_B])
    assert len(result.vectors) == 2


@respx.mock
def test_split_floor_single_oversized_frame_is_a_typed_error() -> None:
    respx.post(EMBEDDINGS_URL).respond(413, text="payload too large")
    client = make_client()
    with pytest.raises(VisualEmbedError, match="single frame exceeds"):
        client.embed_passages([JPEG_A])


@respx.mock
def test_413_does_not_penalize_the_key() -> None:
    route = respx.post(EMBEDDINGS_URL)
    route.side_effect = [
        httpx.Response(413, text="too large"),
        httpx.Response(200, json=embeddings_response(1)),
        httpx.Response(200, json=embeddings_response(1)),
    ]
    ring = KeyRing([KEY_A])
    client = VisualEmbedClient(ring, http=httpx.Client(), now=lambda: 0.0, batch_size=2)
    client.embed_passages([JPEG_A, JPEG_B])
    assert ring.health(0.0)[0].state is KeyState.ALIVE


@respx.mock
def test_oversized_query_is_a_typed_error_not_a_split() -> None:
    respx.post(EMBEDDINGS_URL).respond(413, text="too large")
    client = make_client()
    with pytest.raises(VisualEmbedError, match="query text exceeds"):
        client.embed_query("a" * 100_000)


# --- keyring failover ------------------------------------------------------------------


@respx.mock
def test_401_marks_key_dead_and_rotates_to_next() -> None:
    route = respx.post(EMBEDDINGS_URL)
    route.side_effect = [
        httpx.Response(401, text="invalid api key"),
        httpx.Response(200, json=embeddings_response(1)),
    ]
    ring = KeyRing([KEY_A, KEY_B])
    client = VisualEmbedClient(ring, http=httpx.Client(), now=lambda: 0.0)
    result = client.embed_passages([JPEG_A])
    assert len(result.vectors) == 1
    assert respx.calls[0].request.headers["Authorization"] == f"Bearer {KEY_A}"
    assert respx.calls[1].request.headers["Authorization"] == f"Bearer {KEY_B}"
    health = ring.health(0.0)
    assert health[0].state is KeyState.DEAD
    assert health[1].state is KeyState.ALIVE


@respx.mock
def test_429_cools_key_down_and_rotates() -> None:
    route = respx.post(EMBEDDINGS_URL)
    route.side_effect = [
        httpx.Response(429, text="rate limited"),
        httpx.Response(200, json=embeddings_response(1)),
    ]
    ring = KeyRing([KEY_A, KEY_B])
    client = VisualEmbedClient(ring, http=httpx.Client(), now=lambda: 0.0)
    client.embed_passages([JPEG_A])
    health = ring.health(0.0)
    assert health[0].state is KeyState.COOLING
    assert health[0].cooldown_remaining > 0.0
    assert respx.calls[1].request.headers["Authorization"] == f"Bearer {KEY_B}"


@respx.mock
def test_500_rotates_to_next_key() -> None:
    route = respx.post(EMBEDDINGS_URL)
    route.side_effect = [
        httpx.Response(500, text="server exploded"),
        httpx.Response(200, json=embeddings_response(1)),
    ]
    ring = KeyRing([KEY_A, KEY_B])
    client = VisualEmbedClient(ring, http=httpx.Client(), now=lambda: 0.0)
    client.embed_passages([JPEG_A])
    assert ring.health(0.0)[0].state is KeyState.COOLING
    assert ring.health(0.0)[0].last_status == 500


@respx.mock
def test_exhaustion_raises_typed_error_with_last_status() -> None:
    respx.post(EMBEDDINGS_URL).respond(429, text="rate limited")
    ring = KeyRing([KEY_A, KEY_B])
    client = VisualEmbedClient(ring, http=httpx.Client(), now=lambda: 0.0)
    with pytest.raises(KeyRingExhaustedError) as excinfo:
        client.embed_passages([JPEG_A])
    assert excinfo.value.last_status == 429
    assert excinfo.value.last_error is not None and "HTTP 429" in excinfo.value.last_error


@respx.mock
def test_all_keys_dead_raises_exhausted() -> None:
    respx.post(EMBEDDINGS_URL).respond(403, text="forbidden")
    client = make_client([KEY_A, KEY_B])
    with pytest.raises(KeyRingExhaustedError):
        client.embed_query("q")


@respx.mock
def test_other_4xx_is_a_typed_error_without_key_rotation() -> None:
    respx.post(EMBEDDINGS_URL).respond(422, text="unprocessable")
    ring = KeyRing([KEY_A, KEY_B])
    client = VisualEmbedClient(ring, http=httpx.Client(), now=lambda: 0.0)
    with pytest.raises(VisualEmbedError, match="HTTP 422"):
        client.embed_passages([JPEG_A])
    assert respx.calls.call_count == 1  # never retried on the second key
    assert ring.health(0.0)[0].state is KeyState.ALIVE


# --- malformed responses ------------------------------------------------------------


@respx.mock
def test_response_without_data_list_is_rejected() -> None:
    respx.post(EMBEDDINGS_URL).respond(200, json={"model": MODEL_ID})
    client = make_client()
    with pytest.raises(VisualEmbedError, match="no vectors for 1 inputs"):
        client.embed_passages([JPEG_A])


@respx.mock
def test_response_with_wrong_vector_count_is_rejected() -> None:
    respx.post(EMBEDDINGS_URL).respond(200, json=embeddings_response(1))
    client = make_client()
    with pytest.raises(VisualEmbedError, match="returned 1 vectors for 2 inputs"):
        client.embed_passages([JPEG_A, JPEG_B])


# --- resolve_visual_embedder ----------------------------------------------------------


def test_resolve_without_keys_reports_no_api_key() -> None:
    for raw in (None, "", " , ,"):
        resolution = resolve_visual_embedder(raw)
        assert resolution.client is None
        assert resolution.reason == NO_API_KEY_REASON


def test_resolve_with_keys_returns_client() -> None:
    resolution = resolve_visual_embedder(f"{KEY_A}, {KEY_B}", http=httpx.Client())
    assert resolution.reason is None
    assert isinstance(resolution.client, VisualEmbedClient)


@respx.mock
def test_resolve_default_http_client_is_usable() -> None:
    respx.post(EMBEDDINGS_URL).respond(200, json=embeddings_response(1))
    resolution = resolve_visual_embedder(KEY_A)  # no injected http client
    assert resolution.client is not None
    assert resolution.client.embed_query("q") == [0.0] * DIM
