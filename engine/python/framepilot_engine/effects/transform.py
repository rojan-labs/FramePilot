"""Per-clip transform evaluation from keyframes (PRD §6.3, plan Phase 5).

WHY: a clip's geometric motion — punch-in/zoom (``scale``), reframing (``x``/``y``),
``rotation``, and ``opacity`` — is stored as clip-relative :class:`Keyframe`s. This
module turns those keyframes into a concrete :class:`ClipTransform` at any time,
on top of the deterministic keyframe evaluation engine
(:mod:`framepilot_engine.effects.keyframes`). It is **pure** (no MoviePy, no I/O)
so it is 100% unit-testable; the render compiler applies the result as MoviePy
time-varying functions.

Property names are the convention shared with the editor UI and AI tools (the
``add_keyframes`` op stores free-form property names): ``scale`` (1.0 = native
fit), ``x``/``y`` (pixel offset from centered), ``rotation`` (degrees), ``opacity``
(0..1). Unknown properties are ignored here and reported by the compiler.
"""

from __future__ import annotations

from dataclasses import dataclass

from framepilot_engine.effects.keyframes import evaluate_keyframes
from framepilot_engine.timeline.models import Clip

# Animatable transform properties, by convention (clip-relative keyframes).
SCALE = "scale"
POS_X = "x"
POS_Y = "y"
ROTATION = "rotation"
OPACITY = "opacity"

#: Geometry properties the render compiler composites today (Phase 5 slice A).
RENDERED_TRANSFORM_PROPERTIES = frozenset({SCALE, POS_X, POS_Y, ROTATION})
#: All transform properties this core evaluates (``opacity`` render lands with
#: Phase 6 fades/transitions; see :func:`deferred_transform_properties`).
TRANSFORM_PROPERTIES = RENDERED_TRANSFORM_PROPERTIES | {OPACITY}


@dataclass(frozen=True)
class ClipTransform:
    """A clip's resolved transform at one instant. Identity = no-op."""

    scale: float = 1.0
    x: float = 0.0
    y: float = 0.0
    rotation: float = 0.0
    opacity: float = 1.0


def _clamp01(value: float) -> float:
    return 0.0 if value <= 0.0 else 1.0 if value >= 1.0 else value


def animated_properties(clip: Clip) -> set[str]:
    """Distinct property names this clip animates via keyframes (pure)."""
    return {k.property for k in clip.keyframes}


def has_rendered_transform(clip: Clip) -> bool:
    """True if the clip has keyframes for a property the compiler composites."""
    return not animated_properties(clip).isdisjoint(RENDERED_TRANSFORM_PROPERTIES)


def deferred_transform_properties(clip: Clip) -> list[str]:
    """Animated transform properties evaluated but not yet composited (sorted).

    As of Phase 6, ``opacity`` renders too (composited via the clip mask alongside
    fades/transitions), so the deferred set is empty for the known properties. This
    still surfaces any future evaluated-but-unrendered property explicitly, the
    same contract as :func:`~framepilot_engine.render.compiler.unsupported_track_types`.
    """
    animated = animated_properties(clip)
    rendered = RENDERED_TRANSFORM_PROPERTIES | {OPACITY}
    return sorted(animated & (TRANSFORM_PROPERTIES - rendered))


def evaluate_clip_transform(clip: Clip, time: float) -> ClipTransform:
    """Resolve ``clip``'s transform at clip-relative ``time`` (seconds).

    Each property falls back to its identity value when the clip has no keyframes
    for it, so a clip with only ``scale`` keyframes animates scale and leaves
    position/rotation/opacity untouched.

    :param clip: The clip whose keyframes to evaluate.
    :param time: Clip-relative time in seconds (0 = clip start).
    :returns: The resolved :class:`ClipTransform`.
    """

    def value(prop: str, default: float) -> float:
        evaluated = evaluate_keyframes(clip.keyframes, prop, time)
        return default if evaluated is None else evaluated

    return ClipTransform(
        scale=value(SCALE, 1.0),
        x=value(POS_X, 0.0),
        y=value(POS_Y, 0.0),
        rotation=value(ROTATION, 0.0),
        opacity=_clamp01(value(OPACITY, 1.0)),
    )
