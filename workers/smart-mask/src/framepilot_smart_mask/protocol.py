"""Strict Python mirror of the Capability Pack worker JSON-line protocol, Smart Mask half.

The canonical schema is ``packages/capability-packs/src/worker-protocol.ts`` (the
``subject.matte`` and ``subject.segment_frame`` unions added in BR4.1). The host re-validates
every line, so this module exists to make the worker fail *early and typed* instead of
emitting something the host would reject as a protocol error.

Validation is hand written and dependency free, so the contract suite runs without numpy,
OpenCV or onnxruntime.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Final, Literal

PROTOCOL_VERSION: Final = 1
MAX_LINE_BYTES: Final = 1024 * 1024
MAX_FPS: Final = 240.0
MAX_MEDIA_PATH_LENGTH: Final = 4096
MAX_DIRECTORY_LENGTH: Final = 4096

SMART_MASK_CAPABILITIES: Final = ("subject.matte", "subject.segment_frame")

#: Mirrors CAPABILITY_PACK_MATTE_* in worker-protocol.ts.
MAX_PROMPTS: Final = 512
MAX_POINTS: Final = 64
MAX_REVIEW_RANGES: Final = 4096
MAX_SIDE: Final = 8192
MAX_OUTPUT_BYTES: Final = 256 * 1024 * 1024 * 1024
SEGMENT_FRAME_MAX_PNG_CHARS: Final = 900_000
MAX_SELF_CORRECTION_ROUNDS: Final = 16
MIN_PREVIEW_HEIGHT: Final = 180
MAX_PREVIEW_HEIGHT: Final = 1080
PTS_LIMIT: Final = 2**52

ARTIFACT_FILE_NAMES: Final = (
    "matte.mkv",
    "foreground.mkv",
    "preview.webm",
    "foreground.preview.webm",
    "frames.json",
    "report.json",
)
REQUIRED_ARTIFACT_FILES: Final = ("matte.mkv", "frames.json")
PREVIOUS_INPUT_FILES: Final = (
    "previous/matte.mkv",
    "previous/foreground.mkv",
    "previous/frames.json",
)
REVIEW_REASONS: Final = (
    "subject_lost",
    "estimates_disagree",
    "flow_inconsistent",
    "new_region",
    "edge_misaligned",
    "occlusion",
    "motion_blur",
)
EXECUTION_PROVIDERS: Final = ("coreml", "directml", "cpu")

REQUEST_ID_PATTERN: Final = re.compile(r"^[A-Za-z0-9._:-]{1,256}$")
IDENTIFIER_PATTERN: Final = re.compile(r"^[a-z0-9]+(?:[._-][a-z0-9]+)*$")
SEMVER_PATTERN: Final = re.compile(
    r"^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$"
)
SHA256_PATTERN: Final = re.compile(r"^[0-9a-f]{64}$")
INPUT_FILE_PATTERN: Final = re.compile(r"^(corrections|locked)/-?(0|[1-9]\d{0,15})\.png$")
_WINDOWS_ABSOLUTE: Final = re.compile(r"^[A-Za-z]:[\\/]")

FailureCode = Literal[
    "cancelled",
    "media_unreadable",
    "target_lost",
    "model_unavailable",
    "hardware_unsupported",
    "invalid_request",
    "internal_error",
    "output_too_large",
    "output_unwritable",
]
ProgressPhase = Literal[
    "decode",
    "initialize",
    "prepare",
    "segment",
    "encode",
    "refine",
    "consensus",
    "self_correct",
    "matte",
    "foreground",
    "stabilise",
    "verify",
]
ReviewReason = Literal[
    "subject_lost",
    "estimates_disagree",
    "flow_inconsistent",
    "new_region",
    "edge_misaligned",
    "occlusion",
    "motion_blur",
]
ExecutionProvider = Literal["coreml", "directml", "cpu"]
PointLabel = Literal["include", "exclude"]
PromptKind = Literal["points", "box", "brush", "lock"]


class ProtocolError(Exception):
    """A request the worker refuses to run, carrying its typed terminal failure."""

    def __init__(self, code: FailureCode, detail: str, *, retryable: bool = False) -> None:
        super().__init__(detail)
        self.code: FailureCode = code
        self.detail = detail
        self.retryable = retryable


def _invalid(detail: str) -> ProtocolError:
    return ProtocolError("invalid_request", detail)


# --- request model -------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class NormalizedPoint:
    x: float
    y: float


@dataclass(frozen=True, slots=True)
class PromptPoint:
    x: float
    y: float
    label: PointLabel


@dataclass(frozen=True, slots=True)
class NormalizedBox:
    x: float
    y: float
    width: float
    height: float


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
class OutputHandle:
    handle_id: str
    absolute_path: str
    allowed_files: tuple[str, ...]
    max_bytes: int


@dataclass(frozen=True, slots=True)
class InputHandle:
    handle_id: str
    absolute_path: str
    files: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class Prompt:
    kind: PromptKind
    pts: int
    points: tuple[PromptPoint, ...] = ()
    box: NormalizedBox | None = None
    file: str | None = None


@dataclass(frozen=True, slots=True)
class MatteRequest:
    request_id: str
    project_revision: int
    media: MediaHandle
    output: OutputHandle
    prompts: tuple[Prompt, ...]
    preview_height: int
    inputs: InputHandle | None = None
    previous_artifact: str | None = None
    capability: str = "subject.matte"


@dataclass(frozen=True, slots=True)
class SegmentFrameRequest:
    request_id: str
    project_revision: int
    media: MediaHandle
    pts: int
    preview_height: int
    points: tuple[PromptPoint, ...] = ()
    box: NormalizedBox | None = None
    hover_point: NormalizedPoint | None = None
    capability: str = "subject.segment_frame"


WorkerRequest = MatteRequest | SegmentFrameRequest


@dataclass(frozen=True, slots=True)
class CancelMessage:
    request_id: str


# --- result model --------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ArtifactFile:
    name: str
    bytes: int
    sha256: str


@dataclass(frozen=True, slots=True)
class ReviewRange:
    start_pts: int
    end_pts: int
    reason: ReviewReason


@dataclass(frozen=True, slots=True)
class MatteSummary:
    verified_frames: int
    flagged_frames: int
    locked_frames: int
    self_correction_rounds: int


@dataclass(frozen=True, slots=True)
class MatteArtifact:
    files: tuple[ArtifactFile, ...]
    width: int
    height: int
    frame_count: int
    first_pts: int
    last_pts: int
    time_base: tuple[int, int]


@dataclass(frozen=True, slots=True)
class MatteOutcome:
    artifact: MatteArtifact
    execution_provider: ExecutionProvider
    summary: MatteSummary
    needs_review: tuple[ReviewRange, ...] = field(default_factory=tuple)


# --- primitive validators ------------------------------------------------------------------


def _object(value: Any, allowed: set[str], where: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise _invalid(f"{where} must be an object.")
    unexpected = sorted(set(value) - allowed)
    if unexpected:
        raise _invalid(f"{where} has unexpected keys: {', '.join(unexpected)}.")
    return value


def _require(raw: dict[str, Any], keys: tuple[str, ...], where: str) -> None:
    missing = [key for key in keys if key not in raw]
    if missing:
        raise _invalid(f"{where} is missing: {', '.join(missing)}.")


def _number(value: Any, where: str) -> float:
    # `bool` is an `int` subclass; the TypeScript contract never accepts `true` as a number.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _invalid(f"{where} must be a number.")
    number = float(value)
    if number != number or number in (float("inf"), float("-inf")):
        raise _invalid(f"{where} must be finite.")
    return number


def _integer(value: Any, where: str, *, minimum: int, maximum: int | None = None) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise _invalid(f"{where} must be an integer.")
    if value < minimum:
        raise _invalid(f"{where} must be >= {minimum}.")
    if maximum is not None and value > maximum:
        raise _invalid(f"{where} must be <= {maximum}.")
    return value


def _pts(value: Any, where: str) -> int:
    return _integer(value, where, minimum=-PTS_LIMIT, maximum=PTS_LIMIT)


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


def _normalized_point(value: Any, where: str) -> NormalizedPoint:
    raw = _object(value, {"x", "y"}, where)
    _require(raw, ("x", "y"), where)
    return NormalizedPoint(x=_unit(raw["x"], f"{where}.x"), y=_unit(raw["y"], f"{where}.y"))


def _prompt_point(value: Any, where: str) -> PromptPoint:
    raw = _object(value, {"x", "y", "label"}, where)
    _require(raw, ("x", "y", "label"), where)
    label = raw["label"]
    if label not in ("include", "exclude"):
        raise _invalid(f"{where}.label must be include or exclude.")
    return PromptPoint(
        x=_unit(raw["x"], f"{where}.x"), y=_unit(raw["y"], f"{where}.y"), label=label
    )


def _points(value: Any, where: str) -> tuple[PromptPoint, ...]:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_POINTS:
        raise _invalid(f"{where} must hold between 1 and {MAX_POINTS} points.")
    return tuple(_prompt_point(item, f"{where}[{index}]") for index, item in enumerate(value))


def _box(value: Any, where: str) -> NormalizedBox:
    raw = _object(value, {"x", "y", "width", "height"}, where)
    _require(raw, ("x", "y", "width", "height"), where)
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


def _absolute_directory(value: Any, where: str) -> str:
    path = _string(value, where)
    if len(path) > MAX_DIRECTORY_LENGTH:
        raise _invalid(f"{where} exceeds its bound.")
    if not (path.startswith("/") or _WINDOWS_ABSOLUTE.match(path)):
        raise _invalid(f"{where} must be absolute.")
    if ".." in re.split(r"[\\/]", path):
        raise _invalid(f"{where} must not contain traversal segments.")
    return path


_MEDIA_KEYS: Final = (
    "handleId",
    "assetId",
    "absolutePath",
    "sourceStartSeconds",
    "sourceEndSeconds",
    "fps",
    "firstFrame",
    "lastFrameExclusive",
)


def _media(value: Any) -> MediaHandle:
    raw = _object(value, set(_MEDIA_KEYS), "media")
    _require(raw, _MEDIA_KEYS, "media")
    path = _string(raw["absolutePath"], "media.absolutePath")
    if len(path) > MAX_MEDIA_PATH_LENGTH:
        raise _invalid("media.absolutePath exceeds its bound.")
    asset_id = _string(raw["assetId"], "media.assetId")
    if len(asset_id) > 256:
        raise _invalid("media.assetId exceeds its bound.")
    media = MediaHandle(
        handle_id=_string(raw["handleId"], "media.handleId", pattern=REQUEST_ID_PATTERN),
        asset_id=asset_id,
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


def _output_handle(value: Any) -> OutputHandle:
    keys = ("handleId", "absolutePath", "allowedFiles", "maxBytes")
    raw = _object(value, set(keys), "parameters.output")
    _require(raw, keys, "parameters.output")
    allowed = raw["allowedFiles"]
    if not isinstance(allowed, list) or not 2 <= len(allowed) <= len(ARTIFACT_FILE_NAMES):
        raise _invalid("parameters.output.allowedFiles must list between 2 and 6 files.")
    for name in allowed:
        if name not in ARTIFACT_FILE_NAMES:
            raise _invalid("parameters.output.allowedFiles names a file a matte may not create.")
    if len(set(allowed)) != len(allowed):
        raise _invalid("output handle files must be distinct.")
    if not all(name in allowed for name in REQUIRED_ARTIFACT_FILES):
        raise _invalid("output handle must allow matte.mkv and frames.json.")
    return OutputHandle(
        handle_id=_string(
            raw["handleId"], "parameters.output.handleId", pattern=REQUEST_ID_PATTERN
        ),
        absolute_path=_absolute_directory(raw["absolutePath"], "parameters.output.absolutePath"),
        allowed_files=tuple(allowed),
        max_bytes=_integer(
            raw["maxBytes"], "parameters.output.maxBytes", minimum=1, maximum=MAX_OUTPUT_BYTES
        ),
    )


def _input_handle(value: Any) -> InputHandle:
    keys = ("handleId", "absolutePath", "files")
    raw = _object(value, set(keys), "parameters.inputs")
    _require(raw, keys, "parameters.inputs")
    files = raw["files"]
    if not isinstance(files, list) or not 1 <= len(files) <= MAX_PROMPTS + 3:
        raise _invalid("parameters.inputs.files has an invalid length.")
    for name in files:
        if not isinstance(name, str) or len(name) > 64:
            raise _invalid("parameters.inputs.files entries must be short strings.")
        if INPUT_FILE_PATTERN.match(name) is None and name not in PREVIOUS_INPUT_FILES:
            raise _invalid(
                "matte input files are corrections/<pts>.png, locked/<pts>.png or previous/*."
            )
    if len(set(files)) != len(files):
        raise _invalid("input handle files must be distinct.")
    return InputHandle(
        handle_id=_string(
            raw["handleId"], "parameters.inputs.handleId", pattern=REQUEST_ID_PATTERN
        ),
        absolute_path=_absolute_directory(raw["absolutePath"], "parameters.inputs.absolutePath"),
        files=tuple(files),
    )


def _prompt(value: Any, where: str) -> Prompt:
    if not isinstance(value, dict):
        raise _invalid(f"{where} must be an object.")
    kind = value.get("kind")
    if kind == "points":
        raw = _object(value, {"kind", "pts", "points"}, where)
        _require(raw, ("pts", "points"), where)
        return Prompt(
            kind="points",
            pts=_pts(raw["pts"], f"{where}.pts"),
            points=_points(raw["points"], f"{where}.points"),
        )
    if kind == "box":
        raw = _object(value, {"kind", "pts", "box"}, where)
        _require(raw, ("pts", "box"), where)
        return Prompt(
            kind="box", pts=_pts(raw["pts"], f"{where}.pts"), box=_box(raw["box"], f"{where}.box")
        )
    if kind in ("brush", "lock"):
        raw = _object(value, {"kind", "pts", "file"}, where)
        _require(raw, ("pts", "file"), where)
        file = _string(raw["file"], f"{where}.file")
        if len(file) > 64 or INPUT_FILE_PATTERN.match(file) is None:
            raise _invalid("matte input files are corrections/<pts>.png or locked/<pts>.png.")
        return Prompt(kind=kind, pts=_pts(raw["pts"], f"{where}.pts"), file=file)
    raise _invalid(f"{where}.kind must be points, box, brush or lock.")


def _matte_parameters(value: Any) -> dict[str, Any]:
    keys = {"output", "inputs", "prompts", "previousArtifact", "previewHeight"}
    raw = _object(value, keys, "parameters")
    _require(raw, ("output", "prompts", "previewHeight"), "parameters")
    prompts_raw = raw["prompts"]
    if not isinstance(prompts_raw, list) or not 1 <= len(prompts_raw) <= MAX_PROMPTS:
        raise _invalid(f"parameters.prompts must hold between 1 and {MAX_PROMPTS} prompts.")
    prompts = tuple(
        _prompt(item, f"parameters.prompts[{index}]") for index, item in enumerate(prompts_raw)
    )
    inputs = _input_handle(raw["inputs"]) if "inputs" in raw else None
    previous = None
    if "previousArtifact" in raw:
        previous = _string(
            raw["previousArtifact"], "parameters.previousArtifact", pattern=SHA256_PATTERN
        )
    declared = set(inputs.files) if inputs is not None else set()
    referenced: set[str] = set()
    for prompt in prompts:
        if prompt.kind not in ("brush", "lock"):
            continue
        folder = "corrections" if prompt.kind == "brush" else "locked"
        if prompt.file != f"{folder}/{prompt.pts}.png":
            raise _invalid(f"a {prompt.kind} prompt's file must be {folder}/<its pts>.png.")
        if prompt.file not in declared:
            raise _invalid("brush and lock files must be listed in the inputs handle.")
        referenced.add(prompt.file)
    for name in declared:
        if name.startswith("previous/"):
            if previous is None:
                raise _invalid("previous artifact files need previousArtifact.")
            continue
        if name not in referenced:
            raise _invalid("the inputs handle may list only files a prompt references.")
    if all(prompt.kind in ("brush", "lock") for prompt in prompts) and previous is None:
        raise _invalid("a matte needs a point or box prompt unless it refines a previous artifact.")
    return {
        "output": _output_handle(raw["output"]),
        "inputs": inputs,
        "prompts": prompts,
        "previous_artifact": previous,
        "preview_height": _integer(
            raw["previewHeight"],
            "parameters.previewHeight",
            minimum=MIN_PREVIEW_HEIGHT,
            maximum=MAX_PREVIEW_HEIGHT,
        ),
    }


def _segment_frame_parameters(value: Any) -> dict[str, Any]:
    raw = _object(value, {"pts", "points", "box", "hoverPoint", "previewHeight"}, "parameters")
    _require(raw, ("pts", "previewHeight"), "parameters")
    if not any(key in raw for key in ("points", "box", "hoverPoint")):
        raise _invalid("segment_frame needs points, a box, or a hover point.")
    return {
        "pts": _pts(raw["pts"], "parameters.pts"),
        "points": _points(raw["points"], "parameters.points") if "points" in raw else (),
        "box": _box(raw["box"], "parameters.box") if "box" in raw else None,
        "hover_point": _normalized_point(raw["hoverPoint"], "parameters.hoverPoint")
        if "hoverPoint" in raw
        else None,
        "preview_height": _integer(
            raw["previewHeight"],
            "parameters.previewHeight",
            minimum=MIN_PREVIEW_HEIGHT,
            maximum=MAX_PREVIEW_HEIGHT,
        ),
    }


def _require_protocol_version(value: Any) -> None:
    if value != PROTOCOL_VERSION:
        raise ProtocolError(
            "invalid_request",
            f"unsupported protocol version {value!r}; this worker speaks v{PROTOCOL_VERSION}.",
        )


def parse_input_line(line: str) -> WorkerRequest | CancelMessage:
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
    if capability not in SMART_MASK_CAPABILITIES:
        raise _invalid(f"capability '{capability}' is not provided by Smart Mask.")
    _require(request, ("requestId", "projectRevision", "media", "parameters"), "request")
    request_id = _string(request["requestId"], "requestId", pattern=REQUEST_ID_PATTERN)
    revision = _integer(request["projectRevision"], "projectRevision", minimum=0)
    media = _media(request["media"])
    if capability == "subject.matte":
        parameters = _matte_parameters(request["parameters"])
        return MatteRequest(
            request_id=request_id, project_revision=revision, media=media, **parameters
        )
    frame = _segment_frame_parameters(request["parameters"])
    return SegmentFrameRequest(
        request_id=request_id, project_revision=revision, media=media, **frame
    )


# --- encoders ------------------------------------------------------------------------------


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
        "hardwareBackend": hardware_backend[:128],
        "modelDigests": dict(sorted(model_digests.items())),
    }


def progress_message(
    request_id: str,
    phase: ProgressPhase,
    completed: int,
    total: int,
    *,
    round_number: int | None = None,
    detail: str | None = None,
) -> dict[str, Any]:
    bounded_total = max(total, 1)
    message: dict[str, Any] = {
        "type": "progress",
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
        "phase": phase,
        "completed": min(max(completed, 0), bounded_total),
        "total": bounded_total,
    }
    if round_number is not None:
        if phase != "self_correct":
            raise ProtocolError("internal_error", "only self_correct progress carries a round.")
        message["round"] = min(max(round_number, 1), MAX_SELF_CORRECTION_ROUNDS)
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
        "backend": backend[:128],
        "modelDigests": dict(sorted(digests.items())),
    }


def matte_result_message(
    *,
    request_id: str,
    project_revision: int,
    outcome: MatteOutcome,
    backend: str,
    model_digests: dict[str, str],
) -> dict[str, Any]:
    """Encode a ``subject.matte`` result, refusing any shape the host schema would reject."""
    artifact = outcome.artifact
    names = [file.name for file in artifact.files]
    if len(set(names)) != len(names) or not 2 <= len(names) <= len(ARTIFACT_FILE_NAMES):
        raise ProtocolError("internal_error", "matte artifact files must be 2-6 distinct names.")
    if any(name not in ARTIFACT_FILE_NAMES for name in names):
        raise ProtocolError("internal_error", "matte artifact names an undeclared file.")
    if not all(name in names for name in REQUIRED_ARTIFACT_FILES):
        raise ProtocolError(
            "internal_error", "matte artifact must include matte.mkv and frames.json."
        )
    if not (0 < artifact.width <= MAX_SIDE and 0 < artifact.height <= MAX_SIDE):
        raise ProtocolError("internal_error", "matte artifact size exceeds its bound.")
    if artifact.frame_count < 1 or artifact.last_pts < artifact.first_pts:
        raise ProtocolError("internal_error", "matte artifact frame range is invalid.")
    if artifact.frame_count == 1 and artifact.last_pts != artifact.first_pts:
        raise ProtocolError("internal_error", "a one-frame artifact has one pts.")
    summary = outcome.summary
    if summary.verified_frames + summary.flagged_frames > artifact.frame_count:
        raise ProtocolError("internal_error", "verified and flagged frames exceed the frame count.")
    if not 0 <= summary.self_correction_rounds <= MAX_SELF_CORRECTION_ROUNDS:
        raise ProtocolError("internal_error", "self-correction rounds exceed their bound.")
    if len(outcome.needs_review) > MAX_REVIEW_RANGES:
        raise ProtocolError("internal_error", "review ranges exceed their bound.")
    if outcome.execution_provider not in EXECUTION_PROVIDERS:
        raise ProtocolError("internal_error", "unknown execution provider.")
    message = _result_base(request_id, project_revision, "subject.matte", backend, model_digests)
    message["artifact"] = {
        "files": [{"name": f.name, "bytes": f.bytes, "sha256": f.sha256} for f in artifact.files],
        "width": artifact.width,
        "height": artifact.height,
        "frameCount": artifact.frame_count,
        "firstPts": artifact.first_pts,
        "lastPts": artifact.last_pts,
        "timeBase": [artifact.time_base[0], artifact.time_base[1]],
    }
    message["executionProvider"] = outcome.execution_provider
    message["summary"] = {
        "verifiedFrames": summary.verified_frames,
        "flaggedFrames": summary.flagged_frames,
        "lockedFrames": summary.locked_frames,
        "selfCorrectionRounds": summary.self_correction_rounds,
    }
    message["needsReview"] = [
        {"startPts": item.start_pts, "endPts": item.end_pts, "reason": item.reason}
        for item in outcome.needs_review
    ]
    return message


def segment_frame_result_message(
    *,
    request_id: str,
    project_revision: int,
    pts: int,
    width: int,
    height: int,
    mask_png_base64: str,
    score: float,
    backend: str,
    model_digests: dict[str, str],
) -> dict[str, Any]:
    if not (0 < width <= MAX_SIDE and 0 < height <= MAX_PREVIEW_HEIGHT):
        raise ProtocolError("internal_error", "segment_frame mask size exceeds its bound.")
    if not 8 <= len(mask_png_base64) <= SEGMENT_FRAME_MAX_PNG_CHARS:
        raise ProtocolError("output_too_large", "segment_frame mask PNG exceeds its bound.")
    message = _result_base(
        request_id, project_revision, "subject.segment_frame", backend, model_digests
    )
    message.update(
        {
            "pts": pts,
            "width": width,
            "height": height,
            "maskPng": mask_png_base64,
            "score": min(max(float(score), 0.0), 1.0),
        }
    )
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
        raise ProtocolError("output_too_large", "worker output line exceeded its 1 MiB bound.")
    return f"{encoded}\n"
