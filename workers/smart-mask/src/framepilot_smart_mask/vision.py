"""The Fast engine: subject mattes from Apple's Vision framework (plan 13, SP3).

The pack's models cost 17–40 s per 1080p frame on the CPU (BR0.7) and ~2–3 s on an M1 Pro's GPU,
so a one-minute clip took most of a day. Vision segments the same frame in ~50 ms on the Neural
Engine, ships with macOS (no weights) and returns a soft matte. This module drives the native
helper (``native/vision-matte``) over a pipe and cleans its answer:

* Vision sometimes fuses a bright background object into the subject's instance (a lamp beside
  a presenter). Cutting it off by shape (erode, keep what touches the person) was tried and
  dropped: it left blocky partial removals, and those corrupted the evidence below.
* On the maintainer's clip
  a lamp behind the presenter's hand was in the matte in 28.5% of frames, switching 150 times in
  50 s. What gives it away: a pixel Vision only SOMETIMES takes, whose colour is the same when
  taken and when left out, is the same background object both times. :class:`BackgroundTwins`
  gathers that evidence across the job and gates those regions out (28.5% -> 2.3% of frames on
  that clip). A moving held object is not caught: where it passes, the colour differs.

The helper is macOS-only; :func:`helper_path` returning ``None`` is how every other platform (and
a pack built without the helper) says the Fast engine is unavailable.
"""

from __future__ import annotations

import logging
import os
import struct
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

import numpy as np
import numpy.typing as npt

from .protocol import ProtocolError

_log = logging.getLogger(__name__)

U8 = npt.NDArray[np.uint8]

HELPER_NAME: Final = "fp-vision-matte"
MAGIC: Final = b"FPVM"
MODE_MAIN_SUBJECT: Final = 0
MODE_SEEDED: Final = 1
FLAG_RESET: Final = 1
FLAG_PERSON: Final = 2
#: Work resolution for the evidence and the gates; neither needs source resolution.
ANCHOR_HEIGHT: Final = 270
SOLID: Final = 128
#: Alpha at or below this is nothing.
FAINT_FLOOR: Final = 8
#: A pixel is "sometimes taken" when Vision includes it in at least this share of frames ...
TWIN_MIN_ON_SHARE: Final = 0.03
#: ... and leaves it out of at least this share.
TWIN_MIN_OFF_SHARE: Final = 0.1
#: Largest per-channel difference (0-255) between a pixel's mean colour when taken and when left
#: out for the two to be the same object. A microphone moving over a wall differs by far more.
TWIN_MAX_COLOUR_DIFFERENCE: Final = 24.0
#: Frames of evidence before the gate acts at all.
TWIN_MIN_FRAMES: Final = 30
#: A fused object is at least this share of the frame (smaller specks are edge noise).
TWIN_MIN_AREA_SHARE: Final = 0.001
#: A region is "partly covered" in a frame when its coverage lies between these ...
TWIN_PARTIAL_LOW: Final = 0.2
TWIN_PARTIAL_HIGH: Final = 0.8
#: ... and a static object is partly covered in at most this share of frames.
TWIN_MAX_PARTIAL_SHARE: Final = 0.15
#: The region may flood at most this share of the frame height beyond the evidence ...
TWIN_GROW_SHARE: Final = 0.12
#: ... across neighbouring background pixels that differ by at most this per channel (0-255).
TWIN_GROW_TOLERANCE: Final = 10
#: One flood seed per this many evidence pixels (floods merge, so a sparse set is enough).
TWIN_GROW_SEED_STEP: Final = 16
#: In one frame, a pixel this close (0-255, per channel) to the object's colour is the object.
TWIN_FRAME_COLOUR_DIFFERENCE: Final = 40.0
#: When at least this share of what is solid over an object matches it loosely ...
TWIN_OBJECT_PRESENT_SHARE: Final = 0.5
#: ... all of that is dropped. The loose tolerance:
TWIN_FRAME_LOOSE_DIFFERENCE: Final = 130.0


def helper_path() -> Path | None:
    """The native helper, or ``None`` where the Fast engine cannot run."""
    if sys.platform != "darwin":
        return None
    candidates = []
    root = os.environ.get("FRAMEPILOT_CAPABILITY_PACK_ROOT")
    if root:
        candidates.append(Path(root) / "bin" / HELPER_NAME)
    # A development checkout: built by native/vision-matte/build.sh.
    candidates.append(
        Path(__file__).resolve().parents[2] / "native" / "vision-matte" / "build" / HELPER_NAME
    )
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate
    return None


@dataclass(frozen=True, slots=True)
class Seed:
    """What the editor pointed at, normalised, top-left origin. A click is a zero-area box."""

    x0: float
    y0: float
    x1: float
    y1: float


def small_mask(plane: U8) -> npt.NDArray[np.bool_]:
    """A matte as a solid mask at :data:`ANCHOR_HEIGHT`, where the temporal vote is taken."""
    import cv2

    height, width = plane.shape
    size = (max(1, round(width * ANCHOR_HEIGHT / height)), ANCHOR_HEIGHT)
    return np.asarray(cv2.resize(plane, size, interpolation=cv2.INTER_AREA) >= SOLID)


@dataclass(frozen=True, slots=True)
class TwinModel:
    """Background objects Vision sometimes fuses into the subject, at :data:`ANCHOR_HEIGHT`."""

    #: Where those objects are (grown by a small margin to cover their soft edge).
    region: npt.NDArray[np.bool_]
    #: The background at each pixel: its mean colour over the survey frames that left it out.
    colour: npt.NDArray[np.float32]

    @property
    def empty(self) -> bool:
        return not bool(self.region.any())

    def gate(
        self, solid: npt.NDArray[np.bool_], person: npt.NDArray[np.bool_], rgb_small: U8
    ) -> npt.NDArray[np.bool_] | None:
        """The region one frame's matte may keep; ``None`` = all of it.

        Inside a fused object's region, a pixel is dropped only while it LOOKS like that object:
        a microphone passing in front of the lamp is a different colour and stays.
        """
        if self.empty:
            return None
        import cv2

        difference = np.abs(rgb_small.astype(np.float32) - self.colour).max(axis=-1)
        # Only inside the object itself, and only solid pixels: growing the region to catch the
        # object's soft edge reached into where a dark microphone sits over a dark wall, where
        # colour says nothing, and cut the microphone. The soft edge the object leaves behind is
        # removed as a faint island instead (:func:`faint_islands`).
        strict = difference < TWIN_FRAME_COLOUR_DIFFERENCE
        # The person matte protects a hand passing in front of the object, but Vision's person
        # matte leaks onto the same object in some frames (it kept the whole lamp in ~1% of
        # them). A "person" pixel that looks exactly like the object is the object.
        protected = person & ~strict
        drop = self.region & solid & strict
        if not bool(drop.any()):
            return None
        # A lamp that blows out when the exposure shifts passes the strict tolerance only in
        # patches. Where most of what is solid over an object is roughly that object, all of
        # that goes; what is plainly something else (a black microphone over a bright lamp
        # differs by ~200) never does.
        count, labels = cv2.connectedComponents(self.region.astype(np.uint8))
        for label in range(1, count):
            component = (labels == label) & ~protected & solid
            loose = component & (difference < TWIN_FRAME_LOOSE_DIFFERENCE)
            if component.any() and loose.sum() >= TWIN_OBJECT_PRESENT_SHARE * component.sum():
                drop |= loose
        return ~drop


class BackgroundTwins:
    """Evidence, gathered over a sparse survey of the job, of fused background objects.

    All arrays are at :data:`ANCHOR_HEIGHT`. Three tests, each of which a held object fails:

    1. the pixel is only SOMETIMES in the matte,
    2. its colour is the same when it is in and when it is out (the same object both times; a
       microphone sweeping over a wall is not), and
    3. the connected region of such pixels switches in and out AS A WHOLE. Test 2 alone is
       fooled by dark on dark (a black microphone over a black monitor cut a hole in the
       microphone); a sweeping object covers its region partially most of the time, a static
       object is all in or all out.
    """

    def __init__(self, height: int, width: int) -> None:
        self.on = np.zeros((height, width), np.int32)
        self.colour_on = np.zeros((height, width, 3), np.float64)
        self.colour_off = np.zeros((height, width, 3), np.float64)
        self.series: list[npt.NDArray[np.bool_]] = []

    @property
    def frames(self) -> int:
        return len(self.series)

    def add(self, solid: npt.NDArray[np.bool_], rgb_small: U8) -> None:
        self.series.append(solid)
        self.on += solid
        colour = rgb_small.astype(np.float64)
        self.colour_on += colour * solid[..., None]
        self.colour_off += colour * ~solid[..., None]

    def model(self) -> TwinModel:
        import cv2

        shape = self.on.shape
        # What each pixel looks like when it is NOT in the matte, i.e. the background there.
        # The overall mean is wrong next to the object: where a microphone usually sits, the
        # mean IS the microphone, and gating by it cut the microphone out. A pixel that was
        # never out of the matte has no background colour and can never match.
        never_out = (self.frames - self.on) == 0
        colour = (self.colour_off / np.maximum(self.frames - self.on, 1)[..., None]).astype(
            np.float32
        )
        colour[never_out] = np.inf
        nothing = TwinModel(np.zeros(shape, np.bool_), colour)
        if self.frames < TWIN_MIN_FRAMES:
            return nothing
        off = self.frames - self.on
        sometimes = (self.on >= TWIN_MIN_ON_SHARE * self.frames) & (
            off >= TWIN_MIN_OFF_SHARE * self.frames
        )
        mean_on = self.colour_on / np.maximum(self.on, 1)[..., None]
        mean_off = self.colour_off / np.maximum(off, 1)[..., None]
        same = np.abs(mean_on - mean_off).max(axis=-1) < TWIN_MAX_COLOUR_DIFFERENCE
        kernel = np.ones((3, 3), np.uint8)
        candidates = cv2.morphologyEx((sometimes & same).astype(np.uint8), cv2.MORPH_OPEN, kernel)
        count, labels = cv2.connectedComponents(candidates)
        stack = np.stack(self.series)
        region = np.zeros(shape, np.bool_)
        for label in range(1, count):
            component = labels == label
            if component.sum() < TWIN_MIN_AREA_SHARE * component.size:
                continue
            coverage = stack[:, component].mean(axis=1)
            partial = ((coverage > TWIN_PARTIAL_LOW) & (coverage < TWIN_PARTIAL_HIGH)).mean()
            if partial <= TWIN_MAX_PARTIAL_SHARE:
                region |= component
        if not region.any():
            return nothing
        return TwinModel(_grow_over_background(region, colour), colour)


def _grow_over_background(
    region: npt.NDArray[np.bool_], background: npt.NDArray[np.float32]
) -> npt.NDArray[np.bool_]:
    """``region`` extended over the rest of the same object in the BACKGROUND picture.

    Where the subject often covers part of the object (a microphone in front of half a lamp),
    those pixels fail the evidence tests and half the lamp stayed in the matte. In the
    background picture the object is whole, so the region floods across neighbouring pixels of
    smoothly similar background colour, within a bounded distance of the evidence. A gate there
    is still safe: a pixel is only dropped while it looks like that background.
    """
    import cv2

    height, width = region.shape
    known = np.isfinite(background).all(axis=-1)
    picture = np.where(known[..., None], background, 0).astype(np.uint8)
    reach = max(1, round(TWIN_GROW_SHARE * height))
    bound = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * reach + 1, 2 * reach + 1))
    allowed = (cv2.dilate(region.astype(np.uint8), bound) > 0) & known
    # floodFill's mask is 2 px larger; non-zero mask pixels are walls.
    mask = np.ones((height + 2, width + 2), np.uint8)
    mask[1:-1, 1:-1] = np.where(allowed, 0, 1)
    tolerance = (TWIN_GROW_TOLERANCE,) * 3
    flags = 4 | cv2.FLOODFILL_MASK_ONLY | (2 << 8)
    ys, xs = np.nonzero(region)
    for y, x in zip(ys[::TWIN_GROW_SEED_STEP], xs[::TWIN_GROW_SEED_STEP], strict=True):
        if mask[y + 1, x + 1] == 0:
            cv2.floodFill(picture, mask, (int(x), int(y)), 0, tolerance, tolerance, flags)
    return np.asarray((mask[1:-1, 1:-1] == 2) | region)


def small_rgb(rgb: U8) -> U8:
    import cv2

    height, width = rgb.shape[:2]
    size = (max(1, round(width * ANCHOR_HEIGHT / height)), ANCHOR_HEIGHT)
    return np.asarray(cv2.resize(rgb, size, interpolation=cv2.INTER_AREA), np.uint8)


def faint_islands(alpha_small: U8) -> npt.NDArray[np.bool_]:
    """Islands of the matte with no solid pixel anywhere: the soft outline a removed background
    object leaves behind, or a wisp Vision put on a wall. The subject always has a solid core."""
    import cv2

    present = (alpha_small > FAINT_FLOOR).astype(np.uint8)
    count, labels = cv2.connectedComponents(present)
    if count <= 1:
        return np.zeros(alpha_small.shape, np.bool_)
    has_solid = np.zeros(count, np.bool_)
    has_solid[np.unique(labels[alpha_small >= SOLID])] = True
    has_solid[0] = True
    return np.asarray(~has_solid[labels])


def small_alpha(plane: U8) -> U8:
    import cv2

    height, width = plane.shape
    size = (max(1, round(width * ANCHOR_HEIGHT / height)), ANCHOR_HEIGHT)
    return np.asarray(cv2.resize(plane, size, interpolation=cv2.INTER_AREA), np.uint8)


def apply_gate(alpha: U8, gate: npt.NDArray[np.bool_] | None) -> U8:
    """``alpha`` limited to a small-resolution ``gate``, with a soft seam."""
    if gate is None:
        return alpha
    import cv2

    height, width = alpha.shape
    soft = cv2.resize(gate.astype(np.uint8) * 255, (width, height), interpolation=cv2.INTER_LINEAR)
    return np.minimum(alpha, soft).astype(np.uint8)


@dataclass(frozen=True, slots=True)
class Estimate:
    alpha: U8
    #: The person in the frame at vote resolution (all False when there is none).
    person: npt.NDArray[np.bool_]
    found: bool


class VisionEstimator:
    """One helper process for one frame size. Use as a context manager."""

    def __init__(self, width: int, height: int, helper: Path | None = None) -> None:
        path = helper or helper_path()
        if path is None:
            raise ProtocolError(
                "hardware_unsupported",
                "Fast background removal needs macOS. Choose Best quality instead.",
            )
        self.width = width
        self.height = height
        self._process: subprocess.Popen[bytes] | None = subprocess.Popen(
            [str(path), "--width", str(width), "--height", str(height)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        self._fresh = True

    def __enter__(self) -> VisionEstimator:
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.close()

    def reset(self) -> None:
        """Forget the followed subject (a new window, or a new seed)."""
        self._fresh = True

    def estimate(self, rgb: U8, seed: Seed | None = None) -> Estimate:
        """The subject's matte for one RGB frame."""
        process = self._process
        if process is None or process.stdin is None or process.stdout is None:
            raise ProtocolError("internal_error", "The Fast engine is not running.")
        flags = FLAG_PERSON | (FLAG_RESET if self._fresh else 0)
        self._fresh = False
        box = seed or Seed(0.0, 0.0, 1.0, 1.0)
        mode = MODE_MAIN_SUBJECT if seed is None else MODE_SEEDED
        try:
            process.stdin.write(
                MAGIC + struct.pack("<II4f", mode, flags, box.x0, box.y0, box.x1, box.y1)
            )
            process.stdin.write(np.ascontiguousarray(rgb).tobytes())
            process.stdin.flush()
            status, _instances = struct.unpack("<II", self._read(8))
            plane = self.width * self.height
            alpha = np.frombuffer(self._read(plane), np.uint8).reshape(self.height, self.width)
            person = np.frombuffer(self._read(plane), np.uint8).reshape(self.height, self.width)
        except (BrokenPipeError, EOFError) as error:
            raise ProtocolError(
                "internal_error", "The Fast engine stopped unexpectedly.", retryable=True
            ) from error
        small_person = small_mask(person)
        if status != 0:
            return Estimate(np.zeros((self.height, self.width), np.uint8), small_person, False)
        return Estimate(alpha.copy(), small_person, True)

    def _read(self, count: int) -> bytes:
        assert self._process is not None and self._process.stdout is not None
        chunks = bytearray()
        while len(chunks) < count:
            chunk = self._process.stdout.read(count - len(chunks))
            if not chunk:
                raise EOFError
            chunks += chunk
        return bytes(chunks)

    def close(self) -> None:
        process, self._process = self._process, None
        if process is None:
            return
        try:
            if process.stdin is not None:
                process.stdin.close()
            process.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            process.kill()


__all__ = [
    "BackgroundTwins",
    "Estimate",
    "Seed",
    "TwinModel",
    "VisionEstimator",
    "apply_gate",
    "faint_islands",
    "helper_path",
    "small_alpha",
    "small_mask",
    "small_rgb",
]
