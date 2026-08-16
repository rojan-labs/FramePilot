"""Object / face tracking (PRD §6.4, plan Phase 5).

WHY: tracked motion drives tracked text, callouts, blur-tracked-object, and
text-behind-object. Tracking runs as a Python worker job (PRD §9.1). Results
carry a per-frame bounding box and a confidence score so the UI can flag
low-confidence frames for manual correction (PRD §6.4).
"""

from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, Field


class BoundingBox(BaseModel):
    """Axis-aligned box in normalized ``[0, 1]`` frame coordinates."""

    x: float
    y: float
    width: float
    height: float


class TrackedFrame(BaseModel):
    """A tracked box at a single frame/time."""

    time: float = Field(description="Frame time in seconds.")
    box: BoundingBox
    confidence: float = Field(ge=0.0, le=1.0, description="Tracker confidence for this frame.")


class TrackingResult(BaseModel):
    """The full per-frame track plus an aggregate confidence (PRD §6.4)."""

    clip_id: str
    frames: list[TrackedFrame] = Field(default_factory=list)
    confidence: float = Field(default=0.0, ge=0.0, le=1.0, description="Mean track confidence.")


def track_object(clip_path: Path, initial_box: BoundingBox) -> TrackingResult:
    """Track an arbitrary object across a clip from an initial box.

    :param clip_path: Path to the source media for the clip.
    :param initial_box: The object's bounding box on the first frame.
    :returns: A :class:`TrackingResult` with per-frame boxes + confidence.
    :raises NotImplementedError: Tracking is Phase 5 work.
    """
    raise NotImplementedError("track_object is Phase 5: per-frame object tracking.")


def track_face(clip_path: Path) -> TrackingResult:
    """Detect and track the primary face across a clip.

    :param clip_path: Path to the source media for the clip.
    :returns: A :class:`TrackingResult` for the tracked face.
    :raises NotImplementedError: Face tracking is Phase 5 work.
    """
    raise NotImplementedError("track_face is Phase 5: detect + track primary face.")
