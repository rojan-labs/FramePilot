"""Pinned model/runtime files and their verification.

Weights and native binaries are the part of this pack that is *data*, and data is the
easiest thing to swap without anyone noticing. So the digests below are compiled into the
signed wheel rather than read from a file sitting next to them, and every artifact is
hashed before it is loaded. One that does not match its pin is refused with
``model_unavailable`` — the pack declines to run rather than describe a customer's footage
with something nobody approved.

``pack/models.lock.toml`` is the human-readable record of the same pins, and a unit test
fails if the two ever disagree.

**Every digest below is real.** The artifacts were fetched and recorded on 2026-09-07
from the release and revisions pinned in ``pack/models.lock.toml``. The sentinel
:data:`UNPINNED_DIGEST` remains, and :func:`resolve_model` still refuses it explicitly
with the reason spelled out — a pack whose pins are unknown must fail loudly, never fall
through to "hash matched" by accident — but nothing carries it any more.

WHY THE RUNTIME BINARY IS PINNED HERE TOO: ``llama-mtmd-cli`` is executed as a subprocess
on the user's machine, over their footage. It is a larger trust decision than the weights
it loads, so it is pinned and hashed by exactly the same rule rather than being trusted
because it happened to be in the artifact.

WHY ITS NINE DYLIBS ARE PINNED AS WELL: the CLI is a 83 KiB shim. Every byte that
actually decodes a frame and runs the model lives in ``libmtmd``, ``libllama`` and the
``libggml-*`` family, which it loads out of its own directory (its only ``LC_RPATH`` is
``@loader_path``). Pinning the executable alone would hash the smallest and least
interesting part of the runtime and leave the rest swappable. They arrive inside one
release tarball that is itself pinned by a single digest, so the archive is approved as a
whole and each member is verified again on load.
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
        sha256="b61a6f2b996b6068f36399ac5b54503856071596aef5ff3e665d311ead7e7884",
        license="MIT",
        executable=True,
    ),
    PinnedModel(
        id="runtime-lib-mtmd",
        file="libmtmd.0.4.0.dylib",
        sha256="6e902b5676376c466dc4a1ed66a3b2c675589b47a5292581a3bc7cec895516fa",
        license="MIT",
    ),
    PinnedModel(
        id="runtime-lib-llama",
        file="libllama.0.4.0.dylib",
        sha256="5279dde6e366d797f31fe699985d089ee4dbbbd6d5fd33c02defbc7ede0a34fb",
        license="MIT",
    ),
    PinnedModel(
        id="runtime-lib-llama-common",
        file="libllama-common.0.4.0.dylib",
        sha256="773df6d3afacf1b93bab1a5cad0bc327f537bdee959e9906a794cb9403f0b6e9",
        license="MIT",
    ),
    PinnedModel(
        id="runtime-lib-ggml",
        file="libggml.0.23.0.dylib",
        sha256="98fa46f0bcd8c75a335f733c38cb79f911bc39412ba15ef52fee3ac051c14069",
        license="MIT",
    ),
    PinnedModel(
        id="runtime-lib-ggml-base",
        file="libggml-base.0.23.0.dylib",
        sha256="40a133d388655a8826b298e244a083fcfc4cc219f4b51018b19e6d8ebb64d42c",
        license="MIT",
    ),
    PinnedModel(
        id="runtime-lib-ggml-cpu",
        file="libggml-cpu.0.23.0.dylib",
        sha256="e63a7b4f8eaa5bbd8e93e524d1a828de22a42bead57ae79cfab46e2339571fb2",
        license="MIT",
    ),
    PinnedModel(
        id="runtime-lib-ggml-blas",
        file="libggml-blas.0.23.0.dylib",
        sha256="414856968dcddae3a67e0f9c6dc012e5c4db13320c4d7ea5924dc1ad192dcfd6",
        license="MIT",
    ),
    PinnedModel(
        id="runtime-lib-ggml-metal",
        file="libggml-metal.0.23.0.dylib",
        sha256="c23aa0bd992066b1bc81c2f4a58798fdc6b5384c1df9dba91812db72e95a1833",
        license="MIT",
    ),
    PinnedModel(
        id="runtime-lib-ggml-rpc",
        file="libggml-rpc.0.23.0.dylib",
        sha256="d998f743ae44021c8990a95765585d813bf161fcc8c7a527ed9f746e0f76d144",
        license="MIT",
    ),
    PinnedModel(
        id="vlm",
        file="SmolVLM2-2.2B-Instruct-Q4_K_M.gguf",
        sha256="0cf76814555b8665149075b74ab6b5c1d428ea1d3d01c1918c12012e8d7c9f58",
        license="Apache-2.0",
    ),
    PinnedModel(
        id="mmproj",
        file="mmproj-SmolVLM2-2.2B-Instruct-f16.gguf",
        sha256="db9a3a1648cab1ebc3af4a2b0c8145dd8faebf6f7dd7b16e7dc1842229f14ac4",
        license="Apache-2.0",
    ),
    PinnedModel(
        id="vlm-small",
        file="SmolVLM2-500M-Video-Instruct-Q8_0.gguf",
        sha256="6f67b8036b2469fcd71728702720c6b51aebd759b78137a8120733b4d66438bc",
        license="Apache-2.0",
    ),
    PinnedModel(
        id="mmproj-small",
        file="mmproj-SmolVLM2-500M-Video-Instruct-f16.gguf",
        sha256="b5dc8ebe7cbeab66a5369693960a52515d7824f13d4063ceca78431f2a6b59b0",
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
