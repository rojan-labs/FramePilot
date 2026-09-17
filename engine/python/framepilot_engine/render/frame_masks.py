"""Masks fixed to the OUTPUT FRAME — the mask stack on an effect layer (MK5.2, plan 10).

WHY a module of its own: :mod:`framepilot_engine.render.mask_stack` evaluates a CLIP's stack.
Its geometry is in display-corrected source pixels, it is mapped through the clip's crop, and its
keyframes live on the clip's source clock so a mask stays glued to the picture. An adjustment
lane has none of that: an effect layer has no asset, no crop and no speed, and its mask is meant
to stay where the editor put it **on the frame** (``space: 'frame'``, schema v22). So the mapping
is the identity onto the output frame and the clock is seconds from the layer's ``start``.

Everything else is shared with the clip path on purpose: the same exact rasteriser, the same
combine modes, the same one quantisation (:func:`mask_stack.stack_alpha`), so an editor who
draws the same rectangle on a clip and on an adjustment lane gets the same pixels.

Where it is used: :func:`framepilot_engine.render.frame_effects.apply_effect_layers` mixes each
layer's output back toward its input by this alpha, which is what limits any of the 40 catalog
render kinds to a region (a blur on a face, a grade on the sky). The preview twin is
``apps/web-editor/src/preview/masks/mask-stack.ts`` (``effectLayerMaskStack``) feeding the frame
effect renderer's finish pass.

What the export cannot draw faithfully is REFUSED before rendering, with a remedy and no varying
numbers, exactly as the clip path refuses (memory: ``error-message-text-is-a-guard-key``).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from framepilot_engine.render.mask_raster import FloatArray
from framepilot_engine.render.mask_stack import (
    MaskStackRefusal,
    path_keyframe_at,
    stack_alpha,
)

_log = logging.getLogger(__name__)

#: Kinds an adjustment lane's mask cannot be yet, with the remedy. A ``matte`` is excluded for a
#: different reason from the rest: its artifact is delivered for a CLIP's source frames, and an
#: adjustment lane has no source, so there is nothing to read it against.
_KIND_REFUSALS = {
    "key": "colour key masks render once the key renderer ships",
    "linear": "split masks render once the analytic mask renderer ships",
    "band": "band masks render once the analytic mask renderer ships",
    "gradient": "gradient masks render once the analytic mask renderer ships",
    "layer": "track matte masks render once the layer mask renderer ships",
    "matte": "an AI matte belongs to a clip's own picture, not to an adjustment lane",
}

_DISABLE_REMEDY = "Disable the mask to export now."


def _refuse(mask: Any, layer_id: str, reason: str) -> MaskStackRefusal:
    return MaskStackRefusal(
        f"Mask {mask.id!r} on effect layer {layer_id!r}: {reason}. {_DISABLE_REMEDY}"
    )


def assert_frame_renderable(mask: Any, layer_id: str) -> None:
    """Refuse, before any frame renders, an adjustment-lane mask the export cannot draw."""
    reason = _KIND_REFUSALS.get(str(mask.kind))
    if reason is not None:
        raise _refuse(mask, layer_id, reason)
    if mask.tracking is not None:
        raise _refuse(mask, layer_id, "tracked masks render once mask tracking ships")
    if str(mask.space.value) != "frame":
        raise MaskStackRefusal(
            f"Mask {mask.id!r} on effect layer {layer_id!r} is stored in a clip's source space. "
            "An adjustment lane's mask is fixed to the frame; redraw it on the lane."
        )
    if mask.target.kind != "alpha":
        raise MaskStackRefusal(
            f"Mask {mask.id!r} on effect layer {layer_id!r} limits one effect of a clip. "
            "An adjustment lane's mask limits the whole adjustment; retarget it."
        )
    if str(mask.feather_model.value) != "distance":
        raise MaskStackRefusal(
            f"Mask {mask.id!r} on effect layer {layer_id!r} uses the legacy blur feather, which "
            "only shapes migrated from older projects have. Switch the mask's feather model to "
            "Distance."
        )
    if mask.kind == "path":
        # Raises when the path keyframes disagree about how many vertices they have.
        path_keyframe_at(mask, mask.path_keyframes[0].source_time if mask.path_keyframes else 0.0)


@dataclass(frozen=True)
class FrameOwner:
    """The owner :func:`mask_stack.stack_alpha` needs, for a mask that is in frame pixels.

    An effect layer has no crop, so the source → raster mapping is the identity once the "media
    size" is stated as the frame itself.
    """

    id: str
    crop: None = None


@dataclass(frozen=True)
class FrameMaskStack:
    """An effect layer's enabled masks, ready to evaluate at a layer-local instant."""

    layer_id: str
    masks: tuple[Any, ...]

    @property
    def animated(self) -> bool:
        """Whether the stack changes over the layer's span (a static one is drawn once)."""
        return any(
            bool(mask.keyframes) or (mask.kind == "path" and len(mask.path_keyframes) > 1)
            for mask in self.masks
        )

    def alpha_at(self, local: float, width: int, height: int) -> FloatArray:
        """The stack's alpha on a ``width`` x ``height`` output frame, ``local`` seconds in."""
        return stack_alpha(
            self.masks,
            FrameOwner(self.layer_id),
            (float(width), float(height)),
            width,
            height,
            local,
        )


def layer_mask_stack(layer: Any) -> FrameMaskStack | None:
    """An effect layer's enabled mask stack, or ``None`` when the layer is unmasked.

    :param layer: A :class:`~framepilot_engine.timeline.models.EffectLayer`.
    :raises MaskStackRefusal: When a mask needs a renderer that has not shipped.
    """
    enabled = [mask for mask in (getattr(layer, "masks", None) or []) if mask.enabled]
    if not enabled:
        return None
    for mask in enabled:
        assert_frame_renderable(mask, layer.id)
    _log.debug("frame mask stack for effect layer %s: %d masks", layer.id, len(enabled))
    return FrameMaskStack(layer_id=str(layer.id), masks=tuple(enabled))
