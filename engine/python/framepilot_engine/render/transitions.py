"""Transition envelopes for the render compiler (PRD §6.9, plan Phase 6).

WHY: a transition (the ``add_transition`` op stores a ``transition`` effect on the
*incoming* clip) eases that clip in over its first ``durationSeconds`` — by
opacity (fade / cross-dissolve), geometry (push / zoom / slide), a spatial wipe
reveal, or blur. This module is
the **pure math**: it turns a parsed :class:`Transition` into time functions the
compiler applies as MoviePy time-varying opacity (via the clip mask), transform,
or a blur pass. Deterministic and unit-testable; no MoviePy import.

Because the compiler composites video layers top-down, an opacity ramp on the
incoming clip is a true cross-dissolve when it overlaps the previous clip, and a
fade-from-below (or black) when clips are sequential — one primitive, both cases.

## Parameters (revamp Phase 9)

A transition's ``Effect.params`` is free-form, so ``direction``/``intensity``/
``softness``/``easing`` are additive with **no schema change and no migration**
(sub-plan §4.3). Every default is chosen to reproduce the pre-Phase-9 output
*exactly*, so an existing project renders byte-identically:

===========  =======================  ====================================
param        default                  meaning
===========  =======================  ====================================
direction    the kind's own default   which way the transition moves
intensity    ``1.0``                  how far the effect travels from rest
softness     ``DEFAULT_SOFTNESS``     wipe edge feather (wipe only)
easing       ``"linear"``             the curve progress runs on
===========  =======================  ====================================

**``easing`` defaults to linear, not ``ease-in-out``.** The sub-plan's §4.3 table
says ``ease-in-out``, but progress has always been linear here, and defaulting to
anything else would silently re-time every transition in every existing project —
a change nobody asked for that is only visible as "my dissolves feel different".
The default is what the render already did; ``ease-in-out`` is one click away.

**``direction`` means the direction the transition MOVES**, consistently across
kinds: the way the incoming picture travels for push/slide, the way the reveal
edge sweeps for wipe, and in/out for zoom. Naming it after the source edge instead
("comes from the right") reads more naturally for push but has no meaning at all
for wipe, and one rule that holds everywhere beats two that each hold once.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from framepilot_engine.effects.keyframes import apply_easing

# Opacity transitions ramp 0→1; geometry/blur transitions ramp their effect to 0.
_OPACITY_KINDS = frozenset({"fade", "cross-dissolve"})
_ZOOM_FROM = 1.6  # zoom-in transition starts this much larger than native
_PUSH_FRACTION = 1.0  # push starts one full frame-width away
_SLIDE_FRACTION = 1.0  # slide starts one full frame-height away
# Blur transition's starting radius as a fraction of the smaller frame dimension.
_BLUR_FRACTION = 0.04
# Wipe's soft edge width as a fraction of the frame width (avoids a shimmering
# hard edge at render fps while staying visually a "wipe", not a dissolve).
_WIPE_SOFTNESS = 0.05
# The widest feather a softness of 1.0 buys. Past roughly a quarter of the frame a
# "wipe" stops reading as an edge sweeping across and starts reading as a dissolve
# with a bias, so the knob is bounded rather than open-ended.
_WIPE_SOFTNESS_MAX = 0.25
# Chosen so the DEFAULT softness reproduces `_WIPE_SOFTNESS` exactly (0.2 * 0.25).
DEFAULT_SOFTNESS = _WIPE_SOFTNESS / _WIPE_SOFTNESS_MAX
# A feather can never reach zero: at exactly 0 the alpha formula divides by it, and
# a truly hard edge shimmers at render fps anyway.
_MIN_SOFTNESS_FRACTION = 1e-3

#: Direction a kind moves in when its ``direction`` param is absent. Absent means
#: "whatever the render did before Phase 9", which is what these values encode.
DEFAULT_DIRECTIONS: dict[str, str] = {
    "push": "left",  # started one frame-width to the RIGHT, travelling left
    "slide": "up",  # started one frame-height BELOW, travelling up
    "wipe": "right",  # edge swept left → right
    "zoom": "in",  # started larger than native and settled
}

#: The directions each kind can express. Anything else falls back to the default.
DIRECTIONS_BY_KIND: dict[str, tuple[str, ...]] = {
    "push": ("left", "right", "up", "down"),
    "slide": ("left", "right", "up", "down"),
    "wipe": ("left", "right", "up", "down"),
    "zoom": ("in", "out"),
}

# Unit travel vector per direction, in screen space (y grows downward). A clip
# travelling `left` must START to the right, hence the sign flip at the call site.
_TRAVEL: dict[str, tuple[float, float]] = {
    "left": (-1.0, 0.0),
    "right": (1.0, 0.0),
    "up": (0.0, -1.0),
    "down": (0.0, 1.0),
}


@dataclass(frozen=True)
class Transition:
    """A parsed transition on the incoming clip. Identity-ish kinds (cut) are no-ops.

    The last four fields are the catalog era's (see the bottom of this module) and
    are only populated by :func:`resolve_transition`. :func:`transition_from_clip`
    leaves them at their defaults, because the pre-catalog path that reads it does
    not have a render kind to speak of — it branches on ``kind`` directly.
    """

    kind: str
    duration: float
    direction: str = ""
    intensity: float = 1.0
    softness: float = DEFAULT_SOFTNESS
    easing: str = "linear"
    alignment: str = "start"
    render_kind: str = ""
    params: dict[str, float] = field(default_factory=dict)
    is_cut: bool = False

    @property
    def resolved_direction(self) -> str:
        """The direction actually used: the param when the kind accepts it, else the default."""
        allowed = DIRECTIONS_BY_KIND.get(self.kind, ())
        if self.direction in allowed:
            return self.direction
        return DEFAULT_DIRECTIONS.get(self.kind, "")


def _clamp01(value: float) -> float:
    return 0.0 if value < 0.0 else 1.0 if value > 1.0 else value


def _as_float(value: Any, fallback: float) -> float:
    """Coerce a free-form param to a finite float, falling back when it is not one.

    ``Effect.params`` is ``dict[str, Any]``, so a param can arrive as a string from a
    hand-edited project or an AI patch. A transition that raises mid-render because
    ``intensity`` was ``"1"`` would fail the whole export for a cosmetic value.
    """
    try:
        coerced = float(value)
    except (TypeError, ValueError):
        return fallback
    if coerced != coerced or coerced in (float("inf"), float("-inf")):  # NaN / inf
        return fallback
    return coerced


def transition_from_clip(clip: Any) -> Transition | None:
    """Parse a clip's ``transition`` effect into a :class:`Transition`, or ``None``."""
    effect = next((e for e in clip.effects if e.type == "transition"), None)
    if effect is None:
        return None
    params = effect.params
    return Transition(
        kind=str(params.get("kind", "cut")),
        duration=_as_float(params.get("durationSeconds", 0.5), 0.0),
        direction=str(params.get("direction", "")),
        intensity=_clamp01(_as_float(params.get("intensity", 1.0), 1.0)),
        softness=_clamp01(_as_float(params.get("softness", DEFAULT_SOFTNESS), DEFAULT_SOFTNESS)),
        easing=str(params.get("easing", "linear")),
    )


def progress(t: float, duration: float) -> float:
    """Linear progress in ``[0, 1]`` over the first ``duration`` seconds (1 after)."""
    if duration <= 0.0:
        return 1.0
    if t <= 0.0:
        return 0.0
    if t >= duration:
        return 1.0
    return t / duration


def eased_progress(tr: Transition, t: float) -> float:
    """Progress through ``tr`` at clip-relative ``t``, on the transition's own curve.

    Every envelope below runs on this rather than on raw :func:`progress`, so a
    transition's easing applies to the *whole* effect (a slide's motion and a
    dissolve's opacity alike) rather than to one aspect of it. Unknown easing names
    fall back to linear inside ``apply_easing``, which is the pre-Phase-9 behaviour.
    """
    return apply_easing(tr.easing, progress(t, tr.duration))


def affects_opacity(tr: Transition) -> bool:
    return tr.kind in _OPACITY_KINDS


def affects_geometry(tr: Transition) -> bool:
    return tr.kind in {"push", "zoom", "slide"}


def affects_blur(tr: Transition) -> bool:
    return tr.kind == "blur"


def affects_wipe(tr: Transition) -> bool:
    return tr.kind == "wipe"


def opacity_at(tr: Transition, t: float) -> float:
    """Opacity multiplier (1.0 unless this is an opacity transition, still ramping).

    ``intensity`` sets how far down the dip goes: at 1.0 the clip ramps from fully
    transparent (today's behaviour), at 0.5 from half-opaque — a softer dissolve that
    never fully loses the picture.
    """
    if not affects_opacity(tr):
        return 1.0
    floor = 1.0 - tr.intensity
    return floor + (1.0 - floor) * eased_progress(tr, t)


def zoom_from(tr: Transition) -> float:
    """The scale a zoom transition starts at, before decaying to 1.0.

    ``in`` starts larger and settles; ``out`` starts smaller and grows. The two are
    reciprocals so neither can reach zero (a zero scale is a clip with no pixels) and
    an intensity of 0 is a no-op in both directions.
    """
    magnitude = 1.0 + (_ZOOM_FROM - 1.0) * tr.intensity
    return 1.0 / magnitude if tr.resolved_direction == "out" else magnitude


def scale_at(tr: Transition, t: float) -> float:
    """Extra scale factor for a zoom transition (1.0 otherwise)."""
    if tr.kind != "zoom":
        return 1.0
    start = zoom_from(tr)
    return start + (1.0 - start) * eased_progress(tr, t)


def offset_at(
    tr: Transition, t: float, frame_width: float, frame_height: float
) -> tuple[float, float]:
    """Pixel ``(dx, dy)`` offset for a push/slide transition (zero otherwise).

    The clip starts one frame away **opposite** its travel direction and decays to
    rest, so ``direction="left"`` starts off-screen right and moves left. Push and
    slide share this math and differ only in their default axis — they stay distinct
    kinds because that default is what a user picks them by.
    """
    if tr.kind not in {"push", "slide"}:
        return (0.0, 0.0)
    travel_x, travel_y = _TRAVEL.get(tr.resolved_direction, (0.0, 0.0))
    remaining = (1.0 - eased_progress(tr, t)) * tr.intensity
    return (
        -travel_x * frame_width * _PUSH_FRACTION * remaining,
        -travel_y * frame_height * _SLIDE_FRACTION * remaining,
    )


def blur_radius_at(tr: Transition, t: float, frame_min_dim: float) -> float:
    """Gaussian blur radius (px) for a blur transition, decaying to 0 (0 otherwise)."""
    if tr.kind != "blur":
        return 0.0
    return frame_min_dim * _BLUR_FRACTION * tr.intensity * (1.0 - eased_progress(tr, t))


# Public so the compiler can vectorize the same formula with numpy; tests pin
# the vectorized path against the scalar `wipe_alpha` truth.
WIPE_SOFTNESS: float = _WIPE_SOFTNESS


def wipe_softness(tr: Transition) -> float:
    """The wipe's edge feather as a frame fraction, from its ``softness`` param."""
    return max(_MIN_SOFTNESS_FRACTION, tr.softness * _WIPE_SOFTNESS_MAX)


def wipe_axis(tr: Transition) -> tuple[str, bool]:
    """Which axis a wipe sweeps along, and whether the axis fraction is inverted.

    Returns ``("x" | "y", inverted)``. Inverting the fraction is what turns a
    left→right sweep into right→left without a second formula: the reveal always
    advances in increasing fraction, and the fraction itself is mirrored.
    """
    direction = tr.resolved_direction
    if direction == "left":
        return ("x", True)
    if direction == "up":
        return ("y", True)
    if direction == "down":
        return ("y", False)
    return ("x", False)


def wipe_edge(p: float, softness: float = _WIPE_SOFTNESS) -> float:
    """The wipe edge position (frame fraction) at progress ``p``."""
    return p * (1.0 + softness)


def wipe_alpha(x_frac: float, p: float, softness: float = _WIPE_SOFTNESS) -> float:
    """Alpha at position ``x_frac`` (0..1 along the sweep axis) for wipe progress ``p``.

    A reveal with a soft edge ``softness`` wide: fully transparent everywhere at
    ``p == 0``, fully opaque everywhere at ``p == 1``. The edge position overshoots to
    ``p * (1 + softness)`` so the feather has fully cleared the far border by the time
    progress hits 1.

    ``p >= 1`` short-circuits rather than relying on that overshoot arithmetic. It is
    only *exactly* clear in exact arithmetic: at ``softness = 0.15`` the far column
    comes out as ``0.9999999999999994``, so the last frame of a wipe would leave the
    trailing edge a hair transparent — invisible, but it makes "the transition is over"
    not quite true, and anything downstream comparing against 1.0 would disagree.
    """
    if p >= 1.0:
        return 1.0
    alpha = (wipe_edge(p, softness) - x_frac) / softness
    if alpha <= 0.0:
        return 0.0
    if alpha >= 1.0:
        return 1.0
    return alpha


def wipe_progress_at(tr: Transition, t: float) -> float:
    """Wipe reveal progress in ``[0, 1]`` (1.0 for non-wipe kinds — fully shown)."""
    if not affects_wipe(tr):
        return 1.0
    return eased_progress(tr, t)


# ---------------------------------------------------------------------------
# The catalog era (plan/ADVANCED-TRANSITION-SYSTEM.md)
# ---------------------------------------------------------------------------
#
# Everything above is the ORIGINAL seven kinds' envelope math, and it stays
# exactly as it was: those kinds keep their compiler path (a mask, a geometry
# placement, a blur pass) so every project written before the catalog renders
# byte-identically. Nothing below changes what they do.
#
# Everything below serves the catalog: reading a stored transition against it,
# and splitting the ramp either side of the cut for alignment.

#: The ids that predate the catalog. Their render path is deliberately untouched.
LEGACY_KINDS: frozenset[str] = frozenset(
    {"cut", "fade", "cross-dissolve", "push", "slide", "zoom", "blur", "wipe"}
)

#: What an absent ``alignment`` means — the placement this engine always used.
DEFAULT_ALIGNMENT = "start"

#: Effect type carrying the pre-cut half of a transition, on the outgoing clip.
TRANSITION_OUT_EFFECT_TYPE = "transition_out"


def is_legacy_kind(kind: str) -> bool:
    """True when ``kind`` renders through the pre-catalog path."""
    return kind in LEGACY_KINDS


def transition_window(alignment: str, duration: float) -> tuple[float, float]:
    """Split ``duration`` either side of the cut: ``(in_seconds, out_seconds)``.

    Mirrors ``transitionWindow`` in ``packages/editor-core/src/transitions.ts`` —
    the two must agree or the timeline would draw a transition somewhere the
    render does not put it.
    """
    span = max(0.0, duration)
    if alignment == "centre":
        return (span / 2.0, span / 2.0)
    if alignment == "end":
        return (0.0, span)
    return (span, 0.0)


def read_alignment(params: dict[str, Any]) -> str:
    """Read an alignment from free-form params, falling back to ``start``.

    Unreadable values fall back rather than raising: params can hold anything a
    hand-edited file or an AI patch put there, and the historical placement is the
    right answer for "I cannot tell", not a failed export.
    """
    raw = params.get("alignment")
    return raw if raw in ("start", "centre", "end") else DEFAULT_ALIGNMENT


def progress_at(role: str, t: float, tr: Transition, clip_duration: float) -> float | None:
    """Raw progress through ``tr`` at clip-local ``t``, or ``None`` when inactive.

    One function for both halves because they are one ramp: ``role`` only decides
    which end of the clip the window is anchored to. Mirrors
    ``transitionProgressAt`` in editor-core.

    :param role: ``"in"`` for the incoming clip's effect, ``"out"`` for the
        outgoing clip's companion.
    """
    if tr.duration <= 0.0:
        return None
    in_seconds, out_seconds = transition_window(tr.alignment, tr.duration)
    if role == "in":
        if in_seconds <= 0.0 or t < 0.0 or t >= in_seconds:
            return None
        # The incoming half resumes where the outgoing half left off.
        return (out_seconds + t) / tr.duration
    if out_seconds <= 0.0:
        return None
    start = clip_duration - out_seconds
    if t < start or t >= clip_duration:
        return None
    return (t - start) / tr.duration


def ease(tr: Transition, progress: float) -> float:
    """Put raw progress on the transition's own curve.

    The counterpart to :func:`eased_progress` for the catalog path, which computes
    raw progress itself (from a window that may sit on either clip) rather than
    from a clip-local time.
    """
    return apply_easing(tr.easing, min(1.0, max(0.0, progress)))


def resolve_transition(params: dict[str, Any]) -> Transition | None:
    """Resolve stored params against the catalog, or ``None`` for an unknown kind.

    The Python twin of ``resolveTransitionParamsFor``. The layering is the same and
    the order matters: kind defaults, then what the catalog entry states, then what
    the user actually stored.
    """
    from framepilot_engine.render import transition_catalog

    kind = str(params.get("kind", "cross-dissolve"))
    entry = transition_catalog.get_transition(kind)
    if entry is None:
        return None

    resolved = {**transition_catalog.default_params(entry.render_kind), **entry.params}
    resolved = transition_catalog.clamp_params(entry.render_kind, {**resolved, **params})

    allowed = transition_catalog.directions_for_kind(entry.render_kind)
    stored_direction = params.get("direction")
    if isinstance(stored_direction, str) and stored_direction in allowed:
        direction = stored_direction
    elif entry.direction in allowed:
        direction = entry.direction
    else:
        direction = allowed[0] if allowed else ""

    default_intensity = 1.0 if entry.intensity is None else entry.intensity
    default_soft = DEFAULT_SOFTNESS if entry.softness is None else entry.softness
    return Transition(
        kind=kind,
        duration=max(0.0, _as_float(params.get("durationSeconds", entry.default_duration), 0.0)),
        direction=direction,
        intensity=_clamp01(
            _as_float(params.get("intensity", default_intensity), default_intensity)
        ),
        softness=_clamp01(_as_float(params.get("softness", default_soft), default_soft)),
        easing=str(params.get("easing", entry.easing or "linear")),
        alignment=read_alignment(params),
        render_kind=entry.render_kind,
        params=resolved,
        is_cut=entry.is_cut or bool(params.get("disabled")),
    )


def resolve_from_clip(clip: Any, role: str = "in") -> Transition | None:
    """Resolve the transition effect of ``role`` on ``clip`` against the catalog."""
    wanted = "transition" if role == "in" else TRANSITION_OUT_EFFECT_TYPE
    effect = next((e for e in clip.effects if e.type == wanted), None)
    if effect is None:
        return None
    return resolve_transition(effect.params)
