"""What this pack will and will not claim.

Pure over its inputs: a shot span and a model's JSON in, a normalised description out. The
backend decodes pixels and runs the model; every decision about what the answer *means* is
made here, where it can be tested without a weight file.

The honesty rules, and why each exists:

- **A field is described or it is empty.** There is no filler sentence and no "unknown"
  written into free text. The ledger stores ``""`` for a field nobody described, and the
  renderer prints nothing for it — a plausible sentence would be counted as coverage.
- **Closed vocabularies are closed.** A camera angle or quality word outside the list is
  DROPPED, not mapped to its nearest neighbour. A nearest match is a fact this layer would
  be inventing, and tier 2 would then disagree with tier 1's shot size for a reason nobody
  could trace.
- **``p`` is a bucket, not a measurement.** The model self-rates low/medium/high and the
  engine maps that to 0.5/0.7/0.9. It is a hint the renderer may print; it is never a gate,
  and nothing here calibrates it.
- **A shot that cannot be described fails the request.** It is never dropped: the host asked
  about a specific shot list, and a short answer would be written as coverage for shots
  nobody looked at.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator, Mapping, Sequence
from typing import Any, Final

from .backend import (
    DescribeBackend,
    DescribeFailedError,
    MediaUnreadableError,
    ShotNotDescribableError,
)
from .protocol import (
    MAX_KEYFRAMES_PER_SHOT,
    Camera,
    DescribeRequest,
    ProtocolError,
    ShotDescription,
    ShotSpan,
)
from .schema import (
    CAMERA_ANGLES,
    CAMERA_MOVEMENTS,
    CONFIDENCE_LEVELS,
    DESCRIBED_JSON_SCHEMA,
    MAX_FIELD_CHARS,
    MAX_ON_SCREEN_TEXT_CHARS,
    MAX_ON_SCREEN_TEXT_ITEMS,
    MAX_QUALITY_ITEMS,
    MAX_SUMMARY_CHARS,
    QUALITY_VOCABULARY,
    SHOT_SIZES,
)

#: A span shorter than this is described from ONE frame. Three frames of a third of a
#: second are the same picture three times: it triples the cost of the slowest tier and
#: tells the model nothing it did not already have.
MIN_MULTI_FRAME_SPAN: Final = 0.5

#: Kept off both ends of a span. The first and last frames of a shot are the ones a cut or
#: a dissolve is most likely to contaminate, and a description of a half-faded frame is a
#: description of the transition rather than of the shot.
EDGE_INSET: Final = 0.08

#: The default when a model omits or mangles its self-rating. "medium" rather than "high":
#: an answer we could not read the confidence of is not one to advertise confidence for.
DEFAULT_CONFIDENCE: Final = "medium"


def keyframe_times(span: ShotSpan, *, max_frames: int = MAX_KEYFRAMES_PER_SHOT) -> list[float]:
    """The 1–3 source seconds this shot is described from (VU6.2).

    First, middle and last of the span — because a single keyframe cannot show what a shot
    *does*, and "man at a desk" and "man stands up and leaves" have the same first frame.
    A still, or any span too short for three distinct pictures, gets one frame at its
    midpoint.

    Every returned time lies strictly inside ``[t0, t1)``, so a frame is never decoded from
    the next shot.

    :raises ValueError: If ``max_frames`` is not between 1 and
        :data:`~framepilot_visual_describe.protocol.MAX_KEYFRAMES_PER_SHOT`.
    """
    if not 1 <= max_frames <= MAX_KEYFRAMES_PER_SHOT:
        raise ValueError(f"max_frames must be 1..{MAX_KEYFRAMES_PER_SHOT}, got {max_frames}")
    duration = span.t1 - span.t0
    middle = span.t0 + duration / 2.0
    if duration < MIN_MULTI_FRAME_SPAN or max_frames == 1:
        return [middle]
    inset = min(EDGE_INSET, duration / 4.0)
    times = [span.t0 + inset, middle, span.t1 - inset]
    if max_frames == 2:
        times = [span.t0 + inset, span.t1 - inset]
    # Strictly inside, and strictly increasing: a decoder handed the same timestamp twice
    # would spend a seek to produce a duplicate picture.
    ordered: list[float] = []
    for time in times:
        bounded = min(max(time, span.t0), span.t1 - 1e-6)
        if not ordered or bounded > ordered[-1]:
            ordered.append(bounded)
    return ordered


def _text(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    collapsed = " ".join(value.split())
    return collapsed[:limit].rstrip() if len(collapsed) > limit else collapsed


def _closed(value: Any, vocabulary: Sequence[str]) -> str | None:
    if not isinstance(value, str):
        return None
    candidate = value.strip()
    return candidate if candidate in vocabulary else None


def normalise(payload: Mapping[str, Any] | Any, shot_index: int) -> ShotDescription:
    """Turn one model answer into a description this pack is willing to sign.

    Forgiving about everything except the one field that carries the meaning: a shot with
    no summary has not been described, and saying so is the point of this whole tier.

    :raises DescribeFailedError: If the payload is not an object or has no summary.
    """
    if not isinstance(payload, Mapping):
        raise DescribeFailedError(f"shot {shot_index}: the model did not return an object.")
    summary = _text(payload.get("summary"), MAX_SUMMARY_CHARS)
    if not summary:
        # Parsed, but describes nothing. Distinguished from a malformed answer because only
        # one of the two is worth trying again — see `ShotNotDescribableError`.
        raise ShotNotDescribableError(f"shot {shot_index}: the model returned no summary.")
    raw_camera = payload.get("camera")
    camera_map: Mapping[str, Any] = raw_camera if isinstance(raw_camera, Mapping) else {}
    raw_text = payload.get("onScreenText")
    on_screen = tuple(_on_screen_text(raw_text))
    raw_quality = payload.get("quality")
    quality: list[str] = []
    if isinstance(raw_quality, Sequence) and not isinstance(raw_quality, (str, bytes)):
        for item in raw_quality:
            word = _closed(item, QUALITY_VOCABULARY)
            if word is not None and word not in quality and len(quality) < MAX_QUALITY_ITEMS:
                quality.append(word)
    confidence = payload.get("confidence")
    level = confidence.strip().lower() if isinstance(confidence, str) else ""
    return ShotDescription(
        shot_index=shot_index,
        summary=summary,
        subject=_text(payload.get("subject"), MAX_FIELD_CHARS),
        action=_text(payload.get("action"), MAX_FIELD_CHARS),
        setting=_text(payload.get("setting"), MAX_FIELD_CHARS),
        camera=Camera(
            shot_size=_closed(camera_map.get("shotSize"), SHOT_SIZES),
            angle=_closed(camera_map.get("angle"), CAMERA_ANGLES),
            movement=_closed(camera_map.get("movement"), CAMERA_MOVEMENTS),
        ),
        mood=_text(payload.get("mood"), MAX_FIELD_CHARS),
        on_screen_text=on_screen,
        quality=tuple(quality),
        confidence=level if level in CONFIDENCE_LEVELS else DEFAULT_CONFIDENCE,
    )



def _on_screen_text(raw: Any) -> list[str]:
    """Normalise ``onScreenText``: verbatim per line, deduplicated, bounded.

    Verbatim: whitespace collapsed, length capped, nothing else. Nothing here may "tidy" a
    lower-third, or a solver reading a title reads our paraphrase of it.
    # Deduplicated, first occurrence winning, for the same reason `quality` below
    # is: a constrained decoder that has said everything it has to say fills the
    # array to its bound with the SAME line rather than closing it. Measured on
    # SmolVLM2-2.2B against `eval/media/slate.mp4`, a card reading "SCENE 4 TAKE 2":
    # sixteen identical copies, exactly `MAX_ON_SCREEN_TEXT_ITEMS`. The bound stops
    # the runaway; it does not make the value useful. Verbatim is a promise about
    # each line's CONTENT — never to tidy or paraphrase it — not a promise to repeat
    # a decoder's stutter back to the editor as sixteen separate readings.
    """
    if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes)):
        return []
    seen: list[str] = []
    for item in raw:
        text = _text(item, MAX_ON_SCREEN_TEXT_CHARS)
        if not text or text in seen:
            continue
        seen.append(text)
        if len(seen) >= MAX_ON_SCREEN_TEXT_ITEMS:
            break
    return seen


def describe_shots(
    request: DescribeRequest,
    backend: DescribeBackend,
    *,
    should_cancel: Callable[[], bool] = lambda: False,
) -> Iterator[ShotDescription]:
    """Describe every shot of one request, one model call each, in request order.

    Deliberately NOT batched across shots: a description is *of one shot*, and handing a
    model nine frames from three different shots is how a description of shot 2 acquires
    an object that was only ever in shot 3. Cancellation is polled between shots, which is
    the only place tier 2 can honour it — a llama.cpp call is not interruptible mid-token
    from here.

    A shot the model DECLINES to describe still fails the whole request — the protocol has
    no partial answer, and the engine client rejects a short one — but it fails as NOT
    retryable. See :class:`ShotNotDescribableError`: a featureless frame will decline again,
    so retrying spends a model call to be told the same nothing.

    :raises ProtocolError: ``cancelled`` when the host cancels, ``media_unreadable`` when a
        keyframe cannot be decoded, ``internal_error`` when the model answered nothing
        usable — retryable for a malformed answer, NOT retryable when the model simply had
        nothing to say about the frame.
    """
    for span in request.shots:
        if should_cancel():
            raise ProtocolError("cancelled", "shot description cancelled by the host.")
        times = keyframe_times(span)
        try:
            frames = backend.decode_keyframes(request.media.absolute_path, times)
        except MediaUnreadableError as error:
            raise ProtocolError("media_unreadable", str(error)) from error
        if len(frames) != len(times):
            raise ProtocolError(
                "media_unreadable",
                f"decoder returned {len(frames)} frames for {len(times)} keyframes.",
            )
        try:
            payload = backend.describe(frames, DESCRIBED_JSON_SCHEMA)
            yield normalise(payload, span.shot_index)
        except ShotNotDescribableError as error:
            # NOT retryable. The model looked and had nothing to say, and it will have
            # nothing to say next time: the cause is the frame, not the run. Marking this
            # retryable made a fade to black or a lens cap fail its whole batch on every
            # pass, forever, spending a model call each time to be told the same nothing.
            raise ProtocolError("internal_error", str(error), retryable=False) from error
        except DescribeFailedError as error:
            # Retryable: a malformed answer IS a hiccup, and the same shot on a second pass
            # usually answers. It still fails the whole request rather than being skipped —
            # a described row that was never produced must not be counted as coverage.
            raise ProtocolError("internal_error", str(error), retryable=True) from error
