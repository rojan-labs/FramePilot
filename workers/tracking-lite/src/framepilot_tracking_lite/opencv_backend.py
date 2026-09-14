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
    for _ in range(_MAX_SEEK_RETRIES):
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
        seek_index //= 2
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


class OpenCvBackend:
    def __init__(self) -> None:
        _configure_opencv()
        self._name = f"opencv-{cv2.__version__}-cpu"

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
        return HomographyEstimate(
            matrix=rows, inliers=tuple(bool(item[0]) for item in mask)
        )


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
