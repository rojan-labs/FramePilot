"""Asset indexing with sandboxed path resolution (plan 2.1).

WHY: before a render can prepare assets (PRD §9.3 ``preparing_assets``) or the
patch validator can assert "no missing asset" (plan 1.4), the engine must turn
each project asset's *declared* path into a real, **sandboxed** filesystem path
and report whether it exists. Every declared path is resolved through
:func:`framepilot_engine.safety.resolve_within`, so an asset referencing
``../../etc/passwd`` is flagged as escaping the sandbox rather than read (PRD
§18.1). Probing each asset's media info is optional because it is the expensive
part (it shells out to ffprobe per file).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from framepilot_engine.media.ffmpeg import Runner
from framepilot_engine.media.probe import MediaInfo, inspect_media
from framepilot_engine.safety import PathTraversalError, resolve_within


class AssetEntry(BaseModel):
    """The resolution status of a single project asset."""

    asset_id: str
    declared_path: str = Field(description="The path as written in the project file.")
    resolved_path: str | None = Field(
        default=None, description="Sandbox-resolved absolute path; None if it escaped."
    )
    kind: str | None = None
    within_sandbox: bool = Field(description="False if the declared path escaped the base dir.")
    exists: bool = False
    media: MediaInfo | None = Field(default=None, description="Set only when probe=True.")
    error: str | None = Field(default=None, description="Why the asset is unusable, if so.")

    @property
    def ok(self) -> bool:
        """True if the asset is inside the sandbox and present on disk."""
        return self.within_sandbox and self.exists


class AssetIndex(BaseModel):
    """The resolved status of every asset referenced by a project."""

    base_dir: str
    entries: list[AssetEntry] = Field(default_factory=list)

    def by_id(self, asset_id: str) -> AssetEntry | None:
        """Return the entry for ``asset_id`` (first match) or ``None``."""
        return next((e for e in self.entries if e.asset_id == asset_id), None)

    @property
    def missing(self) -> list[AssetEntry]:
        """Entries that are unusable — escaped the sandbox or absent on disk."""
        return [e for e in self.entries if not e.ok]

    @property
    def ok(self) -> bool:
        """True only if every asset resolved inside the sandbox and exists."""
        return all(e.ok for e in self.entries)


def index_assets(
    assets: Sequence[Mapping[str, Any]],
    base_dir: Path,
    *,
    probe: bool = False,
    runner: Runner | None = None,
) -> AssetIndex:
    """Resolve and (optionally) probe every asset, sandboxed to ``base_dir``.

    :param assets: The project's ``assets`` list (each a mapping with at least
        ``id`` and ``path``; ``kind`` is read if present).
    :param base_dir: The project directory the assets must stay within.
    :param probe: When True, run :func:`inspect_media` on each existing asset.
    :param runner: ffprobe invoker forwarded to :func:`inspect_media` (tests).
    :returns: An :class:`AssetIndex` describing every asset's status.
    """
    entries: list[AssetEntry] = []
    for asset in assets:
        asset_id = str(asset.get("id", ""))
        declared = str(asset.get("path", ""))
        kind = asset.get("kind")

        try:
            resolved = resolve_within(base_dir, declared)
        except PathTraversalError as exc:
            entries.append(
                AssetEntry(
                    asset_id=asset_id,
                    declared_path=declared,
                    kind=kind,
                    within_sandbox=False,
                    exists=False,
                    error=str(exc),
                )
            )
            continue

        exists = resolved.is_file()
        media = inspect_media(resolved, runner=runner) if (probe and exists) else None
        entries.append(
            AssetEntry(
                asset_id=asset_id,
                declared_path=declared,
                resolved_path=str(resolved),
                kind=kind,
                within_sandbox=True,
                exists=exists,
                media=media,
                error=None if exists else "Asset file does not exist.",
            )
        )

    return AssetIndex(base_dir=str(base_dir.resolve()), entries=entries)
