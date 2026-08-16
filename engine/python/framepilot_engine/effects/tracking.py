"""Object tracking seam (PRD §6.4, plan Phase 5).

WHY: a tracker follows an **arbitrary user-picked object** (or a face) across a
clip and emits a per-frame bounding box. That box drives downstream effects —
a mask that hides/blurs the object, or a callout that sticks to it — through the
existing animated-mask / transform render (the box becomes keyframes). Keeping the
tracker behind a small interface means the editor and render never depend on a
specific CV engine.

Build-order honesty (PRD §23): real *automatic* detection/segmentation needs a CV
model (OpenCV / SAM 2 / …) whose dependency is **not yet approved**, so
:func:`get_tracker` returns the deterministic :class:`ManualTracker` for the
``"manual"`` engine and raises :class:`TrackerUnavailableError` for any automatic
engine. The data model, evaluation, and the mask/transform consumers are all built
now, so dropping in an auto engine later is a localized change — it only has to
produce :class:`Box` keyframes the same way ``ManualTracker`` does.

This module is pure (no CV deps, no I/O) and 100% unit-testable.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from itertools import pairwise
from typing import Protocol, runtime_checkable

from framepilot_engine.effects.keyframes import evaluate_keyframes
from framepilot_engine.timeline.models import Effect, Keyframe

#: Bounding-box properties a track animates over time (frame fractions, 0..1).
_BOX_PROPERTIES = ("x", "y", "width", "height")

#: Engines that need a CV dependency not yet approved (see module docstring).
AUTO_ENGINES = frozenset({"auto", "opencv", "sam2", "yolo", "mediapipe"})


@dataclass(frozen=True)
class Box:
    """An axis-aligned region as frame fractions (0..1)."""

    x: float
    y: float
    width: float
    height: float


@dataclass(frozen=True)
class Keyframed:
    """A box sampled at a clip-relative time (seconds)."""

    time: float
    box: Box


class TrackerUnavailableError(RuntimeError):
    """Raised when an automatic tracking engine is requested but unavailable.

    Automatic detection/segmentation requires a CV dependency that has not been
    approved yet (CLAUDE.md §5). The manual tracker is always available.
    """

    def __init__(self, engine: str) -> None:
        super().__init__(
            f"Tracking engine {engine!r} requires a CV dependency that is not "
            f"installed/approved yet; use 'manual' or approve an engine."
        )
        self.engine = engine


@runtime_checkable
class ObjectTracker(Protocol):
    """A tracker turns a picked region + sample times into a box per sample.

    An automatic engine would run detection/segmentation here; the manual tracker
    holds or interpolates the user's keyframes. Implementations are pure given
    their inputs so the render stays deterministic.
    """

    def track(self, region: Box, samples: Sequence[Keyframed]) -> list[Keyframed]:
        """Return the tracked box at each requested sample time."""
        ...


@dataclass(frozen=True)
class ManualTracker:
    """Deterministic, dependency-free tracker (manual / "corrected" tracking).

    With no user corrections it **holds** the picked region for every sample. With
    corrections (boxes the user set at specific times) it **linearly interpolates**
    between them — exactly the "manual correction" workflow (PRD §6.4) and enough
    to drive a tracked mask/callout without any CV engine.
    """

    corrections: tuple[Keyframed, ...] = ()

    def track(self, region: Box, samples: Sequence[Keyframed]) -> list[Keyframed]:
        if not self.corrections:
            return [Keyframed(time=s.time, box=region) for s in samples]
        ordered = sorted(self.corrections, key=lambda k: k.time)
        return [Keyframed(time=s.time, box=_interp_box(ordered, s.time)) for s in samples]


def _interp_box(corrections: list[Keyframed], time: float) -> Box:
    """Linearly interpolate the corrected boxes at ``time`` (holds at the ends)."""
    if time <= corrections[0].time:
        return corrections[0].box
    if time >= corrections[-1].time:
        return corrections[-1].box
    for left, right in pairwise(corrections):
        if left.time <= time <= right.time:
            span = right.time - left.time
            t = 0.0 if span <= 0 else (time - left.time) / span
            return Box(
                x=_lerp(left.box.x, right.box.x, t),
                y=_lerp(left.box.y, right.box.y, t),
                width=_lerp(left.box.width, right.box.width, t),
                height=_lerp(left.box.height, right.box.height, t),
            )
    return corrections[-1].box  # pragma: no cover - bracket always found


def _lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def get_tracker(engine: str = "manual", corrections: Sequence[Keyframed] = ()) -> ObjectTracker:
    """Return a tracker for ``engine``.

    :param engine: ``"manual"`` (always available) or an automatic engine name.
    :param corrections: Optional user-set boxes for the manual tracker.
    :raises TrackerUnavailableError: For any automatic engine (pending a CV dep).
    """
    if engine == "manual":
        return ManualTracker(corrections=tuple(corrections))
    # Every non-manual engine (automatic detection/segmentation) needs a CV
    # dependency that is not approved yet — fail loudly rather than fake a track.
    raise TrackerUnavailableError(engine)


def boxes_to_keyframes(track: Sequence[Keyframed], *, id_prefix: str) -> list[Keyframe]:
    """Convert a tracked box sequence into x/y/width/height keyframes.

    These feed an ``add_mask`` (animated mask that follows the object — hide/blur)
    or transform keyframes (a callout that sticks to it), so a track composites
    through the existing animated-mask / transform render with no new render path.
    """
    keyframes: list[Keyframe] = []
    for sample in track:
        values = {
            "x": sample.box.x,
            "y": sample.box.y,
            "width": sample.box.width,
            "height": sample.box.height,
        }
        for prop, value in values.items():
            keyframes.append(
                Keyframe(
                    id=f"{id_prefix}__{prop}__{round(sample.time * 1000)}",
                    time=sample.time,
                    property=prop,
                    value=value,
                )
            )
    return keyframes


def tracked_box_at(effect: Effect, time: float) -> Box | None:
    """Resolve a track effect's bounding box at clip-relative ``time``.

    Reads the per-frame x/y/width/height keyframes stored on the ``object_track``
    effect. Returns ``None`` when the effect carries no positional track yet
    (e.g. an automatic engine has not run).
    """
    resolved: dict[str, float] = {}
    keyframes = list(effect.keyframes)
    for prop in _BOX_PROPERTIES:
        value = evaluate_keyframes(keyframes, prop, time)
        if value is not None:
            resolved[prop] = value
    if len(resolved) < len(_BOX_PROPERTIES):
        return None
    return Box(x=resolved["x"], y=resolved["y"], width=resolved["width"], height=resolved["height"])
