"""SAM 2.1 video tracking on exported graphs: the upstream orchestration, ported to numpy.

The exported ONNX graphs cover the learned maths (image encoder; prompt encoder + mask
decoder + object pointer; memory attention; memory encoder). What remains is the video
predictor's bookkeeping — which memories a frame attends to, their temporal encodings, object
pointers and their sine encodings, mask-prompt handling — and that is reproduced here from
facebookresearch/sam2 @ 2b90b9f5 (``sam2_base.py``, ``sam2_video_predictor.py``), with two
deliberate, recorded differences:

1. **A bounded memory bank.** Upstream keeps every tracked frame's outputs for the whole video.
   Only the last ``NUM_MASKMEM - 1`` spatial memories and ``MAX_OBJ_PTRS - 1`` object pointers
   in the tracking direction can ever be read, so older non-conditioning entries are evicted.
   The arithmetic is unchanged; the footprint is constant per frame.
2. **At most two conditioning frames per step** (the closest before and after, upstream's own
   ``select_closest_cond_frames`` rule with ``max_cond_frames_in_attn = 2``), because the memory
   attention graph has static shapes: 7 spatial slots and 64 pointer tokens. With one prompt the
   result is identical to upstream; with more, the farthest recent memories and pointers are the
   ones dropped to fit.

The video builder's post-processing overrides are followed: conditioning frames encode a binarised
mask (``binarize_mask_from_pts_for_mem_enc``); small-hole filling (``fill_hole_area=8``) is not
applied, because upstream skips it without its CUDA kernel, which is how the CPU reference ran.
The decoder's dynamic multimask-by-stability is inside the exported graph.

Memory features are stored in fp32 by default (upstream stores bfloat16). ``bfloat16`` storage
is emulated exactly for the parity harness, which compares against the upstream reference.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Any, Final, Literal

import cv2
import numpy as np
import numpy.typing as npt

from .backend import DecoderOutput, ImageFeatures, SamModules

_log = logging.getLogger(__name__)

IMAGE_SIZE: Final = 1024
LOW_RES: Final = 256
FEAT_SIZE: Final = 64
FEAT_TOKENS: Final = FEAT_SIZE * FEAT_SIZE
HIDDEN_DIM: Final = 256
MEM_DIM: Final = 64
NUM_MASKMEM: Final = 7
MEM_SLOTS: Final = 7
PTR_TOKENS: Final = 64
MAX_OBJ_PTRS: Final = 16
MAX_COND_FRAMES_IN_ATTN: Final = 2
MEM_TOKENS: Final = MEM_SLOTS * FEAT_TOKENS + PTR_TOKENS
SIGMOID_SCALE_FOR_MEM_ENC: Final = 20.0
SIGMOID_BIAS_FOR_MEM_ENC: Final = -10.0
MASK_OUT_SCALE: Final = 20.0
MASK_OUT_BIAS: Final = -10.0
NO_OBJ_SCORE: Final = -1024.0
IMG_MEAN: Final = np.array([0.485, 0.456, 0.406], np.float64)
IMG_STD: Final = np.array([0.229, 0.224, 0.225], np.float64)

#: float32 arrays; typed loosely because numpy's stubs widen dtypes through arithmetic.
Float = npt.NDArray[Any]
MemoryStorage = Literal["float32", "bfloat16"]


# --- numeric helpers --------------------------------------------------------------------------


def preprocess(frame: npt.NDArray[np.uint8]) -> Float:
    """Upstream ``_load_img_as_tensor`` + normalisation: PIL bicubic to 1024², ImageNet stats."""
    from PIL import Image

    resized = (
        np.asarray(Image.fromarray(frame).resize((IMAGE_SIZE, IMAGE_SIZE)), dtype=np.float64)
        / 255.0
    )
    normalised = (resized - IMG_MEAN) / IMG_STD
    return np.ascontiguousarray(normalised.transpose(2, 0, 1)[None].astype(np.float32))


def sigmoid(values: Float) -> Float:
    return (1.0 / (1.0 + np.exp(-np.clip(values, -60.0, 60.0)))).astype(np.float32)


def _aa_weights(in_size: int, out_size: int) -> npt.NDArray[np.float64]:
    """torch ``interpolate(mode='bilinear', antialias=True, align_corners=False)`` 1-D weights."""
    scale = in_size / out_size
    support = scale if scale >= 1.0 else 1.0
    invscale = 1.0 / scale if scale >= 1.0 else 1.0
    weights = np.zeros((out_size, in_size), np.float64)
    for index in range(out_size):
        center = scale * (index + 0.5)
        xmin = max(int(center - support + 0.5), 0)
        xmax = min(int(center + support + 0.5), in_size)
        taps = np.arange(xmin, xmax, dtype=np.float64)
        row = np.maximum(0.0, 1.0 - np.abs((taps - center + 0.5) * invscale))
        total = row.sum()
        if total > 0:
            weights[index, xmin:xmax] = row / total
    return weights


def resize_antialias(values: Float, height: int, width: int) -> Float:
    """Separable antialiased bilinear resize of a 2-D map (mask prompts, upstream exact)."""
    rows = _aa_weights(values.shape[0], height)
    cols = _aa_weights(values.shape[1], width)
    return (rows @ values.astype(np.float64) @ cols.T).astype(np.float32)


def resize_bilinear(values: Float, height: int, width: int) -> Float:
    """``interpolate(mode='bilinear', align_corners=False)`` without antialiasing."""
    return cv2.resize(values.astype(np.float32), (width, height), interpolation=cv2.INTER_LINEAR)


def emulate_bfloat16(values: Float) -> Float:
    """Round-trip float32 → bfloat16 → float32 exactly, as upstream stores memory features.

    bfloat16 keeps float32's exponent and 8 significant bits; ties round to even.
    """
    mantissa, exponent = np.frexp(values.astype(np.float64))
    quantised = np.round(mantissa * 256.0) / 256.0
    return np.ldexp(quantised, exponent).astype(np.float32)


def sine_pe(positions: Float, dim: int, temperature: float = 10000.0) -> Float:
    """Upstream ``get_1d_sine_pe``."""
    pe_dim = dim // 2
    dim_t = np.arange(pe_dim, dtype=np.float32)
    dim_t = (temperature ** (2 * np.floor(dim_t / 2) / pe_dim)).astype(np.float32)
    embed = positions[:, None] / dim_t
    return np.concatenate([np.sin(embed), np.cos(embed)], axis=-1).astype(np.float32)


# --- memory bank ------------------------------------------------------------------------------


@dataclass(slots=True)
class FrameOutput:
    """One frame's tracking output, as the bank and the pipeline need it."""

    low_res: Float  # (256,256) logits
    obj_ptr: Float  # (256,)
    score: float  # object score logit
    iou: float
    maskmem_features: Float | None = None  # (4096, 64) tokens
    is_cond: bool = False


@dataclass
class MemoryBank:
    """Conditioning outputs (prompts, locks, seeds) plus a bounded window of recent frames."""

    maskmem_pos: Float  # (4096, 64), identical for every frame
    constants_tpos: Float  # (7,1,1,64)
    proj_weight: Float  # (64,256)
    proj_bias: Float  # (64,)
    cond: dict[int, FrameOutput] = field(default_factory=dict)
    recent: dict[int, FrameOutput] = field(default_factory=dict)

    def remember(self, index: int, output: FrameOutput, reverse: bool) -> None:
        self.recent[index] = output
        horizon = max(NUM_MASKMEM - 1, MAX_OBJ_PTRS - 1)
        stale = [
            key
            for key in self.recent
            if (key > index + horizon if reverse else key < index - horizon)
        ]
        for key in stale:
            del self.recent[key]

    def select_cond(self, frame: int) -> tuple[dict[int, FrameOutput], dict[int, FrameOutput]]:
        """Upstream ``select_closest_cond_frames`` with ``max_cond_frame_num = 2``."""
        if len(self.cond) <= MAX_COND_FRAMES_IN_ATTN:
            return dict(self.cond), {}
        selected: dict[int, FrameOutput] = {}
        before = max((t for t in self.cond if t < frame), default=None)
        if before is not None:
            selected[before] = self.cond[before]
        after = min((t for t in self.cond if t >= frame), default=None)
        if after is not None:
            selected[after] = self.cond[after]
        remaining = MAX_COND_FRAMES_IN_ATTN - len(selected)
        for t in sorted((t for t in self.cond if t not in selected), key=lambda x: abs(x - frame))[
            :remaining
        ]:
            selected[t] = self.cond[t]
        return selected, {t: v for t, v in self.cond.items() if t not in selected}

    def assemble(
        self, frame: int, reverse: bool, num_frames: int
    ) -> tuple[Float, Float, npt.NDArray[np.bool_]]:
        """Static padded memory for ``frame`` (``_prepare_memory_conditioned_features``)."""
        selected, unselected = self.select_cond(frame)
        spatial: list[tuple[int, FrameOutput]] = [(0, out) for out in selected.values()]
        previous: list[tuple[int, FrameOutput]] = []
        for t_pos in range(1, NUM_MASKMEM):
            t_rel = NUM_MASKMEM - t_pos
            prev = frame + t_rel if reverse else frame - t_rel
            out = self.recent.get(prev) or unselected.get(prev)
            if out is not None:
                previous.append((t_pos, out))
        # Static slots: drop the farthest recent memories first (lowest t_pos).
        overflow = len(spatial) + len(previous) - MEM_SLOTS
        if overflow > 0:
            previous = previous[overflow:]
        spatial.extend(previous)

        max_ptrs = min(num_frames, MAX_OBJ_PTRS)
        sign = -1 if reverse else 1
        ptr_cond = {
            t: out for t, out in selected.items() if (t >= frame if reverse else t <= frame)
        }
        cond_ptrs = [((frame - t) * sign, out.obj_ptr) for t, out in ptr_cond.items()]
        recent_ptrs: list[tuple[int, Float]] = []
        for t_diff in range(1, max_ptrs):
            t = frame + t_diff if reverse else frame - t_diff
            if t < 0 or t >= num_frames:
                break
            out = self.recent.get(t) or unselected.get(t)
            if out is not None:
                recent_ptrs.append((t_diff, out.obj_ptr))
        room = PTR_TOKENS // 4 - len(cond_ptrs)
        pointers = cond_ptrs + recent_ptrs[: max(room, 0)]

        memory = np.zeros((MEM_TOKENS, 1, MEM_DIM), np.float32)
        memory_pos = np.zeros((MEM_TOKENS, 1, MEM_DIM), np.float32)
        valid = np.zeros((MEM_TOKENS,), np.bool_)
        for slot, (t_pos, out) in enumerate(spatial):
            assert out.maskmem_features is not None
            start = slot * FEAT_TOKENS
            memory[start : start + FEAT_TOKENS, 0] = out.maskmem_features
            memory_pos[start : start + FEAT_TOKENS, 0] = (
                self.maskmem_pos + self.constants_tpos[NUM_MASKMEM - t_pos - 1, 0]
            )
            valid[start : start + FEAT_TOKENS] = True
        if pointers:
            positions = np.array([p for p, _ in pointers], np.float32)
            t_diff_max = max_ptrs - 1
            pos = sine_pe(positions / max(t_diff_max, 1), HIDDEN_DIM)
            pos = pos @ self.proj_weight.T + self.proj_bias  # (n, 64)
            ptrs = np.stack([ptr for _, ptr in pointers]).reshape(
                -1, HIDDEN_DIM // MEM_DIM, MEM_DIM
            )  # (n,4,64)
            tokens = ptrs.reshape(-1, MEM_DIM)
            token_pos = np.repeat(pos, HIDDEN_DIM // MEM_DIM, axis=0)
            base = MEM_SLOTS * FEAT_TOKENS
            memory[base : base + len(tokens), 0] = tokens
            memory_pos[base : base + len(tokens), 0] = token_pos
            valid[base : base + len(tokens)] = True
        return memory, memory_pos, valid


# --- tracker ----------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class PointPrompt:
    """Coordinates normalised to [0,1] of the display frame; labels 1/0 (points), 2/3 (box)."""

    coords: tuple[tuple[float, float], ...]
    labels: tuple[int, ...]


@dataclass(frozen=True, slots=True)
class MaskPrompt:
    """A binary mask at display size (locked alpha ≥ 128, a window seed, a corrected frame)."""

    mask: npt.NDArray[np.bool_]


CondPrompt = PointPrompt | MaskPrompt


@dataclass(slots=True)
class PassResult:
    """One propagation pass over a window: low-res logits and scores per frame it reached."""

    low_res: dict[int, Float] = field(default_factory=dict)
    scores: dict[int, float] = field(default_factory=dict)
    ious: dict[int, float] = field(default_factory=dict)


class SamTracker:
    """Runs conditioning frames and forward/backward propagation over one window."""

    def __init__(
        self,
        modules: SamModules,
        features: Callable[[int], ImageFeatures],
        *,
        memory_storage: MemoryStorage = "float32",
        should_stop: Callable[[], None] | None = None,
    ) -> None:
        self.modules = modules
        self.features = features
        self.memory_storage = memory_storage
        self.should_stop = should_stop or (lambda: None)
        constants = modules.constants
        self._no_mem_embed = constants.no_mem_embed.reshape(1, HIDDEN_DIM, 1, 1).astype(np.float32)
        self._no_obj_spatial = constants.no_obj_embed_spatial.reshape(1, MEM_DIM, 1, 1).astype(
            np.float32
        )
        self._no_obj_ptr = constants.no_obj_ptr.reshape(HIDDEN_DIM).astype(np.float32)
        self._maskmem_pos: Float | None = None
        self.decoder_calls = 0
        self.attention_calls = 0
        #: Per single-click conditioning frame: every candidate's area and predicted IoU, SAM's
        #: pick and the whole-object choice (report.json, so the rule can be checked on real runs).
        self.click_choices: list[dict[str, Any]] = []
        #: Eval only: the candidates' low-res logits per single-click frame (the eval dump).
        self.click_candidates: list[tuple[int, Float]] = []

    # conditioning frames ----------------------------------------------------------------------

    def condition(self, index: int, prompt: CondPrompt) -> FrameOutput:
        feats = self.features(index)
        if isinstance(prompt, PointPrompt):
            return self._condition_points(feats, prompt, index)
        return self._condition_mask(feats, prompt)

    def _condition_points(
        self, feats: ImageFeatures, prompt: PointPrompt, index: int = -1
    ) -> FrameOutput:
        pix = feats.fpn2 + self._no_mem_embed  # directly_add_no_mem_embed on an initial frame
        coords = np.array(prompt.coords, np.float32).reshape(1, -1, 2) * IMAGE_SIZE
        labels = np.array(prompt.labels, np.int32).reshape(1, -1)
        multimask = labels.shape[1] <= 1
        out = self.modules.decode_points(pix, feats, coords, labels, multimask)
        self.decoder_calls += 1
        if multimask and prompt.labels == (1,) and out.low_res_multimasks is not None:
            candidates = np.asarray(out.low_res_multimasks, np.float32).reshape(
                -1, LOW_RES, LOW_RES
            )
            ious = np.asarray(out.ious, np.float32).reshape(-1)
            chosen = whole_object(candidates, ious, coords[0, 0] * LOW_RES / IMAGE_SIZE)
            self.click_candidates.append((index, candidates.copy()))
            self.click_choices.append(
                {
                    "areas": [int((c > 0).sum()) for c in candidates],
                    "ious": [round(float(v), 4) for v in ious],
                    "samPick": int(np.argmax(ious)),
                    "chosen": chosen,
                }
            )
            if chosen is not None:
                whole = resize_bilinear(candidates[chosen], IMAGE_SIZE, IMAGE_SIZE) > 0
                return self._condition_mask(feats, MaskPrompt(whole))
        return self._with_memory(feats, out, is_cond=True)

    def _condition_mask(self, feats: ImageFeatures, prompt: MaskPrompt) -> FrameOutput:
        mask = prompt.mask.astype(np.float32)
        if mask.shape != (IMAGE_SIZE, IMAGE_SIZE):
            mask = (resize_antialias(mask, IMAGE_SIZE, IMAGE_SIZE) >= 0.5).astype(np.float32)
        high_res = mask * MASK_OUT_SCALE + MASK_OUT_BIAS
        low_res = resize_antialias(high_res, LOW_RES, LOW_RES)
        appearing = bool(mask.any())
        decoded = self.modules.decode_mask(feats.fpn2, feats, mask[None, None])
        self.decoder_calls += 1
        lam = 1.0 if appearing else 0.0
        obj_ptr = lam * decoded.obj_ptr.reshape(HIDDEN_DIM) + (1.0 - lam) * self._no_obj_ptr
        score = MASK_OUT_SCALE * lam + MASK_OUT_BIAS
        # Upstream preflight re-derives the memory mask from the low-res logits.
        for_memory = resize_bilinear(low_res, IMAGE_SIZE, IMAGE_SIZE)
        output = FrameOutput(
            low_res=low_res,
            obj_ptr=obj_ptr.astype(np.float32),
            score=float(score),
            iou=1.0,
            is_cond=True,
        )
        output.maskmem_features = self._encode_memory(feats, for_memory, score, binarize=True)
        return output

    # propagation ------------------------------------------------------------------------------

    def propagate(
        self,
        cond: dict[int, FrameOutput],
        num_frames: int,
        *,
        reverse: bool,
        start: int,
        stop: int,
        on_frame: Callable[[int], None] | None = None,
    ) -> PassResult:
        """Track from ``start`` towards ``stop`` (inclusive), forward or backward.

        Conditioning frames on the way emit their stored output, as upstream does.
        """
        bank = self._bank(cond)
        result = PassResult()
        order: Iterable[int] = range(start, stop - 1, -1) if reverse else range(start, stop + 1)
        for index in order:
            self.should_stop()
            if index in cond:
                output = cond[index]
            else:
                output = self._track(index, bank, reverse, num_frames)
                bank.remember(index, output, reverse)
            result.low_res[index] = output.low_res
            result.scores[index] = output.score
            result.ious[index] = output.iou
            if on_frame is not None:
                on_frame(index)
        return result

    def _bank(self, cond: dict[int, FrameOutput]) -> MemoryBank:
        if self._maskmem_pos is None:
            raise RuntimeError(
                "the memory position encoding is known only after a conditioning frame"
            )
        constants = self.modules.constants
        return MemoryBank(
            maskmem_pos=self._maskmem_pos,
            constants_tpos=constants.maskmem_tpos_enc.astype(np.float32),
            proj_weight=constants.obj_ptr_tpos_proj_weight.astype(np.float32),
            proj_bias=constants.obj_ptr_tpos_proj_bias.astype(np.float32),
            cond=cond,
        )

    def _track(self, index: int, bank: MemoryBank, reverse: bool, num_frames: int) -> FrameOutput:
        feats = self.features(index)
        memory, memory_pos, valid = bank.assemble(index, reverse, num_frames)
        curr = feats.fpn2.reshape(1, HIDDEN_DIM, FEAT_TOKENS).transpose(2, 0, 1)
        curr_pos = feats.pos2.reshape(1, HIDDEN_DIM, FEAT_TOKENS).transpose(2, 0, 1)
        attended = self.modules.attend(
            np.ascontiguousarray(curr), np.ascontiguousarray(curr_pos), memory, memory_pos, valid
        )
        self.attention_calls += 1
        pix = np.ascontiguousarray(
            attended.transpose(1, 2, 0).reshape(1, HIDDEN_DIM, FEAT_SIZE, FEAT_SIZE)
        )
        coords = np.zeros((1, 1, 2), np.float32)
        labels = -np.ones((1, 1), np.int32)
        out = self.modules.decode_points(pix, feats, coords, labels, True)
        self.decoder_calls += 1
        return self._with_memory(feats, out, is_cond=False)

    def _with_memory(
        self, feats: ImageFeatures, out: DecoderOutput, *, is_cond: bool
    ) -> FrameOutput:
        score = float(np.asarray(out.object_score_logits).reshape(-1)[0])
        ious = np.asarray(out.ious).reshape(-1)
        output = FrameOutput(
            low_res=np.asarray(out.low_res_masks, np.float32).reshape(LOW_RES, LOW_RES),
            obj_ptr=np.asarray(out.obj_ptr, np.float32).reshape(HIDDEN_DIM),
            score=score,
            iou=float(ious.max()) if ious.size else 0.0,
            is_cond=is_cond,
        )
        high_res = np.asarray(out.high_res_masks, np.float32).reshape(IMAGE_SIZE, IMAGE_SIZE)
        # Conditioning frames go through upstream's preflight with is_mask_from_pts=True.
        output.maskmem_features = self._encode_memory(feats, high_res, score, binarize=is_cond)
        return output

    def _encode_memory(
        self, feats: ImageFeatures, high_res_logits: Float, score: float, *, binarize: bool
    ) -> Float:
        # build_sam2_video_predictor sets binarize_mask_from_pts_for_mem_enc=true: a conditioning
        # frame is remembered exactly as the editor sees it (logits > 0), not as a probability.
        probability = (
            (high_res_logits > 0).astype(np.float32) if binarize else sigmoid(high_res_logits)
        )
        mask_for_mem = probability * SIGMOID_SCALE_FOR_MEM_ENC + SIGMOID_BIAS_FOR_MEM_ENC
        features, pos = self.modules.encode_memory(
            feats.fpn2, mask_for_mem.reshape(1, 1, IMAGE_SIZE, IMAGE_SIZE)
        )
        features = np.asarray(features, np.float32)
        if score <= 0:
            features = features + self._no_obj_spatial
        if self.memory_storage == "bfloat16":
            features = emulate_bfloat16(features)
        if self._maskmem_pos is None:
            self._maskmem_pos = np.asarray(pos, np.float32).reshape(MEM_DIM, FEAT_TOKENS).T.copy()
        tokens: Float = features.reshape(MEM_DIM, FEAT_TOKENS).T.copy()
        return tokens


#: One click selects the whole subject: of SAM's candidates that contain the click and whose
#: predicted IoU is within this margin of the best, the largest (BR7.4 it0: the best-IoU pick was
#: a part, a torso or a head, in 4 of 5 categories: one-click IoU 0.53-0.86). At 0.15 (it2) the
#: close-ups still kept a part (hair_busy 0.70, talking_head 0.85); the margin is 0.3 since.
WHOLE_OBJECT_IOU_MARGIN: Final = 0.3
#: ... but never a candidate covering more than this fraction of the frame (the background).
WHOLE_OBJECT_MAX_FRACTION: Final = 0.6


def whole_object(candidates: Float, ious: Float, click_low_res: Float) -> int | None:
    """Index of the candidate to condition on for a single click, or None to keep SAM's pick.

    ``candidates`` (M, 256, 256) logits, ``ious`` (M,) predicted IoU, ``click_low_res`` (x, y)
    in low-res pixels. SAM's own pick is the highest predicted IoU, which for a click on a person
    is usually a part; background removal wants the subject the click is on.
    """
    x = int(np.clip(click_low_res[0], 0, LOW_RES - 1))
    y = int(np.clip(click_low_res[1], 0, LOW_RES - 1))
    masks = candidates > 0
    areas = masks.reshape(len(masks), -1).sum(axis=1)
    eligible = [
        index
        for index in range(len(masks))
        if masks[index, y, x] and areas[index] <= WHOLE_OBJECT_MAX_FRACTION * LOW_RES * LOW_RES
    ]
    if not eligible:
        return None
    best = max(float(ious[index]) for index in eligible)
    near_best = [
        index for index in eligible if float(ious[index]) >= best - WHOLE_OBJECT_IOU_MARGIN
    ]
    chosen = max(near_best, key=lambda index: int(areas[index]))
    return None if chosen == int(np.argmax(ious)) else chosen


def video_logits(low_res: Float, height: int, width: int) -> Float:
    """``_get_orig_video_res_output``: bilinear from 256² logits to the display size."""
    return resize_bilinear(low_res, height, width)


__all__ = [
    "IMAGE_SIZE",
    "LOW_RES",
    "MAX_OBJ_PTRS",
    "NUM_MASKMEM",
    "FrameOutput",
    "MaskPrompt",
    "MemoryBank",
    "PassResult",
    "PointPrompt",
    "SamTracker",
    "emulate_bfloat16",
    "preprocess",
    "resize_antialias",
    "resize_bilinear",
    "sigmoid",
    "sine_pe",
    "video_logits",
    "whole_object",
]
