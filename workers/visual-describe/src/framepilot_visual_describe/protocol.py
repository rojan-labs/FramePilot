"""Strict Python mirror of the frozen Capability Pack worker JSON-line protocol.

The canonical schema is ``packages/capability-packs/src/worker-protocol.ts``. This module
covers the ``visual.describe`` member of it. The host re-validates every line, so this
exists to make the worker fail *early and typed* rather than emit something the host would
reject as a protocol error.

Validation is hand written and dependency free, so the unit suite runs without OpenCV, a
llama.cpp binary or any downloaded weight.

Two shapes differ from ``visual.embed`` and are worth naming:

- **A shot carries its whole SPAN, not one keyframe.** Tier 2 looks at up to three frames
  of a shot (first, middle, last) because a still keyframe cannot show what a shot *does*.
  The host therefore sends ``t0``/``t1`` and the worker chooses the frames — the choice is
  part of the description's meaning and belongs with the model that reads them.
- **The batch is much smaller.** A VLM call is seconds, not milliseconds, and one line has
  to stay inside the 1 MiB transport bound while carrying nine text fields per shot. Tier 2
  is the slow tier by design (VU6.4), and :data:`MAX_SHOTS` says so in the contract rather
  than in a comment somewhere upstream.
"""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Final, Literal

from .schema import (
    CAMERA_ANGLES,
    CAMERA_MOVEMENTS,
    CONFIDENCE_LEVELS,
    MAX_FIELD_CHARS,
    MAX_ON_SCREEN_TEXT_CHARS,
    MAX_ON_SCREEN_TEXT_ITEMS,
    MAX_QUALITY_ITEMS,
    MAX_SUMMARY_CHARS,
    QUALITY_VOCABULARY,
    SHOT_SIZES,
    UNKNOWN,
)

PROTOCOL_VERSION: Final = 1
MAX_LINE_BYTES: Final = 1024 * 1024
MAX_FPS: Final = 240.0
MAX_MEDIA_PATH_LENGTH: Final = 4096

CAPABILITY: Final = "visual.describe"
VISUAL_CAPABILITIES: Final = (CAPABILITY,)
#: Shots per ``visual.describe`` request; matches ``CAPABILITY_PACK_WORKER_MAX_DESCRIBE_SHOTS``.
MAX_SHOTS: Final = 16
#: Keyframes a single shot may be described from (first / middle / last of its span).
MAX_KEYFRAMES_PER_SHOT: Final = 3

REQUEST_ID_PATTERN: Final = re.compile(r"^[A-Za-z0-9._:-]{1,256}$")
IDENTIFIER_PATTERN: Final = re.compile(r"^[a-z0-9]+(?:[._-][a-z0-9]+)*$")
SEMVER_PATTERN: Final = re.compile(
    r"^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$"
)
SHA256_PATTERN: Final = re.compile(r"^[0-9a-f]{64}$")

FailureCode = Literal[
    "cancelled",
    "media_unreadable",
    "target_lost",
    "model_unavailable",
    "hardware_unsupported",
    "invalid_request",
    "internal_error",
]
ProgressPhase = Literal[
    "decode", "initialize", "track", "detect", "segment", "embed", "encode", "describe"
]


class ProtocolError(Exception):
    """A request the worker refuses to run, carrying its typed terminal failure."""

    def __init__(self, code: FailureCode, detail: str, *, retryable: bool = False) -> None:
        super().__init__(detail)
        self.code: FailureCode = code
        self.detail = detail
        self.retryable = retryable


def _invalid(detail: str) -> ProtocolError:
    return ProtocolError("invalid_request", detail)


@dataclass(frozen=True, slots=True)
class MediaHandle:
    """Host-resolved, sandbox-checked, read-only media. The worker never resolves paths."""

    handle_id: str
    asset_id: str
    absolute_path: str
    source_start_seconds: float
    source_end_seconds: float
    fps: float
    first_frame: int
    last_frame_exclusive: int


@dataclass(frozen=True, slots=True)
class ShotSpan:
    """One shot to describe: which shot it is, and the source span it occupies."""

    shot_index: int
    t0: float
    t1: float


@dataclass(frozen=True, slots=True)
class DescribeRequest:
    request_id: str
    project_revision: int
    media: MediaHandle
    tier2_version: int
    shots: tuple[ShotSpan, ...]
    capability: str = CAPABILITY


@dataclass(frozen=True, slots=True)
class CancelMessage:
    request_id: str


@dataclass(frozen=True, slots=True)
class Camera:
    """Closed-vocabulary camera facts. ``None`` is "the model said unknown"."""

    shot_size: str | None = None
    angle: str | None = None
    movement: str | None = None


@dataclass(frozen=True, slots=True)
class ShotDescription:
    """One shot's tier-2 product, already normalised to the closed vocabularies.

    Every free-text field defaults to empty rather than to a plausible sentence: a field
    the model left blank is a field nobody has described, and the ledger stores that as
    exactly that.
    """

    shot_index: int
    summary: str
    subject: str = ""
    action: str = ""
    setting: str = ""
    camera: Camera = field(default_factory=Camera)
    mood: str = ""
    on_screen_text: tuple[str, ...] = ()
    quality: tuple[str, ...] = ()
    confidence: str = "medium"


# --- primitive validators ---------------------------------------------------------


def _object(value: Any, allowed: set[str], where: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise _invalid(f"{where} must be an object.")
    unexpected = sorted(set(value) - allowed)
    if unexpected:
        raise _invalid(f"{where} has unexpected keys: {', '.join(unexpected)}.")
    return value


def _number(value: Any, where: str) -> float:
    # `bool` is an `int` subclass in Python; the TypeScript contract would never accept
    # `true` as a timestamp, so neither do we.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _invalid(f"{where} must be a number.")
    number = float(value)
    if number != number or number in (float("inf"), float("-inf")):
        raise _invalid(f"{where} must be finite.")
    return number


def _integer(value: Any, where: str, *, minimum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise _invalid(f"{where} must be an integer.")
    if value < minimum:
        raise _invalid(f"{where} must be >= {minimum}.")
    return value


def _string(value: Any, where: str, *, pattern: re.Pattern[str] | None = None) -> str:
    if not isinstance(value, str) or value == "":
        raise _invalid(f"{where} must be a non-empty string.")
    if pattern is not None and pattern.match(value) is None:
        raise _invalid(f"{where} does not match its required format.")
    return value


_MEDIA_KEYS: Final = {
    "handleId",
    "assetId",
    "absolutePath",
    "sourceStartSeconds",
    "sourceEndSeconds",
    "fps",
    "firstFrame",
    "lastFrameExclusive",
}


def _media(value: Any) -> MediaHandle:
    raw = _object(value, set(_MEDIA_KEYS), "media")
    missing = sorted(_MEDIA_KEYS - set(raw))
    if missing:
        raise _invalid(f"media is missing: {', '.join(missing)}.")
    path = _string(raw["absolutePath"], "media.absolutePath")
    if len(path) > MAX_MEDIA_PATH_LENGTH:
        raise _invalid("media.absolutePath exceeds its bound.")
    media = MediaHandle(
        handle_id=_string(raw["handleId"], "media.handleId", pattern=REQUEST_ID_PATTERN),
        asset_id=_string(raw["assetId"], "media.assetId"),
        absolute_path=path,
        source_start_seconds=_number(raw["sourceStartSeconds"], "media.sourceStartSeconds"),
        source_end_seconds=_number(raw["sourceEndSeconds"], "media.sourceEndSeconds"),
        fps=_number(raw["fps"], "media.fps"),
        first_frame=_integer(raw["firstFrame"], "media.firstFrame", minimum=0),
        last_frame_exclusive=_integer(
            raw["lastFrameExclusive"], "media.lastFrameExclusive", minimum=1
        ),
    )
    if media.source_start_seconds < 0.0:
        raise _invalid("media.sourceStartSeconds must be non-negative.")
    if media.source_end_seconds <= media.source_start_seconds:
        raise _invalid("media source range must be positive.")
    if not 0.0 < media.fps <= MAX_FPS:
        raise _invalid("media.fps must be positive and within its bound.")
    if media.last_frame_exclusive <= media.first_frame:
        raise _invalid("media frame range must be positive.")
    return media


def _shots(value: Any, media: MediaHandle) -> tuple[ShotSpan, ...]:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_SHOTS:
        raise _invalid(f"visual.describe requires between 1 and {MAX_SHOTS} shots.")
    shots: list[ShotSpan] = []
    for index, entry in enumerate(value):
        raw = _object(entry, {"shotIndex", "t0", "t1"}, f"parameters.shots[{index}]")
        for key in ("shotIndex", "t0", "t1"):
            if key not in raw:
                raise _invalid(f"parameters.shots[{index}] requires {key}.")
        t0 = _number(raw["t0"], f"parameters.shots[{index}].t0")
        t1 = _number(raw["t1"], f"parameters.shots[{index}].t1")
        if t0 < 0.0:
            raise _invalid(f"parameters.shots[{index}].t0 must be non-negative.")
        if t1 <= t0:
            raise _invalid(f"parameters.shots[{index}] span must be positive.")
        # A span outside the approved handle would decode frames the host never sandboxed
        # for this request. Refused rather than clamped: a clamped span would silently
        # describe the wrong picture, which is the failure mode a description hides best.
        if t0 < media.source_start_seconds or t1 > media.source_end_seconds:
            raise _invalid(f"parameters.shots[{index}] lies outside the approved media range.")
        shots.append(
            ShotSpan(
                shot_index=_integer(
                    raw["shotIndex"], f"parameters.shots[{index}].shotIndex", minimum=0
                ),
                t0=t0,
                t1=t1,
            )
        )
    if len({shot.shot_index for shot in shots}) != len(shots):
        raise _invalid("visual.describe shots must be distinct.")
    # Sorted by source time so decoding is one forward seek pass, and so an identical
    # request phrased in a different order produces byte-identical output.
    return tuple(sorted(shots, key=lambda shot: (shot.t0, shot.shot_index)))


def parse_input_line(line: str) -> DescribeRequest | CancelMessage:
    """Parse one protocol input line, raising a typed :class:`ProtocolError` on refusal."""
    if len(line.encode("utf-8")) > MAX_LINE_BYTES:
        raise _invalid("input line exceeded its 1 MiB bound.")
    try:
        raw = json.loads(line)
    except json.JSONDecodeError as error:
        raise _invalid(f"input line is not valid JSON: {error.msg}.") from error
    if not isinstance(raw, dict):
        raise _invalid("input line must be a JSON object.")
    message_type = raw.get("type")
    if message_type == "cancel":
        cancel = _object(raw, {"type", "protocolVersion", "requestId"}, "cancel")
        _require_protocol_version(cancel.get("protocolVersion"))
        return CancelMessage(
            request_id=_string(cancel.get("requestId"), "requestId", pattern=REQUEST_ID_PATTERN)
        )
    if message_type != "request":
        raise _invalid("input line must be a request or a cancel message.")
    capability = _string(raw.get("capability"), "capability")
    if capability not in VISUAL_CAPABILITIES:
        raise _invalid(f"capability '{capability}' is not provided by Visual Describe.")
    request = _object(
        raw,
        {
            "type",
            "protocolVersion",
            "requestId",
            "projectRevision",
            "capability",
            "media",
            "parameters",
        },
        "request",
    )
    _require_protocol_version(request.get("protocolVersion"))
    request_id = _string(request.get("requestId"), "requestId", pattern=REQUEST_ID_PATTERN)
    revision = _integer(request.get("projectRevision"), "projectRevision", minimum=0)
    if "parameters" not in request:
        raise _invalid("request requires parameters.")
    media = _media(request.get("media"))
    parameters = _object(request["parameters"], {"tier2Version", "shots"}, "parameters")
    if "tier2Version" not in parameters or "shots" not in parameters:
        raise _invalid("visual.describe requires tier2Version and shots.")
    return DescribeRequest(
        request_id=request_id,
        project_revision=revision,
        media=media,
        tier2_version=_integer(parameters["tier2Version"], "parameters.tier2Version", minimum=1),
        shots=_shots(parameters["shots"], media),
    )


def _require_protocol_version(value: Any) -> None:
    if value != PROTOCOL_VERSION:
        raise ProtocolError(
            "invalid_request",
            f"unsupported protocol version {value!r}; this worker speaks v{PROTOCOL_VERSION}.",
        )


# --- encoders ---------------------------------------------------------------------


def handshake_message(
    *,
    pack_id: str,
    version: str,
    release_digest: str,
    capabilities: tuple[str, ...],
    hardware_backend: str,
    model_digests: dict[str, str],
) -> dict[str, Any]:
    return {
        "type": "handshake",
        "protocolVersion": PROTOCOL_VERSION,
        "pack": {"id": pack_id, "version": version, "releaseDigest": release_digest},
        "capabilities": list(capabilities),
        "hardwareBackend": hardware_backend,
        "modelDigests": dict(sorted(model_digests.items())),
    }


def progress_message(
    request_id: str, phase: ProgressPhase, completed: int, total: int, detail: str | None = None
) -> dict[str, Any]:
    bounded = min(max(completed, 0), total)
    message: dict[str, Any] = {
        "type": "progress",
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
        "phase": phase,
        "completed": bounded,
        "total": total,
    }
    if detail is not None:
        message["detail"] = detail[:512]
    return message


def _closed(value: str | None, vocabulary: Sequence[str]) -> str:
    """One closed-vocabulary value on the wire, or :data:`UNKNOWN`.

    ``UNKNOWN`` rather than an omitted key: the schema requires every property, and an
    absent field and a declined one must not be told apart by whether JSON happened to
    carry the key.
    """
    return value if value is not None and value in vocabulary else UNKNOWN


def describe_result_message(
    *,
    request_id: str,
    project_revision: int,
    tier2_version: int,
    model: str,
    shots: Sequence[ShotDescription],
    backend: str,
    model_digests: dict[str, str],
) -> dict[str, Any]:
    """Encode a ``visual.describe`` result.

    An EMPTY shot list is not a legal answer: the host asked about specific shots and a
    result naming none of them would read as coverage that does not exist. A shot that
    could not be described fails the request instead.
    """
    if not shots:
        raise ProtocolError("internal_error", "a describe result requires at least one shot.")
    if len(shots) > MAX_SHOTS:
        raise ProtocolError("internal_error", "describe result exceeded its shot bound.")
    encoded: list[dict[str, Any]] = []
    for shot in sorted(shots, key=lambda item: item.shot_index):
        summary = " ".join(shot.summary.split())[:MAX_SUMMARY_CHARS].rstrip()
        if not summary:
            raise ProtocolError(
                "internal_error",
                f"shot {shot.shot_index} has no summary; refusing to report it as described.",
            )
        if shot.confidence not in CONFIDENCE_LEVELS:
            raise ProtocolError("internal_error", f"'{shot.confidence}' is not a confidence level.")
        encoded.append(
            {
                "shotIndex": shot.shot_index,
                "summary": summary,
                "subject": _field(shot.subject),
                "action": _field(shot.action),
                "setting": _field(shot.setting),
                "camera": {
                    "shotSize": _closed(shot.camera.shot_size, SHOT_SIZES),
                    "angle": _closed(shot.camera.angle, CAMERA_ANGLES),
                    "movement": _closed(shot.camera.movement, CAMERA_MOVEMENTS),
                },
                "mood": _field(shot.mood),
                "onScreenText": [
                    " ".join(item.split())[:MAX_ON_SCREEN_TEXT_CHARS].rstrip()
                    for item in shot.on_screen_text[:MAX_ON_SCREEN_TEXT_ITEMS]
                    if item.strip()
                ],
                "quality": [
                    word for word in shot.quality[:MAX_QUALITY_ITEMS] if word in QUALITY_VOCABULARY
                ],
                "confidence": shot.confidence,
            }
        )
    return {
        "type": "result",
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
        "projectRevision": project_revision,
        "capability": CAPABILITY,
        "backend": backend,
        "modelDigests": dict(sorted(model_digests.items())),
        "tier2Version": tier2_version,
        "model": model,
        "shots": encoded,
    }


def _field(value: str) -> str:
    return " ".join(value.split())[:MAX_FIELD_CHARS].rstrip()


def failure_message(
    request_id: str, code: FailureCode, detail: str, retryable: bool
) -> dict[str, Any]:
    return {
        "type": "failure",
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
        "code": code,
        "detail": (detail or code)[:2_000],
        "retryable": retryable,
    }


def encode_line(message: dict[str, Any]) -> str:
    """Serialize one output line, refusing to emit anything past the transport bound."""
    encoded = json.dumps(message, separators=(",", ":"), allow_nan=False, sort_keys=True)
    if len(encoded.encode("utf-8")) + 1 > MAX_LINE_BYTES:
        raise ProtocolError("internal_error", "worker output line exceeded its 1 MiB bound.")
    return f"{encoded}\n"
