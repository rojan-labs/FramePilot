"""Per-asset JSON sidecar exports of brain rows (plan B0.3).

WHY: the brain is a derived SQLite cache; the sidecars are its **portable,
human-diffable export** kept in lockstep with the DB (the davinci-resolve-mcp
``analysis.json`` pattern). They make the brain rebuildable — delete
``brain.sqlite``, re-import the sidecars, and the store round-trips to
byte-identical exports (the determinism test in ``test_brain_sidecars.py``).

Layout: ``<brain dir>/sidecars/<assetId>/analysis.json`` — canonical JSON
(sorted keys, trailing newline), written atomically (temp + rename) like every
other persisted FramePilot file (PRD §18.3).

Scope: a sidecar carries the asset row, its analysis results, its
asset-entity provenance fields, and its registered frames. The append-only
``field_changelog`` is deliberately NOT exported — it is history, not state,
and rebuilding state never requires it. The visual-index tables (``visual_spans``
/ ``visual_vectors`` / ``visual_captions``, plan MI2.2) are likewise NOT
exported: they are rebuilt by **re-indexing** the source media, not restored
from a sidecar (plan MI7.2), so this hand-picked export set is left unchanged.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path

from pydantic import BaseModel, Field, ValidationError

from framepilot_engine.brain.models import AnalysisResultRow, AssetRow, FieldRow, FrameRow
from framepilot_engine.brain.store import BrainError, BrainStore
from framepilot_engine.safety import PathTraversalError, resolve_within

_log = logging.getLogger(__name__)

SIDECARS_DIRNAME = "sidecars"
SIDECAR_FILENAME = "analysis.json"
SIDECAR_SCHEMA_VERSION = 1

# Field writes attach to entities by type; only asset-scoped fields travel in a
# sidecar today (frame-scoped fields arrive with the vision protocol, B4).
_ASSET_ENTITY = "asset"


class AssetSidecar(BaseModel):
    """The on-disk shape of one ``analysis.json`` (versioned like every export)."""

    schema_version: int = Field(default=SIDECAR_SCHEMA_VERSION, alias="schemaVersion")
    asset: AssetRow
    analysis: list[AnalysisResultRow] = Field(default_factory=list)
    fields: list[FieldRow] = Field(default_factory=list)
    frames: list[FrameRow] = Field(default_factory=list)

    model_config = {"populate_by_name": True}


def sidecar_path(brain_dir: Path, asset_id: str) -> Path:
    """The sandbox-checked sidecar file path for one asset.

    ``asset_id`` originates from project documents / IPC callers and is
    untrusted as a path segment: :func:`resolve_within` rejects traversal.
    """
    return resolve_within(brain_dir, str(Path(SIDECARS_DIRNAME) / asset_id / SIDECAR_FILENAME))


def _canonical_document(sidecar: AssetSidecar) -> str:
    """Serialize a sidecar to canonical JSON text (deterministic bytes)."""
    payload = sidecar.model_dump(by_alias=True, mode="json")
    return json.dumps(payload, sort_keys=True, ensure_ascii=False, indent=2) + "\n"


def export_asset_sidecar(store: BrainStore, brain_dir: Path, asset_id: str) -> Path:
    """Export one asset's brain rows to its ``analysis.json`` (atomic write).

    Call after any brain write for the asset so DB and sidecar stay in
    lockstep (plan B0.3).

    :raises framepilot_engine.brain.store.BrainError: If the asset is unknown.
    """
    asset = store.get_asset(asset_id)
    if asset is None:
        raise BrainError(f"Cannot export sidecar: asset {asset_id!r} is not in the brain.")

    sidecar = AssetSidecar(
        asset=asset,
        analysis=store.list_analysis(asset_id),
        fields=store.list_fields(_ASSET_ENTITY, asset_id),
        frames=store.list_frames(asset_id),
    )
    target = sidecar_path(brain_dir, asset_id)
    target.parent.mkdir(parents=True, exist_ok=True)

    # Temp file in the same directory then atomic rename, so a crash mid-write
    # never leaves a truncated sidecar (same pattern as ProjectFile / ASR cache).
    fd, tmp_name = tempfile.mkstemp(dir=target.parent, prefix=f".{SIDECAR_FILENAME}.")
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(_canonical_document(sidecar))
        tmp_path.replace(target)
    finally:
        if tmp_path.exists():  # rename failed or write raised
            tmp_path.unlink()
    _log.debug("Exported brain sidecar for asset %s → %s", asset_id, target)
    return target


def export_all_sidecars(store: BrainStore, brain_dir: Path) -> list[Path]:
    """Export every asset's sidecar; returns the written paths in asset order."""
    return [export_asset_sidecar(store, brain_dir, asset.id) for asset in store.list_assets()]


def import_sidecars(store: BrainStore, brain_dir: Path) -> int:
    """Rebuild brain rows from the sidecar files under ``brain_dir`` (plan B0.3).

    Rows are restored VERBATIM (timestamps and provenance included, no
    changelog append) so a rebuilt brain re-exports byte-identical sidecars.
    Unreadable or invalid sidecar files are skipped with a warning — a rebuild
    salvages everything salvageable rather than failing wholesale.

    :returns: How many asset sidecars were imported.
    """
    sidecars_dir = brain_dir / SIDECARS_DIRNAME
    if not sidecars_dir.is_dir():
        return 0

    imported = 0
    for path in sorted(sidecars_dir.glob(f"*/{SIDECAR_FILENAME}")):
        try:
            resolve_within(brain_dir, str(path))  # symlinked entries must not escape
            document = json.loads(path.read_text(encoding="utf-8"))
            sidecar = AssetSidecar.model_validate(document)
        except (OSError, json.JSONDecodeError, ValidationError, PathTraversalError) as exc:
            _log.warning("Skipping invalid brain sidecar %s: %s", path, exc)
            continue
        if sidecar.schema_version > SIDECAR_SCHEMA_VERSION:
            _log.warning(
                "Skipping sidecar %s: schemaVersion %d is newer than this engine's %d.",
                path,
                sidecar.schema_version,
                SIDECAR_SCHEMA_VERSION,
            )
            continue
        store.restore_asset(sidecar.asset)
        for analysis in sidecar.analysis:
            store.restore_analysis(analysis)
        for field in sidecar.fields:
            store.restore_field(field)
        for frame in sidecar.frames:
            store.restore_frame(frame)
        imported += 1
    _log.debug("Imported %d brain sidecars from %s", imported, sidecars_dir)
    return imported
