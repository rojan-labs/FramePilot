"""Scripted stand-ins for the exported graphs, behaving like a tracker on synthetic frames.

Frames are a gray background with one saturated red square that moves. The fake "image
encoder" puts the square's redness in ``fpn2`` channel 0; the fake "memory encoder" stores the
mask in channel 0 of its features; the fake "memory attention" writes the union of the valid
spatial memories into channel 1 of the pixel features; and the fake "decoder" returns the red
component that the prompt or that memory points at. That is enough to exercise every
orchestration rule (conditioning, memory selection, bounded bank, passes, seeding, windows)
without weights, while recording what the real graphs would have been fed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import cv2
import numpy as np

from framepilot_smart_mask.backend import DecoderOutput, ImageFeatures, SamConstants
from framepilot_smart_mask.tracker import FEAT_TOKENS, MEM_SLOTS, PTR_TOKENS

RED = np.array([220, 30, 30], np.uint8)
GRAY = np.array([90, 90, 90], np.uint8)


def _x(index: int, step: int, jump_at: int | None, jump: int) -> int:
    return 10 + index * step + (jump if jump_at is not None and index >= jump_at else 0)


def square_frames(
    count: int,
    height: int = 90,
    width: int = 160,
    size: int = 24,
    step: int = 2,
    gap: range | None = None,
    jump_at: int | None = None,
    jump: int = 0,
) -> np.ndarray:
    """A red square moving right; optionally absent during ``gap`` and displaced from ``jump_at``."""
    frames = np.empty((count, height, width, 3), np.uint8)
    frames[:] = GRAY
    for index in range(count):
        if gap is not None and index in gap:
            continue
        x = _x(index, step, jump_at, jump)
        frames[index, 30 : 30 + size, x : x + size] = RED
    return frames


def truth(
    count: int,
    height: int = 90,
    width: int = 160,
    size: int = 24,
    step: int = 2,
    gap: range | None = None,
    jump_at: int | None = None,
    jump: int = 0,
) -> np.ndarray:
    masks = np.zeros((count, height, width), bool)
    for index in range(count):
        if gap is not None and index in gap:
            continue
        x = _x(index, step, jump_at, jump)
        masks[index, 30 : 30 + size, x : x + size] = True
    return masks


def redness(image: np.ndarray, size: int) -> np.ndarray:
    small = cv2.resize(image, (size, size), interpolation=cv2.INTER_AREA).astype(np.float32)
    return np.clip((small[..., 0] - small[..., 1]) / 150.0, 0.0, 1.0)


def _component(binary: np.ndarray, seeds: np.ndarray) -> np.ndarray:
    _count, labels = cv2.connectedComponents(binary.astype(np.uint8), connectivity=8)
    keep = np.zeros_like(binary)
    for label in np.unique(labels[seeds & binary]):
        if label:
            keep |= labels == label
    return keep


@dataclass
class FakeSam:
    provider: str = "cpu"
    encodes: int = 0
    attend_valid_slots: list[int] = field(default_factory=list)
    attend_ptr_tokens: list[int] = field(default_factory=list)
    closed: bool = False

    @property
    def constants(self) -> SamConstants:
        return SamConstants(
            maskmem_tpos_enc=np.arange(7 * 64, dtype=np.float32).reshape(7, 1, 1, 64) / 1000.0,
            no_mem_embed=np.zeros((1, 1, 256), np.float32),
            no_obj_embed_spatial=np.full((1, 64), -5.0, np.float32),
            obj_ptr_tpos_proj_weight=np.eye(64, 256, dtype=np.float32),
            obj_ptr_tpos_proj_bias=np.zeros(64, np.float32),
            no_obj_ptr=np.zeros((1, 256), np.float32),
        )

    def _alive(self) -> None:
        assert not self.closed, "a closed SAM session was used"

    def encode_image(self, image: np.ndarray) -> ImageFeatures:
        self._alive()
        self.encodes += 1
        # Undo the ImageNet normalisation well enough to recover redness.
        mean = np.array([0.485, 0.456, 0.406], np.float32)[:, None, None]
        std = np.array([0.229, 0.224, 0.225], np.float32)[:, None, None]
        rgb = ((image[0] * std + mean).transpose(1, 2, 0) * 255.0).clip(0, 255).astype(np.uint8)
        fpn2 = np.zeros((1, 256, 64, 64), np.float32)
        fpn2[0, 0] = redness(rgb, 64)
        return ImageFeatures(
            fpn0=np.zeros((1, 32, 256, 256), np.float32),
            fpn1=np.zeros((1, 64, 128, 128), np.float32),
            fpn2=fpn2,
            pos2=np.zeros((1, 256, 64, 64), np.float32),
        )

    def _output(self, mask64: np.ndarray, multimask: bool) -> DecoderOutput:
        low = cv2.resize(mask64.astype(np.float32), (256, 256), interpolation=cv2.INTER_NEAREST)
        logits = np.where(low > 0.5, 8.0, -8.0).astype(np.float32)
        present = bool(mask64.any())
        high = cv2.resize(logits, (1024, 1024), interpolation=cv2.INTER_LINEAR)
        ious = np.array([[0.9, 0.8, 0.7]] if multimask else [[0.9]], np.float32)
        obj_ptr = np.zeros((1, 256), np.float32)
        obj_ptr[0, 0] = 1.0 if present else -1.0
        return DecoderOutput(
            low_res_masks=logits[None, None],
            high_res_masks=high[None, None],
            ious=ious,
            obj_ptr=obj_ptr,
            object_score_logits=np.array([[5.0 if present else -5.0]], np.float32),
        )

    def decode_points(
        self, pix: Any, features: ImageFeatures, coords: Any, labels: Any, multimask: bool
    ) -> DecoderOutput:
        self._alive()
        red = features.fpn2[0, 0] > 0.5
        seeds = np.zeros_like(red)
        label_list = labels.reshape(-1).tolist()
        points = coords.reshape(-1, 2) / 1024.0 * 64.0
        if all(label == -1 for label in label_list):
            prior = pix[0, 1] > 0.5
            prior = cv2.dilate(prior.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)
            return self._output(_component(red, prior), multimask)
        if 2 in label_list:
            (x0, y0), (x1, y1) = points[label_list.index(2)], points[label_list.index(3)]
            seeds[int(y0) : int(np.ceil(y1)), int(x0) : int(np.ceil(x1))] = True
        for (x, y), label in zip(points, label_list, strict=True):
            if label == 1:
                seeds[min(int(y), 63), min(int(x), 63)] = True
        return self._output(_component(red, seeds), multimask)

    def decode_mask(self, pix: Any, features: ImageFeatures, mask: Any) -> DecoderOutput:
        self._alive()
        small = (
            cv2.resize(mask[0, 0].astype(np.float32), (64, 64), interpolation=cv2.INTER_AREA) > 0.5
        )
        return self._output(small, False)

    def attend(self, curr: Any, curr_pos: Any, memory: Any, memory_pos: Any, valid: Any) -> Any:
        self._alive()
        spatial_valid = valid[: MEM_SLOTS * FEAT_TOKENS].reshape(MEM_SLOTS, FEAT_TOKENS)
        slots = [slot for slot in range(MEM_SLOTS) if spatial_valid[slot].all()]
        self.attend_valid_slots.append(len(slots))
        self.attend_ptr_tokens.append(int(valid[MEM_SLOTS * FEAT_TOKENS :].sum()))
        assert int(valid[MEM_SLOTS * FEAT_TOKENS :].sum()) <= PTR_TOKENS
        prior = np.zeros(FEAT_TOKENS, np.float32)
        for slot in slots:
            prior = np.maximum(prior, memory[slot * FEAT_TOKENS : (slot + 1) * FEAT_TOKENS, 0, 0])
        out = curr.copy()
        out[:, 0, 1] = prior
        return out

    def encode_memory(self, pix_feat: Any, mask_for_mem: Any) -> tuple[Any, Any]:
        self._alive()
        present = cv2.resize(
            (mask_for_mem[0, 0] > 0).astype(np.float32), (64, 64), interpolation=cv2.INTER_AREA
        )
        features = np.zeros((1, 64, 64, 64), np.float32)
        features[0, 0] = present
        pos = np.ones((1, 64, 64, 64), np.float32)
        return features, pos

    def close(self) -> None:
        self.closed = True
