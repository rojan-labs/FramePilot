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
    """Sequential reader bounded to the host-approved frame range."""

    def __init__(self, path: str, first_frame: int, last_frame_exclusive: int) -> None:
        self._capture = cv2.VideoCapture(path)
        if not self._capture.isOpened():
            raise MediaUnreadableError(f"could not open approved media handle: {path}")
        self._remaining = last_frame_exclusive - first_frame
        if first_frame > 0:
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

    def read(self) -> Frame | None:
        if self._remaining <= 0:
            return None
        ok, frame = self._capture.read()
        if not ok or frame is None:
            return None
        self._remaining -= 1
        return DecodedFrame(color=frame, gray=cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))

    def close(self) -> None:
        self._capture.release()


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
        self, path: str, first_frame: int, last_frame_exclusive: int
    ) -> OpenCvFrameSource:
        return OpenCvFrameSource(path, first_frame, last_frame_exclusive)

    def optical_flow(
        self, previous: Frame, current: Frame, points: Sequence[Point]
    ) -> Sequence[FlowSample]:
        if not points:
            return []
        source = np.array([[point] for point in points], dtype=np.float32)
        # `nextPts=None` is the documented "let OpenCV allocate" form; the wheel's
        # bundled stubs type that parameter as a required array.
        tracked, status, error = cv2.calcOpticalFlowPyrLK(  # type: ignore[call-overload]
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
