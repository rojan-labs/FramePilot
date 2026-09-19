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
    Alignment,
    FlowSample,
    Frame,
    HomographyEstimate,
    MediaUnreadableError,
    PixelBox,
    RegionUpdate,
)
from framepilot_tracking_lite.geometry import Matrix3x3, Point
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
    #: Per-frame verified agreement / contradiction the registration check reports.
    agreement: dict[int, float] = field(default_factory=dict)
    contradiction: dict[int, float] = field(default_factory=dict)
    #: Frames the registration cannot place at all (the region left the picture).
    unregistrable_frames: set[int] = field(default_factory=set)
    #: Every registration asked for, as (reference, current, motion, guesses).
    alignments: list[tuple[int, int, str, int]] = field(default_factory=list)
    #: The exclusions every feature detection was given (MK7.7).
    detect_exclusions: list[tuple[PixelBox, ...]] = field(default_factory=list)
    #: Per registration: (current frame, exclusions on the reference, exclusions on the current).
    align_exclusions: list[tuple[int, tuple[PixelBox, ...], tuple[PixelBox, ...]]] = field(
        default_factory=list
    )
    #: Frames on which an exclusion's content cannot be found (it left, or turned away).
    occluder_unseen_frames: set[int] = field(default_factory=set)
    #: How an occluder inside an exclusion moves, per frame (MK7.7).
    occluder_motion: tuple[float, float] = (0.0, 0.0)
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
        self,
        path: str,
        first_frame: int,
        last_frame_exclusive: int,
        fps: float | None = None,
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
        self,
        frame: Frame,
        box_pixels: tuple[float, float, float, float],
        max_features: int,
        exclusions: Sequence[PixelBox] = (),
    ) -> Sequence[Point]:
        self.detect_exclusions.append(tuple(exclusions))
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

    def align(
        self,
        reference: Frame,
        current: Frame,
        region: Sequence[Point],
        guesses: Sequence[Matrix3x3],
        motion: str,
        reference_exclusions: Sequence[PixelBox] = (),
        current_exclusions: Sequence[PixelBox] = (),
    ) -> Alignment | None:
        """Registration converges on the subject's TRUE motion, whatever the guesses were.

        That is the property the real backend's ECC + check provides and the policy relies on:
        a biased flow guess is corrected, and how much of the region verified is scripted.
        """
        self.align_exclusions.append(
            (int(current), tuple(reference_exclusions), tuple(current_exclusions))
        )
        self.alignments.append((int(reference), int(current), motion, len(guesses)))
        if int(current) in self.unregistrable_frames or not guesses:
            return None
        dx, dy = self.offset(int(reference), int(current))
        return Alignment(
            matrix=((1.0, 0.0, dx), (0.0, 1.0, dy), (0.0, 0.0, 1.0)),
            agreement=self.agreement.get(int(current), 1.0),
            contradiction=self.contradiction.get(int(current), 0.0),
            cells=16,
        )

    def follow_region(
        self, reference: Frame, box: PixelBox, current: Frame, predicted: PixelBox
    ) -> tuple[PixelBox, float] | None:
        """An occluder that moves by `occluder_motion` per frame, found wherever it went."""
        if int(current) in self.occluder_unseen_frames:
            return None
        steps = int(current) - int(reference)
        dx, dy = self.occluder_motion
        return (box[0] + dx * steps, box[1] + dy * steps, box[2], box[3]), 1.0


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
