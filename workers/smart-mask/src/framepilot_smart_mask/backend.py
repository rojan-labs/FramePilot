"""The injectable seams between the pipeline and anything that needs weights or binaries.

Everything that loads a model or runs ffmpeg lives behind these protocols, so the pipeline —
SAM 2.1's video memory orchestration, windowing, consensus, self-correction, verification,
encoding decisions — is plain numpy and fully unit testable with scripted fakes
(``tests/fakes.py``). The real implementations are ``onnx_backend.py`` (onnxruntime sessions)
and ``media.py`` (ffmpeg/ffprobe subprocesses); both are imported lazily.

Arrays are typed ``Any`` here so importing this module never requires numpy.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

#: An ``np.ndarray``. Shapes are documented per field.
Array = Any


class MediaUnreadableError(Exception):
    """The approved media handle could not be probed or decoded."""


class BackendUnavailableError(Exception):
    """The inference runtime is missing or refuses to run on this hardware."""


class ModelUnavailableError(Exception):
    """A pinned model file is missing, unreadable, or fails its digest check."""


class ToolUnavailableError(Exception):
    """The pack's ffmpeg/ffprobe binary is missing or not an approved build."""


class AcceleratorOutOfMemoryError(Exception):
    """A GPU/NPU execution provider ran out of memory; the caller falls back to CPU."""


@dataclass(frozen=True, slots=True)
class ImageFeatures:
    """SAM 2.1 image encoder output for one frame (``forward_image`` incl. conv_s0/s1).

    ``fpn0`` (1,32,256,256) and ``fpn1`` (1,64,128,128) feed the mask decoder;
    ``fpn2`` (1,256,64,64) is the raw pixel feature; ``pos2`` (1,256,64,64) its position
    encoding.
    """

    fpn0: Array
    fpn1: Array
    fpn2: Array
    pos2: Array

    @property
    def nbytes(self) -> int:
        return int(self.fpn0.nbytes + self.fpn1.nbytes + self.fpn2.nbytes + self.pos2.nbytes)


@dataclass(frozen=True, slots=True)
class DecoderOutput:
    """``SAM2Base._forward_sam_heads`` outputs (object-pointer and no-object logic included).

    ``low_res_masks`` (1,1,256,256) logits of the best mask, ``high_res_masks`` (1,1,1024,1024),
    ``ious`` (1,M), ``obj_ptr`` (1,256), ``object_score_logits`` (1,1).
    """

    low_res_masks: Array
    high_res_masks: Array
    ious: Array
    obj_ptr: Array
    object_score_logits: Array
    #: (1,M,256,256) logits of every candidate when decoded with multimask (a single click).
    low_res_multimasks: Array | None = None


@dataclass(frozen=True, slots=True)
class SamConstants:
    """The orchestration parameters that are not inside any exported graph.

    ``maskmem_tpos_enc`` (7,1,1,64), ``no_mem_embed`` (1,1,256), ``no_obj_embed_spatial``
    (1,64), ``obj_ptr_tpos_proj_weight`` (64,256), ``obj_ptr_tpos_proj_bias`` (64,),
    ``no_obj_ptr`` (1,256).
    """

    maskmem_tpos_enc: Array
    no_mem_embed: Array
    no_obj_embed_spatial: Array
    obj_ptr_tpos_proj_weight: Array
    obj_ptr_tpos_proj_bias: Array
    no_obj_ptr: Array


@runtime_checkable
class SamModules(Protocol):
    """The five exported SAM 2.1 Hiera-L graphs plus their constants."""

    @property
    def provider(self) -> str:
        """Execution provider actually serving the graphs: ``cpu``, ``coreml`` or ``directml``."""

    @property
    def constants(self) -> SamConstants: ...

    def encode_image(self, image: Array) -> ImageFeatures:
        """``image`` (1,3,1024,1024) float32, ImageNet-normalised."""

    def decode_points(
        self,
        pix_feat: Array,
        features: ImageFeatures,
        coords: Array,
        labels: Array,
        multimask: bool,
    ) -> DecoderOutput:
        """``coords`` (1,N,2) in 1024-px units; ``labels`` (1,N) int32 (1, 0, 2, 3, or -1 pad)."""

    def decode_mask(self, pix_feat: Array, features: ImageFeatures, mask: Array) -> DecoderOutput:
        """Mask prompt: ``mask`` (1,1,1024,1024) float in {0,1}; used for the object pointer."""

    def attend(
        self, curr: Array, curr_pos: Array, memory: Array, memory_pos: Array, valid: Array
    ) -> Array:
        """Memory attention over the static padded memory; returns (4096,1,256)."""

    def encode_memory(self, pix_feat: Array, mask_for_mem: Array) -> tuple[Array, Array]:
        """Returns ``(maskmem_features (1,64,64,64), maskmem_pos_enc (1,64,64,64))``."""

    def close(self) -> None: ...


@runtime_checkable
class MattingModel(Protocol):
    """BiRefNet_HR-matting at one static square tile size."""

    @property
    def provider(self) -> str: ...

    @property
    def tile(self) -> int: ...

    def predict(self, rgb: Array) -> Array:
        """``rgb`` (tile,tile,3) uint8 → alpha (tile,tile) float32 in [0,1]."""

    def close(self) -> None: ...


@runtime_checkable
class ModelProvider(Protocol):
    """Opens model sessions on demand, so only one heavy model is in memory at a time."""

    @property
    def backend_label(self) -> str:
        """Short identity for the result's ``backend`` field (runtime + EPs + fallbacks)."""

    @property
    def model_digests(self) -> dict[str, str]: ...

    @property
    def matting_tiles(self) -> tuple[int, ...]:
        """Tile sizes whose pinned graphs are installed, ascending."""

    def open_sam(self) -> SamModules: ...

    def open_matting(self, tile: int) -> MattingModel: ...

    def fallbacks(self) -> list[dict[str, str]]:
        """Every accelerator → CPU fallback taken so far (model, from, to, reason)."""


@dataclass(frozen=True, slots=True)
class VideoInfo:
    """What ffprobe reports about the first video stream, with the engine's frame identity.

    ``pts`` are packet timestamps with discarded packets dropped, sorted into presentation
    order (``render/pts_reader.py::video_timing``). ``rotation`` is the display-matrix turn
    in degrees (0, 90, 180, 270) that ffmpeg's autorotate applies.
    """

    width: int
    height: int
    sample_aspect: tuple[int, int]
    rotation: int
    time_base: tuple[int, int]
    pts: tuple[int, ...]
    start_time: float

    @property
    def display_size(self) -> tuple[int, int]:
        """``floor(display + 0.5)`` per side (BR2.6, ``render/mattes.py::matte_display_size``)."""
        par = self.sample_aspect[0] / self.sample_aspect[1] if self.sample_aspect[1] else 1.0
        width = self.width * (par if par > 0 else 1.0)
        height = float(self.height)
        if self.rotation in (90, 270):
            width, height = height, width
        return (int(width + 0.5), int(height + 0.5))


@runtime_checkable
class MediaTools(Protocol):
    """ffprobe/ffmpeg: probing, decoding in display space, and lossless/preview encoding."""

    def probe(self, path: str) -> VideoInfo: ...

    def frames(self, path: str, info: VideoInfo, first_frame: int, count: int) -> Iterator[Array]:
        """Yield ``count`` RGB uint8 frames (H,W,3) in display space from ``first_frame``."""

    def encode(
        self,
        destination: str,
        kind: str,
        width: int,
        height: int,
        frames: Iterator[bytes],
        preview_height: int,
    ) -> None:
        """Write ``matte``/``foreground`` (FFV1) or ``preview``/``foreground_preview`` (VP9)."""

    def concat(self, destination: str, segments: list[str]) -> None:
        """Losslessly join FFV1 or VP9 segments in order (stream copy)."""


__all__ = [
    "AcceleratorOutOfMemoryError",
    "Array",
    "BackendUnavailableError",
    "DecoderOutput",
    "ImageFeatures",
    "MattingModel",
    "MediaTools",
    "MediaUnreadableError",
    "ModelProvider",
    "ModelUnavailableError",
    "SamConstants",
    "SamModules",
    "ToolUnavailableError",
    "VideoInfo",
]
