"""Transition passes — the catalog-era render stage.

WHAT IS NEW HERE: before the transition catalog there were seven kinds, and each
was expressed as a *property* of the incoming clip that the compiler already knew
how to set — an opacity ramp on its mask, a position on its placement, a blur pass.
That works beautifully for seven and not at all for seventy-seven: a glitch, a
page turn and a kaleidoscope are not properties of a clip, they are pictures.

So this package is a second, general path: a pass takes the incoming clip's frame
and returns ``(rgb, alpha)``. The compositor is unchanged — it draws that over
whatever is beneath, which is the outgoing clip where the two overlap and black
where they are sequential.

**The seven original kinds do NOT come through here.** They keep the exact path
they always had, which is how every project written before the catalog renders
byte-identically. See ``transitions.LEGACY_KINDS``.

THE DISPATCH CONTRACT: passes are registered against the catalog's ``renderKind``
— one of 29 closed values — and NEVER against a catalog entry id. That is what
makes the catalog pure data: 77 entries share these 29 passes, and adding entry
#78 costs nothing here.

WHAT EACH PASS IMPLEMENTS: its look at a given progress, given a float32 RGB frame
in ``[0, 1]``. It does not handle param clamping (the dispatcher clamps against
the catalog first, so a pass can divide by a param without guarding it) or unknown
kinds (the dispatcher skips and warns).

Unlike the effect-layer dispatcher, this one does NOT mix ``intensity`` for the
pass. At progress 0 there is no source to blend back towards, so a generic mix
would turn every transition into a hard cut at its own start. Intensity is each
pass's own business — how far it slides, how much it zooms — via ``ctx.rem``.

Parity: each pass has a GLSL twin in
``apps/web-editor/src/preview/transitions/glsl-transitions.ts``. Change together.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping

import numpy as np

from framepilot_engine.render.transition_catalog import clamp_params
from framepilot_engine.render.transitions import Transition

_log = logging.getLogger(__name__)

__all__ = [
    "PASSES",
    "TransitionContext",
    "TransitionPass",
    "apply_transition_to_frame",
    "known_pass_kinds",
    "register",
]

#: Noise clock quantum. MUST equal the preview's — see ``deterministic.py``.
TIME_QUANTUM = 1.0 / 60.0


class TransitionContext:
    """Everything a pass needs beyond the pixels themselves.

    ``progress`` is ALREADY EASED, so a pass never needs to know which curve it is
    on — the same split the shader uses, and the reason easing works identically
    for every kind without any of them implementing it.
    """

    __slots__ = (
        "aspect",
        "dir_sign",
        "direction",
        "height",
        "intensity",
        "noise_frame",
        "params",
        "progress",
        "softness",
        "width",
    )

    def __init__(
        self,
        *,
        params: Mapping[str, float],
        progress: float,
        intensity: float,
        softness: float,
        direction: tuple[float, float],
        dir_sign: float,
        width: int,
        height: int,
        noise_frame: int,
    ) -> None:
        self.params = params
        self.progress = progress
        self.intensity = intensity
        self.softness = softness
        self.direction = direction
        self.dir_sign = dir_sign
        self.width = width
        self.height = height
        self.noise_frame = noise_frame
        self.aspect = width / max(1.0, height)

    def param(self, name: str, fallback: float = 0.0) -> float:
        """A clamped parameter. Present for every declared param of the kind."""
        return float(self.params.get(name, fallback))

    @property
    def rem(self) -> float:
        """How much of the effect is still to be undone: 1 at the start, 0 at the end."""
        return (1.0 - self.progress) * self.intensity

    @property
    def feather(self) -> float:
        """The mask feather as a frame fraction. Mirrors the shader's ``softness()``."""
        from framepilot_engine.render.transition_passes._common import SOFTNESS_MAX

        return max(1e-3, self.softness * SOFTNESS_MAX)


#: A pass: ``(frame_float32_rgb01, ctx) -> (rgb, alpha)``.
TransitionPass = Callable[[np.ndarray, TransitionContext], tuple[np.ndarray, np.ndarray]]

#: Registered passes by render kind, populated by the family modules on import.
PASSES: dict[str, TransitionPass] = {}


def register(kind: str) -> Callable[[TransitionPass], TransitionPass]:
    """Register a pass for a render kind. Duplicate registration is a bug."""

    def decorate(fn: TransitionPass) -> TransitionPass:
        if kind in PASSES:  # pragma: no cover - import-time programming error
            raise RuntimeError(f"Duplicate transition pass for kind {kind!r}")
        PASSES[kind] = fn
        return fn

    return decorate


def known_pass_kinds() -> frozenset[str]:
    """Render kinds with a working pass. Guarded against the catalog by tests."""
    return frozenset(PASSES)


#: Unit travel vector per direction, in the passes' y-UP UV space.
_TRAVEL: dict[str, tuple[float, float]] = {
    "left": (-1.0, 0.0),
    "right": (1.0, 0.0),
    # Screen space is y-down and this space is y-up, so the vertical pair is
    # flipped HERE, once, exactly as the shader flips it once on upload.
    "up": (0.0, 1.0),
    "down": (0.0, -1.0),
}


def _dir_sign(direction: str) -> float:
    if direction == "in":
        return 1.0
    if direction == "out":
        return -1.0
    return 0.0


def apply_transition_to_frame(
    frame: np.ndarray,
    transition: Transition,
    progress: float,
) -> tuple[np.ndarray, np.ndarray]:
    """Run one transition pass over one frame.

    :param frame: float32 RGB frame in ``[0, 1]``, shape ``(H, W, 3)``.
    :param transition: A catalog-resolved transition (``resolve_transition``).
    :param progress: EASED progress through the ramp, 0 → 1.
    :returns: ``(rgb, alpha)``; alpha is ``(H, W)`` float32 in ``[0, 1]``.
    """
    pass_fn = PASSES.get(transition.render_kind)
    if pass_fn is None:
        # Degrade, do not raise: an unknown kind means the project was written by a
        # newer FramePilot. A hard cut with a warning is the right outcome for a
        # render someone is waiting on; aborting is not.
        _log.warning(
            "apply_transition_to_frame ← unknown transition kind, transition skipped",
            extra={"kind": transition.kind, "renderKind": transition.render_kind},
        )
        return frame, np.ones(frame.shape[:2], dtype=np.float32)

    height, width = frame.shape[0], frame.shape[1]
    ctx = TransitionContext(
        params=clamp_params(transition.render_kind, transition.params),
        progress=float(np.clip(progress, 0.0, 1.0)),
        intensity=transition.intensity,
        softness=transition.softness,
        direction=_TRAVEL.get(transition.direction, (0.0, 0.0)),
        dir_sign=_dir_sign(transition.direction),
        width=width,
        height=height,
        # Derived from PROGRESS, not from a clock: a transition's animated noise
        # must look the same scrubbed to as played through, and an export has no
        # wall clock at all.
        noise_frame=int(max(0.0, progress * transition.duration) / TIME_QUANTUM),
    )

    try:
        rgb, alpha = pass_fn(frame.astype(np.float32), ctx)
    except Exception:  # pragma: no cover - defensive; a pass bug must not kill a render
        _log.exception(
            "apply_transition_to_frame ← pass raised, transition skipped",
            extra={"kind": transition.kind, "renderKind": transition.render_kind},
        )
        return frame, np.ones(frame.shape[:2], dtype=np.float32)

    return np.clip(rgb, 0.0, 1.0), np.clip(alpha, 0.0, 1.0)


# Family modules register their passes on import. Imported at the BOTTOM so the
# decorator and TransitionContext above are fully defined first.
from framepilot_engine.render.transition_passes import deform as _deform  # noqa: E402,F401
from framepilot_engine.render.transition_passes import dissolves as _dissolves  # noqa: E402,F401
from framepilot_engine.render.transition_passes import motion as _motion  # noqa: E402,F401
from framepilot_engine.render.transition_passes import optical as _optical  # noqa: E402,F401
from framepilot_engine.render.transition_passes import spatial as _spatial  # noqa: E402,F401
from framepilot_engine.render.transition_passes import wipes as _wipes  # noqa: E402,F401
