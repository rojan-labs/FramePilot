"""Pinned model files and their verification.

Weights are the part of this pack that is *data*, and data is the easiest thing to swap
without anyone noticing. So the digests below are compiled into the signed wheel rather
than read from a file sitting next to the weights, and every model is hashed before it is
loaded. A weight file that does not match its pin is refused with ``model_unavailable`` —
the pack declines to run rather than embed with something nobody approved.

``pack/models.lock.toml`` is the human-readable record of the same pins, and a unit test
fails if the two ever disagree.

**Every digest below is real.** The weights were fetched and recorded on 2026-09-07 from
the revisions pinned in ``pack/models.lock.toml``. The sentinel :data:`UNPINNED_DIGEST`
remains, and :func:`resolve_model` still refuses it explicitly with the reason spelled
out — a pack whose pins are unknown must fail loudly, never fall through to "hash
matched" by accident — but nothing carries it any more. Re-pinning is
``tools/fetch_models.py --record`` followed by copying its digests here.

YuNet is worth a note: it hashed to the digest this file already carried, which is the
evidence that the fetch resolves the same bytes ``workers/subject-intelligence`` verified
at the same OpenCV Zoo commit.
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from .backend import ModelUnavailableError

#: Installer-provided root of the unpacked pack. Models live in `<root>/models`.
ENV_PACK_ROOT: Final = "FRAMEPILOT_CAPABILITY_PACK_ROOT"
#: Bytes read per hashing chunk; a 370 MiB model is never loaded into memory twice.
_HASH_CHUNK: Final = 1024 * 1024

#: The sentinel a not-yet-fetched weight carries. Sixty-four zeros is not a reachable
#: sha256 of any file, so it can never collide with a real digest.
UNPINNED_DIGEST: Final = "0" * 64


@dataclass(frozen=True, slots=True)
class PinnedModel:
    id: str
    file: str
    sha256: str
    license: str

    @property
    def pinned(self) -> bool:
        return self.sha256 != UNPINNED_DIGEST


PINNED_MODELS: Final = (
    PinnedModel(
        id="image",
        file="siglip2_base_patch16_224_vision.onnx",
        sha256="c0573e3f4140c3a7c4e9cc5912bd6b26a033b46a6a8e8af26cbea262b163bcad",
        license="Apache-2.0",
    ),
    PinnedModel(
        id="text",
        file="siglip2_base_patch16_224_text.onnx",
        sha256="baf12d941beabafafb14f7b4adb38dc15be18681b964a84410ec53d9d65e6293",
        license="Apache-2.0",
    ),
    PinnedModel(
        id="tokenizer",
        file="siglip2_tokenizer.json",
        sha256="cb9140fae3ac5122c972d37adf83e1248471a38147ad76f8215c8872c6fd8322",
        license="Apache-2.0",
    ),
    PinnedModel(
        id="face",
        file="face_detection_yunet_2023mar.onnx",
        sha256="8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
        license="MIT",
    ),
    PinnedModel(
        id="identity",
        file="face_recognition_sface_2021dec.onnx",
        sha256="0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
        license="Apache-2.0",
    ),
)

MODELS_BY_ID: Final = {model.id: model for model in PINNED_MODELS}


def file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(_HASH_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def models_directory(environment: dict[str, str] | None = None) -> Path:
    """Where the installer unpacked the weights.

    Falls back to a ``models/`` directory beside the source tree so a developer can run
    the real backend from a checkout without an installed pack.
    """
    env = os.environ if environment is None else environment
    root = env.get(ENV_PACK_ROOT, "")
    if root:
        return Path(root) / "models"
    return Path(__file__).resolve().parent.parent.parent / "models"


def resolve_model(model_id: str, directory: Path) -> Path:
    """Return the verified path to one pinned model, or refuse.

    :raises ModelUnavailableError: If the id is unknown, the pin is still a placeholder,
        the file is missing, or its content does not hash to the approved digest.
    """
    try:
        pinned = MODELS_BY_ID[model_id]
    except KeyError as error:  # pragma: no cover - guarded by callers
        raise ModelUnavailableError(f"'{model_id}' is not a model of this pack.") from error
    if not pinned.pinned:
        raise ModelUnavailableError(
            f"model '{pinned.file}' has no approved digest yet (placeholder pin); "
            "fetch the weight and record its sha256 in models.py and pack/models.lock.toml "
            "before this pack may load it."
        )
    path = directory / pinned.file
    if not path.is_file():
        raise ModelUnavailableError(
            f"pinned model '{pinned.file}' is not installed at {directory}."
        )
    actual = file_digest(path)
    if actual != pinned.sha256:
        raise ModelUnavailableError(
            f"pinned model '{pinned.file}' hashes to {actual}, not its approved "
            f"{pinned.sha256}; refusing to load it."
        )
    return path


def verify_all(directory: Path) -> dict[str, str]:
    """Verify every pinned model and return the digest map for evidence lineage."""
    digests: dict[str, str] = {}
    for pinned in PINNED_MODELS:
        resolve_model(pinned.id, directory)
        digests[pinned.file] = pinned.sha256
    return digests
