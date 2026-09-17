"""Composition root: the real models, media tools and pipeline behind :class:`WorkerServices`.

Imported lazily by ``__main__`` so a protocol refusal never loads numpy or onnxruntime.
Configuration comes from ``FRAMEPILOT_``-prefixed environment variables, the only channel the
host's worker client passes through (``worker-env.ts``).
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import asdict
from typing import Any, Final

from .backend import BackendUnavailableError, ModelUnavailableError
from .identity import HealthFacts
from .models import PINNED_MODELS, DigestCache, installed_tiles, models_directory
from .protocol import MatteOutcome, MatteRequest, SegmentFrameRequest
from .runtime import CancellationFlag, ProgressSink, SegmentFrameOutcome, WorkerServices

ENV_MEMORY_CEILING_MIB: Final = "FRAMEPILOT_SMART_MASK_MEMORY_CEILING_MIB"
ENV_MATTING_TILE: Final = "FRAMEPILOT_SMART_MASK_MATTING_TILE"
ENV_THREADS: Final = "FRAMEPILOT_SMART_MASK_THREADS"
ENV_CACHE_DIR: Final = "FRAMEPILOT_CAPABILITY_PACK_CACHE"
DEFAULT_MEMORY_CEILING_MIB: Final = 8192


def verified_model_digests(cache: DigestCache | None = None) -> dict[str, str]:
    """Verify every SAM file and every installed BiRefNet tile; at least one tile must exist."""
    directory = models_directory()
    digests = DigestCache() if cache is None else cache
    tiles = installed_tiles(directory)
    if not tiles:
        raise ModelUnavailableError("no BiRefNet_HR-matting tile graph is installed.")
    verified: dict[str, str] = {}
    for model in PINNED_MODELS:
        if model.tile is not None and model.tile not in tiles:
            continue
        digests.resolve(model.id, directory)
        verified[model.file] = model.sha256
    return verified


def probe_health() -> HealthFacts:
    try:
        import onnxruntime
    except ImportError as error:  # pragma: no cover - the pack always installs the cv extra
        raise BackendUnavailableError("onnxruntime is not installed in this pack.") from error
    from .media import verify_tools

    # Refuses a GPL/nonfree ffmpeg inside a pack (plan 02: LGPL-only FFmpeg).
    verify_tools()
    return HealthFacts(
        backend_label=f"onnxruntime-{onnxruntime.__version__}",
        model_digests=verified_model_digests(),
    )


def _int(environment: Mapping[str, str], name: str) -> int | None:
    raw = environment.get(name, "")
    try:
        return int(raw) if raw else None
    except ValueError:
        return None


def pipeline_config(environment: Mapping[str, str] | None = None) -> Any:
    from .pipeline import GIB, PipelineConfig

    env = os.environ if environment is None else environment
    ceiling_mib = _int(env, ENV_MEMORY_CEILING_MIB) or DEFAULT_MEMORY_CEILING_MIB
    return PipelineConfig(
        memory_ceiling_bytes=ceiling_mib * 1024 * 1024,
        matting_tile=_int(env, ENV_MATTING_TILE),
        embedding_ram_bytes=min(ceiling_mib * 1024 * 1024 // 16, GIB),
    )


class PackServices:
    """The real :class:`WorkerServices`."""

    def __init__(self, environment: Mapping[str, str] | None = None) -> None:
        from .media import FfmpegTools, verify_tools
        from .onnx_backend import OnnxModelProvider

        env = os.environ if environment is None else environment
        ffmpeg, ffprobe, report = verify_tools(env)
        self.tools = FfmpegTools(ffmpeg, ffprobe, report)
        self.config = pipeline_config(env)
        cache = env.get(ENV_CACHE_DIR, "")
        from pathlib import Path

        self._interactive: Any = None
        self.provider = OnnxModelProvider(
            models_directory(env),
            compiled_cache=Path(cache) if cache else None,
            intra_op_threads=_int(env, ENV_THREADS) or 0,
        )

    @property
    def backend_label(self) -> str:
        return self.provider.backend_label

    @property
    def model_digests(self) -> dict[str, str]:
        return self.provider.model_digests

    def run_matte(
        self, request: MatteRequest, progress: ProgressSink, cancellation: CancellationFlag
    ) -> MatteOutcome:
        from .memory import MemoryGovernor
        from .pipeline import MatteJob, ToolPaths

        report = asdict(self.tools.report)
        with MemoryGovernor(self.config.memory_ceiling_bytes, cancellation) as governor:

            def on_window(frames: int | None) -> None:
                if frames is None:
                    governor.window_finished()
                else:
                    governor.window_started(frames)

            job = MatteJob(
                request,
                provider=self.provider,
                media=self.tools,
                tools=ToolPaths(str(self.tools.ffmpeg), str(self.tools.ffprobe), report),
                config=self.config,
                progress=progress,
                cancellation=cancellation,
                memory_probe=governor.report,
                on_window=on_window,
            )
            return job.run()

    def segment_frame(
        self, request: SegmentFrameRequest, cancellation: CancellationFlag
    ) -> SegmentFrameOutcome:
        raise BackendUnavailableError("interactive segmentation is not available in this build.")


def create_services() -> WorkerServices:
    return PackServices()
