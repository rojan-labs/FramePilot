"""First-run model preparation, cached across runs (plan 02 "Production requirements").

Execution-provider preparation — onnxruntime's graph optimisation on the CPU EP, CoreML's
MLProgram compilation (422 s cold for the image encoder in BR0.7) — is done once and stored in
the pack's cache directory (``FRAMEPILOT_CAPABILITY_PACK_CACHE``), keyed by

    sha256(model digest | execution provider | OS version | onnxruntime version | machine)

so a model update, an EP change, an OS upgrade or a runtime upgrade all prepare afresh, and
nothing else does. A cached CPU-EP graph carries a sidecar digest; a file that no longer
matches it is discarded and rebuilt, so a damaged cache costs time, never correctness.
Without a cache directory, preparation simply runs every time (and is reported as such).
"""

from __future__ import annotations

import hashlib
import json
import logging
import platform
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Final

_log = logging.getLogger(__name__)

SIDECAR_SUFFIX: Final = ".digest.json"


def os_version() -> str:
    return f"{platform.system()}-{platform.release()}-{platform.mac_ver()[0] or platform.version()}"


def cache_key(
    model_digest: str,
    provider: str,
    runtime_version: str,
    os_name: str | None = None,
    machine: str | None = None,
) -> str:
    parts = [
        model_digest,
        provider,
        os_name or os_version(),
        runtime_version,
        machine or platform.machine(),
    ]
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


def _digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass
class PrepareReport:
    hits: list[str] = field(default_factory=list)
    misses: list[str] = field(default_factory=list)
    uncached: list[str] = field(default_factory=list)
    discarded: list[str] = field(default_factory=list)

    def as_json(self) -> dict[str, Any]:
        return {
            "hits": self.hits,
            "misses": self.misses,
            "uncached": self.uncached,
            "discarded": self.discarded,
        }


class CompiledModelCache:
    def __init__(self, directory: Path | None, runtime_version: str) -> None:
        self.directory = directory
        self.runtime_version = runtime_version
        self.report = PrepareReport()

    def coreml_directory(self, name: str, model_digest: str) -> Path | None:
        if self.directory is None:
            self.report.uncached.append(name)
            return None
        target = self.directory / "coreml" / cache_key(model_digest, "coreml", self.runtime_version)
        (
            self.report.hits if target.is_dir() and any(target.iterdir()) else self.report.misses
        ).append(name)
        target.mkdir(parents=True, exist_ok=True)
        return target

    def cpu_graph(
        self,
        name: str,
        model_digest: str,
        source: Path,
        build: Callable[[Path | None], Any],
        load: Callable[[Path], Any],
    ) -> Any:
        """Return a session: from the cached optimised graph, or built (and saved) from source.

        ``build(save_to)`` creates a session from ``source``, saving its optimised graph to
        ``save_to`` when given; ``load(path)`` creates a session from a cached graph.
        """
        if self.directory is None:
            self.report.uncached.append(name)
            return build(None)
        folder = self.directory / "cpu"
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / f"{cache_key(model_digest, 'cpu', self.runtime_version)}.onnx"
        sidecar = target.with_name(target.name + SIDECAR_SUFFIX)
        if target.is_file() and sidecar.is_file():
            try:
                recorded = json.loads(sidecar.read_text(encoding="utf-8")).get("sha256")
            except (OSError, ValueError):
                recorded = None
            if recorded == _digest(target):
                self.report.hits.append(name)
                return load(target)
            self.report.discarded.append(name)
            target.unlink(missing_ok=True)
            sidecar.unlink(missing_ok=True)
        self.report.misses.append(name)
        temporary = target.with_name(target.name + ".partial")
        session = build(temporary)
        if temporary.is_file():
            temporary.replace(target)
            sidecar.write_text(
                json.dumps({"sha256": _digest(target), "source": source.name}), encoding="utf-8"
            )
        return session


__all__ = ["CompiledModelCache", "PrepareReport", "cache_key", "os_version"]
