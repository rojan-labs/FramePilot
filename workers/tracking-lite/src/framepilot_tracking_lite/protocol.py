"""Strict Python mirror of the frozen Capability Pack worker JSON-line protocol.

The canonical schema is ``packages/capability-packs/src/worker-protocol.ts``. The
host re-validates every line it receives, so this module exists to make the
worker fail *early and typed* on a malformed request rather than emit output the
host would reject as a protocol error. Validation is intentionally hand written:
the protocol layer must stay dependency free so the unit suite can run without
installing NumPy/OpenCV.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Final, Literal

PROTOCOL_VERSION: Final = 1
MAX_LINE_BYTES: Final = 1024 * 1024
MAX_SAMPLES: Final = 18_000
MAX_FPS: Final = 240.0
MAX_MEDIA_PATH_LENGTH: Final = 4096

TRACKING_CAPABILITIES: Final = ("tracking.planar", "tracking.point", "tracking.region")

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
ProgressPhase = Literal["decode", "initialize", "track", "detect", "segment", "encode"]


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
class NormalizedPoint:
    x: float
    y: float


@dataclass(frozen=True, slots=True)
class NormalizedBox:
    x: float
    y: float
    width: float
    height: float

    def as_json(self) -> dict[str, float]:
        return {"x": self.x, "y": self.y, "width": self.width, "height": self.height}


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

    @property
    def frame_count(self) -> int:
        return self.last_frame_exclusive - self.first_frame


@dataclass(frozen=True, slots=True)
class TrackingRequest:
    request_id: str
    project_revision: int
    capability: str
    media: MediaHandle
    point: NormalizedPoint | None = None
    region: NormalizedBox | None = None
    corners: tuple[NormalizedPoint, NormalizedPoint, NormalizedPoint, NormalizedPoint] | None = None


@dataclass(frozen=True, slots=True)
class CancelMessage:
    request_id: str


@dataclass(frozen=True, slots=True)
class TrackingSample:
    frame: int
    box: NormalizedBox
    confidence: float
    occluded: bool


# --- primitive validators -------------------------------------------------


def _object(value: Any, allowed: set[str], where: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise _invalid(f"{where} must be an object.")
    unexpected = sorted(set(value) - allowed)
    if unexpected:
        raise _invalid(f"{where} has unexpected keys: {', '.join(unexpected)}.")
    return value


def _number(value: Any, where: str) -> float:
    # `bool` is an `int` subclass in Python; the TypeScript contract would never
    # accept `true` as a coordinate, so neither do we.
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


def _unit(value: Any, where: str) -> float:
    number = _number(value, where)
    if not 0.0 <= number <= 1.0:
        raise _invalid(f"{where} must be normalized to [0, 1].")
    return number


def _point(value: Any, where: str) -> NormalizedPoint:
    raw = _object(value, {"x", "y"}, where)
    if "x" not in raw or "y" not in raw:
        raise _invalid(f"{where} requires x and y.")
    return NormalizedPoint(x=_unit(raw["x"], f"{where}.x"), y=_unit(raw["y"], f"{where}.y"))


def _box(value: Any, where: str) -> NormalizedBox:
    raw = _object(value, {"x", "y", "width", "height"}, where)
    for key in ("x", "y", "width", "height"):
        if key not in raw:
            raise _invalid(f"{where} requires {key}.")
    box = NormalizedBox(
        x=_unit(raw["x"], f"{where}.x"),
        y=_unit(raw["y"], f"{where}.y"),
        width=_number(raw["width"], f"{where}.width"),
        height=_number(raw["height"], f"{where}.height"),
    )
    if not 0.0 < box.width <= 1.0 or not 0.0 < box.height <= 1.0:
        raise _invalid(f"{where} must have a positive normalized size.")
    if box.x + box.width > 1.0 or box.y + box.height > 1.0:
        raise _invalid(f"{where} must stay inside the frame.")
    return box


def _media(value: Any) -> MediaHandle:
    raw = _object(
        value,
        {
            "handleId",
            "assetId",
            "absolutePath",
            "sourceStartSeconds",
            "sourceEndSeconds",
            "fps",
            "firstFrame",
            "lastFrameExclusive",
        },
        "media",
    )
    missing = sorted(
        {
            "handleId",
            "assetId",
            "absolutePath",
            "sourceStartSeconds",
            "sourceEndSeconds",
            "fps",
            "firstFrame",
            "lastFrameExclusive",
        }
        - set(raw)
    )
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
    if media.frame_count > MAX_SAMPLES:
        raise _invalid(
            f"media frame range of {media.frame_count} exceeds the {MAX_SAMPLES} sample bound."
        )
    return media


def _parameters(capability: str, value: Any) -> dict[str, Any]:
    if capability == "tracking.point":
        raw = _object(value, {"point"}, "parameters")
        if "point" not in raw:
            raise _invalid("tracking.point requires parameters.point.")
        return {"point": _point(raw["point"], "parameters.point")}
    if capability == "tracking.region":
        raw = _object(value, {"region"}, "parameters")
        if "region" not in raw:
            raise _invalid("tracking.region requires parameters.region.")
        return {"region": _box(raw["region"], "parameters.region")}
    raw = _object(value, {"corners"}, "parameters")
    corners = raw.get("corners")
    if not isinstance(corners, list) or len(corners) != 4:
        raise _invalid("tracking.planar requires exactly four corners.")
    return {
        "corners": tuple(
            _point(corner, f"parameters.corners[{index}]") for index, corner in enumerate(corners)
        )
    }


def parse_input_line(line: str) -> TrackingRequest | CancelMessage:
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
    request = _object(
        raw,
        {
            "type",
            "protocolVersion",
            "requestId",
            "projectRevision",
            "media",
            "capability",
            "parameters",
        },
        "request",
    )
    _require_protocol_version(request.get("protocolVersion"))
    capability = _string(request.get("capability"), "capability")
    if capability not in TRACKING_CAPABILITIES:
        raise _invalid(f"capability '{capability}' is not provided by Tracking Lite.")
    if "parameters" not in request:
        raise _invalid("request requires parameters.")
    parameters = _parameters(capability, request["parameters"])
    return TrackingRequest(
        request_id=_string(request.get("requestId"), "requestId", pattern=REQUEST_ID_PATTERN),
        project_revision=_integer(request.get("projectRevision"), "projectRevision", minimum=0),
        capability=capability,
        media=_media(request.get("media")),
        point=parameters.get("point"),
        region=parameters.get("region"),
        corners=parameters.get("corners"),
    )


def _require_protocol_version(value: Any) -> None:
    if value != PROTOCOL_VERSION:
        raise ProtocolError(
            "invalid_request",
            f"unsupported protocol version {value!r}; this worker speaks v{PROTOCOL_VERSION}.",
        )


# --- encoders -------------------------------------------------------------


def handshake_message(
    *,
    pack_id: str,
    version: str,
    release_digest: str,
    capabilities: tuple[str, ...],
    hardware_backend: str,
    model_digests: dict[str, str] | None = None,
) -> dict[str, Any]:
    return {
        "type": "handshake",
        "protocolVersion": PROTOCOL_VERSION,
        "pack": {"id": pack_id, "version": version, "releaseDigest": release_digest},
        "capabilities": list(capabilities),
        "hardwareBackend": hardware_backend,
        # Tracking Lite is purely algorithmic: it ships no model weights, so the
        # digest map is genuinely empty rather than padded with a fake entry.
        "modelDigests": dict(model_digests or {}),
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


def result_message(
    *,
    request_id: str,
    project_revision: int,
    capability: str,
    samples: list[TrackingSample],
    backend: str,
) -> dict[str, Any]:
    if not samples:
        raise ProtocolError("internal_error", "a tracking result requires at least one sample.")
    if len(samples) > MAX_SAMPLES:
        raise ProtocolError("internal_error", "tracking result exceeded its sample bound.")
    return {
        "type": "result",
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
        "projectRevision": project_revision,
        "capability": capability,
        "backend": backend,
        "modelDigests": {},
        # Stable ordering: samples are always emitted in ascending frame order.
        "samples": [
            {
                "frame": sample.frame,
                "box": sample.box.as_json(),
                "confidence": sample.confidence,
                "occluded": sample.occluded,
            }
            for sample in sorted(samples, key=lambda sample: sample.frame)
        ],
    }


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
