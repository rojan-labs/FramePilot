"""MK5.2: an adjustment lane's mask limits its effect, for every catalog render kind.

Two things are asserted here. First the stack itself (``render/frame_masks.py``): the mapping is
the identity onto the output frame, the clock is layer-local, and what the export cannot draw is
refused before a frame renders. Then the mix (``render/frame_effects.apply_layer_to_frame``):
every one of the 40 render kinds leaves the masked-out region byte-identical to its input and
changes something inside the mask, so no kind can quietly ignore its mask.
"""

from __future__ import annotations

import numpy as np
import pytest

from framepilot_engine.render.effect_catalog import known_kinds
from framepilot_engine.render.frame_effects import apply_layer_to_frame, known_pass_kinds
from framepilot_engine.render.frame_masks import layer_mask_stack
from framepilot_engine.render.mask_stack import MaskStackRefusal
from framepilot_engine.timeline.models import EffectLayer

FRAME_W, FRAME_H = 64, 48


def _rectangle(**over: object) -> dict[str, object]:
    return {
        "id": "m1",
        "kind": "rectangle",
        "space": "frame",
        "cx": 16.0,
        "cy": 24.0,
        "width": 32.0,
        "height": 48.0,
        **over,
    }


def _layer(
    kind: str = "blur-gaussian", masks: list[dict[str, object]] | None = None
) -> EffectLayer:
    return EffectLayer.model_validate(
        {
            "id": "fx",
            "effectId": "soft-veil",
            "kind": kind,
            "start": 2.0,
            "end": 4.0,
            "params": {},
            "keyframes": [],
            **({} if masks is None else {"masks": masks}),
        }
    )


def _frame() -> np.ndarray:
    """A deterministic frame with gradients AND hard edges in both halves.

    The hard 8-pixel blocks matter: an edge-finding pass (``edge-outline``, ``sketch``) does
    nothing at all on a smooth ramp, which would make "the kind changed something" vacuous.
    """
    y, x = np.mgrid[0:FRAME_H, 0:FRAME_W]
    blocks = (((x // 8) + (y // 8)) % 2) * 140
    red = ((x * 4) % 256 + blocks) % 256
    green = ((y * 5) % 256 + blocks) % 256
    blue = (((x + y) * 3) % 256 + blocks) % 256
    return np.stack([red, green, blue], axis=-1).astype(np.uint8)


class TestStack:
    def test_unmasked_layer_has_no_stack(self) -> None:
        assert layer_mask_stack(_layer()) is None
        assert layer_mask_stack(_layer(masks=[_rectangle(enabled=False)])) is None

    def test_geometry_is_output_frame_pixels(self) -> None:
        stack = layer_mask_stack(_layer(masks=[_rectangle()]))
        assert stack is not None
        alpha = stack.alpha_at(0.0, FRAME_W, FRAME_H)
        # The rectangle covers x in [0, 32) and the whole height: exactly half the frame.
        assert alpha.sum() == pytest.approx(32 * 48)
        assert alpha[24, 8] == 1.0
        assert alpha[24, 48] == 0.0

    def test_clock_is_layer_local(self) -> None:
        mask = _rectangle(
            keyframes=[
                {"id": "k0", "property": "cx", "sourceTime": 0.0, "value": 16.0},
                {"id": "k1", "property": "cx", "sourceTime": 2.0, "value": 48.0},
            ]
        )
        stack = layer_mask_stack(_layer(masks=[mask]))
        assert stack is not None
        assert stack.animated
        # Halfway through the layer the rectangle has moved to the frame's centre, not to where
        # the layer's absolute start time (2.0 s) would have put it.
        middle = stack.alpha_at(1.0, FRAME_W, FRAME_H)
        assert middle[24, 32] == 1.0
        assert middle[24, 8] == 0.0

    def test_static_stack_is_not_animated(self) -> None:
        stack = layer_mask_stack(_layer(masks=[_rectangle()]))
        assert stack is not None and not stack.animated

    @pytest.mark.parametrize(
        ("mask", "fragment"),
        [
            ({"id": "m1", "kind": "key", "space": "frame", "model": "hsl"}, "key renderer"),
            (
                {
                    "id": "m1",
                    "kind": "layer",
                    "space": "frame",
                    "source": {"kind": "track", "trackId": "v1"},
                },
                "adjustment lane cannot",
            ),
            (_rectangle(space="source"), "fixed to the frame"),
            (
                _rectangle(target={"kind": "effect", "effectId": "grade"}),
                "limits the whole adjustment",
            ),
            (_rectangle(featherModel="gaussian-legacy"), "Distance"),
        ],
    )
    def test_refuses_with_a_remedy(self, mask: dict[str, object], fragment: str) -> None:
        with pytest.raises(MaskStackRefusal, match=fragment):
            layer_mask_stack(_layer(masks=[mask]))


class TestMix:
    def test_masked_region_only(self) -> None:
        frame = _frame()
        layer = _layer(masks=[_rectangle()])
        stack = layer_mask_stack(layer)
        assert stack is not None
        alpha = stack.alpha_at(0.0, FRAME_W, FRAME_H)
        masked = apply_layer_to_frame(frame, layer, 2.0, fps=30.0, mask_alpha=alpha)
        assert np.array_equal(masked[:, 32:], frame[:, 32:])
        assert not np.array_equal(masked[:, :32], frame[:, :32])

    def test_full_mask_equals_no_mask(self) -> None:
        frame = _frame()
        layer = _layer()
        full = np.ones((FRAME_H, FRAME_W), dtype=np.float64)
        assert np.array_equal(
            apply_layer_to_frame(frame, layer, 2.0, fps=30.0, mask_alpha=full),
            apply_layer_to_frame(frame, layer, 2.0, fps=30.0),
        )

    def test_empty_mask_leaves_the_frame_alone(self) -> None:
        frame = _frame()
        empty = np.zeros((FRAME_H, FRAME_W), dtype=np.float64)
        masked = apply_layer_to_frame(frame, _layer(), 2.0, fps=30.0, mask_alpha=empty)
        assert np.array_equal(masked, frame)

    @pytest.mark.parametrize("kind", sorted(known_kinds()))
    def test_every_catalog_kind_honours_its_mask(self, kind: str) -> None:
        """No render kind may ignore its mask.

        Asserted as an identity rather than "the left half changed": several kinds legitimately
        move pixels only in part of the frame (``mirror`` reflects one side onto the other,
        ``tape-dropout`` picks its own bands). What must hold for every kind is that a hard mask
        selects between the fully-affected frame and the untouched one, pixel for pixel — and
        that the kind does something at all, so the identity is not vacuous.
        """
        assert kind in known_pass_kinds(), f"{kind} has no engine pass"
        frame = _frame()
        layer = _layer(kind=kind, masks=[_rectangle()])
        stack = layer_mask_stack(layer)
        assert stack is not None
        alpha = stack.alpha_at(0.0, FRAME_W, FRAME_H)
        # The rectangle has no feather: every pixel is fully in or fully out.
        assert set(np.unique(alpha)) <= {0.0, 1.0}
        inside = alpha[:, :, None] == 1.0
        did_something = False
        for local in (0.25, 1.0):
            at = 2.0 + local
            masked = apply_layer_to_frame(frame, layer, at, fps=30.0, mask_alpha=alpha)
            unmasked = apply_layer_to_frame(frame, layer, at, fps=30.0)
            assert np.array_equal(masked, np.where(inside, unmasked, frame)), (
                f"{kind} did not select by its mask"
            )
            did_something = did_something or not np.array_equal(unmasked, frame)
        assert did_something, f"{kind} changed nothing at either instant"
