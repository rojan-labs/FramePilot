"""Tier 0 of the shot ledger: what one ffmpeg pass can prove about a shot (ADR 0175).

WHY: the agent has never looked at a frame in any recorded run, because looking costs a
turn and a thousand image tokens. So the facts it needs have to be waiting for it in text,
compiled once per asset. This module is the cheapest and most reliable layer of that
compilation — no key, no model, no network, no new dependency. It runs wherever ffmpeg
runs, which is everywhere, and it is the floor under every other backend.

**One decode, two chains.** Scene detection and motion need the native frame rate — at 2 fps
every frame looks like a cut and every clip looks fast, because both measures compare a frame
with the one before it — while colour statistics only need a couple of samples a second. Decoding
twice is the cost we cannot pay at library scale, so the filtergraph splits after a single
``scale=160:-2`` and maps two outputs from one input:

    [0:v]scale=160:-2,split=2[a][b];
    [a]scdet,siti,blackdetect,freezedetect,metadata@scd=mode=print[s];
    [b]fps=2,signalstats,blurdetect,metadata@st=mode=print[t]

Both metadata filters are NAMED (``metadata@scd`` / ``metadata@st``) so their lines are
telling apart in one stderr stream — the whole parse depends on it.

**Why 160 px wide.** Means and percentiles are scale-invariant to within noise, and the
downscale is what makes a ten-hour library affordable. ``tests/test_shot_stats_accuracy.py``
checks that claim against full-resolution statistics rather than assuming it.

Following the house pattern (:mod:`framepilot_engine.analysis.scenes`): the log **parser
and the fold are pure** and fully unit-testable without ffmpeg; only :func:`measure_asset`
touches a subprocess, through an injectable runner.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from pathlib import Path
from statistics import median, pstdev

from pydantic import BaseModel, Field

from framepilot_engine.media.ffmpeg import Runner, find_ffmpeg, run_logs

__all__ = [
    "BLUR_FULL",
    "SHOT_SPLIT_SECONDS",
    "STATS_FPS",
    "FrameSample",
    "MotionSample",
    "ShotStats",
    "Tier0Samples",
    "fold_shots",
    "measure_asset",
    "motion_class_for",
    "parse_tier0_logs",
    "tier0_argv",
]

# ── Constants ───────────────────────────────────────────────────────────────────────────
#
# Every threshold tier 0 depends on lives here, in one block, because they are the whole
# editorial vocabulary: "dim", "warm", "handheld" and "soft" are these numbers and nothing
# else. A threshold buried at its use site is a threshold nobody can calibrate.

#: Frames per second sampled for the statistics chain. Two is enough for per-shot means and
#: percentiles and four times cheaper than the keyframe sampler's one-JPEG-per-second.
STATS_FPS = 2.0

#: Long edge of the analysis frame. Statistics are scale-invariant; decode is not.
ANALYSIS_WIDTH = 160

#: ``scdet`` score above which a frame starts a new shot. scdet reports 0..100 (unlike the
#: 0..1 ``scene`` expression :mod:`.scenes` uses), and 10 is a hard cut rather than a fast
#: pan. Sampled at NATIVE fps, where consecutive frames are genuinely similar.
SCENE_THRESHOLD = 10.0

#: A shot longer than this is split so per-shot statistics stay local. Interviews and screen
#: recordings run for minutes with no cut, and one mean over four minutes describes nothing.
#: The split carries ``split_of=True`` so a transition policy never reads it as an edit point.
SHOT_SPLIT_SECONDS = 30.0

#: 8-bit luma range, for normalising signalstats' 0..255 values to 0..1.
_LUMA_FULL = 255.0

#: Maximum signalstats saturation: sqrt(2) * 128, the corner of the U/V plane.
_SAT_FULL = 181.02

#: Divisor mapping (V - U) onto -1..1: HALF the 8-bit chroma range.
#:
#: Calibrated on the fixtures rather than guessed. A quarter-range divisor pinned every shot
#: of `vertical-30s.mp4` at exactly -1.00 (a genuinely blue-graded clip: UAVG 162, VAVG 86,
#: so V-U = -76), which is the failure mode that matters — a saturated scale cannot tell two
#: cool shots apart, and matching one to the other is precisely what VU3 has to do. The
#: grayscale `ref/mood.png` reads UAVG = VAVG = 128 and therefore warmth exactly 0, so the
#: scale needs no offset term.
_WARMTH_FULL = 128.0

#: ``blurdetect`` reports edge width — HIGHER IS BLURRIER (verified against a `gblur` pass:
#: 4.2 sharp, 13.1 at sigma 6). Sharpness inverts it and saturates here.
BLUR_FULL = 16.0

#: Motion classes from the ``siti`` temporal-information median. A locked-off tripod sits
#: near zero; a handheld talking head runs 5-15; whip pans and fast cuts go well above.
_MOTION_SLOW_TI = 3.0
_MOTION_HANDHELD_TI = 8.0
_MOTION_FAST_TI = 15.0

# ── Log shapes ──────────────────────────────────────────────────────────────────────────
#
# Every line ffmpeg's `metadata=mode=print` emits carries its filter's instance name, which
# is why both metadata filters are named in the graph:
#   [metadata@st @ 0x…] frame:12   pts:6144    pts_time:2.5
#   [metadata@st @ 0x…] lavfi.signalstats.YAVG=76.0338
_LINE_RE = re.compile(r"^\[metadata@(?P<chain>\w+) @ [^\]]+\]\s+(?P<body>.*)$")
_FRAME_RE = re.compile(r"^frame:(?P<n>\d+)\s+pts:\S+\s+pts_time:(?P<t>-?\d+(?:\.\d+)?)")
_KV_RE = re.compile(r"^lavfi\.(?P<key>[\w.]+)=(?P<value>.*)$")


class FrameSample(BaseModel):
    """One sampled frame of the statistics chain."""

    t: float = Field(description="Presentation time in ASSET seconds.")
    y_avg: float
    y_low: float = Field(description="signalstats YLOW — the 10th percentile.")
    y_high: float = Field(description="signalstats YHIGH — the 90th percentile.")
    u_avg: float
    v_avg: float
    sat_avg: float
    blur: float = Field(default=0.0, description="Edge width; higher is blurrier.")


class MotionSample(BaseModel):
    """One native-rate frame's spatial/temporal information.

    Separate from :class:`FrameSample` because it is measured on the other chain: SI/TI
    compare a frame with the one before it, so they are only meaningful at the real frame
    interval, while the colour statistics are happy at 2 fps.
    """

    t: float
    si: float = Field(default=0.0, description="Spatial information — detail.")
    ti: float = Field(default=0.0, description="Temporal information — movement.")


class CutSample(BaseModel):
    """One frame the scene detector scored above the threshold."""

    t: float
    score: float


class Tier0Samples(BaseModel):
    """Everything one tier-0 pass observed, before it is folded into shots."""

    frames: list[FrameSample] = Field(default_factory=list)
    motion: list[MotionSample] = Field(default_factory=list)
    cuts: list[CutSample] = Field(default_factory=list)
    black_spans: list[tuple[float, float]] = Field(default_factory=list)
    freeze_spans: list[tuple[float, float]] = Field(default_factory=list)


class ShotStats(BaseModel):
    """Tier-0 facts for one shot, in the units the ledger stores.

    Normalised here rather than at the reader: `luma` and `sat` are 0..1, `warmth` is
    -1..1, `sharpness` is 0..1 where 1 is sharp. A consumer that had to remember which
    fields were 8-bit would eventually forget.
    """

    shot_index: int
    t0: float
    t1: float
    keyframe_t: float
    split_of: bool = False
    luma_mean: float
    luma_std: float
    luma_p10: float
    luma_p90: float
    u_mean: float
    v_mean: float
    sat_mean: float
    warmth: float
    contrast_idx: float
    si: float
    ti: float
    motion_class: str
    cut_score: float
    black: bool
    freeze: bool
    sharpness: float


def motion_class_for(ti: float) -> str:
    """Name the movement in a shot from its temporal-information median.

    :param ti: Median ``siti`` TI over the shot.
    :returns: One of ``static``/``slow``/``handheld``/``fast``.
    """
    if ti < _MOTION_SLOW_TI:
        return "static"
    if ti < _MOTION_HANDHELD_TI:
        return "slow"
    if ti < _MOTION_FAST_TI:
        return "handheld"
    return "fast"


def _to_float(raw: str) -> float | None:
    try:
        return float(raw.strip())
    except ValueError:
        return None


def parse_tier0_logs(logs: str) -> Tier0Samples:
    """Reduce one tier-0 pass's stderr to typed samples (pure).

    Both chains interleave in one stream, so each line is routed by its filter instance
    name. A malformed or truncated line is skipped rather than raising: a partially
    readable pass still produces most of a ledger, and a ledger is an optimization.

    :param logs: Combined ffmpeg stderr.
    :returns: Frame statistics, scene-cut candidates, and black/freeze spans.
    """
    frames: list[FrameSample] = []
    motion: list[MotionSample] = []
    cuts: list[CutSample] = []
    black: list[tuple[float, float]] = []
    freeze: list[tuple[float, float]] = []
    # Per chain: the time of the frame whose key/value lines are currently being read.
    current_t: dict[str, float] = {}
    pending: dict[str, dict[str, float]] = {"st": {}, "scd": {}}
    open_black: float | None = None
    open_freeze: float | None = None

    def flush_stats() -> None:
        values = pending["st"]
        t = current_t.get("st")
        if t is None or "signalstats.YAVG" not in values:
            return
        frames.append(
            FrameSample(
                t=t,
                y_avg=values["signalstats.YAVG"],
                y_low=values.get("signalstats.YLOW", values["signalstats.YAVG"]),
                y_high=values.get("signalstats.YHIGH", values["signalstats.YAVG"]),
                u_avg=values.get("signalstats.UAVG", 128.0),
                v_avg=values.get("signalstats.VAVG", 128.0),
                sat_avg=values.get("signalstats.SATAVG", 0.0),
                blur=values.get("blur", 0.0),
            )
        )

    def flush_motion() -> None:
        values = pending["scd"]
        t = current_t.get("scd")
        if t is None or "siti.ti" not in values:
            return
        motion.append(MotionSample(t=t, si=values.get("siti.si", 0.0), ti=values["siti.ti"]))

    for line in logs.splitlines():
        match = _LINE_RE.match(line.strip())
        if match is None:
            continue
        chain = match.group("chain")
        body = match.group("body")
        frame_match = _FRAME_RE.match(body)
        if frame_match is not None:
            if chain == "st":
                flush_stats()
            else:
                flush_motion()
            pending[chain] = {}
            current_t[chain] = max(0.0, float(frame_match.group("t")))
            continue
        kv = _KV_RE.match(body)
        if kv is None:
            continue
        key = kv.group("key")
        value = _to_float(kv.group("value"))
        if value is None:
            continue
        if chain == "st":
            pending["st"][key] = value
            continue
        # The detection chain: cuts and the black/freeze spans, all keyed on their own
        # reported time rather than the frame header, because ffmpeg reports the span
        # boundary itself and it is more precise than the frame it happened to land on.
        if key.startswith("siti."):
            pending["scd"][key] = value
        elif key == "scd.time":
            score = pending["scd"].get("scd.score", 0.0)
            cuts.append(CutSample(t=max(0.0, value), score=score))
        elif key == "scd.score":
            pending["scd"]["scd.score"] = value
        elif key == "black_start":
            open_black = max(0.0, value)
        elif key == "black_end" and open_black is not None:
            black.append((open_black, max(0.0, value)))
            open_black = None
        elif key == "freezedetect.freeze_start":
            open_freeze = max(0.0, value)
        elif key == "freezedetect.freeze_end" and open_freeze is not None:
            freeze.append((open_freeze, max(0.0, value)))
            open_freeze = None

    flush_stats()
    flush_motion()
    # A span still open at EOF runs to the end of what we saw. Dropping it would lose the
    # most common case of all: a file that fades to black and stops.
    last_t = frames[-1].t if frames else 0.0
    if open_black is not None:
        black.append((open_black, max(open_black, last_t)))
    if open_freeze is not None:
        freeze.append((open_freeze, max(open_freeze, last_t)))
    return Tier0Samples(
        frames=frames, motion=motion, cuts=cuts, black_spans=black, freeze_spans=freeze
    )


def _overlaps(spans: Sequence[tuple[float, float]], t0: float, t1: float) -> bool:
    """Does any span cover the MIDDLE of [t0, t1)?

    The midpoint, not any overlap: a shot that merely touches the tail of a fade-out is
    not a black shot, and flagging it would make "drop the black clips" delete real
    footage.
    """
    mid = (t0 + t1) / 2.0
    return any(start <= mid < end for start, end in spans)


def shot_boundaries(
    cut_times: Sequence[float],
    duration: float,
    *,
    split_seconds: float = SHOT_SPLIT_SECONDS,
) -> list[tuple[float, float, bool]]:
    """Turn cut times into ``(t0, t1, split_of)`` spans covering the whole asset (pure).

    Cuts at or beyond the duration, and cuts closer together than one statistics sample,
    are dropped: they would produce a shot with nothing measurable in it.

    :param cut_times: Scene-cut times in asset seconds, any order.
    :param duration: Asset duration in seconds.
    :param split_seconds: Maximum shot length before a duration split is inserted.
    :returns: Contiguous spans in time order; the last ends exactly at ``duration``.
    """
    min_gap = 1.0 / STATS_FPS
    starts = [0.0]
    for t in sorted(cut_times):
        if t <= 0.0 or t >= duration:
            continue
        if t - starts[-1] < min_gap:
            continue
        starts.append(t)
    spans: list[tuple[float, float, bool]] = []
    for index, start in enumerate(starts):
        end = starts[index + 1] if index + 1 < len(starts) else duration
        # A scene-bounded span longer than the split budget becomes several shots. The
        # FIRST keeps `split_of=False` (it really does start at a cut); the rest are marked.
        cursor = start
        first = True
        while end - cursor > split_seconds:
            spans.append((cursor, cursor + split_seconds, not first))
            cursor += split_seconds
            first = False
        if end > cursor or not spans:
            spans.append((cursor, max(end, cursor), not first))
    return spans


def fold_shots(
    samples: Tier0Samples,
    duration: float,
    *,
    is_image: bool = False,
) -> list[ShotStats]:
    """Fold per-frame samples into per-shot statistics (pure).

    A shot with no sampled frame inside it (shorter than one sample interval, or a decode
    gap) is still emitted, carrying the nearest frame's values, because the ledger's shot
    indices must line up with the asset's real structure — a missing row would silently
    renumber everything after it.

    :param samples: What :func:`parse_tier0_logs` read.
    :param duration: Asset duration in seconds.
    :param is_image: A still is exactly one shot with no motion, whatever the sampler saw.
    :returns: One :class:`ShotStats` per shot, in time order.
    """
    frames = samples.frames
    if not frames:
        return []
    spans = (
        [(0.0, max(duration, 1e-3), False)]
        if is_image
        else shot_boundaries([c.t for c in samples.cuts], duration)
    )
    cut_score_at = {round(c.t, 3): c.score for c in samples.cuts}

    out: list[ShotStats] = []
    for index, (t0, t1, split_of) in enumerate(spans):
        inside = [f for f in frames if t0 <= f.t < t1]
        if not inside:
            nearest = min(frames, key=lambda f: min(abs(f.t - t0), abs(f.t - t1)))
            inside = [nearest]
        y = [f.y_avg for f in inside]
        luma_mean = sum(y) / len(y) / _LUMA_FULL
        luma_std = (pstdev(y) if len(y) > 1 else 0.0) / _LUMA_FULL
        p10 = median([f.y_low for f in inside]) / _LUMA_FULL
        p90 = median([f.y_high for f in inside]) / _LUMA_FULL
        u_mean = sum(f.u_avg for f in inside) / len(inside)
        v_mean = sum(f.v_avg for f in inside) / len(inside)
        sat_mean = sum(f.sat_avg for f in inside) / len(inside) / _SAT_FULL
        warmth = max(-1.0, min(1.0, (v_mean - u_mean) / _WARMTH_FULL))
        # TI on the FIRST frame of a shot measures the CUT — the difference across the
        # boundary — not the shot's own movement, so it is dropped whenever the shot has
        # another frame to speak for it. Without this every shot after a hard cut reads
        # "fast".
        in_motion = [m for m in samples.motion if t0 <= m.t < t1]
        moving = in_motion[1:] if len(in_motion) > 1 else in_motion
        ti = median([m.ti for m in moving]) if moving else 0.0
        si = median([m.si for m in in_motion]) if in_motion else 0.0
        blur = median([f.blur for f in inside])
        out.append(
            ShotStats(
                shot_index=index,
                t0=t0,
                t1=t1,
                keyframe_t=min(t1 - 1e-3, t0 + (t1 - t0) / 2.0) if t1 > t0 else t0,
                split_of=split_of,
                luma_mean=luma_mean,
                luma_std=luma_std,
                luma_p10=p10,
                luma_p90=p90,
                u_mean=u_mean,
                v_mean=v_mean,
                sat_mean=sat_mean,
                warmth=warmth,
                contrast_idx=max(0.0, p90 - p10),
                si=si,
                ti=0.0 if is_image else ti,
                motion_class="static" if is_image else motion_class_for(ti),
                cut_score=cut_score_at.get(round(t0, 3), 0.0),
                black=_overlaps(samples.black_spans, t0, t1),
                freeze=_overlaps(samples.freeze_spans, t0, t1),
                sharpness=max(0.0, min(1.0, 1.0 - blur / BLUR_FULL)),
            )
        )
    return out


def tier0_argv(
    ffmpeg: str,
    path: Path,
    *,
    width: int = ANALYSIS_WIDTH,
    scene_threshold: float = SCENE_THRESHOLD,
    stats_fps: float = STATS_FPS,
) -> list[str]:
    """The single-decode tier-0 command (pure, so the graph itself is testable).

    :param ffmpeg: Resolved ffmpeg binary.
    :param path: Media file, already sandbox-resolved.
    :param width: Analysis frame width; height follows the aspect ratio.
    :param scene_threshold: ``scdet`` score above which a frame starts a new shot.
    :param stats_fps: Sampling rate of the statistics chain.
    :returns: A full argument vector writing both chains' metadata to stderr.
    """
    graph = (
        f"[0:v]scale={width}:-2,split=2[a][b];"
        f"[a]scdet=threshold={scene_threshold},"
        "siti,"
        "blackdetect=d=0.1:pic_th=0.98,"
        "freezedetect=n=-60dB:d=0.5,"
        "metadata@scd=mode=print[s];"
        f"[b]fps={stats_fps},signalstats,blurdetect,metadata@st=mode=print[t]"
    )
    return [
        ffmpeg,
        "-hide_banner",
        "-nostats",
        "-i",
        str(path),
        "-an",
        "-filter_complex",
        graph,
        "-map",
        "[s]",
        "-f",
        "null",
        "-",
        "-map",
        "[t]",
        "-f",
        "null",
        "-",
    ]


def measure_asset(
    path: Path,
    *,
    duration: float,
    is_image: bool = False,
    runner: Runner | None = None,
    timeout: float | None = 300.0,
) -> list[ShotStats]:
    """Measure one asset's shots with a single ffmpeg decode.

    :param path: Media file to measure (assumed already sandbox-resolved).
    :param duration: Asset duration in seconds, from the probe.
    :param is_image: A still: one shot, no motion.
    :param runner: ffmpeg stderr runner; defaults to the real subprocess runner.
    :param timeout: Per-call timeout in seconds; a long asset needs more than the 60s the
        lighter analyzers use.
    :returns: Tier-0 statistics per shot, in time order.
    :raises FFmpegError: If the pass cannot run at all.
    """
    invoke = runner or (lambda argv: run_logs(argv, timeout=timeout))
    logs = invoke(tier0_argv(find_ffmpeg(), path))
    return fold_shots(parse_tier0_logs(logs), duration, is_image=is_image)
