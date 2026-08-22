"""Route-side glue between the sidecar and the TwelveLabs backend.

WHY: :mod:`framepilot_engine.brain.twelvelabs` is a pure REST client. This module
is the thin, testable layer that the ``/brain/visual/*`` routes use when a
TwelveLabs key is active: it persists the project's TL ``index_id`` and each
asset's ``video_id`` in the **existing** brain tables (no schema change — plan
constraint), drives one asset's upload+index step within a paced slice, and maps
TwelveLabs search clips back onto the :class:`EvidencePacket` contract the
orchestrator already reads. Everything here is deterministic given an injected
clock/sleep, so the paced polling is golden-testable without the live API.

Storage (migration-free, decision: reuse what exists):

- **Index id** — one per project — is a provenance-guarded field row
  (``fields`` table) under entity ``twelvelabs``/``index``. The ``fields`` table
  has no asset foreign key, so a project-level value fits without a sentinel row.
- **Asset → video mapping** is an ``analysis_results`` row (``kind='tl:video'``)
  keyed by the asset. A fixed ``params_hash`` means a re-index of changed bytes
  overwrites the single row (the source ``content_hash`` lives in the result), so
  the mapping never accumulates stale duplicates.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Protocol

from framepilot_engine.brain.models import Provenance, TranscriptUtterance
from framepilot_engine.brain.store import BrainStore
from framepilot_engine.brain.twelvelabs import TaskStatus, TLChapter, TLClip, TLHighlight
from framepilot_engine.brain.visual_search import (
    EvidencePacket,
    SupportsClip,
    project_span_to_timeline,
    transcript_overlap,
)

_log = logging.getLogger(__name__)


class SupportsGetTask(Protocol):
    """The only slice of :class:`TwelveLabsClient` that :func:`poll_index_asset`
    needs — narrowed so tests can pass a fake without subclassing the real
    (``httpx``-backed) client."""

    def get_task(self, task_id: str) -> TaskStatus: ...


__all__ = [
    "TL_MAP_KIND",
    "TL_TOOL",
    "TL_VIDEO_KIND",
    "MappedChapter",
    "MappedHighlight",
    "TLIndexOutcome",
    "VideoMapping",
    "chapters_to_packets",
    "clips_to_packets",
    "map_pegasus_chapters",
    "map_pegasus_highlights",
    "poll_index_asset",
    "read_cached_pegasus",
    "read_index_id",
    "read_video_mapping",
    "store_cached_pegasus",
    "store_index_id",
    "store_video_mapping",
    "video_to_asset_map",
]

#: ``analysis_results.kind`` for the asset→video mapping row.
TL_VIDEO_KIND = "tl:video"
#: ``analysis_results.kind`` for a cached Pegasus footage map (one row per asset,
#: content-hash keyed so it is computed once per indexed video).
TL_MAP_KIND = "tl:map"
#: Constant ``params_hash`` so a re-index overwrites the single mapping row.
_TL_VIDEO_PARAMS = "v1"
#: Tool/actor label recorded on every TwelveLabs-derived row.
TL_TOOL = "twelvelabs"

#: ``fields`` entity for the project-level index id.
_TL_INDEX_ENTITY = "twelvelabs"
_TL_INDEX_ID = "index"
_TL_INDEX_FIELD = "id"

#: Paced polling of one indexing task within a single slice: check every
#: ``INTERVAL`` seconds up to ``BUDGET`` before yielding the slice back to the
#: caller (which re-posts to continue). Keeps each request well under the client
#: timeout while pacing task polling so we never hammer the API.
TL_POLL_INTERVAL_SECONDS = 3.0
TL_SLICE_POLL_BUDGET_SECONDS = 30.0

#: Human-readable "still working" reason surfaced while a task indexes.
INDEXING_REASON = "indexing"


@dataclass(frozen=True)
class VideoMapping:
    """One asset's TwelveLabs indexing state, as persisted in the brain."""

    task_id: str | None
    video_id: str | None
    status: str
    content_hash: str | None
    #: The id of the media we UPLOADED to TwelveLabs (``POST /assets``) — distinct
    #: from ``video_id`` (the indexed asset). Pegasus 1.5 generates from the uploaded
    #: asset, so the footage map needs this id; ``None`` for mappings written before
    #: it was persisted (the route recovers it from the index on demand).
    source_asset_id: str | None = None

    @property
    def ready(self) -> bool:
        """True when this asset is fully indexed and searchable."""
        return self.status == "ready" and self.video_id is not None


@dataclass(frozen=True)
class TLIndexOutcome:
    """Result of driving one asset's TwelveLabs index step in a slice.

    ``advanced`` tells the route whether to move the job cursor past this asset:
    True once the asset is terminal (ready or failed), False while it is still
    indexing (the slice is re-posted to keep polling). ``newly_indexed`` counts a
    just-completed asset (for the response's ``indexed`` total).
    """

    advanced: bool
    ok: bool
    newly_indexed: int
    status: str
    reason: str | None = None


# -- persistence ------------------------------------------------------------------


def read_index_id(store: BrainStore) -> str | None:
    """The project's TwelveLabs index id, or ``None`` if never created."""
    row = store.get_field(_TL_INDEX_ENTITY, _TL_INDEX_ID, _TL_INDEX_FIELD)
    return row.value if row is not None and isinstance(row.value, str) else None


def store_index_id(store: BrainStore, index_id: str) -> None:
    """Persist the project's TwelveLabs index id (one per project)."""
    store.write_field(
        _TL_INDEX_ENTITY,
        _TL_INDEX_ID,
        _TL_INDEX_FIELD,
        index_id,
        source=Provenance.MACHINE,
        actor=TL_TOOL,
    )


def read_video_mapping(store: BrainStore, asset_id: str) -> VideoMapping | None:
    """Read one asset's persisted TwelveLabs mapping, or ``None``."""
    rows = store.list_analysis(asset_id, kind=TL_VIDEO_KIND)
    if not rows:
        return None
    result = rows[-1].result
    return VideoMapping(
        task_id=_str_or_none(result.get("taskId")),
        video_id=_str_or_none(result.get("videoId")),
        status=str(result.get("status") or "unknown"),
        content_hash=_str_or_none(result.get("contentHash")),
        source_asset_id=_str_or_none(result.get("sourceAssetId")),
    )


def store_video_mapping(
    store: BrainStore,
    asset_id: str,
    *,
    content_hash: str,
    status: str,
    task_id: str | None = None,
    video_id: str | None = None,
    source_asset_id: str | None = None,
) -> None:
    """Upsert one asset's TwelveLabs mapping (single row per asset)."""
    store.record_analysis(
        asset_id,
        kind=TL_VIDEO_KIND,
        depth="",
        params_hash=_TL_VIDEO_PARAMS,
        result={
            "taskId": task_id,
            "videoId": video_id,
            "status": status,
            "contentHash": content_hash,
            "sourceAssetId": source_asset_id,
        },
        tool=TL_TOOL,
    )


def video_to_asset_map(store: BrainStore) -> dict[str, str]:
    """Reverse map of ``video_id → asset_id`` for every indexed asset."""
    out: dict[str, str] = {}
    for row in store.list_analysis(kind=TL_VIDEO_KIND):
        video_id = _str_or_none(row.result.get("videoId"))
        if video_id is not None:
            out[video_id] = row.asset_id
    return out


# -- Pegasus map cache (kind='tl:map', content-hash keyed, plan FI2.1/FI2.3) -------


def read_cached_pegasus(
    store: BrainStore, asset_id: str, *, content_hash: str
) -> tuple[list[TLChapter], list[TLHighlight], str] | None:
    """Read one asset's cached Pegasus map for the CURRENT bytes, or ``None``.

    The cache is keyed on the video's ``content_hash`` (``params_hash``), so a
    re-index (new bytes → new ``video_id`` → new hash) is an automatic miss — a
    stale map is never served (plan FI2.3). Returns asset-time chapters/highlights
    plus the whole-video summary; the route re-projects them onto timeline time.
    """
    row = store.get_analysis(asset_id, kind=TL_MAP_KIND, params_hash=content_hash)
    if row is None:
        return None
    result = row.result
    chapters = [
        TLChapter(
            start=float(c["start"]),
            end=float(c["end"]),
            title=str(c.get("title") or ""),
            summary=str(c.get("summary") or ""),
        )
        for c in result.get("chapters", [])
        if isinstance(c, dict) and "start" in c and "end" in c
    ]
    highlights = [
        TLHighlight(start=float(h["start"]), end=float(h["end"]), label=str(h.get("label") or ""))
        for h in result.get("highlights", [])
        if isinstance(h, dict) and "start" in h and "end" in h
    ]
    summary = str(result.get("summary") or "")
    return chapters, highlights, summary


def store_cached_pegasus(
    store: BrainStore,
    asset_id: str,
    *,
    content_hash: str,
    chapters: Sequence[TLChapter],
    highlights: Sequence[TLHighlight],
    summary: str,
) -> None:
    """Persist one asset's Pegasus map, keyed by the current ``content_hash``.

    Stored in **asset** time (the projection onto timeline is cheap and depends on
    the live project), so the row survives timeline edits and is invalidated only
    by a re-index of changed bytes.
    """
    store.record_analysis(
        asset_id,
        kind=TL_MAP_KIND,
        depth="",
        params_hash=content_hash,
        result={
            "chapters": [
                {"start": c.start, "end": c.end, "title": c.title, "summary": c.summary}
                for c in chapters
            ],
            "highlights": [{"start": h.start, "end": h.end, "label": h.label} for h in highlights],
            "summary": summary,
        },
        tool=TL_TOOL,
    )


# -- paced per-asset indexing -----------------------------------------------------


def poll_index_asset(
    client: SupportsGetTask,
    store: BrainStore,
    index_id: str,
    asset_id: str,
    media_path_name: str,
    upload: Callable[[], str],
    *,
    content_hash: str,
    sleep: Callable[[float], None] = time.sleep,
    now: Callable[[], float] = time.monotonic,
    poll_interval: float = TL_POLL_INTERVAL_SECONDS,
    poll_budget: float = TL_SLICE_POLL_BUDGET_SECONDS,
) -> TLIndexOutcome:
    """Drive one asset's TwelveLabs indexing forward within a single slice.

    Idempotent + resumable: an already-ready mapping for the current bytes is a
    no-op (``advanced``); a changed ``content_hash`` (or no mapping) starts a new
    upload; a pending task is polled up to ``poll_budget`` before the slice is
    yielded back to be re-posted. ``upload`` is a thunk (so the caller owns opening
    the file) that returns the new task id.

    Never raises for an API failure — the caller catches :class:`TwelveLabsError`;
    this returns typed outcomes only.
    """
    mapping = read_video_mapping(store, asset_id)
    fresh = mapping is None or mapping.content_hash != content_hash or mapping.status == "failed"

    if not fresh and mapping is not None and mapping.ready:
        _log.debug(
            "twelvelabs slice: asset=%s already ready (video=%s)", asset_id, mapping.video_id
        )
        return TLIndexOutcome(advanced=True, ok=True, newly_indexed=0, status="ready")

    source_asset_id = None if fresh else (mapping.source_asset_id if mapping else None)
    if fresh or mapping is None or mapping.task_id is None:
        _log.info(
            "ACT twelvelabs index asset (fresh upload): asset=%s file=%s", asset_id, media_path_name
        )
        task_id = upload()
        store_video_mapping(
            store, asset_id, content_hash=content_hash, status="indexing", task_id=task_id
        )
    else:
        task_id = mapping.task_id
        _log.info("ACT twelvelabs index asset (resume poll): asset=%s task=%s", asset_id, task_id)

    # Poll this task up to the slice budget so a short clip finishes in one call.
    started = now()
    deadline = started + poll_budget
    while True:
        status = client.get_task(task_id)
        # The current TwelveLabs workflow is upload asset → attach to index. Its
        # opaque polling token advances at that boundary, so persist and continue
        # with the returned token instead of repeatedly creating indexed assets.
        task_id = status.task_id
        # The uploaded-asset id is what Pegasus generates from, and the task token
        # stops carrying it once the asset is attached to the index — so keep the
        # first value we see rather than dropping it on a later poll.
        source_asset_id = status.source_asset_id or source_asset_id
        if status.ready:
            store_video_mapping(
                store,
                asset_id,
                content_hash=content_hash,
                status="ready",
                task_id=task_id,
                video_id=status.video_id,
                source_asset_id=source_asset_id,
            )
            _log.info(
                "ACT twelvelabs index asset ready: asset=%s task=%s video=%s",
                asset_id,
                task_id,
                status.video_id,
            )
            return TLIndexOutcome(advanced=True, ok=True, newly_indexed=1, status="ready")
        if status.failed:
            store_video_mapping(
                store,
                asset_id,
                content_hash=content_hash,
                status="failed",
                task_id=task_id,
                source_asset_id=source_asset_id,
            )
            _log.warning("twelvelabs index asset FAILED: asset=%s task=%s", asset_id, task_id)
            return TLIndexOutcome(
                advanced=True,
                ok=False,
                newly_indexed=0,
                status="failed",
                reason="TwelveLabs failed to index this asset",
            )
        current = now()
        if current >= deadline:
            # Still indexing — persist progress and yield; the slice is re-posted.
            store_video_mapping(
                store,
                asset_id,
                content_hash=content_hash,
                status=status.status,
                task_id=task_id,
                source_asset_id=source_asset_id,
            )
            _log.info(
                "twelvelabs index asset still indexing: asset=%s task=%s status=%s "
                "(polled %.0fs this slice, yielding to re-post)",
                asset_id,
                task_id,
                status.status,
                current - started,
            )
            return TLIndexOutcome(
                advanced=False,
                ok=True,
                newly_indexed=0,
                status=status.status,
                reason=INDEXING_REASON,
            )
        sleep(poll_interval)


# -- clip → evidence packet -------------------------------------------------------


def clips_to_packets(
    clips: Sequence[TLClip],
    *,
    video_to_asset: dict[str, str],
    clips_by_asset: dict[str, list[SupportsClip]],
    utterances: Sequence[TranscriptUtterance],
    k: int,
    asset_ids: Sequence[str] | None = None,
) -> list[EvidencePacket]:
    """Map ranked TwelveLabs clips onto the evidence-packet contract (MI5.1).

    ``start``/``end`` are asset seconds and become ``t0``/``t1`` directly. When a
    project doc supplied the clips + transcript, the span is projected onto
    timeline time and any overlapping dialogue fills ``transcriptOverlap``;
    otherwise the clip's own spoken words (from the audio modality) are used, so
    the field is never fabricated. A clip whose ``video_id`` is not one of THIS
    project's indexed assets is skipped — never mapped to a wrong asset.
    ``scene_index`` is the clip's rank (TwelveLabs has no scene model); it only
    keeps packets for the same asset distinct.
    """
    allow = set(asset_ids) if asset_ids else None
    packets: list[EvidencePacket] = []
    for rank, clip in enumerate(clips):
        asset_id = video_to_asset.get(clip.video_id)
        if asset_id is None:
            continue
        if allow is not None and asset_id not in allow:
            continue
        timeline_ranges = project_span_to_timeline(
            clip.start, clip.end, clips_by_asset.get(asset_id, [])
        )
        overlap = transcript_overlap(timeline_ranges, utterances)
        if not overlap and clip.transcription:
            overlap = clip.transcription
        packets.append(
            EvidencePacket(
                asset_id=asset_id,
                t0=clip.start,
                t1=clip.end,
                scene_index=rank,
                score=clip.score,
                caption=None,
                transcript_overlap=overlap,
                sources=[TL_TOOL],
            )
        )
        if len(packets) >= k:
            break
    return packets


# -- Pegasus map → footage map / evidence packets ---------------------------------


@dataclass(frozen=True)
class MappedChapter:
    """One Pegasus chapter projected onto **timeline** seconds (plan FI1.2).

    ``t0``/``t1`` are timeline seconds; ``title``/``summary`` are Pegasus' labels.
    The route converts a list of these into the ``FootageMapResponse.chapters``
    wire shape.
    """

    t0: float
    t1: float
    title: str
    summary: str


@dataclass(frozen=True)
class MappedHighlight:
    """One Pegasus highlight projected onto timeline seconds (plan FI1.2).

    ``score`` is derived from position (earlier = higher) since Pegasus gives no
    native numeric score; it only orders highlights, never claims a probability.
    """

    t0: float
    t1: float
    label: str
    score: float


def _project_span(
    start: float, end: float, asset_id: str, clips_by_asset: dict[str, list[SupportsClip]]
) -> tuple[float, float]:
    """Project an asset span ``[start, end)`` onto its timeline extent.

    Reuses :func:`project_span_to_timeline`; when the asset is on the timeline the
    extent spans the first projected range's start to the last range's end. When no
    clip windows over the span (no project doc, or the asset is not placed), the
    asset time is returned unchanged — honest, never dropped.
    """
    ranges = project_span_to_timeline(start, end, clips_by_asset.get(asset_id, []))
    if not ranges:
        return start, end
    return ranges[0][0], ranges[-1][1]


def map_pegasus_chapters(
    chapters: Sequence[TLChapter],
    *,
    asset_id: str,
    clips_by_asset: dict[str, list[SupportsClip]],
) -> list[MappedChapter]:
    """Project one video's Pegasus chapters onto timeline time (plan FI1.2).

    The chapters belong to a single indexed video (mapped to ``asset_id``); each
    asset span is projected through that asset's clips. Chapters keep their order.
    """
    mapped: list[MappedChapter] = []
    for chapter in chapters:
        t0, t1 = _project_span(chapter.start, chapter.end, asset_id, clips_by_asset)
        mapped.append(MappedChapter(t0=t0, t1=t1, title=chapter.title, summary=chapter.summary))
    return mapped


def map_pegasus_highlights(
    highlights: Sequence[TLHighlight],
    *,
    asset_id: str,
    clips_by_asset: dict[str, list[SupportsClip]],
) -> list[MappedHighlight]:
    """Project one video's Pegasus highlights onto timeline time (plan FI1.2).

    ``score`` is ``1/rank`` by original position so the caller can order highlights
    best-first across videos without a native score.
    """
    mapped: list[MappedHighlight] = []
    for rank, highlight in enumerate(highlights, start=1):
        t0, t1 = _project_span(highlight.start, highlight.end, asset_id, clips_by_asset)
        mapped.append(MappedHighlight(t0=t0, t1=t1, label=highlight.label, score=1.0 / rank))
    return mapped


def chapters_to_packets(
    chapters: Sequence[TLChapter],
    *,
    asset_id: str,
    clips_by_asset: dict[str, list[SupportsClip]],
    utterances: Sequence[TranscriptUtterance],
) -> list[EvidencePacket]:
    """Walk Pegasus chapters into evidence packets for the describe path (plan FI2.2).

    Each chapter becomes one packet in time order: ``t0``/``t1`` are the chapter's
    **asset** seconds (matching the built-in describe contract), ``caption`` is the
    chapter title+summary, and ``transcriptOverlap`` is the dialogue over the
    chapter's timeline projection. ``score`` is a constant (enumeration has no
    ranking, mirroring the built-in describe route).
    """
    packets: list[EvidencePacket] = []
    for index, chapter in enumerate(chapters):
        timeline_ranges = project_span_to_timeline(
            chapter.start, chapter.end, clips_by_asset.get(asset_id, [])
        )
        caption = chapter.title
        if chapter.summary:
            caption = f"{chapter.title} — {chapter.summary}"
        packets.append(
            EvidencePacket(
                asset_id=asset_id,
                t0=chapter.start,
                t1=chapter.end,
                scene_index=index,
                score=1.0,
                caption=caption,
                transcript_overlap=transcript_overlap(timeline_ranges, utterances),
                sources=[TL_TOOL],
            )
        )
    return packets


def _str_or_none(value: object) -> str | None:
    """A non-empty string, or ``None`` (defensive against malformed rows)."""
    return value if isinstance(value, str) and value else None
