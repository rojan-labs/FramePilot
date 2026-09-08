"""Shared fakes for the Visual Describe worker suite.

Every test in the default tier runs against :class:`FakeDescribeBackend`. No llama.cpp
binary, no GGUF weight and no OpenCV are installed or needed — which is the point of the
injected-backend boundary in :mod:`framepilot_visual_describe.backend`, and the reason the
whole pack is reviewable before ~1.6 GiB of binaries exist.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any

import pytest

from framepilot_visual_describe.backend import (
    DescribeFailedError,
    Frame,
    MediaUnreadableError,
)
from framepilot_visual_describe.protocol import PROTOCOL_VERSION
from framepilot_visual_describe.schema import TIER2_VERSION

FAKE_DIGEST = "a" * 64


def answer(**overrides: Any) -> dict[str, Any]:
    """A well-formed model answer, with fields overridable per test."""
    payload: dict[str, Any] = {
        "summary": "A man in a grey jacket speaks to camera at a desk.",
        "subject": "man in grey jacket",
        "action": "speaking to camera",
        "setting": "office desk with a laptop",
        "camera": {"shotSize": "MS", "angle": "eye-level", "movement": "static"},
        "mood": "neutral, bright",
        "onScreenText": [],
        "quality": ["well-lit"],
        "confidence": "medium",
    }
    payload.update(overrides)
    return payload


class FakeDescribeBackend:
    """A scripted backend: canned frames, canned answers, recorded calls."""

    def __init__(
        self,
        *,
        answers: Sequence[Mapping[str, Any]] | None = None,
        decode_error: str | None = None,
        describe_error: str | None = None,
        frames_per_call: int | None = None,
    ) -> None:
        self._answers = list(answers) if answers is not None else None
        self._decode_error = decode_error
        self._describe_error = describe_error
        self._frames_per_call = frames_per_call
        self.decoded: list[tuple[str, list[float]]] = []
        self.described: list[int] = []
        self.schemas: list[Mapping[str, Any]] = []

    @property
    def name(self) -> str:
        return "fake"

    @property
    def model_id(self) -> str:
        return "fake/describe-1"

    @property
    def model_digests(self) -> dict[str, str]:
        return {"fake.gguf": FAKE_DIGEST}

    def decode_keyframes(self, path: str, timestamps: Sequence[float]) -> Sequence[Frame]:
        self.decoded.append((path, list(timestamps)))
        if self._decode_error is not None:
            raise MediaUnreadableError(self._decode_error)
        count = self._frames_per_call if self._frames_per_call is not None else len(timestamps)
        return [f"frame@{t:.3f}".encode() for t in list(timestamps)[:count]]

    def describe(self, frames: Sequence[Frame], schema: Mapping[str, Any]) -> Mapping[str, Any]:
        self.described.append(len(frames))
        self.schemas.append(schema)
        if self._describe_error is not None:
            raise DescribeFailedError(self._describe_error)
        if self._answers is None:
            return answer()
        index = min(len(self.described) - 1, len(self._answers) - 1)
        return self._answers[index]


def media(**overrides: Any) -> dict[str, Any]:
    handle: dict[str, Any] = {
        "handleId": "media-asset-1",
        "assetId": "asset-1",
        "absolutePath": "/media/asset-1.mp4",
        "sourceStartSeconds": 0.0,
        "sourceEndSeconds": 60.0,
        "fps": 30.0,
        "firstFrame": 0,
        "lastFrameExclusive": 1800,
    }
    handle.update(overrides)
    return handle


def request_body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "type": "request",
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": "describe:asset-1:0",
        "projectRevision": 3,
        "capability": "visual.describe",
        "media": media(),
        "parameters": {
            "tier2Version": TIER2_VERSION,
            "shots": [
                {"shotIndex": 0, "t0": 0.0, "t1": 4.0},
                {"shotIndex": 1, "t0": 4.0, "t1": 9.0},
            ],
        },
    }
    body.update(overrides)
    return body


def request_line(**overrides: Any) -> str:
    return json.dumps(request_body(**overrides))


@pytest.fixture
def backend() -> FakeDescribeBackend:
    return FakeDescribeBackend()
