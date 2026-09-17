"""Shared request builders for the contract suites (no numpy needed here)."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

SHA = "a" * 64


def media(**overrides: Any) -> dict[str, Any]:
    value: dict[str, Any] = {
        "handleId": "media-1",
        "assetId": "asset-1",
        "absolutePath": "/media/clip.mov",
        "sourceStartSeconds": 0.0,
        "sourceEndSeconds": 2.0,
        "fps": 24.0,
        "firstFrame": 0,
        "lastFrameExclusive": 48,
    }
    value.update(overrides)
    return value


def matte_request(
    output_dir: str = "/project/.framepilot-derived/mattes/.staging/job-1", **parameters: Any
) -> dict[str, Any]:
    params: dict[str, Any] = {
        "output": {
            "handleId": "out-1",
            "absolutePath": output_dir,
            "allowedFiles": [
                "matte.mkv",
                "frames.json",
                "foreground.mkv",
                "preview.webm",
                "foreground.preview.webm",
                "report.json",
            ],
            "maxBytes": 10_000_000_000,
        },
        "prompts": [
            {"kind": "box", "pts": 0, "box": {"x": 0.2, "y": 0.1, "width": 0.5, "height": 0.8}}
        ],
        "previewHeight": 360,
    }
    params.update(parameters)
    return {
        "type": "request",
        "protocolVersion": 1,
        "requestId": "req-1",
        "projectRevision": 7,
        "media": media(),
        "capability": "subject.matte",
        "parameters": params,
    }


def segment_frame_request(**parameters: Any) -> dict[str, Any]:
    params: dict[str, Any] = {
        "pts": 1024,
        "points": [{"x": 0.5, "y": 0.5, "label": "include"}],
        "previewHeight": 360,
    }
    params.update(parameters)
    return {
        "type": "request",
        "protocolVersion": 1,
        "requestId": "seg-1",
        "projectRevision": 7,
        "media": media(),
        "capability": "subject.segment_frame",
        "parameters": params,
    }


def line(message: dict[str, Any]) -> str:
    return json.dumps(message)


def mutate(message: dict[str, Any], path: list[str | int], value: Any) -> dict[str, Any]:
    copied = copy.deepcopy(message)
    cursor: Any = copied
    for key in path[:-1]:
        cursor = cursor[key]
    if value is DELETE:
        del cursor[path[-1]]
    else:
        cursor[path[-1]] = value
    return copied


DELETE = object()


@pytest.fixture
def staging(tmp_path: Path) -> Path:
    directory = tmp_path / "staging"
    directory.mkdir()
    (directory / "inputs").mkdir()
    return directory
