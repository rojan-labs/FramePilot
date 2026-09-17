"""Pinned model files, their verification, and the (model, execution provider) allow list.

Weights are the part of this pack that is *data*, and data is the easiest thing to swap
without anyone noticing. The digests below are compiled into the signed wheel rather than
read from a file beside the weights, and every model is hashed before it is loaded. A file
that does not match its pin is refused with ``model_unavailable``.

``pack/models.lock.toml`` is the human-readable record of the same pins (sources, export
tool, licences); ``tests/test_models_and_manifest.py`` fails if the two disagree.

**Execution providers are enabled by evidence, not by availability** (ADR 0179 §4). A
(model, EP) pair is allowed only if it passed the parity gate against the PyTorch reference
(SAM: per-frame IoU ≥ 0.999; BiRefNet: band mean |Δα| ≤ 1/255, max ≤ 4/255). A pair that
failed, did not build, did not fit the memory budget or was never measured is disabled, and
the chain moves on, ending at CPU. The initial table is BR0-FINDINGS §BR0.2.
"""

from __future__ import annotations

import hashlib
import os
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Literal

from .backend import ModelUnavailableError

#: Installer-provided root of the unpacked pack. Models live in `<root>/models`.
ENV_PACK_ROOT: Final = "FRAMEPILOT_CAPABILITY_PACK_ROOT"
#: Developer override: a directory holding the model files (e.g. the git-ignored .cache/onnx).
ENV_MODELS_DIR: Final = "FRAMEPILOT_SMART_MASK_MODELS_DIR"
_HASH_CHUNK: Final = 1024 * 1024
#: The sentinel a not-yet-exported file carries. Not a reachable sha256 of any file.
UNPINNED_DIGEST: Final = "0" * 64

ModelFamily = Literal["sam", "birefnet"]
ProviderName = Literal["coreml", "directml", "winml", "cpu"]


@dataclass(frozen=True, slots=True)
class PinnedModel:
    id: str
    family: ModelFamily
    file: str
    sha256: str
    bytes: int
    license: str
    #: BiRefNet only: the static square tile this graph was exported at.
    tile: int | None = None

    @property
    def pinned(self) -> bool:
        return self.sha256 != UNPINNED_DIGEST


PINNED_MODELS: Final = (
    PinnedModel(
        id="sam_image_encoder",
        family="sam",
        file="sam21l_image_encoder.fp32.onnx",
        sha256="320ed56abe3142d383aecf5f55aeea7b76cf60fb7e7ffe10ca654b834d695e86",
        bytes=852_442_220,
        license="Apache-2.0",
    ),
    PinnedModel(
        id="sam_decoder_multi_n1",
        family="sam",
        file="sam21l_decoder_multi_n1.fp32.onnx",
        sha256="e2dde51052f71db13bc8a247b9012c03537b783835a2d3b692328f0265be7c0c",
        bytes=17_738_335,
        license="Apache-2.0",
    ),
    PinnedModel(
        id="sam_decoder_points",
        family="sam",
        file="sam21l_decoder_points.fp32.onnx",
        sha256=UNPINNED_DIGEST,
        bytes=0,
        license="Apache-2.0",
    ),
    PinnedModel(
        id="sam_decoder_mask",
        family="sam",
        file="sam21l_decoder_mask.fp32.onnx",
        sha256=UNPINNED_DIGEST,
        bytes=0,
        license="Apache-2.0",
    ),
    PinnedModel(
        id="sam_memory_attention",
        family="sam",
        file="sam21l_memory_attention.fp32.onnx",
        sha256="e5d6c81df8fb2005f2b2a95dacff181ce00231dd666baba43b0a04226ba48960",
        bytes=28_008_575,
        license="Apache-2.0",
    ),
    PinnedModel(
        id="sam_memory_encoder",
        family="sam",
        file="sam21l_memory_encoder.fp32.onnx",
        sha256="c2b48f90b9970d06f313ac6fdf0b427573decde1b3e81483caccf76fe26cf0f3",
        bytes=5_582_325,
        license="Apache-2.0",
    ),
    PinnedModel(
        id="sam_constants",
        family="sam",
        file="sam21l_constants.npz",
        sha256=UNPINNED_DIGEST,
        bytes=0,
        license="Apache-2.0",
    ),
    PinnedModel(
        id="birefnet_768",
        family="birefnet",
        file="birefnet_hr_matting_768.fp16s.onnx",
        sha256="37738f15337ff1c11cdf49cdcfdc9e4d57b91a4c3a8f911582c1597bf1f38ef4",
        bytes=448_273_052,
        license="MIT",
        tile=768,
    ),
    PinnedModel(
        id="birefnet_1024",
        family="birefnet",
        file="birefnet_hr_matting_1024.fp16s.onnx",
        sha256="ea5d48fc2e6795e317b351caa3da164a2b6a8c85231193c34d7ebbefb58ab41d",
        bytes=449_002_377,
        license="MIT",
        tile=1024,
    ),
    PinnedModel(
        id="birefnet_2048",
        family="birefnet",
        file="birefnet_hr_matting_2048.fp16s.onnx",
        sha256="b6c710045302a90f0e5c87a65a42768a9bbaa3394d80a5167cfe459e54a4d3b5",
        bytes=449_580_627,
        license="MIT",
        tile=2048,
    ),
)

MODELS_BY_ID: Final = {model.id: model for model in PINNED_MODELS}
SAM_MODEL_IDS: Final = tuple(model.id for model in PINNED_MODELS if model.family == "sam")


@dataclass(frozen=True, slots=True)
class ParityVerdict:
    enabled: bool
    evidence: str


#: (family, provider) → verdict. Anything not listed is disabled ("not measured").
PARITY_TABLE: Final[dict[tuple[ModelFamily, ProviderName], ParityVerdict]] = {
    ("sam", "cpu"): ParityVerdict(True, "BR0.2: fp32 min per-frame IoU 0.99954 (gate 0.999)"),
    ("sam", "coreml"): ParityVerdict(
        False, "BR0.2: decoder does not build; memory attention 8.4 GB footprint; slower than CPU"
    ),
    ("sam", "directml"): ParityVerdict(False, "not measured: MO-9 (no Windows GPU machine)"),
    ("sam", "winml"): ParityVerdict(False, "not measured: MO-9 (no Windows GPU machine)"),
    ("birefnet", "cpu"): ParityVerdict(
        True, "BR0.2: fp16-stored band mean 0.0047/255, max 0.108/255 at 768²"
    ),
    ("birefnet", "coreml"): ParityVerdict(
        False, "BR0.2: session build exceeded the memory budget at 768²"
    ),
    ("birefnet", "directml"): ParityVerdict(False, "not measured: MO-9 (no Windows GPU machine)"),
    ("birefnet", "winml"): ParityVerdict(False, "not measured: MO-9 (no Windows GPU machine)"),
}

#: onnxruntime provider names per logical provider.
ORT_PROVIDER_NAMES: Final[dict[ProviderName, str]] = {
    "coreml": "CoreMLExecutionProvider",
    "directml": "DmlExecutionProvider",
    # Windows ML registers vendor EPs dynamically; any of these counts as "winml".
    "winml": "WinMLExecutionProvider",
    "cpu": "CPUExecutionProvider",
}


def provider_chain(
    platform: str = sys.platform, windows_build: int | None = None
) -> tuple[ProviderName, ...]:
    """The decided preference order per OS (plan 02 Runtime), always ending at CPU."""
    if platform == "darwin":
        return ("coreml", "cpu")
    if platform == "win32":
        # Windows ML needs Windows 11 24H2 (build 26100) or later.
        if windows_build is not None and windows_build >= 26100:
            return ("winml", "directml", "cpu")
        return ("directml", "cpu")
    return ("cpu",)


def select_provider(
    family: ModelFamily,
    available: tuple[str, ...],
    chain: tuple[ProviderName, ...],
    table: Mapping[tuple[ModelFamily, ProviderName], ParityVerdict] = PARITY_TABLE,
) -> tuple[ProviderName, list[dict[str, str]]]:
    """First provider in ``chain`` that is available AND parity-enabled for ``family``.

    Returns the choice plus one record per provider skipped and why, for report.json.
    """
    skipped: list[dict[str, str]] = []
    for provider in chain:
        if provider != "cpu" and ORT_PROVIDER_NAMES[provider] not in available:
            skipped.append({"provider": provider, "reason": "not available in this runtime"})
            continue
        verdict = table.get((family, provider), ParityVerdict(False, "not measured"))
        if not verdict.enabled:
            skipped.append(
                {"provider": provider, "reason": f"disabled by parity rule: {verdict.evidence}"}
            )
            continue
        return provider, skipped
    return "cpu", skipped


def result_provider(provider: ProviderName) -> Literal["coreml", "directml", "cpu"]:
    """The protocol enum has no ``winml``: Windows ML dispatches through DirectML-class EPs."""
    return "directml" if provider == "winml" else provider


def file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(_HASH_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def models_directory(environment: Mapping[str, str] | None = None) -> Path:
    """Where the installer unpacked the weights (or a developer's override)."""
    env = os.environ if environment is None else environment
    override = env.get(ENV_MODELS_DIR, "")
    if override:
        return Path(override)
    root = env.get(ENV_PACK_ROOT, "")
    if root:
        return Path(root) / "models"
    return Path(__file__).resolve().parent.parent.parent / "models"


class DigestCache:
    """Hashes each pinned file once per process (the image encoder is 813 MiB)."""

    def __init__(self) -> None:
        self._verified: dict[Path, tuple[int, int, str]] = {}

    def resolve(self, model_id: str, directory: Path) -> Path:
        """Return the verified path to one pinned model, or refuse.

        :raises ModelUnavailableError: Unknown id, placeholder pin, missing file, wrong digest.
        """
        pinned = MODELS_BY_ID.get(model_id)
        if pinned is None:
            raise ModelUnavailableError(f"'{model_id}' is not a model of this pack.")
        if not pinned.pinned:
            raise ModelUnavailableError(
                f"model '{pinned.file}' has no approved digest yet; export it with "
                "tools/export_onnx.py and record its sha256 in models.py and pack/models.lock.toml."
            )
        path = directory / pinned.file
        if not path.is_file():
            raise ModelUnavailableError(f"pinned model '{pinned.file}' is not installed.")
        info = path.stat()
        cached = self._verified.get(path)
        if cached is not None and cached[:2] == (info.st_size, info.st_mtime_ns):
            actual = cached[2]
        else:
            actual = file_digest(path)
            self._verified[path] = (info.st_size, info.st_mtime_ns, actual)
        if actual != pinned.sha256:
            raise ModelUnavailableError(
                f"pinned model '{pinned.file}' does not hash to its approved digest; "
                "refusing to load it."
            )
        return path


def installed_tiles(directory: Path) -> tuple[int, ...]:
    """BiRefNet tile sizes whose graph file is present (verified later, at load)."""
    return tuple(
        sorted(
            model.tile
            for model in PINNED_MODELS
            if model.tile is not None and (directory / model.file).is_file()
        )
    )


__all__ = [
    "ENV_MODELS_DIR",
    "ENV_PACK_ROOT",
    "MODELS_BY_ID",
    "PARITY_TABLE",
    "PINNED_MODELS",
    "SAM_MODEL_IDS",
    "UNPINNED_DIGEST",
    "DigestCache",
    "ParityVerdict",
    "PinnedModel",
    "file_digest",
    "installed_tiles",
    "models_directory",
    "provider_chain",
    "result_provider",
    "select_provider",
]
