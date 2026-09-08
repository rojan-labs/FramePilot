"""Strict Python mirror of the frozen Capability Pack worker JSON-line protocol.

The canonical schema is ``packages/capability-packs/src/worker-protocol.ts``. This module
covers the ``visual.embed`` and ``visual.text`` half of it. The host re-validates every
line, so this exists to make the worker fail *early and typed* rather than emit something
the host would reject as a protocol error.

Validation is hand written and dependency free, so the unit suite runs without NumPy,
onnxruntime, a tokenizer or any downloaded weight.

Two shapes here are worth naming because they differ from the tracking/subject half:

- **``visual.text`` carries no media handle.** A query ("wide shots of the street") has no
  frames to sandbox, so the request is the one media-free member of the union. Forcing a
  synthetic handle onto it would ask the host to sandbox-check a file that has nothing to
  do with the request.
- **The frame-range sample cap does not apply.** Subject Intelligence refuses a handle
  spanning more than ``MAX_SAMPLES`` frames because it visits every frame. This pack
  decodes exactly one keyframe per requested shot, so the bound that matters is
  :data:`MAX_SHOTS`, and a handle spanning a whole two-hour asset is legitimate.
"""

from __future__ import annotations

import base64
import json
import re
import struct
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Final, Literal

PROTOCOL_VERSION: Final = 1
MAX_LINE_BYTES: Final = 1024 * 1024
MAX_FPS: Final = 240.0
MAX_MEDIA_PATH_LENGTH: Final = 4096

VISUAL_CAPABILITIES: Final = ("visual.embed", "visual.text")
#: Shots per ``visual.embed`` request; matches ``CAPABILITY_PACK_WORKER_MAX_SHOTS``.
MAX_SHOTS: Final = 64
#: Texts per ``visual.text`` request; matches ``CAPABILITY_PACK_WORKER_MAX_TEXTS``.
MAX_TEXTS: Final = 64
MAX_TEXT_LENGTH: Final = 512
MAX_DIM: Final = 8192
MAX_FACES_PER_SHOT: Final = 1_000

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
ProgressPhase = Literal["decode", "initialize", "track", "detect", "segment", "embed", "encode"]

#: The label groups a result may carry, in the ledger's own field names.
LABEL_GROUPS: Final = ("shotSize", "subjectKind", "setting", "screenContent")


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
class ShotPrompt:
    """One shot to embed: which shot it is, and the source second to decode for it."""

    shot_index: int
    keyframe_t: float


@dataclass(frozen=True, slots=True)
class EmbedRequest:
    request_id: str
    project_revision: int
    media: MediaHandle
    prompt_bank_version: int
    shots: tuple[ShotPrompt, ...]
    capability: str = "visual.embed"


@dataclass(frozen=True, slots=True)
class TextRequest:
    request_id: str
    project_revision: int
    texts: tuple[str, ...]
    capability: str = "visual.text"


@dataclass(frozen=True, slots=True)
class CancelMessage:
    request_id: str


@dataclass(frozen=True, slots=True)
class ConfidentLabel:
    value: str
    p: float


@dataclass(frozen=True, slots=True)
class ShotEmbedding:
    """One shot's tier-1 product, ready to encode.

    ``labels`` holds only the groups that were actually scored. A group the backend could
    not score is ABSENT, never a zero-probability guess: the ledger stores "not labelled"
    and "labelled as nothing in particular" as different facts.
    """

    shot_index: int
    vector: Sequence[float]
    labels: dict[str, ConfidentLabel]
    faces: int
    face_vectors: Sequence[Sequence[float]] = ()


# --- packed vectors ---------------------------------------------------------------


def pack_fp16(vector: Sequence[float]) -> str:
    """Pack a float vector as base64 fp16.

    Half precision because these are L2-normalised direction vectors: every component is
    within [-1, 1], where fp16's ~3 decimal digits cost about 1e-3 of cosine similarity —
    far below the gap between any two of the prompt bank's phrases — and halve a line that
    would otherwise carry 64 x 768 floats as JSON text.

    :raises ProtocolError: If a component is not finite. A NaN would encode silently and
        poison every cosine it later touches.
    """
    for value in vector:
        if value != value or value in (float("inf"), float("-inf")):
            raise ProtocolError("internal_error", "refusing to pack a non-finite vector.")
    return base64.b64encode(struct.pack(f"<{len(vector)}e", *vector)).decode("ascii")


def unpack_fp16(packed: str) -> tuple[float, ...]:
    """Inverse of :func:`pack_fp16`.

    :raises ProtocolError: If the payload is not base64 or not a whole number of halves.
    """
    try:
        raw = base64.b64decode(packed, validate=True)
    except (ValueError, TypeError) as error:
        raise _invalid("packed vector is not valid base64.") from error
    if len(raw) % 2 != 0 or not raw:
        raise _invalid("packed vector is not a whole number of fp16 components.")
    return struct.unpack(f"<{len(raw) // 2}e", raw)


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


def _shots(value: Any, media: MediaHandle) -> tuple[ShotPrompt, ...]:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_SHOTS:
        raise _invalid(f"visual.embed requires between 1 and {MAX_SHOTS} shots.")
    shots: list[ShotPrompt] = []
    for index, entry in enumerate(value):
        raw = _object(entry, {"shotIndex", "keyframeT"}, f"parameters.shots[{index}]")
        for key in ("shotIndex", "keyframeT"):
            if key not in raw:
                raise _invalid(f"parameters.shots[{index}] requires {key}.")
        keyframe = _number(raw["keyframeT"], f"parameters.shots[{index}].keyframeT")
        if keyframe < 0.0:
            raise _invalid(f"parameters.shots[{index}].keyframeT must be non-negative.")
        # A keyframe outside the approved handle would decode a frame the host never
        # sandboxed for this request. Refused rather than clamped: a clamped timestamp
        # would silently label the wrong picture.
        if not media.source_start_seconds <= keyframe < media.source_end_seconds:
            raise _invalid(
                f"parameters.shots[{index}].keyframeT lies outside the approved media range."
            )
        shots.append(
            ShotPrompt(
                shot_index=_integer(
                    raw["shotIndex"], f"parameters.shots[{index}].shotIndex", minimum=0
                ),
                keyframe_t=keyframe,
            )
        )
    if len({shot.shot_index for shot in shots}) != len(shots):
        raise _invalid("visual.embed shots must be distinct.")
    # Sorted by source time so decoding is one forward seek pass, and so an identical
    # request phrased in a different order produces byte-identical output.
    return tuple(sorted(shots, key=lambda shot: (shot.keyframe_t, shot.shot_index)))


def _texts(value: Any) -> tuple[str, ...]:
    raw = _object(value, {"texts"}, "parameters")
    texts = raw.get("texts")
    if not isinstance(texts, list) or not 1 <= len(texts) <= MAX_TEXTS:
        raise _invalid(f"visual.text requires between 1 and {MAX_TEXTS} texts.")
    out: list[str] = []
    for index, text in enumerate(texts):
        value_text = _string(text, f"parameters.texts[{index}]")
        if len(value_text) > MAX_TEXT_LENGTH:
            raise _invalid(f"parameters.texts[{index}] exceeds {MAX_TEXT_LENGTH} characters.")
        out.append(value_text)
    return tuple(out)


def parse_input_line(line: str) -> EmbedRequest | TextRequest | CancelMessage:
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
        raise _invalid(f"capability '{capability}' is not provided by Visual Embed.")
    allowed = {
        "type",
        "protocolVersion",
        "requestId",
        "projectRevision",
        "capability",
        "parameters",
    }
    if capability == "visual.embed":
        allowed.add("media")
    request = _object(raw, allowed, "request")
    _require_protocol_version(request.get("protocolVersion"))
    request_id = _string(request.get("requestId"), "requestId", pattern=REQUEST_ID_PATTERN)
    revision = _integer(request.get("projectRevision"), "projectRevision", minimum=0)
    if "parameters" not in request:
        raise _invalid("request requires parameters.")
    if capability == "visual.text":
        return TextRequest(
            request_id=request_id,
            project_revision=revision,
            texts=_texts(request["parameters"]),
        )
    media = _media(request.get("media"))
    parameters = _object(request["parameters"], {"promptBankVersion", "shots"}, "parameters")
    if "promptBankVersion" not in parameters or "shots" not in parameters:
        raise _invalid("visual.embed requires promptBankVersion and shots.")
    return EmbedRequest(
        request_id=request_id,
        project_revision=revision,
        media=media,
        prompt_bank_version=_integer(
            parameters["promptBankVersion"], "parameters.promptBankVersion", minimum=1
        ),
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


def _result_base(
    request_id: str, project_revision: int, capability: str, backend: str, digests: dict[str, str]
) -> dict[str, Any]:
    return {
        "type": "result",
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
        "projectRevision": project_revision,
        "capability": capability,
        "backend": backend,
        "modelDigests": dict(sorted(digests.items())),
    }


def embed_result_message(
    *,
    request_id: str,
    project_revision: int,
    prompt_bank_version: int,
    dim: int,
    face_dim: int | None,
    shots: Sequence[ShotEmbedding],
    backend: str,
    model_digests: dict[str, str],
) -> dict[str, Any]:
    """Encode a ``visual.embed`` result.

    Unlike detection, an EMPTY shot list is not a legal answer here: the host asked about
    specific shots and a result naming none of them would read as coverage that does not
    exist. A shot that could not be embedded fails the request instead.
    """
    if not shots:
        raise ProtocolError("internal_error", "an embed result requires at least one shot.")
    if len(shots) > MAX_SHOTS:
        raise ProtocolError("internal_error", "embed result exceeded its shot bound.")
    if not 0 < dim <= MAX_DIM:
        raise ProtocolError("internal_error", "embedding dimension exceeded its bound.")
    encoded: list[dict[str, Any]] = []
    for shot in sorted(shots, key=lambda item: item.shot_index):
        if len(shot.vector) != dim:
            raise ProtocolError(
                "internal_error",
                f"shot {shot.shot_index} carries a {len(shot.vector)}-d vector, not {dim}.",
            )
        if not 0 <= shot.faces <= MAX_FACES_PER_SHOT:
            raise ProtocolError("internal_error", "face count exceeded its bound.")
        if shot.face_vectors and len(shot.face_vectors) != shot.faces:
            raise ProtocolError(
                "internal_error", "faceVectors must carry one vector per counted face."
            )
        for group in shot.labels:
            if group not in LABEL_GROUPS:
                raise ProtocolError("internal_error", f"'{group}' is not a ledger label group.")
        encoded.append(
            {
                "shotIndex": shot.shot_index,
                "vector": pack_fp16(shot.vector),
                "labels": {
                    group: {"value": shot.labels[group].value, "p": shot.labels[group].p}
                    for group in LABEL_GROUPS
                    if group in shot.labels
                },
                "faces": shot.faces,
                "faceVectors": [pack_fp16(vector) for vector in shot.face_vectors],
            }
        )
    message = _result_base(request_id, project_revision, "visual.embed", backend, model_digests)
    message["promptBankVersion"] = prompt_bank_version
    message["dim"] = dim
    if face_dim is not None:
        message["faceDim"] = face_dim
    message["shots"] = encoded
    return message


def text_result_message(
    *,
    request_id: str,
    project_revision: int,
    dim: int,
    vectors: Sequence[Sequence[float]],
    backend: str,
    model_digests: dict[str, str],
) -> dict[str, Any]:
    if not vectors:
        raise ProtocolError("internal_error", "a text result requires at least one vector.")
    if len(vectors) > MAX_TEXTS:
        raise ProtocolError("internal_error", "text result exceeded its vector bound.")
    for vector in vectors:
        if len(vector) != dim:
            raise ProtocolError("internal_error", "a text vector disagrees with the dimension.")
    message = _result_base(request_id, project_revision, "visual.text", backend, model_digests)
    message["dim"] = dim
    message["vectors"] = [pack_fp16(vector) for vector in vectors]
    return message


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
