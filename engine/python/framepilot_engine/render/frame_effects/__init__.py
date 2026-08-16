"""Frame effects — the adjustment-layer render stage (schema v13, ADR 0088).

WHAT IS NEW HERE: before v13 every effect lived on a clip and was applied to that
clip's own picture (``compiler._apply_color_grade``). An effect LAYER is different
in kind — it applies to the frame **composited from every visible track beneath
it**, for its own time range. There was no stage in the compiler that could do
that, so this package is it.

Where it plugs in: ``compile_timeline`` builds the composite, then wraps it once
with :func:`apply_effect_layers` before audio is attached. One wrap handles every
layer on every effect track; the per-frame walk decides what is live.

THE DISPATCH CONTRACT: passes are registered against
:class:`~framepilot_engine.timeline.models.EffectLayer.kind` — one of the 40
closed-enum render kinds — and NEVER against a catalog effect id. That is what
makes the catalog pure data: 72 catalog entries share these 40 passes, and adding
entry #73 costs nothing here.

WHAT EACH PASS IMPLEMENTS: its look at FULL strength, given a float32 RGB frame in
``[0, 1]``. It does not handle:

* ``intensity`` — the dispatcher mixes the result back toward the input, so every
  kind gets a working strength dial without writing one;
* param clamping — the dispatcher clamps against the catalog first, so a pass can
  divide by a param without guarding it;
* unknown kinds — the dispatcher skips and warns.

Parity: each pass has a GLSL twin in ``apps/web-editor/src/preview/effects/``.
The two are pinned by a parity test on a fixed synthetic frame. Change together.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from typing import Any

import numpy as np

from framepilot_engine.render.effect_catalog import clamp_params
from framepilot_engine.timeline.models import EffectLayer, Timeline

_log = logging.getLogger(__name__)

__all__ = [
    "PASSES",
    "EffectContext",
    "apply_effect_layers",
    "apply_layer_to_frame",
    "known_pass_kinds",
    "register",
]


class EffectContext:
    """Everything a pass needs beyond the pixels themselves.

    ``local_time``/``duration`` are LAYER-relative, not timeline-relative: an
    envelope effect (a zoom punch, a flash ramp) is defined by where it sits
    inside its own span, so moving the layer must not change how it looks. Passing
    absolute time would silently couple every envelope to the sequence origin.
    """

    __slots__ = ("duration", "frame_index", "height", "local_time", "params", "width")

    def __init__(
        self,
        *,
        params: Mapping[str, float],
        local_time: float,
        duration: float,
        width: int,
        height: int,
        frame_index: int,
    ) -> None:
        self.params = params
        self.local_time = local_time
        self.duration = duration
        self.width = width
        self.height = height
        self.frame_index = frame_index

    def param(self, name: str, fallback: float = 0.0) -> float:
        """A clamped parameter. Present for every declared param of the kind."""
        return float(self.params.get(name, fallback))

    @property
    def progress(self) -> float:
        """Position through the layer in ``[0, 1]`` — the envelope parameter."""
        if self.duration <= 0.0:
            return 0.0
        return min(1.0, max(0.0, self.local_time / self.duration))


#: A pass: ``(frame_float32_rgb01, ctx) -> frame_float32_rgb01``.
EffectPass = Callable[[np.ndarray, EffectContext], np.ndarray]

#: Registered passes by render kind. Populated by the family modules' ``register``
#: calls at import time (see the imports at the bottom of this module).
PASSES: dict[str, EffectPass] = {}


def register(kind: str) -> Callable[[EffectPass], EffectPass]:
    """Register a pass for a render kind. Duplicate registration is a bug."""

    def decorate(fn: EffectPass) -> EffectPass:
        if kind in PASSES:  # pragma: no cover - import-time programming error
            raise RuntimeError(f"Duplicate frame-effect pass for kind {kind!r}")
        PASSES[kind] = fn
        return fn

    return decorate


def known_pass_kinds() -> frozenset[str]:
    """Render kinds with a working pass. Guarded against the catalog by tests."""
    return frozenset(PASSES)


def apply_layer_to_frame(
    frame: np.ndarray,
    layer: EffectLayer,
    timeline_time: float,
    *,
    fps: float,
) -> np.ndarray:
    """Apply one effect layer to one frame.

    :param frame: ``uint8`` or float RGB frame, shape ``(H, W, 3)``.
    :param layer: The layer to apply. Assumed live at ``timeline_time``.
    :param timeline_time: Absolute sequence time, seconds.
    :param fps: Output frame rate, for deriving a stable integer frame index.
    :returns: A frame of the same dtype and shape as ``frame``.
    """
    pass_fn = PASSES.get(layer.kind)
    if pass_fn is None:
        # Degrade, do not raise: an unknown kind means the project was written by
        # a newer FramePilot. Dropping the effect with a warning is the right
        # outcome for a render the user is waiting on; aborting is not.
        _log.warning(
            "apply_layer_to_frame ← unknown effect kind, layer skipped",
            extra={"kind": layer.kind, "layer": layer.id},
        )
        return frame

    strength = float(np.clip(layer.strength, 0.0, 1.0))
    if strength <= 0.0:
        # A fully dialled-down layer is a no-op. Returning early also means a
        # zero-intensity layer costs nothing per frame.
        return frame

    was_uint8 = frame.dtype == np.uint8
    source = frame.astype(np.float32) / np.float32(255.0) if was_uint8 else frame.astype(np.float32)

    height, width = source.shape[0], source.shape[1]
    ctx = EffectContext(
        params=clamp_params(layer.kind, layer.params),
        local_time=max(0.0, timeline_time - layer.start),
        duration=max(0.0, layer.end - layer.start),
        width=width,
        height=height,
        # Derived from absolute time so animated noise is stable under seeking:
        # scrubbing to 4.0s must look like playing to 4.0s.
        frame_index=round(timeline_time * max(1.0, fps)),
    )

    try:
        result = pass_fn(source, ctx)
    except Exception:  # pragma: no cover - defensive; a pass bug must not kill a render
        _log.exception(
            "apply_layer_to_frame ← pass raised, layer skipped",
            extra={"kind": layer.kind, "layer": layer.id},
        )
        return frame

    # The intensity mix, applied once here so no pass implements it. Doing it in
    # float and clipping only at the end avoids double-quantizing an 8-bit frame.
    if strength < 1.0:
        result = source + (result - source) * np.float32(strength)

    result = np.clip(result, 0.0, 1.0)
    if was_uint8:
        # +0.5 before truncating = round-half-up, matching how the WebGL path's
        # 8-bit framebuffer quantizes. Plain truncation would darken every frame
        # by up to 1/255 relative to preview.
        return (result * np.float32(255.0) + np.float32(0.5)).astype(np.uint8)
    return result


def apply_effect_layers(source: Any, timeline: Timeline, *, fps: float) -> Any:
    """Wrap a composited MoviePy clip with the timeline's effect layers.

    Returns ``source`` unchanged when the timeline has no effect layers at all, so
    a project without effects renders byte-identically to before v13 and pays no
    per-frame cost.
    """
    has_any = any(track.effect_layers for track in timeline.tracks)
    if not has_any:
        return source

    def transform(get_frame: Callable[[float], np.ndarray], t: float) -> np.ndarray:
        frame = get_frame(t)
        live = timeline.active_effect_layers_at(t)
        if not live:
            return frame
        # `active_effect_layers_at` owns the ordering (tracks bottom-up, then by
        # start) and the web preview walks the identical sequence — that shared
        # order is what makes stacked effects agree between the two renderers.
        for _track, layer in live:
            frame = apply_layer_to_frame(frame, layer, t, fps=fps)
        return frame

    return source.transform(transform, apply_to=[])


# Family modules register their passes on import. Imported at the BOTTOM so the
# decorator and EffectContext above are fully defined first, and re-exported
# nowhere — `PASSES` is the only intended entry point.
from framepilot_engine.render.frame_effects import blur as _blur  # noqa: E402
from framepilot_engine.render.frame_effects import color as _color  # noqa: E402
from framepilot_engine.render.frame_effects import geometry as _geometry  # noqa: E402
from framepilot_engine.render.frame_effects import texture as _texture  # noqa: E402

_ = (_blur, _color, _geometry, _texture)  # keep linters from pruning the imports
