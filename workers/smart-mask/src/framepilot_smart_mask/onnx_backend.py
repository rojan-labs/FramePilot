"""onnxruntime sessions for the pinned graphs, chosen by the parity allow list.

Sessions are created lazily and closed as soon as a stage is done, so SAM (≈ 6 GB footprint on
the CPU EP) and BiRefNet (3.8 GB at 768², 6.9 GB at 1024²) are never loaded together (BR0.7).
Session options follow BR0's memory lessons: no CPU memory arena and no memory-pattern
pre-planning, which otherwise keep the peak allocation reserved for the process lifetime.

An accelerator that runs out of memory mid-job is replaced by the CPU EP for that model and
the call is retried once (BR3.14); every fallback is recorded and reported.
"""

from __future__ import annotations

import logging
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any, Final

import numpy as np

from .backend import (
    AcceleratorOutOfMemoryError,
    BackendUnavailableError,
    DecoderOutput,
    ImageFeatures,
    SamConstants,
)
from .models import (
    ORT_PROVIDER_NAMES,
    DigestCache,
    ModelFamily,
    ProviderName,
    installed_tiles,
    provider_chain,
    select_provider,
)

_log = logging.getLogger(__name__)

DECODER_OUTPUTS: Final = (
    "low_res_multimasks",
    "high_res_multimasks",
    "ious",
    "low_res_masks",
    "high_res_masks",
    "obj_ptr",
    "object_score_logits",
)
_OOM_MARKERS: Final = (
    "out of memory",
    "failed to allocate",
    "e_outofmemory",
    "0x8007000e",
    "887a0005",
)
IMAGENET_MEAN: Final = np.array([0.485, 0.456, 0.406], np.float32)
IMAGENET_STD: Final = np.array([0.229, 0.224, 0.225], np.float32)


def _ort() -> Any:
    try:
        import onnxruntime
    except ImportError as error:  # pragma: no cover - the pack always installs onnxruntime
        raise BackendUnavailableError("onnxruntime is not installed in this pack.") from error
    return onnxruntime


def _windows_build() -> int | None:
    if sys.platform != "win32":
        return None
    return int(getattr(sys, "getwindowsversion")().build)  # noqa: B009 - Windows-only API


class GuardedSession:
    """One graph on one EP; an accelerator OOM rebuilds it on CPU and retries once."""

    def __init__(
        self,
        path: Path,
        family: ModelFamily,
        provider: ProviderName,
        on_fallback: Callable[[dict[str, str]], None],
        factory: Callable[[ProviderName], Any],
    ) -> None:
        self.path = path
        self.family = family
        self.provider: ProviderName = provider
        self._on_fallback = on_fallback
        self._factory = factory
        self._session = self._create(provider)

    def _create(self, provider: ProviderName) -> Any:
        try:
            return self._factory(provider)
        except Exception as error:
            if provider != "cpu":
                self._record_fallback(provider, f"session build failed: {type(error).__name__}")
                return self._create("cpu")
            raise BackendUnavailableError(
                f"onnxruntime could not load {self.path.name}."
            ) from error

    def _record_fallback(self, provider: ProviderName, reason: str) -> None:
        self.provider = "cpu"
        record = {"model": self.path.name, "from": provider, "to": "cpu", "reason": reason}
        _log.warning("execution provider fallback: %s", record)
        self._on_fallback(record)

    def run(self, feeds: dict[str, Any]) -> list[Any]:
        prepared = {name: np.ascontiguousarray(value) for name, value in feeds.items()}
        try:
            return list(self._session.run(None, prepared))
        except Exception as error:
            out_of_memory = any(marker in str(error).lower() for marker in _OOM_MARKERS)
            if not out_of_memory:
                raise
            if self.provider == "cpu":
                raise AcceleratorOutOfMemoryError(
                    f"{self.path.name} ran out of memory on the CPU EP."
                ) from error
            previous = self.provider
            self._session = None
            self._session = self._create("cpu")
            self._record_fallback(previous, "accelerator out of memory")
            return list(self._session.run(None, prepared))

    def close(self) -> None:
        self._session = None


class OnnxSam:
    """The SAM 2.1 graphs plus constants, implementing :class:`SamModules`.

    Sessions open on first use and :meth:`release` drops one, so the image encoder (3.4 GB on
    the CPU EP) and memory attention (2.4 GB) need not be resident together (BR0.7).
    """

    def __init__(
        self, open_session: Callable[[str], GuardedSession], constants: SamConstants
    ) -> None:
        self._open = open_session
        self._sessions: dict[str, GuardedSession] = {}
        self._constants = constants

    def _session(self, name: str) -> GuardedSession:
        if name not in self._sessions:
            self._sessions[name] = self._open(name)
        return self._sessions[name]

    def release(self, name: str) -> None:
        session = self._sessions.pop(name, None)
        if session is not None:
            session.close()

    @property
    def provider(self) -> str:
        providers = {session.provider for session in self._sessions.values()} or {"cpu"}
        return "cpu" if "cpu" in providers else next(iter(providers))

    @property
    def constants(self) -> SamConstants:
        return self._constants

    def encode_image(self, image: Any) -> ImageFeatures:
        fpn0, fpn1, fpn2, _pos0, _pos1, pos2 = self._session("sam_image_encoder").run(
            {"image": image}
        )
        return ImageFeatures(fpn0=fpn0, fpn1=fpn1, fpn2=fpn2, pos2=pos2)

    @staticmethod
    def _decoded(outputs: list[Any]) -> DecoderOutput:
        values = dict(zip(DECODER_OUTPUTS, outputs, strict=True))
        return DecoderOutput(
            low_res_masks=values["low_res_masks"],
            high_res_masks=values["high_res_masks"],
            ious=values["ious"],
            obj_ptr=values["obj_ptr"],
            object_score_logits=values["object_score_logits"],
            low_res_multimasks=values["low_res_multimasks"],
        )

    def decode_points(
        self, pix_feat: Any, features: ImageFeatures, coords: Any, labels: Any, multimask: bool
    ) -> DecoderOutput:
        count = int(np.asarray(labels).shape[1])
        if multimask and count != 1:
            raise BackendUnavailableError("multimask decoding is exported for exactly one point.")
        name = "sam_decoder_multi_n1" if multimask else "sam_decoder_points"
        feeds = {
            "pix_feat": np.asarray(pix_feat, np.float32),
            "high_res0": features.fpn0,
            "high_res1": features.fpn1,
            "point_coords": np.asarray(coords, np.float32),
            "point_labels": np.asarray(labels, np.int32),
        }
        return self._decoded(self._session(name).run(feeds))

    def decode_mask(self, pix_feat: Any, features: ImageFeatures, mask: Any) -> DecoderOutput:
        feeds = {
            "pix_feat": np.asarray(pix_feat, np.float32),
            "high_res0": features.fpn0,
            "high_res1": features.fpn1,
            "mask": np.asarray(mask, np.float32),
        }
        return self._decoded(self._session("sam_decoder_mask").run(feeds))

    def attend(self, curr: Any, curr_pos: Any, memory: Any, memory_pos: Any, valid: Any) -> Any:
        (out,) = self._session("sam_memory_attention").run(
            {
                "curr": curr,
                "curr_pos": curr_pos,
                "memory": memory,
                "memory_pos": memory_pos,
                "memory_valid": valid,
            }
        )
        return out

    def encode_memory(self, pix_feat: Any, mask_for_mem: Any) -> tuple[Any, Any]:
        features, pos = self._session("sam_memory_encoder").run(
            {
                "pix_feat": np.asarray(pix_feat, np.float32),
                "mask_for_mem": np.asarray(mask_for_mem, np.float32),
            }
        )
        return features, pos

    def close(self) -> None:
        for session in self._sessions.values():
            session.close()
        self._sessions.clear()


class OnnxMatting:
    """BiRefNet_HR-matting at one tile size, implementing :class:`MattingModel`."""

    def __init__(self, session: GuardedSession, tile: int) -> None:
        self._session = session
        self._tile = tile

    @property
    def provider(self) -> str:
        return self._session.provider

    @property
    def tile(self) -> int:
        return self._tile

    def predict(self, rgb: Any) -> Any:
        tile = np.asarray(rgb, np.float32) / 255.0
        normalised = ((tile - IMAGENET_MEAN) / IMAGENET_STD).transpose(2, 0, 1)[None]
        (alpha,) = self._session.run({"image": normalised.astype(np.float32)})
        return np.asarray(alpha, np.float32)[0, 0]

    def close(self) -> None:
        self._session.close()


class OnnxModelProvider:
    """Implements :class:`ModelProvider` over the installed, digest-verified graphs."""

    def __init__(
        self,
        directory: Path,
        *,
        digests: DigestCache | None = None,
        compiled_cache: Path | None = None,
        intra_op_threads: int = 0,
    ) -> None:
        self.directory = directory
        self._digests = digests or DigestCache()
        self._compiled_cache = compiled_cache
        self._threads = intra_op_threads
        self._fallbacks: list[dict[str, str]] = []
        self._skipped: dict[str, list[dict[str, str]]] = {}
        self._chosen: dict[str, ProviderName] = {}
        self.prepare_seconds: dict[str, float] = {}
        from .prepare import CompiledModelCache

        self._prepared = CompiledModelCache(compiled_cache, _ort().__version__)

    @property
    def backend_label(self) -> str:
        ort = _ort()
        parts = [f"onnxruntime-{ort.__version__}"]
        parts += [f"{family}={provider}" for family, provider in sorted(self._chosen.items())]
        if self._fallbacks:
            parts.append("fallback=" + ",".join(sorted({item["from"] for item in self._fallbacks})))
        return ":".join(parts)[:128]

    @property
    def model_digests(self) -> dict[str, str]:
        from .models import PINNED_MODELS

        tiles = set(installed_tiles(self.directory))
        return {
            model.file: model.sha256
            for model in PINNED_MODELS
            if model.pinned and (model.tile is None or model.tile in tiles)
        }

    @property
    def matting_tiles(self) -> tuple[int, ...]:
        return installed_tiles(self.directory)

    def fallbacks(self) -> list[dict[str, str]]:
        return list(self._fallbacks)

    def provider_report(self) -> dict[str, Any]:
        return {
            "chosen": dict(self._chosen),
            "skipped": dict(self._skipped),
            "fallbacks": self.fallbacks(),
        }

    def _session_options(self) -> Any:
        ort = _ort()
        options = ort.SessionOptions()
        options.log_severity_level = 3
        options.enable_cpu_mem_arena = False
        options.enable_mem_pattern = False
        if self._threads > 0:
            options.intra_op_num_threads = self._threads
        return options

    def _provider_options(self, provider: ProviderName, model_id: str, digest: str) -> list[Any]:
        name = ORT_PROVIDER_NAMES[provider]
        if provider == "coreml":
            options: dict[str, str] = {
                "ModelFormat": "MLProgram",
                "RequireStaticInputShapes": "1",
                "MLComputeUnits": "ALL",
            }
            directory = self._prepared.coreml_directory(model_id, digest)
            if directory is not None:
                options["ModelCacheDirectory"] = str(directory)
            return [(name, options), "CPUExecutionProvider"]
        return [name, "CPUExecutionProvider"]

    def _provider_for(self, family: ModelFamily) -> ProviderName:
        if family not in self._chosen:
            available = tuple(_ort().get_available_providers())
            provider, skipped = select_provider(
                family, available, provider_chain(sys.platform, _windows_build())
            )
            self._chosen[family] = provider
            self._skipped[family] = skipped
        return self._chosen[family]

    def _session(self, model_id: str, family: ModelFamily) -> GuardedSession:
        import time

        from .models import MODELS_BY_ID

        path = self._digests.resolve(model_id, self.directory)
        digest = MODELS_BY_ID[model_id].sha256
        ort = _ort()

        def factory(provider: ProviderName) -> Any:
            if provider == "cpu":

                def build(save_to: Path | None) -> Any:
                    options = self._session_options()
                    if save_to is not None:
                        options.optimized_model_filepath = str(save_to)
                    return ort.InferenceSession(
                        str(path), options, providers=["CPUExecutionProvider"]
                    )

                def load(cached: Path) -> Any:
                    options = self._session_options()
                    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
                    return ort.InferenceSession(
                        str(cached), options, providers=["CPUExecutionProvider"]
                    )

                return self._prepared.cpu_graph(model_id, digest, path, build, load)
            return ort.InferenceSession(
                str(path),
                self._session_options(),
                providers=self._provider_options(provider, model_id, digest),
            )

        started = time.monotonic()
        session = GuardedSession(
            path, family, self._provider_for(family), self._fallbacks.append, factory
        )
        self.prepare_seconds[model_id] = round(time.monotonic() - started, 3)
        return session

    def open_sam(self) -> OnnxSam:
        return OnnxSam(lambda model_id: self._session(model_id, "sam"), self.load_constants())

    def load_constants(self) -> SamConstants:
        path = self._digests.resolve("sam_constants", self.directory)
        with np.load(path) as data:
            return SamConstants(
                maskmem_tpos_enc=np.array(data["maskmem_tpos_enc"], np.float32),
                no_mem_embed=np.array(data["no_mem_embed"], np.float32),
                no_obj_embed_spatial=np.array(data["no_obj_embed_spatial"], np.float32),
                obj_ptr_tpos_proj_weight=np.array(data["obj_ptr_tpos_proj_weight"], np.float32),
                obj_ptr_tpos_proj_bias=np.array(data["obj_ptr_tpos_proj_bias"], np.float32),
                no_obj_ptr=np.array(data["no_obj_ptr"], np.float32),
            )

    def open_matting(self, tile: int) -> OnnxMatting:
        return OnnxMatting(self._session(f"birefnet_{tile}", "birefnet"), tile)


__all__ = ["GuardedSession", "OnnxMatting", "OnnxModelProvider", "OnnxSam"]
