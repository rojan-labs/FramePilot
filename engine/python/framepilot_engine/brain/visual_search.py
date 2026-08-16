"""Reciprocal-rank fusion + span math for visual search (plan MI5.1/MI5.2, §3.4).

WHY: ``POST /brain/visual/search`` must merge THREE recall modalities into one
readable ranking the orchestrator can act on — nemotron visual KNN over the
embedded frames, FTS5 keyword hits over the VLM captions and the transcript,
and the ONNX text-vector search over those same captions/utterances. None of
them share a score scale, so this module fuses them by **rank** (reciprocal-rank
fusion, plan §3.4d) rather than by comparing incomparable distances, and emits
one *evidence packet* per surviving visual span.

This module is the **pure, deterministic core** (plan §6): it takes
already-retrieved ranked lists (the route owns the embedding call, the vector
store, and the brain reads) plus the plain span/caption/clip/transcript metadata,
and returns fused :class:`EvidencePacket` rows. No I/O, no NVIDIA, no SQLite —
so 100% branch coverage is reachable with hand-built inputs and the golden
retrieval tests pin their vectors directly.

Two responsibilities, kept separate:

- **Fusion** (:func:`reciprocal_rank_fusion`): merge N labelled ranked lists of
  span keys into one score, accumulating which retrievers ("sources") hit each
  span. Standard RRF with a documented constant (:data:`RRF_K`).
- **Span math** (:func:`project_span_to_timeline`, :func:`transcript_overlap`):
  a visual span is stored in **asset** seconds, but the transcript lives in
  **timeline** seconds, so a hit only resolves against dialogue after its
  ``[t0, t1)`` is projected back onto the timeline through the project's clips
  (plan MI5.2). The projection is deterministic and the packet carries the
  transcript text overlapping the span so the model reads evidence, not a
  timestamp.

The brain package must not depend on the timeline package (mirrors
``brain/fts.py``), so clips are consumed through the :class:`SupportsClip`
Protocol, never an import of ``timeline.models``.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Protocol

from pydantic import BaseModel, Field

from framepilot_engine.brain.models import (
    SearchHit,
    SearchHitType,
    TranscriptUtterance,
    VisualCaptionRow,
    VisualSpanRow,
)
from framepilot_engine.brain.vector_store import VisualHit

__all__ = [
    "RRF_K",
    "SOURCE_CAPTION_FTS",
    "SOURCE_SEMANTIC",
    "SOURCE_TRANSCRIPT",
    "SOURCE_VISUAL",
    "EvidencePacket",
    "RankedList",
    "SupportsClip",
    "build_evidence_packets",
    "project_span_to_timeline",
    "reciprocal_rank_fusion",
    "transcript_overlap",
]

#: RRF constant ``k`` in ``1 / (k + rank)`` (plan §3.4d). 60 is the value from
#: Cormack et al. 2009 and the de-facto default in Elasticsearch/Vespa: large
#: enough that a #1 and a #2 hit score close together (rank differences past the
#: top few barely matter), small enough that the top handful still separate.
RRF_K = 60

#: Retriever labels surfaced in ``EvidencePacket.sources`` (plan §3.4e). The FTS
#: caption and transcript lanes stay DISTINCT sources even though §3.4 counts
#: them as one "keyword" modality — the packet contract names each retriever
#: that hit (e.g. ``["visual", "caption-fts", "transcript"]``) so the model can
#: weigh agreement across independent signals.
SOURCE_VISUAL = "visual"
SOURCE_CAPTION_FTS = "caption-fts"
SOURCE_TRANSCRIPT = "transcript"
SOURCE_SEMANTIC = "semantic"

#: A visual span's fusion identity: ``(asset_id, t0)``. Model/sampler_version are
#: omitted — a project embeds under one model at a time, and both the durable
#: rows and :class:`VisualHit` already agree on ``(asset_id, t0)`` as the span's
#: handle for search.
SpanKey = tuple[str, float]


class SupportsClip(Protocol):
    """Anything shaped like a timeline clip (``timeline.models.Clip``).

    A Protocol, not an import, so the brain package never depends on the
    timeline package (mirrors ``brain/fts.py``'s ``SupportsMarker``). The
    service layer is the only place the two meet.
    """

    @property
    def asset_id(self) -> str: ...
    @property
    def start(self) -> float: ...
    @property
    def end(self) -> float: ...
    @property
    def source_start(self) -> float: ...
    @property
    def source_end(self) -> float | None: ...
    @property
    def speed(self) -> float | None: ...


@dataclass(frozen=True)
class RankedList:
    """One retriever's ranked span keys, best-first, tagged with its source label.

    Repeats within ``span_keys`` are collapsed to the span's BEST (earliest)
    rank by :func:`reciprocal_rank_fusion` — a caption search that maps two hits
    onto the same span must not double-count that span's contribution.
    """

    source: str
    span_keys: Sequence[SpanKey]


@dataclass(frozen=True)
class _Fused:
    """Intermediate fusion result before packets are enriched."""

    key: SpanKey
    score: float
    sources: list[str] = field(default_factory=list)


class EvidencePacket(BaseModel):
    """One fused visual-search result the orchestrator reads directly (§3.4e).

    ``t0``/``t1``/``sceneId`` come from the hit's ``visual_spans`` row and are
    **asset** seconds; ``score`` is the fused RRF score (higher = stronger
    agreement across retrievers, not a probability). ``caption`` is the scene's
    VLM caption when one exists; ``transcriptOverlap`` is the transcript text
    overlapping the span's timeline projection (empty when the span is off the
    timeline or nothing was said over it). ``sources`` names every retriever
    that surfaced the span.
    """

    asset_id: str = Field(alias="assetId")
    t0: float = Field(description="Span start in asset seconds (inclusive).")
    t1: float = Field(description="Span end in asset seconds (exclusive).")
    scene_index: int = Field(alias="sceneId", description="Source scene the span belongs to.")
    score: float = Field(description="Fused reciprocal-rank score; higher is more relevant.")
    caption: str | None = Field(default=None, description="Scene VLM caption, when captioned.")
    transcript_overlap: str = Field(
        default="",
        alias="transcriptOverlap",
        description="Transcript text overlapping the span's timeline projection.",
    )
    sources: list[str] = Field(
        default_factory=list, description="Retrievers that hit this span (e.g. ['visual'])."
    )

    model_config = {"populate_by_name": True}


def reciprocal_rank_fusion(
    rankings: Iterable[RankedList], *, k_rrf: int = RRF_K
) -> list[_Fused]:
    """Fuse labelled ranked lists into one score per span (plan §3.4d).

    Each list contributes ``1 / (k_rrf + rank)`` to every span it ranks, with
    ``rank`` starting at 1 for its top hit; a span's fused score is the sum over
    all lists that ranked it, so a span found by several retrievers outranks one
    found by a single strong hit. Within one list a span is counted once, at its
    best rank. ``sources`` accumulates the labels in the order the lists are
    given, deduplicated.

    Returned rows are sorted by score descending, then by key for a stable,
    backend-independent order.
    """
    scored: dict[SpanKey, float] = {}
    sources: dict[SpanKey, list[str]] = {}
    for ranked in rankings:
        seen: set[SpanKey] = set()
        rank = 0
        for key in ranked.span_keys:
            if key in seen:
                continue  # collapse repeats to the span's best rank in this list
            seen.add(key)
            rank += 1
            scored[key] = scored.get(key, 0.0) + 1.0 / (k_rrf + rank)
            bucket = sources.setdefault(key, [])
            if ranked.source not in bucket:
                bucket.append(ranked.source)
    fused = [_Fused(key=key, score=score, sources=sources[key]) for key, score in scored.items()]
    fused.sort(key=lambda f: (-f.score, f.key))
    return fused


def _span_hi(t0: float, t1: float) -> float:
    """Closed-interval upper bound for a span/caption whose ``t1`` may be a point.

    Image spans are stored ``[0, 0)`` (``t1 <= t0``); treating the interval as
    the closed point ``[t0, t0]`` makes overlap tests inclusive and correct for
    both real spans and single-instant images.
    """
    return t1 if t1 > t0 else t0


def _closed_overlap(a0: float, a1: float, b0: float, b1: float) -> bool:
    """Whether closed intervals ``[a0, a1]`` and ``[b0, b1]`` intersect.

    Inclusive on purpose: visual recall should be generous at boundaries, and a
    point interval (``lo == hi``) overlaps any range that contains the point.
    """
    return a0 <= b1 and b0 <= a1


def project_span_to_timeline(
    t0: float, t1: float, clips: Sequence[SupportsClip]
) -> list[tuple[float, float]]:
    """Map an asset span ``[t0, t1)`` onto timeline seconds through ``clips`` (MI5.2).

    A span appears on the timeline wherever a clip of its asset windows over it:
    for a clip with source window ``[sourceStart, sourceEnd)`` played at
    ``speed`` into timeline ``[start, end)``, an asset time ``ta`` lands at
    ``start + (ta - sourceStart) / speed``. The span's overlap with the window is
    projected end-to-end; a span used by several clips yields several ranges
    (and none when the asset is not on the timeline). An open ``sourceEnd`` is
    derived from the clip's timeline duration and speed (the schema invariant
    ``end - start == (sourceEnd - sourceStart) / speed``).

    ``clips`` must already be the clips FOR this span's asset (the caller filters
    by ``assetId``). Ranges come back sorted; a point span yields point ranges.
    """
    hi = _span_hi(t0, t1)
    ranges: list[tuple[float, float]] = []
    for clip in clips:
        speed = clip.speed if clip.speed else 1.0
        src_start = clip.source_start
        src_end = clip.source_end
        if src_end is None:
            src_end = src_start + (clip.end - clip.start) * speed
        # Intersect the (closed) span [t0, hi] with the clip's source window.
        lo = max(t0, src_start)
        clipped_end = min(hi, src_end)
        if lo > clipped_end:
            continue  # span does not fall inside this clip's source window
        tl_start = clip.start + (lo - src_start) / speed
        tl_end = clip.start + (clipped_end - src_start) / speed
        ranges.append((tl_start, tl_end))
    ranges.sort()
    return ranges


def transcript_overlap(
    timeline_ranges: Sequence[tuple[float, float]],
    utterances: Sequence[TranscriptUtterance],
) -> str:
    """Transcript text spoken over any of ``timeline_ranges`` (plan §3.4e).

    Utterances (timeline seconds) overlapping a range are joined in time order;
    each utterance appears once even if it spans several ranges. Empty when the
    span is off the timeline or silent.
    """
    if not timeline_ranges or not utterances:
        return ""
    hits: list[TranscriptUtterance] = []
    for utt in utterances:
        if any(_closed_overlap(utt.start, utt.end, r0, r1) for r0, r1 in timeline_ranges):
            hits.append(utt)
    hits.sort(key=lambda u: (u.start, u.end))
    return " ".join(u.text for u in hits)


def _hit_span_keys(
    hits: Iterable[SearchHit],
    spans: Sequence[VisualSpanRow],
    clips_by_asset: Mapping[str, Sequence[SupportsClip]],
) -> list[SpanKey]:
    """Reduce keyword/semantic hits to the visual spans they evidence, in hit order.

    A caption hit (asset seconds) lifts every span of its asset whose interval
    overlaps it; a transcript hit (timeline seconds) lifts every span whose
    timeline projection overlaps it. Asset-name hits (from the semantic digest
    rows) point at no span and are skipped. Order follows the ranked hit order,
    then span ``t0`` — :func:`reciprocal_rank_fusion` collapses the inevitable
    repeats to each span's best rank.
    """
    keys: list[SpanKey] = []
    for hit in hits:
        if hit.type == SearchHitType.CAPTION and hit.asset_id is not None:
            lo = hit.start if hit.start is not None else 0.0
            hi = hit.end if hit.end is not None else lo
            for span in spans:
                if span.asset_id != hit.asset_id:
                    continue
                if _closed_overlap(span.t0, _span_hi(span.t0, span.t1), lo, hi):
                    keys.append((span.asset_id, span.t0))
        elif hit.type == SearchHitType.TRANSCRIPT and hit.start is not None:
            lo, hi = hit.start, hit.end if hit.end is not None else hit.start
            for span in spans:
                ranges = project_span_to_timeline(
                    span.t0, span.t1, clips_by_asset.get(span.asset_id, [])
                )
                if any(_closed_overlap(r0, r1, lo, hi) for r0, r1 in ranges):
                    keys.append((span.asset_id, span.t0))
        # else: ASSET/MARKER hits carry no span — nothing to fuse.
    return keys


def _in_query_time_range(t0: float, t1: float, start: float, end: float) -> bool:
    """Whether a span passes the query ``timeRange`` filter (mirrors vector_store).

    Kept identical to ``vector_store._in_time_range`` so the non-visual lanes
    filter spans exactly as the visual KNN already did (parity across sources).
    """
    if t1 <= t0:
        return start <= t0 <= end
    return t0 <= end and t1 > start


def build_evidence_packets(
    *,
    visual_hits: Sequence[VisualHit],
    caption_fts_hits: Sequence[SearchHit],
    transcript_fts_hits: Sequence[SearchHit],
    semantic_hits: Sequence[SearchHit],
    spans: Sequence[VisualSpanRow],
    captions: Sequence[VisualCaptionRow],
    clips: Sequence[SupportsClip],
    utterances: Sequence[TranscriptUtterance],
    k: int,
    asset_ids: Sequence[str] | None = None,
    time_range: tuple[float, float] | None = None,
) -> list[EvidencePacket]:
    """Fuse every retriever into ranked evidence packets (plan §3.4, the pure core).

    The visual lane is ranked directly; the caption/transcript/semantic lanes are
    reduced to the spans they evidence (:func:`_hit_span_keys`) before fusion, so
    all four contribute to one :func:`reciprocal_rank_fusion`. The candidate
    universe is the passed ``spans`` (plus any span a visual hit names), filtered
    by ``asset_ids``/``time_range`` identically to the vector store — a retriever
    can never smuggle in a span the caller excluded. Each surviving span is
    enriched with its scene caption and the transcript spoken over it.

    :param k: Max packets; ``<= 0`` returns ``[]``.
    """
    if k <= 0:
        return []

    allowed = set(asset_ids) if asset_ids is not None else None
    # Span metadata keyed by fusion key. Visual hits are self-sufficient (they
    # carry t1/scene), so a span named only by a hit still resolves.
    meta: dict[SpanKey, tuple[float, float, int]] = {}
    for span in spans:
        meta[(span.asset_id, span.t0)] = (span.t0, span.t1, span.scene_index)
    for hit in visual_hits:
        meta.setdefault((hit.asset_id, hit.t0), (hit.t0, hit.t1, hit.scene_index))

    def passes_filters(key: SpanKey) -> bool:
        asset_id, _ = key
        if allowed is not None and asset_id not in allowed:
            return False
        t0, t1, _scene = meta[key]
        return time_range is None or _in_query_time_range(t0, t1, *time_range)

    # Only spans that pass the filters can be candidates in ANY lane.
    candidate_spans = [s for s in spans if passes_filters((s.asset_id, s.t0))]
    clips_by_asset: dict[str, list[SupportsClip]] = {}
    for clip in clips:
        clips_by_asset.setdefault(clip.asset_id, []).append(clip)

    rankings = [
        RankedList(
            SOURCE_VISUAL,
            [(h.asset_id, h.t0) for h in visual_hits if passes_filters((h.asset_id, h.t0))],
        ),
        RankedList(
            SOURCE_CAPTION_FTS, _hit_span_keys(caption_fts_hits, candidate_spans, clips_by_asset)
        ),
        RankedList(
            SOURCE_TRANSCRIPT, _hit_span_keys(transcript_fts_hits, candidate_spans, clips_by_asset)
        ),
        RankedList(
            SOURCE_SEMANTIC, _hit_span_keys(semantic_hits, candidate_spans, clips_by_asset)
        ),
    ]

    caption_by_scene: dict[tuple[str, int], str] = {}
    for cap in captions:
        caption_by_scene.setdefault((cap.asset_id, cap.scene_index), cap.text)

    # Every fused key came from the filtered visual lane or from candidate_spans,
    # so it is guaranteed present in `meta` and already past the filters — no
    # re-check needed here.
    packets: list[EvidencePacket] = []
    for fused in reciprocal_rank_fusion(rankings):
        asset_id, _ = fused.key
        t0, t1, scene_index = meta[fused.key]
        tl_ranges = project_span_to_timeline(t0, t1, clips_by_asset.get(asset_id, []))
        packets.append(
            EvidencePacket(
                asset_id=asset_id,
                t0=t0,
                t1=t1,
                scene_index=scene_index,
                score=fused.score,
                caption=caption_by_scene.get((asset_id, scene_index)),
                transcript_overlap=transcript_overlap(tl_ranges, utterances),
                sources=fused.sources,
            )
        )
        if len(packets) >= k:
            break
    return packets
