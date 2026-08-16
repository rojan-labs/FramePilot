"""What the worker is willing to claim.

The models produce raw scores and raw masks. This module decides what becomes a
reported result, and every rule here exists to stop the pack from returning
something that merely looks like an answer:

* **A floor on confidence.** Detectors emit long tails of low-scoring guesses. A
  0.2-confidence "face" on a doorknob is noise, and passing it to the editor as a
  subject would be worse than returning nothing.
* **Nothing found is a real answer.** An empty detection list is returned as an
  empty detection list. There is no fallback that invents a centre-frame box.
* **A point prompt is resolved against a real detection**, never expanded into a
  guessed rectangle. If no person contains the prompted point, that is
  ``target_lost`` — the honest answer — because a guessed box would produce a
  confident mask of the wrong thing.
* **An empty mask is a loss, not a mask.** Segmenting a region with no subject in
  it returns ``target_lost`` rather than an all-zero mask the host would have to
  interpret.
* **Total ordering.** Results are emitted in a stable order so the same media and
  request produce byte-identical output across runs and across machines.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from typing import Final

from .backend import FrameSource, RawDetection, SubjectBackend
from .geometry import (
    PixelBox,
    contains,
    encode_run_lengths,
    normalize_box,
    point_in_pixels,
    to_pixel_box,
)
from .protocol import (
    Detection,
    MaskSample,
    ProtocolError,
    SubjectRequest,
)

#: Below this the detector is guessing, and a guess presented as a subject is
#: worse for an editor than an honest empty result.
MIN_DETECTION_CONFIDENCE: Final = 0.5

#: A mask covering less of the prompt than this is noise — a few stray pixels,
#: not a subject. Reported as `target_lost` instead of a near-empty mask.
MIN_FOREGROUND_FRACTION: Final = 0.02


class SubjectNotFoundError(Exception):
    """No subject could be found where the caller pointed."""


def select_detections(
    raw: list[RawDetection],
    frame: int,
    width: int,
    height: int,
    *,
    labels: tuple[str, ...],
    max_detections: int,
) -> list[Detection]:
    """Filter, bound and normalize one frame's detections."""
    wanted = [
        item
        for item in raw
        if item.label in labels and item.confidence >= MIN_DETECTION_CONFIDENCE
    ]
    # Highest confidence first, then a positional tiebreak so `max_detections`
    # cuts the same way every run even when two scores are identical.
    wanted.sort(key=lambda item: (-item.confidence, item.box[0], item.box[1]))
    kept: list[Detection] = []
    for item in wanted[:max_detections]:
        box = normalize_box(item.box, width, height)
        if box.width <= 0.0 or box.height <= 0.0:
            # Entirely outside the frame after clipping: not a detection at all.
            continue
        kept.append(
            Detection(
                frame=frame,
                label=item.label,
                box=box,
                confidence=min(max(item.confidence, 0.0), 1.0),
            )
        )
    return kept


def run_detection(
    request: SubjectRequest,
    source: FrameSource,
    backend: SubjectBackend,
    *,
    should_cancel: Callable[[], bool],
) -> Iterator[list[Detection]]:
    """Yield each frame's detections in ascending frame order."""
    wants_faces = "face" in request.labels
    wants_objects = "person" in request.labels or "object" in request.labels
    frame_number = request.media.first_frame
    while True:
        if should_cancel():
            raise ProtocolError("cancelled", "subject detection cancelled by the host.")
        frame = source.read()
        if frame is None:
            return
        raw: list[RawDetection] = []
        if wants_faces:
            raw.extend(backend.detect_faces(frame))
        if wants_objects:
            raw.extend(backend.detect_objects(frame))
        yield select_detections(
            raw,
            frame_number,
            source.width,
            source.height,
            labels=request.labels,
            max_detections=request.max_detections,
        )
        frame_number += 1


def resolve_prompt_region(
    request: SubjectRequest,
    frame: object,
    backend: SubjectBackend,
    width: int,
    height: int,
) -> PixelBox:
    """Turn the caller's prompt into a real pixel region to segment.

    A region prompt is used as given. A point prompt is resolved against actual
    person detections: the smallest detected person containing the point wins,
    because when someone clicks on a face in a crowd they mean that person, not
    the group behind them.
    """
    if request.region is not None:
        return to_pixel_box(request.region, width, height)
    assert request.point is not None
    target = point_in_pixels(request.point, width, height)
    candidates = [
        item
        for item in backend.detect_objects(frame)
        if item.label == "person"
        and item.confidence >= MIN_DETECTION_CONFIDENCE
        and contains(item.box, target)
    ]
    if not candidates:
        raise SubjectNotFoundError(
            "no person was detected at the prompted point, so there is nothing to segment."
        )
    smallest = min(candidates, key=lambda item: (item.box[2] * item.box[3], item.box[0]))
    return smallest.box


def build_mask_sample(
    frame_number: int,
    mask_width: int,
    mask_height: int,
    values: list[int],
    confidence: float,
) -> MaskSample:
    """Encode one mask, refusing to report a mask with effectively nothing in it."""
    filled = sum(1 for value in values if value)
    if filled == 0 or filled < MIN_FOREGROUND_FRACTION * len(values):
        raise SubjectNotFoundError(
            "the prompted region contains no recognizable subject to segment."
        )
    return MaskSample(
        frame=frame_number,
        width=mask_width,
        height=mask_height,
        counts=encode_run_lengths(values),
        confidence=min(max(confidence, 0.0), 1.0),
    )


def run_segmentation(
    request: SubjectRequest,
    source: FrameSource,
    backend: SubjectBackend,
    *,
    should_cancel: Callable[[], bool],
) -> Iterator[MaskSample]:
    """Yield one mask per frame, in ascending frame order."""
    frame_number = request.media.first_frame
    while True:
        if should_cancel():
            raise ProtocolError("cancelled", "subject segmentation cancelled by the host.")
        frame = source.read()
        if frame is None:
            return
        region = resolve_prompt_region(request, frame, backend, source.width, source.height)
        raw = backend.segment_subject(frame, region)
        yield build_mask_sample(
            frame_number,
            raw.width,
            raw.height,
            list(raw.values),
            raw.confidence,
        )
        frame_number += 1
