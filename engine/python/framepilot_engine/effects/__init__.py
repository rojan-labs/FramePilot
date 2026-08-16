"""Effects: keyframe easing and value interpolation (PRD §6.3, plan Phase 5)."""

from __future__ import annotations

from framepilot_engine.effects.keyframes import (
    Easing,
    apply_easing,
    evaluate_keyframes,
    interpolate,
    punch_in_keyframes,
)
from framepilot_engine.effects.tracking import (
    Box,
    Keyframed,
    ManualTracker,
    ObjectTracker,
    TrackerUnavailableError,
    boxes_to_keyframes,
    get_tracker,
    tracked_box_at,
)

__all__ = [
    "Box",
    "Easing",
    "Keyframed",
    "ManualTracker",
    "ObjectTracker",
    "TrackerUnavailableError",
    "apply_easing",
    "boxes_to_keyframes",
    "evaluate_keyframes",
    "get_tracker",
    "interpolate",
    "punch_in_keyframes",
    "tracked_box_at",
]
