"""The real inference backend: OpenCV `dnn` running three pinned ONNX models.

Pre- and post-processing follows each model's own reference implementation in
OpenCV Zoo rather than a plausible reconstruction. That matters more than it
sounds: YOLOX's boxes are decoded from grid offsets with `exp`-scaled sizes and a
letterbox ratio, and PPHumanSeg expects `(x/255 - 0.5) / 0.5` on RGB. Getting
either subtly wrong produces detections that look reasonable and sit in the wrong
place — the failure mode this pack's decoded-media proof exists to catch.

Determinism: one thread, OpenCL off, fixed seed. Same media in, same bytes out.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from typing import Any, Final

import numpy as np

from .backend import (
    BackendUnavailableError,
    FrameSource,
    MediaUnreadableError,
    RawDetection,
    RawMask,
)
from .geometry import PixelBox, clamp
from .models import models_directory, resolve_model, verify_all
from .sandbox import DETERMINISTIC_SEED

#: YuNet's own score threshold. Below this its output is not worth showing.
FACE_SCORE_THRESHOLD: Final = 0.7
FACE_NMS_THRESHOLD: Final = 0.3
FACE_TOP_K: Final = 500
#: YuNet is trained at a fixed working size; larger inputs are scaled to it so a
#: 4K frame costs the same as a 1080p one and gives the same answer.
FACE_WORKING_EDGE: Final = 640

YOLOX_INPUT: Final = 640
YOLOX_STRIDES: Final = (8, 16, 32)
YOLOX_SCORE_THRESHOLD: Final = 0.5
YOLOX_NMS_THRESHOLD: Final = 0.5
YOLOX_PAD_VALUE: Final = 114.0
#: COCO class 0. Every other class is reported as a generic `object`, because
#: this protocol has three labels and inventing an 80-way taxonomy on the wire
#: would be a schema change, not an implementation detail.
COCO_PERSON_CLASS: Final = 0

SEGMENT_INPUT: Final = 192
SEGMENT_MEAN: Final = 0.5
SEGMENT_STD: Final = 0.5
#: Emitted masks are bounded so one frame cannot exceed the protocol's run-length
#: cap. 512 on the long edge is ample for a matte the host will scale anyway.
MASK_LONG_EDGE: Final = 512


def _require_cv() -> Any:
    try:
        import cv2
    except ImportError as error:  # pragma: no cover - exercised by pack CI only
        raise BackendUnavailableError(
            "OpenCV is not installed in this pack runtime."
        ) from error
    return cv2


class _VideoFrameSource:
    """Decodes exactly the approved frame range, in order, once."""

    def __init__(self, cv2: Any, path: str, first_frame: int, last_frame_exclusive: int) -> None:
        self._cv2 = cv2
        capture = cv2.VideoCapture(path)
        if not capture.isOpened():
            raise MediaUnreadableError(f"could not open approved media at {path}.")
        self._capture = capture
        self._remaining = last_frame_exclusive - first_frame
        if first_frame > 0:
            capture.set(cv2.CAP_PROP_POS_FRAMES, first_frame)
        self._width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        self._height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        if self._width <= 0 or self._height <= 0:
            capture.release()
            raise MediaUnreadableError(f"approved media at {path} reports no picture size.")

    @property
    def width(self) -> int:
        return self._width

    @property
    def height(self) -> int:
        return self._height

    def read(self) -> Any | None:
        if self._remaining <= 0:
            return None
        ok, frame = self._capture.read()
        if not ok or frame is None:
            return None
        self._remaining -= 1
        return frame

    def close(self) -> None:
        self._capture.release()


class _ImageFrameSource:
    """A single still image, so detection can run on a frame grab as well as video."""

    def __init__(self, cv2: Any, path: str, frames: int) -> None:
        image = cv2.imread(path)
        if image is None:
            raise MediaUnreadableError(f"could not decode approved image at {path}.")
        self._image = image
        self._remaining = frames
        # `shape` is untyped, so the sizes are pinned to int here rather than
        # leaking Any out through the FrameSource contract.
        self._height = int(image.shape[0])
        self._width = int(image.shape[1])

    @property
    def width(self) -> int:
        return self._width

    @property
    def height(self) -> int:
        return self._height

    def read(self) -> Any | None:
        if self._remaining <= 0:
            return None
        self._remaining -= 1
        return self._image

    def close(self) -> None:
        return None


#: Extensions decoded as stills rather than through the video reader.
_IMAGE_SUFFIXES: Final = frozenset({".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tif", ".tiff"})


class OpenCvBackend:
    """Loads and runs the three pinned models."""

    def __init__(self, directory: Path | None = None) -> None:
        cv2 = _require_cv()
        self._cv2 = cv2
        cv2.setNumThreads(1)
        cv2.setRNGSeed(DETERMINISTIC_SEED)
        if hasattr(cv2, "ocl") and hasattr(cv2.ocl, "setUseOpenCL"):
            # OpenCL kernels vary by driver; a signed pack must not produce a
            # different answer on a different GPU.
            cv2.ocl.setUseOpenCL(False)
        models = directory if directory is not None else models_directory()
        self._digests = verify_all(models)
        self._face = cv2.FaceDetectorYN.create(
            str(resolve_model("face", models)),
            "",
            (FACE_WORKING_EDGE, FACE_WORKING_EDGE),
            FACE_SCORE_THRESHOLD,
            FACE_NMS_THRESHOLD,
            FACE_TOP_K,
        )
        self._objects = cv2.dnn.readNet(str(resolve_model("object", models)))
        self._segment = cv2.dnn.readNet(str(resolve_model("segment", models)))
        self._grids, self._grid_strides = _yolox_anchors()

    @property
    def name(self) -> str:
        return f"opencv-dnn-{self._cv2.__version__}"

    @property
    def model_digests(self) -> dict[str, str]:
        return dict(self._digests)

    def open_frames(self, path: str, first_frame: int, last_frame_exclusive: int) -> FrameSource:
        frames = last_frame_exclusive - first_frame
        if Path(path).suffix.lower() in _IMAGE_SUFFIXES:
            return _ImageFrameSource(self._cv2, path, frames)
        return _VideoFrameSource(self._cv2, path, first_frame, last_frame_exclusive)

    def detect_faces(self, frame: Any) -> Sequence[RawDetection]:
        cv2 = self._cv2
        height, width = frame.shape[:2]
        scale = min(1.0, FACE_WORKING_EDGE / max(width, height))
        working = (
            frame
            if scale >= 1.0
            else cv2.resize(frame, (max(1, int(width * scale)), max(1, int(height * scale))))
        )
        working_height, working_width = working.shape[:2]
        self._face.setInputSize((working_width, working_height))
        _, faces = self._face.detect(working)
        if faces is None:
            return ()
        inverse = 1.0 / scale if scale > 0 else 1.0
        detections: list[RawDetection] = []
        for row in faces:
            x, y, box_width, box_height = (float(value) * inverse for value in row[:4])
            detections.append(
                RawDetection(
                    label="face",
                    box=(x, y, box_width, box_height),
                    confidence=float(row[-1]),
                )
            )
        return tuple(detections)

    def detect_objects(self, frame: Any) -> Sequence[RawDetection]:
        cv2 = self._cv2
        height, width = frame.shape[:2]
        ratio = min(YOLOX_INPUT / height, YOLOX_INPUT / width)
        padded = np.ones((YOLOX_INPUT, YOLOX_INPUT, 3), np.float32) * YOLOX_PAD_VALUE
        resized = cv2.resize(
            frame, (int(width * ratio), int(height * ratio)), interpolation=cv2.INTER_LINEAR
        ).astype(np.float32)
        padded[: int(height * ratio), : int(width * ratio)] = resized
        self._objects.setInput(np.transpose(padded, (2, 0, 1))[np.newaxis])
        raw = self._objects.forward(self._objects.getUnconnectedOutLayersNames())[0][0]

        boxes = np.array(raw[:, :4], dtype=np.float32)
        centres = (boxes[:, :2] + self._grids) * self._grid_strides
        sizes = np.exp(boxes[:, 2:4]) * self._grid_strides
        corners = np.stack(
            [centres[:, 0] - sizes[:, 0] / 2.0, centres[:, 1] - sizes[:, 1] / 2.0], axis=1
        )
        scores = raw[:, 4:5] * raw[:, 5:]
        best = np.amax(scores, axis=1)
        classes = np.argmax(scores, axis=1)

        candidates = [
            [float(corners[i, 0]), float(corners[i, 1]), float(sizes[i, 0]), float(sizes[i, 1])]
            for i in range(raw.shape[0])
        ]
        keep = cv2.dnn.NMSBoxesBatched(
            candidates,
            best.tolist(),
            classes.tolist(),
            YOLOX_SCORE_THRESHOLD,
            YOLOX_NMS_THRESHOLD,
        )
        detections: list[RawDetection] = []
        for index in np.array(keep).flatten().tolist():
            index = int(index)
            x, y, box_width, box_height = (value / ratio for value in candidates[index])
            detections.append(
                RawDetection(
                    label="person" if int(classes[index]) == COCO_PERSON_CLASS else "object",
                    box=(x, y, box_width, box_height),
                    confidence=float(best[index]),
                )
            )
        return tuple(detections)

    def segment_subject(self, frame: Any, region: PixelBox) -> RawMask:
        cv2 = self._cv2
        height, width = frame.shape[:2]
        left = int(clamp(region[0], 0.0, float(width - 1)))
        top = int(clamp(region[1], 0.0, float(height - 1)))
        right = int(clamp(region[0] + region[2], float(left + 1), float(width)))
        bottom = int(clamp(region[1] + region[3], float(top + 1), float(height)))
        crop = frame[top:bottom, left:right]
        if crop.size == 0:
            raise MediaUnreadableError("the prompted region is empty after clipping to the frame.")

        prepared = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
        prepared = cv2.resize(prepared, (SEGMENT_INPUT, SEGMENT_INPUT)).astype(np.float32) / 255.0
        prepared = (prepared - SEGMENT_MEAN) / SEGMENT_STD
        self._segment.setInput(cv2.dnn.blobFromImage(prepared))
        logits = self._segment.forward()[0]

        # Softmax over the two channels gives a real probability, so the reported
        # confidence is measured rather than a constant.
        shifted = logits - np.max(logits, axis=0, keepdims=True)
        exponentials = np.exp(shifted)
        probabilities = exponentials / np.sum(exponentials, axis=0, keepdims=True)
        foreground = probabilities[1]

        mask_width, mask_height = _mask_size(width, height)
        crop_width = max(1, round((right - left) * mask_width / width))
        crop_height = max(1, round((bottom - top) * mask_height / height))
        crop_mask = cv2.resize(
            foreground, (crop_width, crop_height), interpolation=cv2.INTER_LINEAR
        )
        canvas = np.zeros((mask_height, mask_width), np.float32)
        canvas_left = min(round(left * mask_width / width), mask_width - crop_width)
        canvas_top = min(round(top * mask_height / height), mask_height - crop_height)
        canvas[
            canvas_top : canvas_top + crop_height, canvas_left : canvas_left + crop_width
        ] = crop_mask

        binary = (canvas >= 0.5).astype(np.uint8)
        selected = canvas[binary == 1]
        confidence = float(selected.mean()) if selected.size else 0.0
        return RawMask(
            width=mask_width,
            height=mask_height,
            values=binary.flatten().tolist(),
            confidence=confidence,
        )


def _mask_size(width: int, height: int) -> tuple[int, int]:
    """Bound the emitted mask so its run lengths stay well inside the protocol cap."""
    longest = max(width, height)
    if longest <= MASK_LONG_EDGE:
        return width, height
    scale = MASK_LONG_EDGE / longest
    return max(1, round(width * scale)), max(1, round(height * scale))


def _yolox_anchors() -> tuple[Any, Any]:
    """Grid centres and their strides, matching the reference decoder exactly."""
    grids = []
    strides = []
    for stride in YOLOX_STRIDES:
        size = YOLOX_INPUT // stride
        xs, ys = np.meshgrid(np.arange(size), np.arange(size))
        grid = np.stack((xs, ys), 2).reshape(-1, 2)
        grids.append(grid)
        strides.append(np.full((grid.shape[0], 1), stride))
    return (
        np.concatenate(grids, 0).astype(np.float32),
        np.concatenate(strides, 0).astype(np.float32),
    )


__all__ = ["OpenCvBackend"]
