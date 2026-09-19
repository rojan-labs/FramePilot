"""The real OpenCV tracking backend.

This is the only module that imports OpenCV/NumPy, and it is imported lazily by
the entrypoint. Everything above it — protocol, policy, trackers — stays pure so
the base repository can test the worker without a CV stack installed.

Determinism: OpenCV is pinned to one thread with OpenCL disabled and a fixed RNG
seed, so RANSAC and the correlation filter produce identical output for identical
input on the same platform build.
"""

from __future__ import annotations

import contextlib
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Final

from .backend import (
    Alignment,
    BackendUnavailableError,
    FlowSample,
    Frame,
    HomographyEstimate,
    MediaUnreadableError,
    RegionUpdate,
)
from .geometry import Matrix3x3, Point
from .sandbox import DETERMINISTIC_SEED

try:  # pragma: no cover - exercised only in the pack build job
    import cv2
    import numpy as np
except ImportError as error:  # pragma: no cover - exercised only without the CV extra
    raise BackendUnavailableError(
        "the Tracking Lite CV runtime is not installed in this pack artifact"
    ) from error

#: Lucas–Kanade window and pyramid depth. The window is also the reported point patch.
FLOW_WINDOW: Final = (21, 21)
FLOW_PYRAMID_LEVELS: Final = 3
FLOW_CRITERIA: Final = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01)
#: RANSAC reprojection tolerance, in pixels, for the planar fit.
HOMOGRAPHY_REPROJECTION_PIXELS: Final = 3.0
HOMOGRAPHY_MAX_ITERATIONS: Final = 2_000
#: Fixed template size for appearance similarity, so scale changes stay comparable.
TEMPLATE_SIZE: Final = (64, 64)
#: Alignment tolerance, in source pixels, when measuring appearance similarity.
APPEARANCE_SEARCH_PIXELS: Final = 4

# --- registration and its check (MK7.5) -------------------------------------------------------
#: Registration runs on at most this many region pixels. Sub-pixel on a 720p plane, and a 4K
#: plane costs the same as a 720p one instead of eleven times as much.
ALIGN_MAX_PIXELS: Final = 160_000
#: ECC refinement: a bounded, deterministic iteration budget, and the smoothing ECC applies to
#: both images first (it has no pyramid, so a small blur widens its basin of convergence).
ECC_CRITERIA: Final = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 40, 1e-5)
ECC_SMOOTHING: Final = 5
#: The check: cells of this size (working pixels) block-matched within ± CHECK_SEARCH. The
#: search is wide on purpose: a registration that slipped by a whole period of a repeating
#: pattern is only contradicted by cells that can see that far.
CHECK_CELL_MAX: Final = 32
CHECK_CELL_MIN: Final = 12
CHECK_SEARCH: Final = 32
CHECK_NARROW: Final = 4
#: Blur (sigma, working pixels) applied to both sides of the check. A sharp reference against a
#: motion-blurred frame must not read as "unseen"; a 1.5 px blur leaves a 1 px shift measurable.
CHECK_SMOOTHING: Final = 1.5
#: A cell flatter than this (grey-level std after a light blur) carries no position, only noise,
#: and is left out rather than counted either way.
CHECK_MIN_TEXTURE: Final = 4.0
#: Below this normalised correlation the cell no longer shows the reference at all (occluded).
CHECK_MIN_MATCH: Final = 0.5
#: A cell only contradicts the registration with a match this strong somewhere else.
CHECK_CONTRADICTION_MATCH: Final = 0.8
#: ...and only when that match beats the registered place by this much.
CHECK_DISTINCT: Final = 0.1
#: A cell whose correlation at zero offset is this close to its best is on an edge (aperture):
#: it agrees along the edge, so it counts as agreeing.
CHECK_TIE: Final = 0.005
#: A cell agrees when it lands within this many SOURCE pixels of where the registration says.
#: Equal to the host's flag residual (`TRACK_FLAG_RESIDUAL_PX`), half the 2 px gate.
CHECK_TOLERANCE_PIXELS: Final = 1.0
#: A first candidate this well verified is taken without trying the others.
CHECK_GOOD_ENOUGH: Final = 0.9
#: Room ECC's residual warp has to move in, working pixels.
ECC_PADDING: Final = 12

#: Matched cells needed before they are trusted to re-fit a doubtful registration.
REFIT_MIN_CELLS: Final = 8
#: RANSAC tolerance for that re-fit, working pixels.
REFIT_THRESHOLD: Final = 1.0
_TEMPLATE_CACHE_LIMIT: Final = 1024


@dataclass(frozen=True, slots=True)
class DecodedFrame:
    """One decoded frame kept in both the colour and grayscale forms the algorithms need."""

    color: Any
    gray: Any


def _configure_opencv() -> None:
    cv2.setNumThreads(1)
    cv2.setRNGSeed(DETERMINISTIC_SEED)
    # OpenCL is absent in some headless builds; its absence is not an error.
    with contextlib.suppress(cv2.error):
        cv2.ocl.setUseOpenCL(False)


class OpenCvFrameSource:
    """Sequential reader bounded to the host-approved range, sampled on the request's grid.

    The host numbers frames on the PROJECT frame rate (it does not know the
    file's), so request frame ``n`` means source time ``n / fps``. With ``fps``
    given, the reader maps each grid time to the file frame showing at that
    time: it skips frames when the file is faster and holds the current frame
    when the file is slower, so the sample count and numbering still match the
    request exactly. Without ``fps`` (or when the file reports no rate) it
    keeps the historical file-index behaviour.

    The skip/hold decision compares each decoded frame's actual presentation
    timestamp (``CAP_PROP_POS_MSEC``), not ``file frame index / nominal fps``:
    on variable-frame-rate media a frame's ordinal drifts from its real
    timestamp, so counting frames at a nominal rate would silently sample the
    wrong instant. Constant-frame-rate media reports timestamps that already
    fall on ``index / fps``, so this reads the same frames as before there.
    """

    def __init__(
        self,
        path: str,
        first_frame: int,
        last_frame_exclusive: int,
        fps: float | None = None,
    ) -> None:
        self._capture = cv2.VideoCapture(path)
        if not self._capture.isOpened():
            raise MediaUnreadableError(f"could not open approved media handle: {path}")
        self._remaining = last_frame_exclusive - first_frame
        file_fps = float(self._capture.get(cv2.CAP_PROP_FPS))
        self._grid = _grid_mapping(file_fps, fps, first_frame)
        self._current: DecodedFrame | None = None
        #: The real timestamp of `_current`, so `read()` can tell whether the held
        #: frame actually reaches the requested grid time or is only being held
        #: because the media ended before a fresher one arrived.
        self._current_seconds: float = float("-inf")
        #: One frame read ahead of `_current`, paired with its real timestamp, so
        #: `read()` can tell whether a fresher frame is still at or before the
        #: requested grid time before consuming it. `None` once the media is
        #: exhausted.
        self._pending: tuple[DecodedFrame, float] | None = None
        if self._grid is not None:
            # A coarse, nominal-rate seek to land near the range's start,
            # decode-verified and corrected if it overshot: the timestamp-driven
            # read loop below only ever reads forward, so a seek that lands past
            # the first requested grid time can never be recovered from later.
            assert fps is not None  # `_grid_mapping` only returns non-None when fps is set.
            self._pending = _seek_near_grid_start(self._capture, file_fps, fps, first_frame)
        elif first_frame > 0:
            self._capture.set(cv2.CAP_PROP_POS_FRAMES, float(first_frame))
        width = int(self._capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(self._capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        if width <= 0 or height <= 0:
            self._capture.release()
            raise MediaUnreadableError(f"approved media reports no frame size: {path}")
        self._width = width
        self._height = height

    @property
    def width(self) -> int:
        return self._width

    @property
    def height(self) -> int:
        return self._height

    def _pull(self) -> None:
        """Decode one more frame into `_pending`, or clear it at end of media."""
        ok, frame = self._capture.read()
        if not ok or frame is None:
            self._pending = None
            return
        timestamp_seconds = self._capture.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
        decoded = DecodedFrame(color=frame, gray=cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))
        self._pending = (decoded, timestamp_seconds)

    def read(self) -> Frame | None:
        if self._remaining <= 0:
            return None
        if self._grid is None:
            ok, frame = self._capture.read()
            if not ok or frame is None:
                return None
            self._remaining -= 1
            return DecodedFrame(color=frame, gray=cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))
        target = self._grid.target_seconds()
        if self._current is None and self._pending is None:
            self._pull()
        # Consume the read-ahead frame while it is still at or before the grid
        # time (or there is no current answer yet): that is what makes this a
        # hold — a fresher frame already at/before `target` always wins, and a
        # frame past `target` is left buffered for a later call instead of
        # being decided on prematurely.
        while self._pending is not None and (
            self._current is None or self._pending[1] <= target + _GRID_EPSILON
        ):
            self._current, self._current_seconds = self._pending
            self._pull()
        if self._current is None or (
            self._pending is None and self._current_seconds < target - _GRID_EPSILON
        ):
            # Either nothing has been decoded yet, or the held frame does not
            # reach this grid time and the media ended before a fresher one
            # arrived: the range is bounded by what exists, never padded with a
            # repeated last frame.
            return None
        self._grid.emitted += 1
        self._remaining -= 1
        return self._current

    def close(self) -> None:
        self._capture.release()


#: Absorbs float error so a grid time exactly on a file frame maps to that frame.
_GRID_EPSILON: Final = 1e-6


@dataclass(slots=True)
class _GridMapping:
    """The source time requested for grid frame ``first + emitted``."""

    grid_fps: float
    first_frame: int
    emitted: int = 0

    def target_seconds(self) -> float:
        return (self.first_frame + self.emitted) / self.grid_fps


def _grid_mapping(file_fps: float, grid_fps: float | None, first_frame: int) -> _GridMapping | None:
    if grid_fps is None or not grid_fps > 0.0 or not file_fps > 0.0 or file_fps != file_fps:
        return None
    return _GridMapping(grid_fps=grid_fps, first_frame=first_frame)


#: Nominal frames subtracted from the coarse seek estimate as a safety margin.
#: Scaled by the file's own reported rate rather than a flat second count, so it
#: stays proportionate whether the file claims 24fps or 240fps.
_SEEK_SAFETY_FRAMES: Final = 3.0
#: Bounded retries for the overshoot-correction seek below, each halving the
#: remaining distance back to the start of the file. `VideoCapture` only reads
#: forward, so an unrecovered overshoot would silently answer every grid time
#: in the request with a frame that is already too late.
_MAX_SEEK_RETRIES: Final = 6


def _seek_near_grid_start(
    capture: Any, file_fps: float, grid_fps: float, first_frame: int
) -> tuple[DecodedFrame, float] | None:
    """Seek close to the first requested grid time, then decode-verify the landing.

    The estimate is nominal-rate arithmetic minus a small safety margin, so on
    variable-frame-rate media running slower than the file's single reported
    rate around this point, the seek still tends to land before the target
    instant rather than after it. That is only a tendency, not a guarantee — the
    file's reported rate can be arbitrarily wrong for the region actually being
    sought into — so the first decoded frame is checked: if it is already past
    the target by more than half a (nominal) frame, or the seek failed outright
    (an index the real content does not reach yet, e.g. seeking too far into a
    slower stretch), the seek point is halved back toward the start of the file
    and retried, bounded so a genuinely degenerate file fails fast instead of
    looping. Returns the accepted ``(frame, seconds)`` pair, the closest
    best-effort pair if every retry still overshot, or ``None`` if nothing could
    be decoded at all.
    """
    target_seconds = first_frame / grid_fps
    margin_seconds = _SEEK_SAFETY_FRAMES / file_fps
    seek_seconds = max(0.0, target_seconds - margin_seconds)
    seek_index = int(seek_seconds * file_fps + _GRID_EPSILON)
    half_frame_seconds = 0.5 / file_fps
    best_effort: tuple[DecodedFrame, float] | None = None
    for attempt in range(_MAX_SEEK_RETRIES):
        capture.set(cv2.CAP_PROP_POS_FRAMES, float(seek_index))
        ok, frame = capture.read()
        if ok and frame is not None:
            timestamp_seconds = capture.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
            decoded = DecodedFrame(color=frame, gray=cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))
            if timestamp_seconds <= target_seconds + half_frame_seconds:
                return (decoded, timestamp_seconds)
            best_effort = (decoded, timestamp_seconds)
        if seek_index <= 0:
            break
        # The final attempt seeks to the file's start: frame 0 can never overshoot, so a
        # file whose reported rate is wildly wrong costs decode time instead of sampling
        # the wrong instant.
        seek_index = 0 if attempt == _MAX_SEEK_RETRIES - 2 else seek_index // 2
    return best_effort


class OpenCvRegionTracker:
    """CSRT with an appearance-similarity confidence measured against the template."""

    def __init__(self, frame: DecodedFrame, box_pixels: tuple[float, float, float, float]) -> None:
        self._tracker = _create_csrt()
        rect = tuple(round(value) for value in box_pixels)
        self._tracker.init(frame.color, rect)
        self._template = _template_patch(frame.gray, box_pixels)

    def update(self, frame: Frame) -> RegionUpdate:
        ok, rect = self._tracker.update(frame.color)
        if not ok:
            return RegionUpdate(box_pixels=None, appearance=0.0)
        box = (float(rect[0]), float(rect[1]), float(rect[2]), float(rect[3]))
        return RegionUpdate(box_pixels=box, appearance=self._appearance(frame.gray, box))

    def _appearance(self, gray: Any, box: tuple[float, float, float, float]) -> float:
        """Best template correlation within a small search margin around the box.

        Correlating only at the exact reported box makes confidence hostage to
        sub-pixel alignment: on high-frequency detail a one-pixel offset drops
        normalized cross-correlation nearly to zero even though the subject is
        perfectly visible. Searching a few pixels around the box measures "is the
        target still here and still looking like itself", which is the question
        confidence is supposed to answer, while an absent or replaced subject
        still collapses the score.
        """
        if self._template is None:
            return 0.0
        search = _search_patch(gray, box)
        if search is None:
            return 0.0
        score = cv2.matchTemplate(search, self._template, cv2.TM_CCOEFF_NORMED)
        # Negative correlation means the patch no longer resembles the target at
        # all; it is reported as zero confidence rather than rescaled upward.
        return max(float(score.max()), 0.0)


@dataclass(frozen=True, slots=True)
class _Template:
    """The reference side of a registration, computed once per region."""

    #: Keeps the reference frame alive so its ``id`` in the cache key cannot be reused.
    frame: Any
    image: Any
    #: Lightly blurred, for the cell check (sensor noise must not decide a match).
    smoothed: Any
    mask: Any
    #: The template and its mask padded for ECC's residual search (see `_refine`).
    padded_image: Any
    padded_mask: Any
    #: Template pixels → reference pixels.
    to_reference: Any
    #: Nominal working scale (1 on anything up to ~400 x 400 px of region).
    scale: float
    size: tuple[int, int]


@dataclass(slots=True)
class _Working:
    """The current frame at the working scale, and the exact map into it."""

    frame: Any
    image: Any
    #: Current pixels → working pixels.
    to_working: Any
    #: 1 where the working image exists — the check ignores cells that left the frame.
    valid: Any


@dataclass(frozen=True, slots=True)
class _Checked:
    matrix: Any
    agreement: float
    contradiction: float
    cells: int
    #: Matched cells as (template point, where it was found in template coordinates).
    matches: tuple[tuple[tuple[float, float], tuple[float, float]], ...]


class OpenCvBackend:
    def __init__(self) -> None:
        _configure_opencv()
        self._name = f"opencv-{cv2.__version__}-cpu"
        self._templates: dict[tuple[Any, ...], _Template] = {}
        self._working: dict[float, _Working] = {}

    @property
    def name(self) -> str:
        return self._name

    def open_frames(
        self,
        path: str,
        first_frame: int,
        last_frame_exclusive: int,
        fps: float | None = None,
    ) -> OpenCvFrameSource:
        return OpenCvFrameSource(path, first_frame, last_frame_exclusive, fps)

    def optical_flow(
        self, previous: Frame, current: Frame, points: Sequence[Point]
    ) -> Sequence[FlowSample]:
        if not points:
            return []
        source = np.array([[point] for point in points], dtype=np.float32)
        # `nextPts=None` is the documented "let OpenCV allocate" form.
        tracked, status, error = cv2.calcOpticalFlowPyrLK(
            previous.gray,
            current.gray,
            source,
            None,
            winSize=FLOW_WINDOW,
            maxLevel=FLOW_PYRAMID_LEVELS,
            criteria=FLOW_CRITERIA,
        )
        samples: list[FlowSample] = []
        for index in range(len(points)):
            ok = bool(status[index][0]) and tracked is not None
            position = (
                (float(tracked[index][0][0]), float(tracked[index][0][1]))
                if tracked is not None
                else points[index]
            )
            samples.append(
                FlowSample(
                    point=position,
                    ok=ok,
                    error=float(error[index][0]) if error is not None else 0.0,
                )
            )
        return samples

    def create_region_tracker(
        self, frame: Frame, box_pixels: tuple[float, float, float, float]
    ) -> OpenCvRegionTracker:
        return OpenCvRegionTracker(frame, box_pixels)

    def detect_features(
        self, frame: Frame, box_pixels: tuple[float, float, float, float], max_features: int
    ) -> Sequence[Point]:
        gray = frame.gray
        mask = np.zeros(gray.shape[:2], dtype=np.uint8)
        left, top, width, height = (round(value) for value in box_pixels)
        mask[max(top, 0) : top + max(height, 1), max(left, 0) : left + max(width, 1)] = 255
        found = cv2.goodFeaturesToTrack(
            gray, maxCorners=max_features, qualityLevel=0.01, minDistance=4, mask=mask
        )
        if found is None:
            return []
        return [(float(item[0][0]), float(item[0][1])) for item in found]

    def estimate_homography(
        self, source: Sequence[Point], destination: Sequence[Point]
    ) -> HomographyEstimate | None:
        if len(source) < 4 or len(source) != len(destination):
            return None
        matrix, mask = cv2.findHomography(
            np.array(source, dtype=np.float32).reshape(-1, 1, 2),
            np.array(destination, dtype=np.float32).reshape(-1, 1, 2),
            cv2.RANSAC,
            HOMOGRAPHY_REPROJECTION_PIXELS,
            maxIters=HOMOGRAPHY_MAX_ITERATIONS,
            confidence=0.995,
        )
        if matrix is None or mask is None:
            return None
        rows: Matrix3x3 = (
            (float(matrix[0][0]), float(matrix[0][1]), float(matrix[0][2])),
            (float(matrix[1][0]), float(matrix[1][1]), float(matrix[1][2])),
            (float(matrix[2][0]), float(matrix[2][1]), float(matrix[2][2])),
        )
        return HomographyEstimate(matrix=rows, inliers=tuple(bool(item[0]) for item in mask))

    def align(
        self,
        reference: Frame,
        current: Frame,
        region: Sequence[Point],
        guesses: Sequence[Matrix3x3],
        motion: str,
    ) -> Alignment | None:
        template = self._template(reference, region)
        if template is None or not guesses:
            return None
        working = self._working_frame(current, template.scale)
        best: _Checked | None = None
        for guess in guesses:
            start = np.array(guess, dtype=np.float64)
            for candidate in (self._refine(template, working, start, motion), start):
                if candidate is None:
                    continue
                checked = _check(template, working, candidate)
                if best is None or _score(checked) > _score(best):
                    best = checked
                if checked.agreement >= CHECK_GOOD_ENOUGH:
                    break
            if best is not None and best.agreement >= CHECK_GOOD_ENOUGH:
                break
        if best is None:
            return None
        if best.agreement < CHECK_GOOD_ENOUGH:
            best = self._refit(template, working, best, motion)
        return Alignment(
            matrix=_rows(best.matrix),
            agreement=best.agreement,
            contradiction=best.contradiction,
            cells=best.cells,
        )

    def _refit(
        self, template: _Template, working: _Working, best: _Checked, motion: str
    ) -> _Checked:
        """Re-estimate the region from the cells that DID match, then check that.

        ECC minimises one photometric error over the whole region, so an occluder or a repeat
        can pull it; the matched cells are a robust, independent set of correspondences. A
        RANSAC fit over them — refined by ECC from there — is kept only if it verifies better.
        """
        if len(best.matches) < REFIT_MIN_CELLS:
            return best
        source = np.array([m[0] for m in best.matches], dtype=np.float32).reshape(-1, 1, 2)
        target = np.array([m[1] for m in best.matches], dtype=np.float32).reshape(-1, 1, 2)
        if motion == "homography":
            correction, _ = cv2.findHomography(source, target, cv2.RANSAC, REFIT_THRESHOLD)
        else:
            affine, _ = cv2.estimateAffine2D(
                source, target, method=cv2.RANSAC, ransacReprojThreshold=REFIT_THRESHOLD
            )
            correction = None if affine is None else np.vstack([affine, [0.0, 0.0, 1.0]])
        if correction is None or not np.all(np.isfinite(correction)):
            return best
        # The cells were matched in the RECTIFIED frame, so the correction composes on the
        # template side: current = matrix · reference-from-template · correction.
        to_template = np.linalg.inv(template.to_reference)
        refitted = best.matrix @ template.to_reference @ correction @ to_template
        for candidate in (self._refine(template, working, refitted, motion), refitted):
            if candidate is None:
                continue
            checked = _check(template, working, candidate)
            if _score(checked) > _score(best):
                best = checked
        return best

    def _template(self, reference: Frame, region: Sequence[Point]) -> _Template | None:
        key = (id(reference), tuple(region))
        cached = self._templates.get(key)
        if cached is not None and cached.frame is reference:
            return cached
        gray = reference.gray
        height, width = gray.shape[:2]
        xs = [point[0] for point in region]
        ys = [point[1] for point in region]
        x0, y0 = max(int(np.floor(min(xs))), 0), max(int(np.floor(min(ys))), 0)
        x1, y1 = min(int(np.ceil(max(xs))), width), min(int(np.ceil(max(ys))), height)
        if x1 - x0 < 2 * CHECK_CELL_MIN or y1 - y0 < 2 * CHECK_CELL_MIN:
            return None
        scale = min(1.0, float(np.sqrt(ALIGN_MAX_PIXELS / float((x1 - x0) * (y1 - y0)))))
        size = (max(round((x1 - x0) * scale), 1), max(round((y1 - y0) * scale), 1))
        image = cv2.resize(gray[y0:y1, x0:x1], size, interpolation=cv2.INTER_AREA).astype(
            np.float32
        )
        # Pixel centres, not corners, and the scale the resize ACTUALLY applied per axis (the
        # rounded size, not the nominal factor — the difference is a fraction of a pixel, which
        # is exactly the size of error this module exists to remove).
        to_reference = np.linalg.inv(
            _resampling(size[0] / (x1 - x0), size[1] / (y1 - y0), -float(x0), -float(y0))
        )
        mask = np.zeros((size[1], size[0]), dtype=np.uint8)
        polygon = np.linalg.inv(to_reference) @ np.array(
            [[p[0] for p in region], [p[1] for p in region], [1.0] * len(region)]
        )
        cv2.fillPoly(mask, [np.round(polygon[:2] / polygon[2]).T.astype(np.int32)], 255)
        pad = ECC_PADDING
        template = _Template(
            frame=reference,
            image=image,
            smoothed=cv2.GaussianBlur(image, (0, 0), CHECK_SMOOTHING),
            mask=mask,
            padded_image=cv2.copyMakeBorder(image, pad, pad, pad, pad, cv2.BORDER_REPLICATE),
            padded_mask=cv2.copyMakeBorder(mask, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=0),
            to_reference=to_reference,
            scale=scale,
            size=size,
        )
        if len(self._templates) >= _TEMPLATE_CACHE_LIMIT:
            self._templates.clear()
        self._templates[key] = template
        return template

    def _working_frame(self, current: Frame, scale: float) -> _Working:
        cached = self._working.get(scale)
        if cached is not None and cached.frame is current:
            return cached
        gray = current.gray
        height, width = gray.shape[:2]
        if scale < 1.0:
            size = (max(round(width * scale), 1), max(round(height * scale), 1))
            image = cv2.resize(gray, size, interpolation=cv2.INTER_AREA)
            to_working = _resampling(size[0] / width, size[1] / height, 0.0, 0.0)
        else:
            image = gray
            to_working = np.eye(3)
        working = _Working(
            frame=current,
            image=image.astype(np.float32),
            to_working=to_working,
            valid=np.ones(image.shape[:2], dtype=np.uint8),
        )
        if len(self._working) >= 4:
            self._working.clear()
        self._working[scale] = working
        return working

    def _refine(
        self, template: _Template, working: _Working, guess: Any, motion: str
    ) -> Any | None:
        """The guess, ECC-refined against the reference, or ``None`` if ECC cannot converge.

        OpenCV 5.0's ECC asserts when the template and the input differ in size and a mask is
        given, so the current frame is first rectified through the guess into the template's own
        (padded) frame, and ECC refines only the small residual warp from the identity. The
        padding leaves room for that residual to move without sampling outside the image.
        """
        guess_warp = working.to_working @ guess @ template.to_reference
        if not np.all(np.isfinite(guess_warp)) or abs(guess_warp[2][2]) < 1e-12:
            return None
        pad = ECC_PADDING
        width, height = template.size
        unpad = np.array([[1.0, 0.0, -pad], [0.0, 1.0, -pad], [0.0, 0.0, 1.0]])
        rectified = cv2.warpPerspective(
            working.image,
            guess_warp @ unpad,
            (width + 2 * pad, height + 2 * pad),
            flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
            borderMode=cv2.BORDER_REPLICATE,
        )
        homography = motion == "homography"
        residual = np.eye(3, dtype=np.float32) if homography else np.eye(2, 3, dtype=np.float32)
        try:
            _, found = cv2.findTransformECC(
                template.padded_image,
                rectified,
                residual,
                cv2.MOTION_HOMOGRAPHY if homography else cv2.MOTION_AFFINE,
                ECC_CRITERIA,
                template.padded_mask,
                ECC_SMOOTHING,
            )
        except cv2.error:
            return None
        step = np.eye(3)
        step[: found.shape[0]] = found.astype(np.float64)
        total = guess_warp @ unpad @ step @ np.linalg.inv(unpad)
        matrix = np.linalg.inv(working.to_working) @ total @ np.linalg.inv(template.to_reference)
        if not np.all(np.isfinite(matrix)) or abs(matrix[2][2]) < 1e-12:
            return None
        return matrix / matrix[2][2]


def _resampling(sx: float, sy: float, dx: float, dy: float) -> Any:
    """Pixel-centre map of a resize by (sx, sy) after a shift: x -> (x + dx + 0.5) * s - 0.5."""
    return np.array(
        [
            [sx, 0.0, (dx + 0.5) * sx - 0.5],
            [0.0, sy, (dy + 0.5) * sy - 0.5],
            [0.0, 0.0, 1.0],
        ]
    )


def _score(checked: _Checked) -> float:
    """Which candidate registration the check prefers: agreement, less any contradiction."""
    return checked.agreement - checked.contradiction


def _rows(matrix: Any) -> Matrix3x3:
    return (
        (float(matrix[0][0]), float(matrix[0][1]), float(matrix[0][2])),
        (float(matrix[1][0]), float(matrix[1][1]), float(matrix[1][2])),
        (float(matrix[2][0]), float(matrix[2][1]), float(matrix[2][2])),
    )


def _check(template: _Template, working: _Working, matrix: Any) -> _Checked:
    """Block-match the region's cells between the reference and the rectified current frame.

    Independent of the fit: ECC minimises one global photometric error, and an occluder, an
    aliased repeat or a competing surface can win that minimisation. Each textured cell is then
    one of three things:

    * **agrees** — it is where the registration puts it (within the tolerance, or tied there,
      which is how an edge or a repeating pattern answers);
    * **contradicts** — it clearly matches somewhere else within ±`CHECK_SEARCH` px, which is
      direct evidence the registration is wrong by that much;
    * **unseen** — it matches nowhere (occluded, or moved further than the search).

    Agreement is the agreeing fraction; the contradiction fraction is returned separately
    because a contradiction is evidence of a wrong plane, while an unseen cell is only absence.
    """
    search = CHECK_SEARCH
    warp = working.to_working @ matrix @ template.to_reference
    unpad = np.array([[1.0, 0.0, -search], [0.0, 1.0, -search], [0.0, 0.0, 1.0]])
    width, height = template.size
    padded = (width + 2 * search, height + 2 * search)
    inverse = cv2.WARP_INVERSE_MAP
    rectified = cv2.GaussianBlur(
        cv2.warpPerspective(working.image, warp @ unpad, padded, flags=cv2.INTER_LINEAR | inverse),
        (3, 3),
        0,
    )
    inside = cv2.warpPerspective(
        working.valid, warp @ unpad, padded, flags=cv2.INTER_NEAREST | inverse
    )
    cell = max(CHECK_CELL_MIN, min(CHECK_CELL_MAX, min(width, height) // 3))
    agree = 0
    contradict = 0
    cells = 0
    matches: list[tuple[tuple[float, float], tuple[float, float]]] = []
    for top in range(0, height - cell + 1, cell):
        for left in range(0, width - cell + 1, cell):
            if template.mask[top : top + cell, left : left + cell].min() == 0:
                continue
            core = inside[top + search : top + search + cell, left + search : left + search + cell]
            if core.min() == 0:
                # Where the region has left the frame there is nothing to check against.
                continue
            patch = template.smoothed[top : top + cell, left : left + cell]
            if float(patch.std()) < CHECK_MIN_TEXTURE:
                continue
            cells += 1
            centre = (left + (cell - 1) / 2.0, top + (cell - 1) / 2.0)
            # Narrow first: nearly every cell of a right registration agrees within a few pixels,
            # and only the ones that do not pay for the wide search.
            found = None
            for reach in (CHECK_NARROW, search):
                found = _match(rectified, inside, patch, top, left, cell, search, reach)
                if found is not None and _within(found, template.scale):
                    break
            if found is None:
                continue
            dx, dy, _, peak, at_zero = found
            if _within(found, template.scale):
                agree += 1
                matches.append((centre, (centre[0] + dx, centre[1] + dy)))
            elif peak >= CHECK_CONTRADICTION_MATCH and peak - at_zero >= CHECK_DISTINCT:
                # Only a STRONG, DISTINCT match elsewhere is evidence. A weak one in a wide window
                # is what an occluder's own texture produces by chance; a strong one barely
                # better than the registered place is an edge sliding along itself (aperture).
                contradict += 1
                matches.append((centre, (centre[0] + dx, centre[1] + dy)))
    return _Checked(
        matrix=matrix,
        agreement=agree / cells if cells else 0.0,
        contradiction=contradict / cells if cells else 0.0,
        cells=cells,
        matches=tuple(matches),
    )


def _within(found: tuple[float, float, bool, float, float], scale: float) -> bool:
    dx, dy, tied, _, _ = found
    return tied or float(np.hypot(dx, dy)) / scale <= CHECK_TOLERANCE_PIXELS


def _match(
    rectified: Any,
    inside: Any,
    patch: Any,
    top: int,
    left: int,
    cell: int,
    pad: int,
    reach: int,
) -> tuple[float, float, bool, float, float] | None:
    """Best match of `patch` within ± `reach` of its registered place.

    Returns ``(dx, dy, tied, peak, at_zero)`` — ``tied`` when the registered place scores within
    ``CHECK_TIE`` of the best (an edge or a repeat), reported as a zero offset — or ``None`` when
    nothing in reach matches at all.
    """
    rows = slice(pad + top - reach, pad + top + cell + reach)
    columns = slice(pad + left - reach, pad + left + cell + reach)
    scores = cv2.matchTemplate(rectified[rows, columns], patch, cv2.TM_CCOEFF_NORMED)
    # Positions whose window ran off the frame are not candidates.
    covered = cv2.erode(inside[rows, columns], np.ones((cell, cell), np.uint8), anchor=(0, 0))
    scores = np.where(covered[: scores.shape[0], : scores.shape[1]] > 0, scores, -1.0)
    _, peak, _, location = cv2.minMaxLoc(scores)
    if peak < CHECK_MIN_MATCH:
        return None
    at_zero = float(scores[reach][reach])
    dx = location[0] + _vertex(scores, location, axis=1) - reach
    dy = location[1] + _vertex(scores, location, axis=0) - reach
    tied = at_zero >= peak - CHECK_TIE
    if tied:
        dx, dy = 0.0, 0.0
    return dx, dy, tied, float(peak), at_zero


def _vertex(scores: Any, location: Sequence[int], axis: int) -> float:
    """Sub-pixel peak offset along one axis from a parabola through the peak and its neighbours."""
    x, y = location
    limit = scores.shape[1] if axis == 1 else scores.shape[0]
    index = x if axis == 1 else y
    if index <= 0 or index >= limit - 1:
        return 0.0
    if axis == 1:
        left, centre, right = scores[y][x - 1], scores[y][x], scores[y][x + 1]
    else:
        left, centre, right = scores[y - 1][x], scores[y][x], scores[y + 1][x]
    denominator = float(left - 2.0 * centre + right)
    if abs(denominator) < 1e-12:
        return 0.0
    return float(np.clip(0.5 * (left - right) / denominator, -0.5, 0.5))


def _create_csrt() -> Any:
    for factory in ("TrackerCSRT_create", "TrackerCSRT"):
        candidate = getattr(cv2, factory, None)
        if candidate is None:
            continue
        return candidate() if factory == "TrackerCSRT_create" else candidate.create()
    legacy = getattr(cv2, "legacy", None)
    if legacy is not None and hasattr(legacy, "TrackerCSRT_create"):
        return legacy.TrackerCSRT_create()
    raise BackendUnavailableError("this OpenCV build does not provide the CSRT tracker")


def _template_patch(gray: Any, box: tuple[float, float, float, float]) -> Any:
    left, top, width, height = (round(value) for value in box)
    left, top = max(left, 0), max(top, 0)
    patch = gray[top : top + max(height, 1), left : left + max(width, 1)]
    if patch.size == 0:
        return None
    return cv2.resize(patch, TEMPLATE_SIZE, interpolation=cv2.INTER_AREA)


def _search_patch(gray: Any, box: tuple[float, float, float, float]) -> Any:
    """The box grown by the search margin, rescaled so the template's scale matches."""
    left, top, width, height = box
    if width <= 0.0 or height <= 0.0:
        return None
    margin = APPEARANCE_SEARCH_PIXELS
    x0 = max(round(left - margin), 0)
    y0 = max(round(top - margin), 0)
    x1 = min(round(left + width + margin), gray.shape[1])
    y1 = min(round(top + height + margin), gray.shape[0])
    patch = gray[y0:y1, x0:x1]
    if patch.size == 0:
        return None
    # Scale by the *box*, not the crop, so the template keeps its own scale and
    # the extra margin becomes the search range matchTemplate slides over.
    scaled_width = max(round(patch.shape[1] * TEMPLATE_SIZE[0] / width), TEMPLATE_SIZE[0])
    scaled_height = max(round(patch.shape[0] * TEMPLATE_SIZE[1] / height), TEMPLATE_SIZE[1])
    return cv2.resize(patch, (scaled_width, scaled_height), interpolation=cv2.INTER_AREA)
