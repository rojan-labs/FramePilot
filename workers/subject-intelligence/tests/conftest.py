"""A scripted backend that simulates detector behaviour, so policy is testable alone.

This is not a canned-output stub. It reproduces the *shapes* of real detector
behaviour that the policy has to survive — long low-confidence tails, boxes that
hang off the edge of frame, overlapping people, empty frames, masks that are
almost but not quite empty — so a policy bug shows up here rather than only in
the (slow, weights-dependent) decoded-media job.

Real-inference proof lives in ``test_decoded_media.py`` and is a separate tier.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

import pytest

from framepilot_subject_intelligence.backend import (
    MediaUnreadableError,
    RawDetection,
    RawMask,
)
from framepilot_subject_intelligence.geometry import PixelBox
from framepilot_subject_intelligence.protocol import (
    MediaHandle,
    SubjectRequest,
)

FRAME_WIDTH = 1920
FRAME_HEIGHT = 1080


@dataclass
class ScriptedSource:
    width: int = FRAME_WIDTH
    height: int = FRAME_HEIGHT
    frames: int = 3
    closed: bool = False

    def read(self) -> object | None:
        if self.frames <= 0:
            return None
        self.frames -= 1
        # Frames are opaque to the policy; an index is enough to distinguish them.
        return f"frame-{self.frames}"

    def close(self) -> None:
        self.closed = True


@dataclass
class ScriptedBackend:
    """Returns whatever the test scripted, per frame."""

    faces: Sequence[Sequence[RawDetection]] = field(default_factory=list)
    objects: Sequence[Sequence[RawDetection]] = field(default_factory=list)
    masks: Sequence[RawMask] = field(default_factory=list)
    media_unreadable: bool = False
    frames: int = 3
    source: ScriptedSource | None = None
    face_calls: int = 0
    object_calls: int = 0
    segment_regions: list[PixelBox] = field(default_factory=list)

    @property
    def name(self) -> str:
        return "scripted"

    @property
    def model_digests(self) -> dict[str, str]:
        return {"scripted.onnx": "0" * 64}

    def open_frames(self, path: str, first_frame: int, last_frame_exclusive: int) -> ScriptedSource:
        if self.media_unreadable:
            raise MediaUnreadableError(f"cannot read {path}.")
        self.source = ScriptedSource(frames=self.frames)
        return self.source

    def detect_faces(self, frame: object) -> Sequence[RawDetection]:
        index = self.face_calls
        self.face_calls += 1
        return self.faces[index] if index < len(self.faces) else ()

    def detect_objects(self, frame: object) -> Sequence[RawDetection]:
        index = self.object_calls
        self.object_calls += 1
        return self.objects[index] if index < len(self.objects) else ()

    def segment_subject(self, frame: object, region: PixelBox) -> RawMask:
        index = len(self.segment_regions)
        self.segment_regions.append(region)
        if index < len(self.masks):
            return self.masks[index]
        return solid_mask()


def solid_mask(width: int = 4, height: int = 4, confidence: float = 0.9) -> RawMask:
    """A mask whose middle two rows are foreground: unambiguously a real subject."""
    values = [1 if height // 4 <= row < height - height // 4 else 0 for row in range(height)]
    return RawMask(
        width=width,
        height=height,
        values=[values[row] for row in range(height) for _ in range(width)],
        confidence=confidence,
    )


def media(frames: int = 3) -> MediaHandle:
    return MediaHandle(
        handle_id="handle-1",
        asset_id="asset-1",
        absolute_path="/approved/media.mp4",
        source_start_seconds=0.0,
        source_end_seconds=frames / 30.0,
        fps=30.0,
        first_frame=0,
        last_frame_exclusive=frames,
    )


def detect_request(**overrides: object) -> SubjectRequest:
    base: dict[str, object] = {
        "request_id": "req-1",
        "project_revision": 7,
        "capability": "subject.detect",
        "media": media(),
        "labels": ("face",),
        "max_detections": 20,
    }
    base.update(overrides)
    return SubjectRequest(**base)  # type: ignore[arg-type]


def segment_request(**overrides: object) -> SubjectRequest:
    from framepilot_subject_intelligence.protocol import NormalizedBox

    base: dict[str, object] = {
        "request_id": "req-1",
        "project_revision": 7,
        "capability": "subject.segment",
        "media": media(),
        "region": NormalizedBox(x=0.25, y=0.25, width=0.5, height=0.5),
    }
    base.update(overrides)
    return SubjectRequest(**base)  # type: ignore[arg-type]


@pytest.fixture
def backend() -> ScriptedBackend:
    return ScriptedBackend()
