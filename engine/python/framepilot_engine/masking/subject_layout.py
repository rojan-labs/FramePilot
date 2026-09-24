"""Where the cut-out subject sits on the delivered frame, measured from its matte.

WHY THIS EXISTS

The agent places captions, titles and "text behind the subject" by numbers (``yPercent``,
``fontSizePercent``), and until now nothing told it where the person on screen actually is.
The captured desktop runs of 2026-09-23 show the cost: a "MOTION" title set at 20 % of the
frame height ran out of both sides of a 9:16 frame, then at 11 % it sat exactly on the
speaker's eyes, so his head hid the middle three letters and the word read "M… ON"; captions
were moved to "the top" and "the centre" of shots whose top was his forehead. Every one of
those choices was made blind.

A cut-out already exists for every "text behind the subject" edit, and its matte IS the
answer: a per-frame alpha of exactly the subject. This module samples that matte across a
time range, maps each sample through the clip's crop and its keyframed placement onto the
OUTPUT frame (the same :func:`~framepilot_engine.render.compiler.picture_placement_at` the
compiler composites with), and reports the geometry in frame fractions:

* the subject's box, its union over the range, and how high it reaches (its head);
* how much of the frame's width it covers in each horizontal band — where text would sit
  on the person and where it would not;
* the shoulder line, below which a caption covers the body rather than the face;
* for a title of a given rendered size, the height at which it reads as BEHIND the subject
  (partly covered, both ends visible) rather than hidden by it or floating clear of it.

It measures and suggests; it never edits. Pure numpy over frames the export's own
:class:`~framepilot_engine.render.mattes.MatteReader` decodes, so the geometry is the
geometry the render will draw.
"""

from __future__ import annotations

import logging
import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import numpy.typing as npt

from framepilot_engine.render.compiler import picture_placement_at
from framepilot_engine.render.mattes import MatteReader, MatteRefusal, prepare_matte
from framepilot_engine.timeline.models import Clip, Project

_log = logging.getLogger(__name__)

__all__ = [
    "DEFAULT_SAMPLES",
    "MAX_SAMPLES",
    "BandCoverage",
    "SubjectLayout",
    "SubjectLayoutError",
    "SubjectSample",
    "TextBehindPlacement",
    "measure_subject_layout",
    "solve_text_behind",
]

#: Samples across the measured range when the caller does not say. Six moments of a
#: talking head already bound how far the head travels; more buys little and costs a decode each.
DEFAULT_SAMPLES = 6
#: Hard cap: each sample decodes one full-resolution matte frame.
MAX_SAMPLES = 24
#: Rows of the coverage grid laid over the output frame. One row is ~1 % of the frame height,
#: which is finer than any placement decision this feeds (text is placed in whole percents).
GRID_ROWS = 96
#: A matte pixel at or above this fraction of its maximum is subject.
SUBJECT_THRESHOLD = 0.5
#: Horizontal bands reported to the model: ten bands of 10 % of the frame height. Coarse on
#: purpose — it is read by a person-like reasoner, not a solver.
REPORT_BANDS = 10
#: Width covered, as a multiple of the head's own width, that marks the shoulders.
SHOULDER_WIDTH_RATIO = 1.8
#: A title "behind" the subject should be partly covered: less than this and it floats clear
#: of the person (it is simply in front of the background); more and the word stops reading.
BEHIND_MIN_OCCLUSION = 0.12
BEHIND_MAX_OCCLUSION = 0.42
#: The occlusion aimed for inside that band: enough to read as depth, little enough to read.
BEHIND_TARGET_OCCLUSION = 0.28
#: The left and right ends of a title (this fraction of its width each) must stay visible for
#: the word to read; the subject may cover the middle.
TITLE_END_FRACTION = 0.18
#: Title centre heights the solver considers, as frame fractions (the upper 70 % of the frame).
SOLVER_TOP = 0.05
SOLVER_BOTTOM = 0.7
SOLVER_STEP = 0.005
#: Horizontal steps for the title centre. A behind-the-subject word is centred on the PERSON:
#: a speaker left of centre in a 9:16 crop covers one end of any frame-centred word.
SOLVER_X_STEP = 0.01
#: A picture larger than the frame by this factor on both axes is punched in: easing that zoom
#: shows more of the shot rather than bars.
PUNCH_IN_SCALE = 1.02
#: Space kept clear at each side of the frame, matching the 92 % title-safe width.
TITLE_SIDE_MARGIN = 0.04


class SubjectLayoutError(ValueError):
    """The layout cannot be measured; the message says why and what to do instead."""


@dataclass(frozen=True)
class SubjectSample:
    """The subject at one timeline instant, in output-frame fractions (origin top-left)."""

    time: float
    #: ``(x0, y0, x1, y1)``; ``None`` when the subject is not in frame at all.
    box: tuple[float, float, float, float] | None
    #: Fraction of the whole frame the subject covers.
    area: float


@dataclass(frozen=True)
class BandCoverage:
    """One horizontal band of the frame and the most of its width the subject ever covers."""

    top: float
    bottom: float
    #: Largest fraction of the frame WIDTH covered in this band at any sample.
    width_covered: float
    #: Leftmost and rightmost covered x over the range, or ``None`` when the band stays clear.
    span: tuple[float, float] | None


@dataclass(frozen=True)
class TextBehindPlacement:
    """Where a title of a given size reads as behind the subject."""

    #: Title box centre, percent of the frame height (the ``yPercent`` a text clip takes).
    y_percent: float
    #: Fraction of the title's box the subject covers at the worst sample.
    occluded: float
    #: Whether both ends of the word stay uncovered at every sample.
    ends_visible: bool
    #: One sentence for the model: why this height, or why no height works.
    note: str
    #: Title box centre, percent of the frame width (the ``xPercent`` a text clip takes).
    x_percent: float = 50.0
    #: Whether this placement reads as behind the subject. ``False`` is the best fallback,
    #: returned with a note saying what to change.
    reads_behind: bool = False
    #: Which way the title's width would have to go for a placement to exist: ``"wider"``
    #: (its ends meet the subject, or it is buried) or ``"narrower"`` (the subject is too
    #: small to cover enough of it). ``None`` when it already reads as behind.
    wants: str | None = None


@dataclass(frozen=True)
class SubjectLayout:
    """The measured geometry of one clip's cut-out subject over a timeline range."""

    clip_id: str
    mask_id: str
    start: float
    end: float
    samples: tuple[SubjectSample, ...]
    #: Median box over the samples — where the subject usually is.
    box: tuple[float, float, float, float] | None
    #: Union of every sample's box — everywhere the subject reaches.
    reach: tuple[float, float, float, float] | None
    #: Highest point the subject reaches (top of the head), frame fraction.
    head_top: float | None
    #: Where the subject widens into shoulders; text above it and below ``head_top`` is on
    #: the face. ``None`` when no widening is measured (e.g. a full body shot of a small figure).
    shoulders: float | None
    bands: tuple[BandCoverage, ...]
    text_behind: TextBehindPlacement | None = None
    #: The coverage grid (rows x cols, max over samples), for the solver. Not serialized.
    grid: npt.NDArray[np.float32] = field(
        repr=False, compare=False, default_factory=lambda: np.zeros((0, 0), np.float32)
    )
    #: Every sample's own coverage grid, so a caller can re-solve for another title size
    #: without decoding the matte again. Not serialized.
    grids: tuple[npt.NDArray[np.float32], ...] = field(repr=False, compare=False, default=())


def _matte_mask(clip: Clip, mask_id: str | None) -> Any:
    """The enabled alpha-target matte on ``clip`` that is its subject."""
    for mask in clip.masks or []:
        if getattr(mask, "kind", None) != "matte" or not mask.enabled:
            continue
        if getattr(mask.target, "kind", "alpha") != "alpha":
            continue
        if mask_id is None or str(mask.id) == mask_id:
            return mask
    raise SubjectLayoutError(
        f"Clip {clip.id!r} has no cut-out to measure. Remove its background first "
        "(remove_background), or look at a frame with get_frame."
    )


#: Combine modes that, as the only mask, draw what the matte keeps: a stack starts empty
#: (ADR 0178), so subtract/intersect/darken from nothing are nothing. Mirrors
#: ``cutoutHidesSubject`` in ``editor-core/mask-operations.ts``.
MODES_THAT_DRAW_ALONE = frozenset({"add", "difference", "lighten"})


#: Step, in percent of the frame height, between the title sizes a resize search tries.
RESIZE_STEP_PERCENT = 0.5
#: The most sizes a resize search tries in one direction: each is a raster and a solve.
MAX_RESIZE_STEPS = 24


def search_behind_size(
    grids: Sequence[npt.NDArray[np.float32]],
    box_at: Callable[[float], tuple[float, float]],
    size: float,
    *,
    wants: str,
    smallest: float,
    largest: float,
) -> tuple[float, TextBehindPlacement, tuple[float, float]] | None:
    """The size nearest ``size``, in the direction ``wants``, at which the title reads behind.

    :param grids: The per-sample coverage grids of a measured layout.
    :param box_at: The title's rendered ``(width, height)`` as frame fractions at a size.
    :param size: The size the title was measured at, percent of the frame height.
    :param wants: ``"wider"`` searches larger sizes, ``"narrower"`` smaller ones.
    :param smallest: The smallest size worth trying.
    :param largest: The largest size that still fits the frame.
    :returns: ``(size, placement, box)``, or ``None`` when no size in reach works.
    """
    step = RESIZE_STEP_PERCENT if wants == "wider" else -RESIZE_STEP_PERCENT
    candidate = size
    for _ in range(MAX_RESIZE_STEPS):
        candidate = round(candidate + step, 1)
        if candidate > largest + 1e-9 or candidate < smallest - 1e-9:
            return None
        box = box_at(candidate)
        placement = solve_text_behind(grids, box[0], box[1])
        if placement.reads_behind:
            return candidate, placement, box
    return None


def _cutout_hides_subject(mask: Any) -> str | None:
    """Why ``mask`` would not draw its subject, or ``None`` when it does.

    The geometry below reads the raw matte; a cut-out switched to Subtract or inverted in the
    Inspector draws nothing (or the background) on the delivered frame, so measuring the raw
    matte would describe a subject the export never shows.
    """
    mode = str(getattr(mask.mode, "value", mask.mode))
    if mode not in MODES_THAT_DRAW_ALONE:
        return f"is set to {mode}"
    if mask.invert:
        return "is inverted"
    if mask.opacity <= 0:
        return "has no opacity"
    return None


def _find_clip(project: Project, clip_id: str) -> Clip:
    for track in project.timeline.tracks:
        for clip in track.clips:
            if clip.id == clip_id:
                return clip
    raise SubjectLayoutError(f"Unknown clip {clip_id!r}.")


def _sample_times(start: float, end: float, count: int) -> list[float]:
    """``count`` instants spread evenly INSIDE ``[start, end)`` (never on the cut itself)."""
    span = max(0.0, end - start)
    return [start + span * (index + 0.5) / count for index in range(count)]


def _nearest_matte_index(reader: MatteReader, source_seconds: float) -> int:
    """The matte frame nearest to asset second ``source_seconds``, clamped into the artifact."""
    frames = reader.prepared.frames
    first = frames.source_seconds(0)
    last = frames.source_seconds(frames.count - 1)
    if frames.count == 1 or source_seconds <= first:
        return 0
    if source_seconds >= last:
        return frames.count - 1
    step = (last - first) / (frames.count - 1)
    guess = round((source_seconds - first) / step)
    return max(0, min(frames.count - 1, guess))


def _grid_cols(target: tuple[int, int]) -> int:
    width, height = target
    return max(1, round(GRID_ROWS * width / height))


def _coverage_on_frame(
    alpha: npt.NDArray[np.float32],
    crop: tuple[float, float, float, float],
    placement: Any,
    target: tuple[int, int],
) -> npt.NDArray[np.float32]:
    """Subject coverage (0/1) of each grid cell of the OUTPUT frame at one instant.

    Each cell centre is mapped back through the clip's placement into the cropped picture,
    then into the matte, and reads the matte there. Nearest-neighbour: this is geometry for
    placement decisions, not a render.
    """
    rows, cols = GRID_ROWS, _grid_cols(target)
    target_w, target_h = target
    crop_x, crop_y, crop_w, crop_h = crop
    matte_h, matte_w = alpha.shape
    ys = (np.arange(rows, dtype=np.float64) + 0.5) / rows * target_h
    xs = (np.arange(cols, dtype=np.float64) + 0.5) / cols * target_w
    # Output pixel → fraction of the placed (cropped, scaled) picture.
    u = (xs - placement.x) / max(1, placement.width)
    v = (ys - placement.y) / max(1, placement.height)
    # Fraction of the cropped picture → fraction of the full source → matte pixel.
    mx = np.floor((crop_x + u * crop_w) * matte_w).astype(np.int64)
    my = np.floor((crop_y + v * crop_h) * matte_h).astype(np.int64)
    inside_x = (u >= 0) & (u < 1) & (mx >= 0) & (mx < matte_w)
    inside_y = (v >= 0) & (v < 1) & (my >= 0) & (my < matte_h)
    grid = np.zeros((rows, cols), dtype=np.float32)
    if not inside_x.any() or not inside_y.any():
        return grid
    sub = alpha[np.ix_(my[inside_y], mx[inside_x])]
    grid[np.ix_(np.nonzero(inside_y)[0], np.nonzero(inside_x)[0])] = (
        sub >= SUBJECT_THRESHOLD
    ).astype(np.float32)
    return grid


def _box_of(grid: npt.NDArray[np.float32]) -> tuple[float, float, float, float] | None:
    rows, cols = grid.shape
    covered_rows = np.nonzero(grid.any(axis=1))[0]
    covered_cols = np.nonzero(grid.any(axis=0))[0]
    if covered_rows.size == 0:
        return None
    return (
        float(covered_cols[0]) / cols,
        float(covered_rows[0]) / rows,
        float(covered_cols[-1] + 1) / cols,
        float(covered_rows[-1] + 1) / rows,
    )


def _median_box(
    boxes: Sequence[tuple[float, float, float, float]],
) -> tuple[float, float, float, float] | None:
    if not boxes:
        return None
    columns = np.asarray(boxes, dtype=np.float64)
    x0, y0, x1, y1 = (float(value) for value in np.median(columns, axis=0))
    return (x0, y0, x1, y1)


def _union_box(
    boxes: Sequence[tuple[float, float, float, float]],
) -> tuple[float, float, float, float] | None:
    if not boxes:
        return None
    return (
        min(box[0] for box in boxes),
        min(box[1] for box in boxes),
        max(box[2] for box in boxes),
        max(box[3] for box in boxes),
    )


def _bands(grid: npt.NDArray[np.float32]) -> tuple[BandCoverage, ...]:
    rows, cols = grid.shape
    bands: list[BandCoverage] = []
    for band in range(REPORT_BANDS):
        top_row = band * rows // REPORT_BANDS
        bottom_row = (band + 1) * rows // REPORT_BANDS
        block = grid[top_row:bottom_row]
        width_covered = float(block.sum(axis=1).max()) / cols if block.size else 0.0
        covered_cols = np.nonzero(block.any(axis=0))[0]
        span = (
            (float(covered_cols[0]) / cols, float(covered_cols[-1] + 1) / cols)
            if covered_cols.size
            else None
        )
        bands.append(
            BandCoverage(
                top=top_row / rows,
                bottom=bottom_row / rows,
                width_covered=round(width_covered, 3),
                span=span,
            )
        )
    return tuple(bands)


def _shoulders(grid: npt.NDArray[np.float32]) -> float | None:
    """The first row, below the head, where the subject is much wider than the head.

    The head is measured over the rows just under its top (the widest of the first ~8 % of
    the subject's height), so a tilt or a raised hand at the very top does not set it.
    """
    rows = grid.shape[0]
    widths = grid.sum(axis=1)
    covered = np.nonzero(widths > 0)[0]
    if covered.size < 4:
        return None
    top = int(covered[0])
    head_rows = max(2, round(0.08 * (int(covered[-1]) - top + 1)))
    head_width = float(widths[top : top + head_rows].max())
    if head_width <= 0:
        return None
    for row in range(top + head_rows, int(covered[-1]) + 1):
        if widths[row] >= SHOULDER_WIDTH_RATIO * head_width:
            return float(row) / float(rows)
    return None


def _integral(grid: npt.NDArray[np.float32]) -> npt.NDArray[np.float64]:
    """Summed-area table of ``grid`` with a zero first row and column."""
    table = np.zeros((grid.shape[0] + 1, grid.shape[1] + 1), dtype=np.float64)
    table[1:, 1:] = grid.astype(np.float64).cumsum(axis=0).cumsum(axis=1)
    return table


def _block_sum(table: npt.NDArray[np.float64], y0: int, y1: int, x0: int, x1: int) -> float:
    """Covered cells in rows ``[y0, y1)`` and columns ``[x0, x1)``."""
    return float(table[y1, x1] - table[y0, x1] - table[y1, x0] + table[y0, x0])


def _x_centres(text_width: float) -> list[float]:
    """Title centres that keep the box inside the title-safe width, frame centre included."""
    low = text_width / 2 + TITLE_SIDE_MARGIN
    high = 1.0 - text_width / 2 - TITLE_SIDE_MARGIN
    if high <= low:
        return [0.5]
    count = math.floor((high - low) / SOLVER_X_STEP + 1e-9)
    return sorted({0.5, *(round(low + i * SOLVER_X_STEP, 4) for i in range(count + 1))})


def solve_text_behind(
    grids: Sequence[npt.NDArray[np.float32]],
    text_width: float,
    text_height: float,
    *,
    punched_in: bool = True,
) -> TextBehindPlacement:
    """Where a ``text_width`` x ``text_height`` title box reads as BEHIND the subject.

    Every candidate centre (height in the upper frame, horizontal position inside the
    title-safe width) is scored by the worst sample's occlusion of the box, and both ENDS of the
    word must stay clear. Among the positions whose occlusion falls in
    ``[BEHIND_MIN_OCCLUSION, BEHIND_MAX_OCCLUSION]`` with visible ends, the one nearest the frame
    centre wins, then the occlusion nearest :data:`BEHIND_TARGET_OCCLUSION`, then the higher one
    (titles live in the upper part of a talking-head shot). A word moves off-centre only as far
    as the subject makes it. When nothing qualifies, the readable position nearest that band
    is returned — whichever side it misses on — and the note says what to change.

    :param grids: Per-sample coverage grids over the output frame.
    :param text_width: Title box width, fraction of the frame width.
    :param text_height: Title box height, fraction of the frame height.
    :param punched_in: Whether the picture is scaled past filling the frame on this stretch,
        so easing the zoom would make room beside the head. At its widest, zooming out only
        adds bars, and the note says to put the title in front instead.
    """
    if not grids:
        raise SubjectLayoutError("No samples to place the title against.")
    rows, cols = grids[0].shape
    tables = [_integral(grid) for grid in grids]
    half = text_height / 2
    heights: list[float] = []
    centre = max(SOLVER_TOP, half)
    while centre <= min(SOLVER_BOTTOM, 1.0 - half) + 1e-9:
        heights.append(centre)
        centre += SOLVER_STEP
    # (x centre, y centre, worst occlusion, ends clear)
    candidates: list[tuple[float, float, float, bool]] = []
    for x_centre in _x_centres(text_width):
        x0 = max(0, math.floor((x_centre - text_width / 2) * cols))
        x1 = min(cols, math.ceil((x_centre + text_width / 2) * cols))
        if x1 <= x0:
            continue
        end_cols = max(1, round(TITLE_END_FRACTION * (x1 - x0)))
        for y_centre in heights:
            y0 = max(0, math.floor((y_centre - half) * rows))
            y1 = min(rows, max(y0 + 1, math.ceil((y_centre + half) * rows)))
            area = float((y1 - y0) * (x1 - x0))
            worst = 0.0
            ends_clear = True
            for table in tables:
                worst = max(worst, _block_sum(table, y0, y1, x0, x1) / area)
                if (
                    _block_sum(table, y0, y1, x0, x0 + end_cols) > 0
                    or _block_sum(table, y0, y1, x1 - end_cols, x1) > 0
                ):
                    ends_clear = False
            candidates.append((x_centre, y_centre, worst, ends_clear))

    def off_centre(candidate: tuple[float, float, float, bool]) -> int:
        return round(abs(candidate[0] - 0.5) / SOLVER_X_STEP)

    behind = [
        c for c in candidates if c[3] and BEHIND_MIN_OCCLUSION <= c[2] <= BEHIND_MAX_OCCLUSION
    ]
    if behind:
        best = min(behind, key=lambda c: (off_centre(c), abs(c[2] - BEHIND_TARGET_OCCLUSION), c[1]))
        where = (
            f"At {best[1] * 100:.0f}% down"
            if off_centre(best) == 0
            else f"Centred {best[0] * 100:.0f}% across (on the subject, not the frame) and "
            f"{best[1] * 100:.0f}% down"
        )
        return TextBehindPlacement(
            y_percent=round(best[1] * 100, 1),
            x_percent=round(best[0] * 100, 1),
            occluded=round(best[2], 3),
            ends_visible=True,
            reads_behind=True,
            note=(
                f"{where}, the subject covers about {best[2] * 100:.0f}% of the title and both "
                "ends stay visible, so it reads as behind them."
            ),
        )
    readable = [c for c in candidates if c[3]]
    if readable:
        best = min(readable, key=lambda c: (_distance_from_behind(c[2]), off_centre(c), c[1]))
        # Where the subject covers enough of the word but always reaches an end, the word is
        # narrower than the subject is wide there: it needs to be WIDER, not smaller.
        ends_block = any(c[2] >= BEHIND_MIN_OCCLUSION and not c[3] for c in candidates)
        if best[2] > BEHIND_MAX_OCCLUSION:
            wants = "wider"
            why = (
                "the subject covers too much of the title everywhere its ends stay clear. "
                "Try a wider word or a larger size, so more of it shows beside them"
            )
        elif ends_block:
            wants = "wider"
            why = (
                "wherever the word overlaps the subject enough, the subject reaches one of its "
                "ends: the word is narrower than they are wide there. A larger size or a longer "
                "word clears them"
            )
        else:
            wants = "narrower"
            why = (
                "the subject barely overlaps the title anywhere it stays readable, so it will "
                "read as floating in front of the background rather than behind them. Try a "
                "shorter word or a smaller size, so the subject covers more of it"
            )
        return TextBehindPlacement(
            y_percent=round(best[1] * 100, 1),
            x_percent=round(best[0] * 100, 1),
            occluded=round(best[2], 3),
            ends_visible=True,
            note=f"No position reads cleanly as behind: {why}.",
            wants=wants,
        )
    best = min(candidates, key=lambda c: (c[2], off_centre(c), c[1]))
    return TextBehindPlacement(
        y_percent=round(best[1] * 100, 1),
        x_percent=round(best[0] * 100, 1),
        occluded=round(best[2], 3),
        ends_visible=False,
        wants="wider",
        note=(
            "The subject covers an end of the title wherever it is placed: the person fills too "
            "much of the frame's width for a word to read behind them. "
            + (
                "Ease the punch-in on this stretch (scale the cut-out and its background "
                "together) so there is room beside the head, or put the title in front of them."
                if punched_in
                else "The shot is already at its widest — zooming out would only add bars — so "
                "put the title in front of them (above the head or in the lower third), or use "
                "a wider shot."
            )
        ),
    )


def _distance_from_behind(occluded: float) -> float:
    """How far an occlusion falls outside the band that reads as behind (0 inside it)."""
    if occluded < BEHIND_MIN_OCCLUSION:
        return BEHIND_MIN_OCCLUSION - occluded
    return max(0.0, occluded - BEHIND_MAX_OCCLUSION)


def measure_subject_layout(
    project: Project,
    base_dir: Path,
    clip_id: str,
    *,
    start: float | None = None,
    end: float | None = None,
    samples: int = DEFAULT_SAMPLES,
    mask_id: str | None = None,
    text_box: tuple[float, float] | None = None,
) -> SubjectLayout:
    """Measure where ``clip_id``'s cut-out subject sits on the output frame over a range.

    :param project: The working project (assets must carry ``media`` sizes).
    :param base_dir: The project directory the matte artifact lives under.
    :param clip_id: A clip carrying an enabled matte (a removed background).
    :param start: Timeline second the range starts (default: the clip's start).
    :param end: Timeline second the range ends (default: the clip's end).
    :param samples: How many instants to sample, clamped to ``[1, MAX_SAMPLES]``.
    :param mask_id: A specific matte; default the clip's first enabled alpha matte.
    :param text_box: ``(width, height)`` of a title as frame fractions; when given, the
        layout carries a :class:`TextBehindPlacement` for it.
    :raises SubjectLayoutError: No matte, an unmeasured asset, a range outside the clip, or an
        artifact the export would refuse.
    """
    clip = _find_clip(project, clip_id)
    mask = _matte_mask(clip, mask_id)
    hidden = _cutout_hides_subject(mask)
    if hidden is not None:
        raise SubjectLayoutError(
            f"The cut-out on clip {clip_id!r} {hidden}, so the subject is not drawn on the "
            'frame. Set it back to add, not inverted (refine_mask with mode "add" and invert '
            "false), then measure again."
        )
    asset = next((a for a in project.assets if a.id == clip.asset_id), None)
    media = asset.media if asset is not None else None
    if media is None or media.display_size() is None:
        raise SubjectLayoutError(
            f"The picture size of clip {clip_id!r}'s media was never measured, so its cut-out "
            "cannot be placed on the frame."
        )
    lo = clip.start if start is None else max(clip.start, float(start))
    hi = clip.end if end is None else min(clip.end, float(end))
    if hi <= lo:
        raise SubjectLayoutError(
            f"The range {lo:.2f}-{hi:.2f}s is outside clip {clip_id!r} "
            f"({clip.start:.2f}-{clip.end:.2f}s)."
        )
    try:
        prepared = prepare_matte(mask, clip, base_dir, media, float(project.fps or 30))
    except MatteRefusal as exc:
        raise SubjectLayoutError(str(exc)) from exc
    target = (int(project.resolution.width), int(project.resolution.height))
    crop = (
        (clip.crop.x, clip.crop.y, clip.crop.width, clip.crop.height)
        if clip.crop is not None
        else (0.0, 0.0, 1.0, 1.0)
    )
    display_w, display_h = media.display_size() or (1.0, 1.0)
    picture_size = (
        max(1, round(display_w * crop[2])),
        max(1, round(display_h * crop[3])),
    )
    speed = clip.speed if clip.speed else 1.0
    count = max(1, min(MAX_SAMPLES, int(samples)))
    reader = MatteReader(prepared, want_foreground=False)
    grids: list[npt.NDArray[np.float32]] = []
    punched_in = False
    measured: list[SubjectSample] = []
    try:
        for time in _sample_times(lo, hi, count):
            local = time - clip.start
            source_seconds = clip.source_start + local * speed
            frame = reader.frame(_nearest_matte_index(reader, source_seconds))
            alpha = frame.alpha.astype(np.float32) / float(frame.maximum)
            placement = picture_placement_at(clip, local, picture_size, target, None)
            punched_in = punched_in or (
                placement.width > target[0] * PUNCH_IN_SCALE
                and placement.height > target[1] * PUNCH_IN_SCALE
            )
            grid = _coverage_on_frame(alpha, crop, placement, target)
            grids.append(grid)
            measured.append(
                SubjectSample(time=round(time, 3), box=_box_of(grid), area=float(grid.mean()))
            )
    finally:
        reader.close()
    union = np.maximum.reduce(grids) if grids else np.zeros((GRID_ROWS, 1), np.float32)
    boxes = [s.box for s in measured if s.box is not None]
    reach = _union_box(boxes)
    text_placement = (
        solve_text_behind(grids, text_box[0], text_box[1], punched_in=punched_in)
        if text_box is not None
        else None
    )
    _log.info(
        "ACT subject layout measured: clip=%s samples=%d reach=%s",
        clip_id,
        len(measured),
        reach,
    )
    return SubjectLayout(
        clip_id=clip_id,
        mask_id=str(mask.id),
        start=round(lo, 3),
        end=round(hi, 3),
        samples=tuple(measured),
        box=_median_box(boxes),
        reach=reach,
        head_top=reach[1] if reach is not None else None,
        shoulders=_shoulders(union),
        bands=_bands(union),
        text_behind=text_placement,
        grids=tuple(grids),
        grid=union,
    )
