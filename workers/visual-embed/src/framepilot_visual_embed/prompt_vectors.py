"""Text vectors for the prompt bank: computed once per bank version, then cached.

WHY A CACHE AT ALL: the bank is 43 short phrases, so the text tower costs a fraction of a
second — but it costs it on every worker process, and the host runs one process per
request. Caching turns a per-request cost into a per-install one.

WHY IT IS KEYED BY DIGEST AND NOT BY VERSION: a version number only invalidates what
somebody remembered to bump. The file name carries
:func:`~framepilot_visual_embed.prompt_bank.bank_digest`, so an edited phrase under an
unchanged version misses the cache instead of silently labelling against the old
sentences.

The cache directory is supplied by the installer through the environment and is OPTIONAL:
with no directory the vectors are computed in-process and nothing is written. A pack
artifact is immutable (ADR 0114), so the worker never writes inside its own root.
"""

from __future__ import annotations

import json
import os
from collections.abc import Sequence
from pathlib import Path
from typing import Final

from .backend import Vector, VisualEmbedBackend
from .prompt_bank import PROMPT_BANK_VERSION, all_prompts, bank_digest

#: Installer-provided WRITABLE directory for derived artifacts. Never inside the pack.
ENV_CACHE_DIR: Final = "FRAMEPILOT_CAPABILITY_PACK_CACHE"


def cache_path(directory: Path) -> Path:
    """Where this bank's vectors live inside ``directory``."""
    return directory / f"prompt-bank-v{PROMPT_BANK_VERSION}-{bank_digest()[:16]}.json"


def cache_directory(environment: dict[str, str] | None = None) -> Path | None:
    """The writable cache directory, or ``None`` when the host supplied none."""
    env = os.environ if environment is None else environment
    raw = env.get(ENV_CACHE_DIR, "")
    return Path(raw) if raw else None


def _read(path: Path, *, dim: int) -> list[list[float]] | None:
    """Load cached vectors, or ``None`` if they are absent or unusable.

    Every failure mode — missing file, truncated JSON, wrong phrase count, wrong
    dimension — returns ``None`` and recomputes. A cache is an optimisation, so a corrupt
    one must cost time and never correctness.
    """
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    vectors = payload.get("vectors") if isinstance(payload, dict) else None
    if not isinstance(vectors, list) or len(vectors) != len(all_prompts()):
        return None
    out: list[list[float]] = []
    for vector in vectors:
        if not isinstance(vector, list) or len(vector) != dim:
            return None
        out.append([float(value) for value in vector])
    return out


def load_or_compute(backend: VisualEmbedBackend, directory: Path | None = None) -> Sequence[Vector]:
    """The bank's text vectors, from cache when possible.

    :param backend: Used only on a miss.
    :param directory: Writable cache directory; ``None`` computes in-process every time.
    :returns: One vector per phrase, in :func:`all_prompts` order.
    """
    path = cache_path(directory) if directory is not None else None
    if path is not None:
        cached = _read(path, dim=backend.image_dim)
        if cached is not None:
            return cached
    vectors = [list(vector) for vector in backend.encode_texts(list(all_prompts()))]
    if len(vectors) != len(all_prompts()):
        raise ValueError("the text tower returned the wrong number of prompt vectors")
    if path is not None:
        _write(path, vectors)
    return vectors


def _write(path: Path, vectors: list[list[float]]) -> None:
    """Persist the vectors, treating any filesystem refusal as a cache miss next time.

    Written to a temporary sibling and renamed, so a killed worker never leaves a
    half-written cache that the next one would read as complete.
    """
    payload = {
        "promptBankVersion": PROMPT_BANK_VERSION,
        "bankDigest": bank_digest(),
        "vectors": vectors,
    }
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".partial")
        temporary.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
        temporary.replace(path)
    except OSError:
        return
