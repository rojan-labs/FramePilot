"""Pure shot-ledger arithmetic: measurements in, ledger rows and a digest out.

WHY A SEPARATE MODULE (ADR 0175, plan/visual-understanding VU1.3): every function here
is a total function of its arguments — no connection, no clock, no I/O — while
:mod:`framepilot_engine.brain.store` is nothing but SQL and timestamps. Keeping the two
apart is what lets the interesting decisions (which shots count as low quality, what a
"mix" is when half the tiers have not run, what a median shot length means for an empty
asset) be tested without a database, the same split
:mod:`framepilot_engine.analysis.shot_stats` already draws between its parser and its
subprocess.

The store re-exports nothing from here; callers that need a digest built import these
directly and hand the result to :meth:`BrainStore.upsert_asset_digest`.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from statistics import median

from framepilot_engine.analysis.shot_stats import ShotStats
from framepilot_engine.brain.ledger_models import (
    TIER0_VERSION,
    AssetDigest,
    ChromaStats,
    LumaStats,
    MeasuredFacts,
    MotionClass,
    MotionStats,
    ShotRecord,
    TierCoverage,
)

__all__ = [
    "LABEL_MIN_P",
    "LOW_SHARPNESS",
    "coverage_of",
    "digest_from_shots",
    "shots_from_stats",
]

#: Minimum confidence at which a tier-1 label is allowed to influence anything the agent
#: reads. Same number as the clip-row printing rule (``01-ARCHITECTURE.md`` §7), and
#: deliberately the same CONSTANT: a digest that counted labels the row refuses to print
#: would describe footage the agent cannot see described.
LABEL_MIN_P = 0.6

#: Sharpness at or below which a shot is called soft. ``sharpness`` is
#: ``1 - median(blurdetect) / BLUR_FULL``, and ``shot_stats`` measured a sharp frame at
#: edge width 4.2 (sharpness 0.74) against a sigma-6 gaussian blur at 13.1 (0.18). 0.4
#: sits between them, at edge width ~9.6. A first calibration: VU1.6's hand-labelled
#: sharpness classes are what will either confirm it or move it.
LOW_SHARPNESS = 0.4


def _motion_class(raw: str) -> MotionClass:
    """Widen ``ShotStats.motion_class`` (a plain ``str``) to the ledger enum.

    ``shot_stats`` deliberately returns a string so the analysis layer does not depend on
    the brain; the conversion has to happen somewhere, and an unknown value is a bug in
    the producer rather than something to swallow.

    :raises ValueError: If the class name is not one of the four in the vocabulary.
    """
    return MotionClass(raw)


def shots_from_stats(
    asset_id: str,
    content_hash: str,
    stats: Sequence[ShotStats],
    *,
    phashes: Mapping[int, str] | None = None,
    loudness_lufs: Mapping[int, float] | None = None,
) -> list[ShotRecord]:
    """Convert one asset's tier-0 measurements into ledger rows.

    The two side channels are separate arguments because they come from separate passes:
    the keyframe dHash is produced by the existing sampler (one JPEG per shot) and
    loudness by the audio-only ``ebur128`` pass, neither of which is part of the single
    statistics decode. Both are keyed by ``shot_index``.

    A missing phash is written as ``None`` — "no keyframe hash was computed" — rather than a
    plausible-looking zero, because duplicate detection compares Hamming distances and a
    shared fake value would make every unhashed shot a duplicate of every other.

    :param asset_id: Owning asset.
    :param content_hash: Digest of the source bytes these measurements describe.
    :param stats: Per-shot statistics, in ``shot_index`` order.
    :param phashes: Keyframe dHash per shot index, when computed.
    :param loudness_lufs: Integrated loudness per shot index; absent for silent assets.
    :returns: One :class:`ShotRecord` per input, each with ``measured`` populated.
    """
    hashes = phashes or {}
    loud = loudness_lufs or {}
    return [
        ShotRecord(
            asset_id=asset_id,
            content_hash=content_hash,
            shot_index=s.shot_index,
            t0=s.t0,
            t1=s.t1,
            keyframe_t=s.keyframe_t,
            split_of=s.split_of,
            measured=MeasuredFacts(
                tier0_version=TIER0_VERSION,
                luma=LumaStats(mean=s.luma_mean, std=s.luma_std, p10=s.luma_p10, p90=s.luma_p90),
                chroma=ChromaStats(u_mean=s.u_mean, v_mean=s.v_mean, sat_mean=s.sat_mean),
                warmth=s.warmth,
                contrast_idx=s.contrast_idx,
                motion=MotionStats(si=s.si, ti=s.ti, motion_class=_motion_class(s.motion_class)),
                cut_score=s.cut_score,
                black=s.black,
                freeze=s.freeze,
                sharpness=s.sharpness,
                phash=hashes.get(s.shot_index),
                loudness_lufs=loud.get(s.shot_index),
            ),
        )
        for s in stats
    ]


def coverage_of(shots: Sequence[ShotRecord]) -> TierCoverage:
    """Count how many of ``shots`` each tier has actually reached.

    Reported, never inferred: "described 0/61" and "described 61/61, all empty" are
    different facts about the footage and the agent has to be able to tell them apart.
    """
    return TierCoverage(
        measured=sum(1 for s in shots if s.measured is not None),
        labelled=sum(1 for s in shots if s.labelled is not None),
        described=sum(1 for s in shots if s.described is not None),
        total=len(shots),
    )


def _mix(values: Sequence[str]) -> dict[str, float]:
    """Fractions of a categorical vocabulary, rounded so canonical JSON stays stable.

    Rounded to three places because the digest is serialized byte-for-byte into the brain
    and compared across runs; ``0.30000000000000004`` would make an unchanged asset look
    like a changed one.
    """
    if not values:
        return {}
    counts = Counter(values)
    total = float(len(values))
    return {key: round(counts[key] / total, 3) for key in sorted(counts)}


def _confident_values(shots: Sequence[ShotRecord], field: str) -> list[str]:
    """The values of one tier-1 ``Confident`` field that clear :data:`LABEL_MIN_P`."""
    out: list[str] = []
    for shot in shots:
        if shot.labelled is None:
            continue
        label = getattr(shot.labelled, field)
        if label is not None and label.p >= LABEL_MIN_P:
            out.append(label.value)
    return out


def digest_from_shots(
    asset_id: str,
    content_hash: str,
    shots: Sequence[ShotRecord],
    *,
    duration_s: float,
    has_speech: bool = False,
) -> AssetDigest:
    """Aggregate one asset's shots into the summary the project digest reads.

    Built here, from rows the caller already holds, so the digest is rebuilt in the same
    transaction that wrote the tier — a digest that lags its shots would tell the agent
    about footage that no longer exists.

    Every aggregate degrades independently. An asset with no ``measured`` rows has no
    exposure range (``None``, not ``(0, 0)``); one with no ``labelled`` rows has empty
    mixes rather than a mix of nothing. The empty-asset case is a real one — a still that
    failed to decode has a digest with zero shots — and it returns zeros rather than
    raising, because a missing digest and an empty digest mean different things to the
    coverage line.

    :param asset_id: Owning asset.
    :param content_hash: Digest of the bytes these shots describe.
    :param shots: Every shot of the asset, in any order.
    :param duration_s: Asset duration in seconds, from the probe (NOT the shot spans,
        which stop at the last detected cut and can under-report a tail).
    :param has_speech: Whether a transcript exists for the asset.
    :returns: The pre-aggregated per-asset summary.
    """
    measured = [s.measured for s in shots if s.measured is not None]
    lengths = [s.t1 - s.t0 for s in shots]
    lumas = [m.luma.mean for m in measured]
    warmths = [m.warmth for m in measured]

    people = Counter(
        entity.id
        for shot in shots
        if shot.labelled is not None
        for entity in shot.labelled.entities
        if entity.kind == "person" and entity.p >= LABEL_MIN_P
    )

    low_quality = sorted(
        shot.shot_index
        for shot in shots
        if shot.measured is not None
        and (
            shot.measured.black or shot.measured.freeze or shot.measured.sharpness <= LOW_SHARPNESS
        )
    )

    return AssetDigest(
        asset_id=asset_id,
        content_hash=content_hash,
        duration_s=duration_s,
        shot_count=len(shots),
        median_shot_s=round(median(lengths), 3) if lengths else 0.0,
        shot_size_mix=_mix(_confident_values(shots, "shot_size")),
        setting_mix=_mix(_confident_values(shots, "setting")),
        motion_mix=_mix([m.motion.motion_class.value for m in measured]),
        # Most frequent first, then by id so two equally-seen people never swap places
        # between runs (the digest is cached by content hash and compared byte-wise).
        people=[pid for pid, _ in sorted(people.items(), key=lambda kv: (-kv[1], kv[0]))],
        exposure_range=(min(lumas), max(lumas)) if lumas else None,
        warmth_range=(min(warmths), max(warmths)) if warmths else None,
        has_speech=has_speech,
        low_quality_shots=low_quality,
        coverage=coverage_of(shots),
    )
