"""Adaptive visual sampling — scene-aware spans with dHash dedupe (plan MI1.1/MI1.3).

WHY: embedding every frame of a video at 1 fps would cost one NVIDIA API call
per second even for a static talking-head (decision D2 in
``plan/MEDIA-INTELLIGENCE.md``). Instead, each *vector* covers a time **span**:
candidate frames are sampled at 1 fps within each detected scene, and a
candidate that is perceptually near-identical (dHash Hamming distance ≤
threshold) to the frame that *started* the current span extends that span
instead of producing a new one. The result is an ordered, contiguous,
non-overlapping set of spans covering ``[0, duration)`` exactly — every second
of the video maps deterministically to exactly one vector, and scene boundaries
always start a new span so a retrieval hit never straddles a cut.

Following the analysis-module convention (``analysis/frames.py`` et al.) this
module is **pure**: no disk, no subprocess, no pixel decoding. The dHash here
takes an already-downsampled 9x8 grayscale grid; the route layer (MI1.2/MI4)
owns ffmpeg extraction and grayscale downsampling and feeds hashes in via
``frame_hashes``.

Idempotency (MI1.3): the stored idempotency key is
``(asset content_hash, model_id, SAMPLER_VERSION, t0)``. **Any behavioral
change to this module — sampling cadence, hash algorithm, threshold semantics,
span construction — MUST bump ``SAMPLER_VERSION``**, otherwise re-runs would
mix spans produced by two different samplers and "already indexed" checks
would silently lie.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from itertools import pairwise

from pydantic import BaseModel, Field, field_serializer

#: Version of the sampling behavior, part of the idempotency key (MI1.3).
#: Bump on ANY change to candidate cadence, dHash, threshold handling, or span
#: construction — see the module docstring.
SAMPLER_VERSION = 1

#: dHash grid: 9 columns x 8 rows of grayscale values → 8 horizontal-gradient
#: bits per row → a 64-bit hash (the standard dHash construction).
DHASH_GRID_WIDTH = 9
DHASH_GRID_HEIGHT = 8

#: Max Hamming distance at which two frames count as "the same shot content".
#: 6/64 bits (~9%) is the conventional dHash near-duplicate threshold: tight
#: enough that layout/content changes split spans, loose enough that sensor
#: noise, slight motion, and compression jitter in a static shot do not.
DEFAULT_HAMMING_THRESHOLD = 6

#: Candidate sampling cadence within a scene (decision D2: ≤1 vector/second).
_CANDIDATE_INTERVAL_SECONDS = 1.0

#: Source of candidate hashes: a precomputed ``{timestamp: hash}`` mapping or a
#: callable the route layer backs with frame extraction.
HashLookup = Mapping[float, int] | Callable[[float], int]


class FrameCandidate(BaseModel):
    """One sampled candidate frame, ready for span construction."""

    t: float = Field(ge=0.0, description="Candidate timestamp in seconds.")
    scene_index: int = Field(alias="sceneIndex", ge=0)
    hash: int = Field(ge=0, description="64-bit dHash of the frame.")

    model_config = {"populate_by_name": True}


class VisualSpan(BaseModel):
    """One embedded vector's temporal coverage: ``[t0, t1)`` within one scene.

    ``phash`` is the dHash of the span's keyframe (the frame that gets
    embedded). It is a full 64-bit value, so it serializes as a **string**:
    JSON numbers round-trip through JS ``Number`` (53-bit mantissa) and would
    silently corrupt the top bits.
    """

    t0: float = Field(ge=0.0, description="Span start in seconds (inclusive).")
    t1: float = Field(ge=0.0, description="Span end in seconds (exclusive).")
    scene_index: int = Field(alias="sceneIndex", ge=0)
    keyframe_t: float = Field(
        alias="keyframeT", ge=0.0, description="Timestamp of the embedded frame (== t0)."
    )
    phash: int = Field(ge=0, description="64-bit dHash of the keyframe.")
    frame_count: int = Field(
        alias="frameCount", ge=1, description="How many 1 fps candidates the span absorbed."
    )

    model_config = {"populate_by_name": True}

    @field_serializer("phash")
    def _phash_as_string(self, value: int) -> str:
        """64-bit safety: serialize as a decimal string (see class docstring)."""
        return str(value)


def dhash(rows: Sequence[Sequence[int]]) -> int:
    """64-bit dHash of an already-downsampled 9x8 grayscale grid (pure).

    Each row of 9 values yields 8 horizontal-gradient bits (1 when the left
    pixel is brighter than its right neighbour), packed MSB-first row by row.
    Pixel decoding/downsampling happens in the route layer — this function only
    does the arithmetic, keeping the module free of image I/O.

    :param rows: Exactly 8 rows of exactly 9 grayscale values each.
    :returns: The 64-bit hash as a non-negative int.
    :raises ValueError: On a grid that is not 8x9.
    """
    if len(rows) != DHASH_GRID_HEIGHT:
        raise ValueError(f"dhash needs {DHASH_GRID_HEIGHT} rows, got {len(rows)}.")
    value = 0
    for row in rows:
        if len(row) != DHASH_GRID_WIDTH:
            raise ValueError(f"dhash needs {DHASH_GRID_WIDTH} values per row, got {len(row)}.")
        for left, right in pairwise(row):
            value = (value << 1) | (1 if left > right else 0)
    return value


def hamming(a: int, b: int) -> int:
    """Number of differing bits between two hashes (pure)."""
    return (a ^ b).bit_count()


def _scene_starts(duration_seconds: float, scene_cuts: Sequence[float]) -> list[float]:
    """Scene start times: 0 plus every distinct cut strictly inside ``(0, duration)``.

    Cuts at or before 0, at or beyond the duration, and duplicates are dropped —
    a cut outside the media cannot start a scene, and scene detection sometimes
    reports the very first frame as a cut.
    """
    inside = sorted({cut for cut in scene_cuts if 0.0 < cut < duration_seconds})
    return [0.0, *inside]


def candidate_timestamps(
    duration_seconds: float, scene_cuts: Sequence[float]
) -> list[float]:
    """Candidate frame timestamps: 1 fps within each scene, from the scene start (pure).

    Every scene contributes its start time plus one candidate per second until
    the next scene starts (or the media ends) — so even a sub-second scene gets
    exactly one candidate, and coverage never skips a scene.

    :param duration_seconds: Media duration; ``0`` yields no candidates.
    :param scene_cuts: Detected cut times; values outside ``(0, duration)`` are ignored.
    :returns: Ascending timestamps, one scene's run after another.
    :raises ValueError: On a negative duration.
    """
    if duration_seconds < 0:
        raise ValueError(f"duration_seconds must be >= 0, got {duration_seconds}.")
    if duration_seconds == 0:
        return []
    starts = _scene_starts(duration_seconds, scene_cuts)
    ends = [*starts[1:], duration_seconds]
    candidates: list[float] = []
    for start, end in zip(starts, ends, strict=True):
        # Multiply-from-start (not repeated addition) keeps the grid exact
        # enough that float drift never skips or duplicates a second.
        step = 0
        while (t := start + step * _CANDIDATE_INTERVAL_SECONDS) < end:
            candidates.append(t)
            step += 1
    return candidates


def build_candidates(
    duration_seconds: float,
    scene_cuts: Sequence[float],
    frame_hashes: HashLookup,
) -> list[FrameCandidate]:
    """Pair every candidate timestamp with its scene index and dHash (pure).

    :param frame_hashes: ``{timestamp: hash}`` (must cover every candidate
        timestamp) or a callable resolving one timestamp to its hash.
    :raises KeyError: When a mapping is missing a candidate timestamp.
    """
    lookup = frame_hashes.__getitem__ if isinstance(frame_hashes, Mapping) else frame_hashes
    starts = _scene_starts(duration_seconds, scene_cuts)
    candidates: list[FrameCandidate] = []
    scene_index = 0
    for t in candidate_timestamps(duration_seconds, scene_cuts):
        while scene_index + 1 < len(starts) and t >= starts[scene_index + 1]:
            scene_index += 1
        candidates.append(FrameCandidate(t=t, scene_index=scene_index, hash=lookup(t)))
    return candidates


def build_spans(
    candidates: Sequence[FrameCandidate],
    *,
    duration_seconds: float,
    hamming_threshold: int = DEFAULT_HAMMING_THRESHOLD,
) -> list[VisualSpan]:
    """Fold candidates into contiguous, non-overlapping spans covering ``[0, duration)``.

    A candidate starts a new span when it enters a new scene (boundaries always
    split, even on an identical hash — a retrieval hit must never straddle a
    cut) or when its hash drifts more than ``hamming_threshold`` bits from the
    **span-starting** (embedded) frame — comparing against the keyframe rather
    than the previous candidate stops slow drift from stretching one span over
    genuinely different content. Otherwise it extends the current span.

    Coverage invariant: each span's ``t1`` is the next span's ``t0``; the last
    span ends at ``duration_seconds``. No candidates → no spans (``[0, 0)``).

    :param candidates: Time-ordered candidates (as from :func:`build_candidates`).
    :param duration_seconds: Media duration; the final span's exclusive end.
    :param hamming_threshold: Max bit distance that still counts as "same content".
    :raises ValueError: On out-of-order candidates or a candidate at/past the duration.
    """
    if not candidates:
        return []
    spans: list[VisualSpan] = []
    current: VisualSpan | None = None
    previous_t = -1.0
    for candidate in candidates:
        if candidate.t <= previous_t:
            raise ValueError(f"Candidates must be strictly ascending at t={candidate.t}.")
        if candidate.t >= duration_seconds:
            raise ValueError(
                f"Candidate at t={candidate.t} is at/past duration {duration_seconds}."
            )
        previous_t = candidate.t
        if current is not None:
            extends = (
                candidate.scene_index == current.scene_index
                and hamming(candidate.hash, current.phash) <= hamming_threshold
            )
            if extends:
                current.frame_count += 1
                continue
            current.t1 = candidate.t  # close the previous span, contiguously
        current = VisualSpan(
            t0=candidate.t,
            t1=duration_seconds,  # provisional; closed by the next span start
            scene_index=candidate.scene_index,
            keyframe_t=candidate.t,
            phash=candidate.hash,
            frame_count=1,
        )
        spans.append(current)
    return spans


def plan_spans(
    *,
    duration_seconds: float,
    scene_cuts: Sequence[float],
    frame_hashes: HashLookup,
    hamming_threshold: int = DEFAULT_HAMMING_THRESHOLD,
) -> list[VisualSpan]:
    """Full sampling plan for one video: scenes → 1 fps candidates → dHash → spans.

    Convenience composition of :func:`candidate_timestamps`,
    :func:`build_candidates`, and :func:`build_spans` (plan §3.1). Pure given
    the hashes — the route layer supplies ``frame_hashes`` from extracted frames.
    """
    candidates = build_candidates(duration_seconds, scene_cuts, frame_hashes)
    return build_spans(
        candidates, duration_seconds=duration_seconds, hamming_threshold=hamming_threshold
    )


def image_span(*, phash: int = 0) -> VisualSpan:
    """The single degenerate ``[0, 0)`` span a still image embeds as (plan §3.1)."""
    return VisualSpan(
        t0=0.0, t1=0.0, scene_index=0, keyframe_t=0.0, phash=phash, frame_count=1
    )
