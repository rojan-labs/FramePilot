"""Depth-tiered analysis vocabulary for the unified ``POST /analyze`` route (plan B1.2).

WHY: callers (the agent loop, MCP clients, the session-warmup job) should ask
for "a quick pass" or "the deep pass" instead of hand-picking analyzer routes,
and every analyzer's identity/version/parameters must hash into the stable
cache key the brain persists results under (plan B1.3).

This module is pure and deterministic (100%-coverage core): it owns the kind/
depth vocabulary, the depth → kinds expansion, and the cache-key hashing. The
IO orchestration (resolving media, invoking ffmpeg/whisper) lives in the
sidecar route.
"""

from __future__ import annotations

import hashlib
import json
from enum import StrEnum
from typing import Any

__all__ = [
    "ANALYZER_VERSIONS",
    "DEPTH_KINDS",
    "AnalysisDepth",
    "AnalysisKind",
    "analysis_params_hash",
    "kinds_for",
]


class AnalysisKind(StrEnum):
    """One deterministic analyzer the substrate can run over an asset."""

    PROBE = "probe"
    SILENCE = "silence"
    SCENES = "scenes"
    LOUDNESS = "loudness"
    BLACK = "black"
    BEATS = "beats"
    FREEZE = "freeze"
    TRANSCRIPTION = "transcription"


class AnalysisDepth(StrEnum):
    """How much analysis to run (davinci-style quick/standard/deep tiers)."""

    QUICK = "quick"
    STANDARD = "standard"
    DEEP = "deep"


#: What each tier runs (plan B1.2). Deep supersets standard supersets quick, so
#: a deeper pass never loses what a shallower one would have learned.
DEPTH_KINDS: dict[AnalysisDepth, tuple[AnalysisKind, ...]] = {
    AnalysisDepth.QUICK: (AnalysisKind.PROBE, AnalysisKind.SILENCE),
    AnalysisDepth.STANDARD: (
        AnalysisKind.PROBE,
        AnalysisKind.SILENCE,
        AnalysisKind.SCENES,
        AnalysisKind.LOUDNESS,
        AnalysisKind.BLACK,
    ),
    AnalysisDepth.DEEP: (
        AnalysisKind.PROBE,
        AnalysisKind.SILENCE,
        AnalysisKind.SCENES,
        AnalysisKind.LOUDNESS,
        AnalysisKind.BLACK,
        AnalysisKind.BEATS,
        AnalysisKind.FREEZE,
        AnalysisKind.TRANSCRIPTION,
    ),
}

#: Bump an analyzer's version whenever its output shape or detection behaviour
#: changes — the version participates in the cache key (plan B1.3), so a bump
#: invalidates stale cached results instead of silently serving them.
ANALYZER_VERSIONS: dict[AnalysisKind, int] = {kind: 1 for kind in AnalysisKind}


def kinds_for(
    depth: AnalysisDepth, kinds: list[AnalysisKind] | None = None
) -> tuple[AnalysisKind, ...]:
    """The analyzers one ``/analyze`` call should run.

    An explicit ``kinds`` list wins over the tier expansion (the caller knows
    exactly what it wants); duplicates are dropped preserving first-seen order.

    :param depth: The requested tier; used when ``kinds`` is not given.
    :param kinds: Optional explicit analyzer selection.
    :returns: The analyzers to run, in execution order.
    """
    if kinds:
        return tuple(dict.fromkeys(kinds))
    return DEPTH_KINDS[depth]


def analysis_params_hash(
    kind: AnalysisKind,
    params: dict[str, Any],
    *,
    content_sha256: str | None,
) -> str:
    """The stable cache key component for one analysis run (plan B1.3).

    Hashes the analyzer id + version + its effective parameters + the source
    content hash, so any of those changing produces a different key: re-running
    with identical inputs is a cache hit, while a re-encoded source file or a
    parser upgrade honestly invalidates. Canonical JSON keeps the digest
    byte-stable across processes.

    :param kind: The analyzer.
    :param params: The analyzer's *effective* parameters (defaults applied).
    :param content_sha256: The source file's content hash (``None`` when the
        caller could not hash — such results are stored but never trusted as
        cache hits for a different file).
    :returns: A hex SHA256 digest.
    """
    payload = {
        "kind": str(kind),
        "analyzerVersion": ANALYZER_VERSIONS[kind],
        "params": params,
        "contentSha256": content_sha256,
    }
    canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
