"""Composition root: the real models, media tools and pipeline behind :class:`WorkerServices`.

Imported lazily by ``__main__`` so a protocol refusal never loads numpy or onnxruntime.
"""

from __future__ import annotations

from .backend import BackendUnavailableError, ModelUnavailableError
from .identity import HealthFacts
from .models import PINNED_MODELS, DigestCache, installed_tiles, models_directory
from .runtime import WorkerServices


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


def create_services() -> WorkerServices:
    raise BackendUnavailableError("the Smart Mask pipeline is not assembled in this build.")
