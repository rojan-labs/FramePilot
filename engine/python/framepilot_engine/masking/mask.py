"""Masks and the text-behind-object pipeline (PRD §6.5/§6.6, plan Phase 5).

WHY: masks gate where an effect or layer is visible. Shape masks (rectangle /
ellipse / polygon) support feather, opacity, and mask keyframes. Subject masks
(AI segmentation) drive the text-behind-object effect.

Text-behind-object pipeline (PRD §6.6) — note the **deterministic layer order**:

1. Base video layer.
2. Text/overlay layer placed *above* the base.
3. Subject mask layer (segmented foreground subject) placed *above the text*,
   so the subject occludes the text and the text appears to sit behind it.

The mask outputs are alpha matte arrays; typed loosely as ``Any`` to avoid a
hard numpy import in the stub.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

_PHASE = "Phase 5"


def rectangle_mask(
    width: int, height: int, x: float, y: float, w: float, h: float, feather: float = 0.0
) -> Any:
    """Build a rectangular alpha matte.

    :param width: Frame width in pixels.
    :param height: Frame height in pixels.
    :param x: Rect left (normalized).
    :param y: Rect top (normalized).
    :param w: Rect width (normalized).
    :param h: Rect height (normalized).
    :param feather: Edge feather amount.
    :returns: An alpha matte buffer.
    :raises NotImplementedError: Masking is Phase 5 work.
    """
    raise NotImplementedError(f"rectangle_mask is {_PHASE}.")


def ellipse_mask(
    width: int, height: int, cx: float, cy: float, rx: float, ry: float, feather: float = 0.0
) -> Any:
    """Build an elliptical alpha matte.

    :param width: Frame width in pixels.
    :param height: Frame height in pixels.
    :param cx: Center x (normalized).
    :param cy: Center y (normalized).
    :param rx: Radius x (normalized).
    :param ry: Radius y (normalized).
    :param feather: Edge feather amount.
    :returns: An alpha matte buffer.
    :raises NotImplementedError: Masking is Phase 5 work.
    """
    raise NotImplementedError(f"ellipse_mask is {_PHASE}.")


def polygon_mask(
    width: int, height: int, points: list[tuple[float, float]], feather: float = 0.0
) -> Any:
    """Build a polygonal alpha matte from normalized vertices.

    :param width: Frame width in pixels.
    :param height: Frame height in pixels.
    :param points: Polygon vertices in normalized coordinates.
    :param feather: Edge feather amount.
    :returns: An alpha matte buffer.
    :raises NotImplementedError: Masking is Phase 5 work.
    """
    raise NotImplementedError(f"polygon_mask is {_PHASE}.")


def subject_mask(frame: Any) -> Any:
    """Segment the foreground subject from a frame (AI matte).

    :param frame: A single video frame buffer.
    :returns: An alpha matte isolating the subject.
    :raises NotImplementedError: Subject segmentation is Phase 5 work.
    """
    raise NotImplementedError(f"subject_mask is {_PHASE}.")


def text_behind_object(clip_path: Path, text: str, style: dict[str, Any]) -> Any:
    """Composite text behind the subject (PRD §6.6).

    See the module docstring for the deterministic layer order.

    :param clip_path: Path to the source clip.
    :param text: The text to place behind the subject.
    :param style: Text styling parameters.
    :returns: The composited result.
    :raises NotImplementedError: Pipeline is Phase 5 work.
    """
    raise NotImplementedError(f"text_behind_object is {_PHASE}.")
