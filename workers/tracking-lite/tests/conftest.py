"""A scripted, dependency-free backend used to unit test tracking policy.

The scripted backend is a real geometric simulation, not a stub that returns
canned samples: a synthetic subject follows a caller-supplied trajectory, and
flow/region/homography primitives are computed from it. Tests can therefore
assert that the reported boxes actually follow the moving subject, and that a
*wrong* trajectory fails to match.

Decoded-media proof against real pixels is a separate, OpenCV-only job (see the
``decoded_media`` marker); this suite exists so the base repository can verify
protocol and policy behaviour without installing a CV stack.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field

import pytest

from framepilot_tracking_lite.backend import (
    FlowSample,
    Frame,
    HomographyEstimate,
    MediaUnreadableError,
    RegionUpdate,
)
from framepilot_tracking_lite.geometry import Point
from framepilot_tracking_lite.protocol import (
    MediaHandle,
    NormalizedBox,
    NormalizedPoint,
    TrackingRequest,
)

Trajectory = Callable[[int], Point]

WIDTH = 640
HEIGHT = 360


def linear_trajectory(dx: float, dy: float) -> Trajectory:
    """Absolute subject offset at a given frame index."""
    return lambda frame: (dx * frame, dy * frame)


@dataclass
class ScriptedFrameSource:
    first_frame: int
    last_frame_exclusive: int
    frame_width: int = WIDTH
    frame_height: int = HEIGHT
    decodable_frames: int | None = None
    #: Simulated decode cost, used to prove cancellation reaches a running track.
    frame_delay_seconds: float = 0.0
    closed: bool = False
    _next: int = field(init=False, default=0)

    def __post_init__(self) -> None:
        self._next = self.first_frame

    @property
    def width(self) -> int:
        return self.frame_width

    @property
    def height(self) -> int:
        return self.frame_height

    def read(self) -> Frame | None:
        produced = self._next - self.first_frame
        if self.decodable_frames is not None and produced >= self.decodable_frames:
            return None
        if self._next >= self.last_frame_exclusive:
            return None
        if self.frame_delay_seconds > 0.0:
            time.sleep(self.frame_delay_seconds)
        frame = self._next
        self._next += 1
        return frame

    def close(self) -> None:
        self.closed = True


@dataclass
class ScriptedRegionTracker:
    backend: ScriptedBackend
    origin: tuple[float, float, float, float]
    start_frame: int
    _frame: int = field(init=False, default=0)

    def __post_init__(self) -> None:
        self._frame = self.start_frame

    def update(self, frame: Frame) -> RegionUpdate:
        self._frame = int(frame)
        if self._frame in self.backend.lost_frames:
            return RegionUpdate(box_pixels=None, appearance=0.0)
        offset = self.backend.offset(self.start_frame, self._frame)
        box = (
            self.origin[0] + offset[0],
            self.origin[1] + offset[1],
            self.origin[2],
            self.origin[3],
        )
        return RegionUpdate(
            box_pixels=box, appearance=self.backend.appearance.get(self._frame, 1.0)
        )


@dataclass
class ScriptedBackend:
    trajectory: Trajectory = field(default_factory=lambda: linear_trajectory(2.0, 1.0))
    #: Frames where flow/region measurement fails outright.
    lost_frames: set[int] = field(default_factory=set)
    #: Per-frame reported flow error.
    flow_errors: dict[int, float] = field(default_factory=dict)
    #: Per-frame forward/backward inconsistency, in pixels.
    round_trip_errors: dict[int, float] = field(default_factory=dict)
    #: Per-frame measured region appearance similarity.
    appearance: dict[int, float] = field(default_factory=dict)
    #: Feature points returned inside the requested quad, deliberately unsorted.
    features: list[Point] | None = None
    #: Fraction of planar correspondences treated as outliers.
    outlier_frames: dict[int, int] = field(default_factory=dict)
    media_unreadable: bool = False
    frame_width: int = WIDTH
    frame_height: int = HEIGHT
    decodable_frames: int | None = None
    frame_delay_seconds: float = 0.0
    opened: list[ScriptedFrameSource] = field(default_factory=list)

    @property
    def name(self) -> str:
        return "scripted-cpu"

    def offset(self, from_frame: int, to_frame: int) -> Point:
        start = self.trajectory(from_frame)
        end = self.trajectory(to_frame)
        return (end[0] - start[0], end[1] - start[1])

    def open_frames(
        self, path: str, first_frame: int, last_frame_exclusive: int
    ) -> ScriptedFrameSource:
        if self.media_unreadable:
            raise MediaUnreadableError(f"could not open approved media handle: {path}")
        source = ScriptedFrameSource(
            first_frame=first_frame,
            last_frame_exclusive=last_frame_exclusive,
            frame_width=self.frame_width,
            frame_height=self.frame_height,
            decodable_frames=self.decodable_frames,
            frame_delay_seconds=self.frame_delay_seconds,
        )
        self.opened.append(source)
        return source

    def optical_flow(
        self, previous: Frame, current: Frame, points: Sequence[Point]
    ) -> Sequence[FlowSample]:
        source_frame, target_frame = int(previous), int(current)
        backwards = target_frame < source_frame
        offset = self.offset(source_frame, target_frame)
        # A backward pass re-lands on the original point unless this frame is
        # scripted to be inconsistent, which is how occlusion is simulated.
        jitter = 0.0 if not backwards else self.round_trip_errors.get(source_frame, 0.0)
        lost = target_frame in self.lost_frames or (backwards and source_frame in self.lost_frames)
        error = self.flow_errors.get(max(source_frame, target_frame), 0.0)
        samples: list[FlowSample] = []
        for index, point in enumerate(points):
            outliers = self.outlier_frames.get(target_frame, 0)
            # Outliers scatter rather than agreeing: correspondences that all
            # drift the *same* way are a real second plane, not noise.
            drift = 25.0 * (index + 1) if index < outliers else 0.0
            samples.append(
                FlowSample(
                    point=(point[0] + offset[0] + jitter + drift, point[1] + offset[1]),
                    ok=not lost,
                    error=error,
                )
            )
        return samples

    def create_region_tracker(
        self, frame: Frame, box_pixels: tuple[float, float, float, float]
    ) -> ScriptedRegionTracker:
        return ScriptedRegionTracker(backend=self, origin=box_pixels, start_frame=int(frame))

    def detect_features(
        self, frame: Frame, box_pixels: tuple[float, float, float, float], max_features: int
    ) -> Sequence[Point]:
        if self.features is not None:
            return self.features[:max_features]
        left, top, width, height = box_pixels
        grid = [
            (left + width * fx, top + height * fy)
            for fx in (0.8, 0.2, 0.5)
            for fy in (0.8, 0.2, 0.5)
        ]
        return grid[:max_features]

    def estimate_homography(
        self, source: Sequence[Point], destination: Sequence[Point]
    ) -> HomographyEstimate | None:
        """A deterministic translation-only robust fit, sufficient to exercise policy."""
        if len(source) < 4 or len(source) != len(destination):
            return None
        shifts = sorted(
            (destination[index][0] - source[index][0], destination[index][1] - source[index][1])
            for index in range(len(source))
        )
        median = shifts[len(shifts) // 2]
        inliers = tuple(
            abs(shift[0] - median[0]) <= 3.0 and abs(shift[1] - median[1]) <= 3.0
            for shift in (
                (destination[index][0] - source[index][0], destination[index][1] - source[index][1])
                for index in range(len(source))
            )
        )
        matrix = ((1.0, 0.0, median[0]), (0.0, 1.0, median[1]), (0.0, 0.0, 1.0))
        return HomographyEstimate(matrix=matrix, inliers=inliers)


def media_handle(first_frame: int = 0, last_frame_exclusive: int = 30) -> MediaHandle:
    return MediaHandle(
        handle_id="handle-1",
        asset_id="asset-1",
        absolute_path="/approved/project/media/shot.mp4",
        source_start_seconds=0.0,
        source_end_seconds=2.0,
        fps=30.0,
        first_frame=first_frame,
        last_frame_exclusive=last_frame_exclusive,
    )


def point_request(**overrides: object) -> TrackingRequest:
    base = {
        "request_id": "req-1",
        "project_revision": 7,
        "capability": "tracking.point",
        "media": media_handle(),
        "point": NormalizedPoint(x=0.5, y=0.5),
    }
    base.update(overrides)
    return TrackingRequest(**base)  # type: ignore[arg-type]


def region_request(**overrides: object) -> TrackingRequest:
    base = {
        "request_id": "req-1",
        "project_revision": 7,
        "capability": "tracking.region",
        "media": media_handle(),
        "region": NormalizedBox(x=0.4, y=0.4, width=0.2, height=0.2),
    }
    base.update(overrides)
    return TrackingRequest(**base)  # type: ignore[arg-type]


def planar_request(**overrides: object) -> TrackingRequest:
    corners = (
        NormalizedPoint(x=0.3, y=0.3),
        NormalizedPoint(x=0.6, y=0.3),
        NormalizedPoint(x=0.6, y=0.7),
        NormalizedPoint(x=0.3, y=0.7),
    )
    base = {
        "request_id": "req-1",
        "project_revision": 7,
        "capability": "tracking.planar",
        "media": media_handle(),
        "corners": corners,
    }
    base.update(overrides)
    return TrackingRequest(**base)  # type: ignore[arg-type]


@pytest.fixture
def backend() -> ScriptedBackend:
    return ScriptedBackend()
