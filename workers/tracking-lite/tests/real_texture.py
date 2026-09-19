"""MK7.5: real texture, known motion — the construction behind the real-texture tracking gates.

Plan 06 asks for "real clips with hand-labelled corners". Hand labels are a maintainer action
(MO-8) and are themselves a few tenths of a pixel wrong. This module builds the next best thing,
which is in one respect better: **real camera texture moved by a KNOWN camera**, so the ground
truth is exact rather than labelled.

* **Texture** is three people-free stills cut from the mission b-roll
  (`fixtures/real-texture/`, see its README): sunlit foliage, a tree against leaves, and a
  low-light pavement. Real sensor noise, real compression history, real texture statistics —
  none of which the seeded-noise plate of `test_tracking_gates.py` has.
* **Motion** is a continuous 3x3 function of time in frame pixels. A frame is the plate seen
  through that homography, rendered 2x supersampled and area-reduced, so it has the anti-aliased
  look of a sensor rather than a bilinear resample.
* **Degradations** follow a camera's order: motion blur (sub-frame exposure across a 180°
  shutter), a moving foreground occluder, exposure drift, sensor noise, 8-bit quantisation, then a
  real H.264 encode that the worker decodes through its own `OpenCvFrameSource`.

The truth for frame ``t`` is ``H(t)`` at mid-exposure, so every error reported is the distance
between where the tracked mask put a point and where the camera actually moved it.

The host's policy — constraining a measured plane to the editor's method, the residual penalty
and the flag floor — is re-stated here from `packages/editor-core/src/mask-track-solve.ts` and
`mask-track-review.ts`; `test_tracking_gates.py` pins the constants against the TypeScript.
"""

from __future__ import annotations

import math
import os
import shutil
import subprocess
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

from framepilot_tracking_lite.backend import FrameSource
from framepilot_tracking_lite.opencv_backend import OpenCvBackend
from framepilot_tracking_lite.policy import run_tracker
from framepilot_tracking_lite.protocol import (
    MediaHandle,
    NormalizedPoint,
    TrackingRequest,
    TrackingSample,
)
from framepilot_tracking_lite.runtime import ReversedFrameSource, build_tracker

PLATES = Path(__file__).parent / "fixtures" / "real-texture"
FPS = 30.0
#: The frame shows the central 80 % of the plate, so a moving camera never runs off its edge.
VIEW_FRACTION = 0.8
SUPERSAMPLE = 2

#: Host policy (`mask-track-solve.ts`), pinned by `test_tracking_gate_constants_match_the_host`.
FLAG_CONFIDENCE = 0.5
FLAG_RESIDUAL_PX = 1.0

Matrix = np.ndarray
Motion = Callable[[float], Matrix]


# --- plates and motion ----------------------------------------------------------------------


def load_plate(name: str) -> np.ndarray:
    image = cv2.imread(str(PLATES / f"{name}.jpg"), cv2.IMREAD_COLOR)
    assert image is not None, f"missing real-texture plate {name}"
    return image.astype(np.float32)


def about_centre(size: tuple[int, int], matrix: Matrix) -> Matrix:
    """`matrix` expressed about the frame centre instead of the top-left corner."""
    cx, cy = (size[0] - 1) / 2.0, (size[1] - 1) / 2.0
    to_centre = np.array([[1.0, 0.0, -cx], [0.0, 1.0, -cy], [0.0, 0.0, 1.0]])
    back = np.array([[1.0, 0.0, cx], [0.0, 1.0, cy], [0.0, 0.0, 1.0]])
    return back @ matrix @ to_centre


def camera(
    size: tuple[int, int],
    *,
    dx: float = 0.0,
    dy: float = 0.0,
    scale: float = 1.0,
    degrees: float = 0.0,
    tilt_x: float = 0.0,
    tilt_y: float = 0.0,
) -> Matrix:
    """A plane's motion in frame pixels: translation, similarity and keystone about the centre.

    ``tilt_x``/``tilt_y`` are the third-row terms in units of 1/frame-width, so ``0.1`` is a
    keystone that changes scale by about 10 % across the frame — a strong, real perspective.
    """
    radians = math.radians(degrees)
    c, s = math.cos(radians) * scale, math.sin(radians) * scale
    similarity = np.array([[c, -s, dx], [s, c, dy], [0.0, 0.0, 1.0]])
    keystone = np.array(
        [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [tilt_x / size[0], tilt_y / size[0], 1.0]]
    )
    return about_centre(size, similarity @ keystone)


def view_matrix(plate: np.ndarray, size: tuple[int, int]) -> Matrix:
    """Plate pixels → frame pixels at t = 0: the plate's centre, scaled to fill the view."""
    plate_h, plate_w = plate.shape[:2]
    scale = size[0] / (plate_w * VIEW_FRACTION)
    pcx, pcy = (plate_w - 1) / 2.0, (plate_h - 1) / 2.0
    fcx, fcy = (size[0] - 1) / 2.0, (size[1] - 1) / 2.0
    return np.array([[scale, 0.0, fcx - scale * pcx], [0.0, scale, fcy - scale * pcy], [0, 0, 1.0]])


def supersampled(size: tuple[int, int]) -> Matrix:
    """Frame pixels → the 2x render grid, pixel centres aligned (x ↦ 2x + 0.5)."""
    k = float(SUPERSAMPLE)
    offset = (k - 1.0) / 2.0
    return np.array([[k, 0.0, offset], [0.0, k, offset], [0.0, 0.0, 1.0]])


def render(image: np.ndarray, matrix: Matrix, size: tuple[int, int]) -> np.ndarray:
    """`image` through `matrix` (image → frame pixels), rendered 2x and area-reduced."""
    hi = (size[0] * SUPERSAMPLE, size[1] * SUPERSAMPLE)
    warped = cv2.warpPerspective(
        image,
        supersampled(size) @ matrix,
        hi,
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REFLECT101,
    )
    return cv2.resize(warped, size, interpolation=cv2.INTER_AREA)


# --- the scene ------------------------------------------------------------------------------


@dataclass
class Layer:
    """A foreground element: colour and alpha in frame pixels at time t, or None when absent."""

    draw: Callable[[float], tuple[np.ndarray, np.ndarray] | None]


@dataclass
class Scene:
    plate: str
    size: tuple[int, int]
    frames: int
    motion: Motion
    #: Fraction of the frame interval the shutter is open (0.5 = 180°). 0 disables blur.
    shutter: float = 0.5
    blur_samples: int = 5
    noise_sigma: float = 2.0
    #: Exposure: (gain, offset) at time t.
    exposure: Callable[[float], tuple[float, float]] = lambda _t: (1.0, 0.0)
    layers: list[Layer] = field(default_factory=list)
    seed: int = 1
    #: Replace the plate (e.g. a periodic pattern built from it).
    plate_override: np.ndarray | None = None

    def truth(self, frame: int) -> Matrix:
        return self.motion(float(frame))


def exposure_drift(
    amplitude: float, period_frames: float
) -> Callable[[float], tuple[float, float]]:
    """Auto-exposure breathing: a slow gain wobble of ± `amplitude`."""
    return lambda t: (1.0 + amplitude * math.sin(2.0 * math.pi * t / period_frames), 0.0)


def frames_of(scene: Scene) -> Iterator[np.ndarray]:
    plate = load_plate(scene.plate) if scene.plate_override is None else scene.plate_override
    view = view_matrix(plate, scene.size)
    rng = np.random.default_rng(scene.seed)
    for index in range(scene.frames):
        t = float(index)
        if scene.shutter > 0.0 and scene.blur_samples > 1:
            offsets = np.linspace(-scene.shutter / 2.0, scene.shutter / 2.0, scene.blur_samples)
        else:
            offsets = np.array([0.0])
        picture = np.zeros((scene.size[1], scene.size[0], 3), np.float32)
        for offset in offsets:
            sub = render(plate, scene.motion(t + offset) @ view, scene.size)
            for layer in scene.layers:
                drawn = layer.draw(t + float(offset))
                if drawn is None:
                    continue
                colour, alpha = drawn
                sub = sub * (1.0 - alpha[..., None]) + colour * alpha[..., None]
            picture += sub
        picture /= float(len(offsets))
        gain, bias = scene.exposure(t)
        picture = picture * gain + bias
        if scene.noise_sigma > 0.0:
            picture += rng.normal(0.0, scene.noise_sigma, picture.shape).astype(np.float32)
        yield np.clip(np.rint(picture), 0, 255).astype(np.uint8)


def moving_patch(
    source: np.ndarray,
    size: tuple[int, int],
    patch: tuple[int, int],
    path: Callable[[float], tuple[float, float] | None],
    feather: float = 6.0,
) -> Layer:
    """A foreground occluder of real texture, sliding along `path` (top-left, frame pixels)."""
    height, width = patch
    crop = source[:height, :width].astype(np.float32)
    mask = np.zeros((height, width), np.float32)
    inset = int(feather)
    mask[inset : height - inset, inset : width - inset] = 1.0
    mask = cv2.GaussianBlur(mask, (0, 0), feather / 2.0)

    def draw(t: float) -> tuple[np.ndarray, np.ndarray] | None:
        where = path(t)
        if where is None:
            return None
        shift = np.array([[1.0, 0.0, where[0]], [0.0, 1.0, where[1]], [0.0, 0.0, 1.0]])
        colour = cv2.warpPerspective(crop, shift, size, flags=cv2.INTER_LINEAR)
        alpha = cv2.warpPerspective(mask, shift, size, flags=cv2.INTER_LINEAR)
        return colour, alpha

    return Layer(draw)


# --- encoding -------------------------------------------------------------------------------


def ffmpeg_executable() -> str | None:
    """System ffmpeg, else the `imageio-ffmpeg` binary the pack workflow adds for the test run."""
    explicit = os.environ.get("FRAMEPILOT_TEST_FFMPEG")
    if explicit:
        return explicit
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg  # type: ignore[import-not-found]
    except ImportError:
        return None
    return str(imageio_ffmpeg.get_ffmpeg_exe())


def encode(scene: Scene, path: Path, crf: int) -> Path:
    """Render `scene` straight into an H.264 file (yuv420p, GOP 30, B-frames) — a camera file."""
    executable = ffmpeg_executable()
    assert executable is not None, "the real-texture gates need ffmpeg to encode"
    width, height = scene.size
    command = [
        executable,
        "-v",
        "error",
        "-y",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "bgr24",
        "-s",
        f"{width}x{height}",
        "-r",
        str(int(FPS)),
        "-i",
        "-",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        str(crf),
        "-pix_fmt",
        "yuv420p",
        "-g",
        "30",
        "-bf",
        "2",
        "-threads",
        "1",
        str(path),
    ]
    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    assert process.stdin is not None
    try:
        for frame in frames_of(scene):
            process.stdin.write(frame.tobytes())
    finally:
        process.stdin.close()
        code = process.wait()
    assert code == 0, f"ffmpeg failed encoding {path.name} (exit {code})"
    return path


# --- running the worker exactly as a request does ----------------------------------------------


def normalized(point: tuple[float, float], size: tuple[int, int]) -> NormalizedPoint:
    return NormalizedPoint(x=point[0] / size[0], y=point[1] / size[1])


def request(
    *,
    path: Path,
    size: tuple[int, int],
    first: int,
    last_exclusive: int,
    quad: Sequence[tuple[float, float]] | None = None,
    point: tuple[float, float] | None = None,
    points: Sequence[tuple[float, float]] = (),
    reverse: bool = False,
) -> TrackingRequest:
    media = MediaHandle(
        handle_id="h",
        asset_id="a",
        absolute_path=str(path),
        source_start_seconds=first / FPS,
        source_end_seconds=last_exclusive / FPS,
        fps=FPS,
        first_frame=first,
        last_frame_exclusive=last_exclusive,
    )
    if quad is not None:
        corners = tuple(normalized(corner, size) for corner in quad)
        return TrackingRequest(
            request_id="rt",
            project_revision=0,
            capability="tracking.planar",
            media=media,
            corners=corners,  # type: ignore[arg-type]
            reverse=reverse,
        )
    assert point is not None
    return TrackingRequest(
        request_id="rt",
        project_revision=0,
        capability="tracking.point",
        media=media,
        point=normalized(point, size),
        points=tuple(normalized(p, size) for p in points),
        reverse=reverse,
    )


def run(req: TrackingRequest) -> list[TrackingSample]:
    """`runtime.execute_request` without the wire: same source, same reverse, same tracker."""
    backend = OpenCvBackend()

    def open_range(first: int, last: int) -> FrameSource:
        return backend.open_frames(req.media.absolute_path, first, last, fps=req.media.fps)

    source: FrameSource = (
        ReversedFrameSource(open_range, req.media.first_frame, req.media.last_frame_exclusive)
        if req.reverse
        else open_range(req.media.first_frame, req.media.last_frame_exclusive)
    )
    try:
        tracker = build_tracker(req, backend, source.width, source.height)
        return list(run_tracker(req, source, tracker, should_cancel=lambda: False))
    finally:
        source.close()


# --- the host's policy, re-stated -----------------------------------------------------------


def warp_point(matrix: Matrix, point: tuple[float, float]) -> tuple[float, float]:
    x, y, w = matrix @ np.array([point[0], point[1], 1.0])
    return (float(x / w), float(y / w))


def pixel_matrix(transform: Sequence[float], size: tuple[int, int]) -> Matrix:
    scale = np.diag([float(size[0]), float(size[1]), 1.0])
    return scale @ np.asarray(transform, dtype=np.float64).reshape(3, 3) @ np.linalg.inv(scale)


def constrain(homography: Matrix, method: str, quad: Sequence[tuple[float, float]]) -> Matrix:
    """`constrainTransform`: the measured plane reduced to the editor's motion model."""
    if method in ("perspective", "point-cloud"):
        return homography
    source = np.asarray(quad, dtype=np.float64)
    mapped = np.asarray([warp_point(homography, p) for p in quad])
    s_mean, t_mean = source.mean(axis=0), mapped.mean(axis=0)
    if method == "position":
        return np.array([[1, 0, t_mean[0] - s_mean[0]], [0, 1, t_mean[1] - s_mean[1]], [0, 0, 1.0]])
    sc, tc = source - s_mean, mapped - t_mean
    a = float(np.sum(sc[:, 0] * tc[:, 0] + sc[:, 1] * tc[:, 1]))
    b = float(np.sum(sc[:, 0] * tc[:, 1] - sc[:, 1] * tc[:, 0]))
    variance = float(np.sum(sc * sc))
    cos, sin = a / variance, b / variance
    return np.array(
        [
            [cos, -sin, t_mean[0] - (cos * s_mean[0] - sin * s_mean[1])],
            [sin, cos, t_mean[1] - (sin * s_mean[0] + cos * s_mean[1])],
            [0.0, 0.0, 1.0],
        ]
    )


def model_residual(measured: Matrix, model: Matrix, quad: Sequence[tuple[float, float]]) -> float:
    worst = 0.0
    for point in quad:
        mx, my = warp_point(measured, point)
        fx, fy = warp_point(model, point)
        worst = max(worst, math.hypot(mx - fx, my - fy))
    return worst


def host_confidence(measured: float, residual_px: float) -> float:
    """`confidenceOf`: the tracker's number, penalised by the model residual."""
    clamped = min(max(measured, 0.0), 1.0)
    penalty = min(max(1.0 - residual_px / (2.0 * FLAG_RESIDUAL_PX), 0.0), 1.0)
    return clamped * penalty


@dataclass
class TrackedFrame:
    frame: int
    #: Where the mask's geometry lands, per tracked point, frame pixels.
    points: list[tuple[float, float]]
    #: The stored (host) confidence.
    confidence: float
    held: bool


def host_track(
    samples: Sequence[TrackingSample],
    *,
    method: str,
    size: tuple[int, int],
    reference_frame: int,
    quad: Sequence[tuple[float, float]],
    geometry: Sequence[tuple[float, float]],
) -> dict[int, TrackedFrame]:
    """`buildTrackArtifact` + the render: each frame's mask geometry as the editor would see it.

    `geometry` is the mask's own points at the reference frame (the quad corners for a planar
    method, the path vertices for a shape track).
    """
    by_frame = {sample.frame: sample for sample in samples}
    out: dict[int, TrackedFrame] = {}
    if method == "point-cloud":
        for sample in samples:
            assert sample.points is not None
            moved = [(p.x * size[0], p.y * size[1]) for p in sample.points]
            out[sample.frame] = TrackedFrame(
                sample.frame, moved, host_confidence(sample.confidence, 0.0), sample.occluded
            )
        return out
    reference = by_frame[reference_frame]
    assert reference.transform is not None
    inverse_reference = np.linalg.inv(pixel_matrix(reference.transform, size))
    for sample in samples:
        assert sample.transform is not None
        anchored = pixel_matrix(sample.transform, size) @ inverse_reference
        model = constrain(anchored, method, quad)
        residual = model_residual(anchored, model, quad)
        out[sample.frame] = TrackedFrame(
            sample.frame,
            [warp_point(model, p) for p in geometry],
            host_confidence(sample.confidence, residual),
            sample.occluded,
        )
    return out


def point_errors(
    scene: Scene,
    tracked: TrackedFrame,
    reference_frame: int,
    geometry: Sequence[tuple[float, float]],
) -> list[float]:
    """Per point: the distance between the tracked geometry and where the camera moved it."""
    relative = scene.truth(tracked.frame) @ np.linalg.inv(scene.truth(reference_frame))
    errors: list[float] = []
    for measured, original in zip(tracked.points, geometry, strict=True):
        tx, ty = warp_point(relative, original)
        errors.append(math.hypot(measured[0] - tx, measured[1] - ty))
    return errors


def frame_error(
    scene: Scene,
    tracked: TrackedFrame,
    reference_frame: int,
    geometry: Sequence[tuple[float, float]],
) -> float:
    """The frame's worst point: a mask is only as right as its worst corner or vertex."""
    return max(point_errors(scene, tracked, reference_frame, geometry))


def flagged(frame: TrackedFrame) -> bool:
    return frame.confidence < FLAG_CONFIDENCE


def summary(errors: Sequence[float]) -> dict[str, float]:
    values = np.asarray(errors, dtype=np.float64)
    return {
        "medianPx": float(np.median(values)),
        "p95Px": float(np.percentile(values, 95.0)),
        "maxPx": float(values.max()),
    }


# --- correction: constraint frames and re-track (mask-track-review.ts) --------------------------


def flagged_ranges(confidence: dict[int, float]) -> list[tuple[int, int]]:
    """Contiguous runs of frames under the floor, half-open on the frame grid."""
    ranges: list[tuple[int, int]] = []
    start: int | None = None
    frames = sorted(confidence)
    for frame in frames:
        low = confidence[frame] < FLAG_CONFIDENCE
        if low and start is None:
            start = frame
        if not low and start is not None:
            ranges.append((start, frame))
            start = None
    if start is not None:
        ranges.append((start, frames[-1] + 1))
    return ranges


def retrack_plan(
    confidence: dict[int, float], anchors: Sequence[int], first: int, last_exclusive: int
) -> list[tuple[int, int, int, bool]]:
    """`retrackPlan`: (reference, first, lastExclusive, reverse) per measurement.

    Each direction runs from the constraint to the end of the first low-confidence stretch it
    meets, bounded by the midpoint to the neighbouring constraint.
    """

    def low(frame: int) -> bool:
        return confidence.get(frame, 1.0) < FLAG_CONFIDENCE

    ordered = sorted(anchors)
    plan: list[tuple[int, int, int, bool]] = []
    for index, anchor in enumerate(ordered):
        previous = ordered[index - 1] if index > 0 else None
        following = ordered[index + 1] if index + 1 < len(ordered) else None
        lower = first if previous is None else math.ceil((previous + anchor) / 2)
        upper = last_exclusive if following is None else math.ceil((anchor + following) / 2)
        frame = anchor
        while frame < upper and not low(frame):
            frame += 1
        if frame < upper:
            while frame < upper and low(frame):
                frame += 1
            if frame - anchor >= 1:
                plan.append((anchor, anchor, frame, False))
        frame = anchor
        while frame >= lower and not low(frame):
            frame -= 1
        if frame >= lower:
            while frame >= lower and low(frame):
                frame -= 1
            if anchor - frame > 1:
                plan.append((anchor, frame + 1, anchor + 1, True))
    return plan
