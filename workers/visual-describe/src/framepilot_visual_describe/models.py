"""Pinned model/runtime files and their verification.

Weights and native binaries are the part of this pack that is *data*, and data is the
easiest thing to swap without anyone noticing. So the digests below are compiled into the
signed wheel rather than read from a file sitting next to them, and every artifact is
hashed before it is loaded. One that does not match its pin is refused with
``model_unavailable`` — the pack declines to run rather than describe a customer's footage
with something nobody approved.

``pack/models.lock.toml`` is the human-readable record of the same pins, and a unit test
fails if the two ever disagree.

**Every digest below is a PLACEHOLDER.** Nothing has been fetched: this pack was built
without downloading a weight or a binary, on purpose, so the machinery could be reviewed
before ~1.6 GiB of binaries entered the picture. A placeholder is stored as the sentinel
:data:`UNPINNED_DIGEST` and :func:`resolve_model` refuses it explicitly, with the reason
spelled out — a pack whose pins are unknown must fail loudly, never fall through to "hash
matched" by accident. The one mechanical step that makes this pack live is replacing every
sentinel here and in ``pack/models.lock.toml`` with the real digest of the fetched file.

WHY THE RUNTIME BINARY IS PINNED HERE TOO: ``llama-mtmd-cli`` is executed as a subprocess
on the user's machine, over their footage. It is a larger trust decision than the weights
it loads, so it is pinned and hashed by exactly the same rule rather than being trusted
because it happened to be in the artifact.
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
#: Bytes read per hashing chunk; a 1.5 GiB model is never loaded into memory twice.
_HASH_CHUNK: Final = 1024 * 1024

#: The sentinel a not-yet-fetched artifact carries. Sixty-four zeros is not a reachable
#: sha256 of any file, so it can never collide with a real digest.
UNPINNED_DIGEST: Final = "0" * 64


@dataclass(frozen=True, slots=True)
class PinnedModel:
    id: str
    file: str
    sha256: str
    license: str
    #: Whether the file must be executable. The runtime binary is; a weight never is.
    executable: bool = False

    @property
    def pinned(self) -> bool:
        return self.sha256 != UNPINNED_DIGEST


PINNED_MODELS: Final = (
    PinnedModel(
        id="runtime",
        file="llama-mtmd-cli",
        sha256=UNPINNED_DIGEST,
        license="MIT",
        executable=True,
    ),
    PinnedModel(
        id="vlm",
        file="SmolVLM2-2.2B-Instruct-Q4_K_M.gguf",
        sha256=UNPINNED_DIGEST,
        license="Apache-2.0",
    ),
    PinnedModel(
        id="mmproj",
        file="mmproj-SmolVLM2-2.2B-Instruct-f16.gguf",
        sha256=UNPINNED_DIGEST,
        license="Apache-2.0",
    ),
    PinnedModel(
        id="vlm-small",
        file="SmolVLM2-500M-Video-Instruct-Q8_0.gguf",
        sha256=UNPINNED_DIGEST,
        license="Apache-2.0",
    ),
    PinnedModel(
        id="mmproj-small",
        file="mmproj-SmolVLM2-500M-Video-Instruct-f16.gguf",
        sha256=UNPINNED_DIGEST,
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
    """Where the installer unpacked the weights and the runtime binary.

    Falls back to a ``models/`` directory beside the source tree so a developer can run the
    real backend from a checkout without an installed pack.
    """
    env = os.environ if environment is None else environment
    root = env.get(ENV_PACK_ROOT, "")
    if root:
        return Path(root) / "models"
    return Path(__file__).resolve().parent.parent.parent / "models"


def resolve_model(model_id: str, directory: Path) -> Path:
    """Return the verified path to one pinned artifact, or refuse.

    :raises ModelUnavailableError: If the id is unknown, the pin is still a placeholder,
        the file is missing, it is not executable when it must be, or its content does not
        hash to the approved digest.
    """
    try:
        pinned = MODELS_BY_ID[model_id]
    except KeyError as error:  # pragma: no cover - guarded by callers
        raise ModelUnavailableError(f"'{model_id}' is not an artifact of this pack.") from error
    if not pinned.pinned:
        raise ModelUnavailableError(
            f"artifact '{pinned.file}' has no approved digest yet (placeholder pin); "
            "fetch it and record its sha256 in models.py and pack/models.lock.toml "
            "before this pack may load it."
        )
    path = directory / pinned.file
    if not path.is_file():
        raise ModelUnavailableError(
            f"pinned artifact '{pinned.file}' is not installed at {directory}."
        )
    actual = file_digest(path)
    if actual != pinned.sha256:
        raise ModelUnavailableError(
            f"pinned artifact '{pinned.file}' hashes to {actual}, not its approved "
            f"{pinned.sha256}; refusing to load it."
        )
    if pinned.executable and not os.access(path, os.X_OK):
        raise ModelUnavailableError(
            f"pinned runtime '{pinned.file}' is not executable; refusing to run it."
        )
    return path


def verify_all(directory: Path) -> dict[str, str]:
    """Verify every pinned artifact and return the digest map for evidence lineage."""
    digests: dict[str, str] = {}
    for pinned in PINNED_MODELS:
        resolve_model(pinned.id, directory)
        digests[pinned.file] = pinned.sha256
    return digests
