"""Per-asset preparation outcomes, persisted.

WHY this module exists: ``VisualIndexItem`` — the record of what happened to one asset
and why — was computed, returned once over HTTP, and dropped. The only surviving trace
was a ``_log.warning`` in a sidecar process the user never sees, gone at restart.

The consequence was visible in a real project: ``project_new_proj_mtbeyu802xjq`` holds
**55 assets, about 100 ``visual-index`` jobs all ``state='done'``, and zero visual spans
and zero hosted mappings**. Every job completed having prepared nothing, the project is
silently unsearchable, and the reason no longer exists anywhere.

Storage reuses what exists (no schema change): an ``analysis_results`` row per asset,
``kind='visual:outcome'``, ``params_hash`` = the asset's content hash. That gives the
same invalidation discipline the ``tl:video`` and ``tl:map`` rows already have — changed
bytes are automatically a miss, and nothing accumulates.
"""

from __future__ import annotations

import logging

from framepilot_engine.brain.store import BrainStore

_log = logging.getLogger(__name__)

__all__ = [
    "VISUAL_OUTCOME_KIND",
    "VISUAL_OUTCOME_TOOL",
    "AssetOutcomeRecord",
    "failed_outcomes",
    "record_asset_outcome",
]

#: ``analysis_results.kind`` for one asset's preparation outcome.
VISUAL_OUTCOME_KIND = "visual:outcome"
#: Tool/actor label recorded on the row.
VISUAL_OUTCOME_TOOL = "visual-index"


class AssetOutcomeRecord:
    """One asset's last preparation outcome, as persisted."""

    __slots__ = ("asset_id", "ok", "reason")

    def __init__(self, asset_id: str, *, ok: bool, reason: str | None) -> None:
        self.asset_id = asset_id
        self.ok = ok
        self.reason = reason

    def __repr__(self) -> str:
        return f"AssetOutcomeRecord({self.asset_id!r}, ok={self.ok}, reason={self.reason!r})"


def record_asset_outcome(
    store: BrainStore,
    asset_id: str,
    *,
    content_hash: str,
    ok: bool,
    reason: str | None,
    indexed: int = 0,
    captioned: int = 0,
) -> None:
    """Persist what happened to one asset, keyed by the bytes it happened to."""
    store.record_analysis(
        asset_id,
        kind=VISUAL_OUTCOME_KIND,
        depth="",
        params_hash=content_hash,
        result={
            "ok": ok,
            "reason": reason,
            "indexed": indexed,
            "captioned": captioned,
        },
        tool=VISUAL_OUTCOME_TOOL,
    )


def failed_outcomes(store: BrainStore) -> list[AssetOutcomeRecord]:
    """Assets whose LAST preparation attempt failed, for their current bytes.

    An outcome recorded against different bytes is stale by construction (the
    ``params_hash`` is the content hash), so a re-imported or re-encoded asset never
    carries an old failure forward. Sorted by asset id so the surface that renders it
    is stable between polls.
    """
    current: dict[str, str] = {
        asset.id: asset.content_sha256 for asset in store.list_assets() if asset.content_sha256
    }
    failures: list[AssetOutcomeRecord] = []
    for row in store.list_analysis(kind=VISUAL_OUTCOME_KIND):
        if current.get(row.asset_id) != row.params_hash:
            continue
        if row.result.get("ok") is True:
            continue
        reason = row.result.get("reason")
        failures.append(
            AssetOutcomeRecord(
                row.asset_id, ok=False, reason=str(reason) if isinstance(reason, str) else None
            )
        )
    return sorted(failures, key=lambda record: record.asset_id)
