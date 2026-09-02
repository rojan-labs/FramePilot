"""Automatic render validation (PRD §9.4, plan 2.3).

WHY: "reliability over fake magic" (PRD §3.6) — every render is checked before
it is shown to the user, so a black/silent/truncated export never silently
ships. This module runs the PRD §9.4 checks via ffprobe (duration/streams) and
ffmpeg analysis filters (``blackdetect`` for black frames, ``volumedetect`` for
audio clipping) and assembles a :class:`ValidationReport`.

The probe function and the ffmpeg log runner are both injectable, and the log
**parsers** are pure, so the whole check matrix is unit-testable without the
binaries (dependency inversion).
"""

from __future__ import annotations

import re
from collections.abc import Callable
from enum import StrEnum
from pathlib import Path

from pydantic import BaseModel, Field

from framepilot_engine.analysis.black import (
    BlackRange,
    blackdetect_argv,
    parse_black_ranges,
)

# Black-frame parsing/detection is shared with the first-class analyzer
# (plan B1.1) — QC and analysis must never drift apart on what "black" means.
from framepilot_engine.analysis.black import (  # re-exported for QC callers/tests
    detect_black_seconds as detect_black_seconds,
)
from framepilot_engine.analysis.black import (
    parse_black_seconds as parse_black_seconds,
)
from framepilot_engine.analysis.silence import SilentRange, parse_silence_ranges
from framepilot_engine.media.ffmpeg import FFmpegError, Runner, find_ffmpeg, run_logs
from framepilot_engine.media.probe import MediaInfo, inspect_media
from framepilot_engine.validation.perceptual_thresholds import (
    EXPORT_MAX_AUDIO_DBFS,
    EXPORT_MAX_BLACK_RATIO,
)

# volumedetect findings are emitted on stderr in this form:
#   [Parsed_volumedetect_0 @ 0x..] max_volume: -3.1 dB
_MAX_VOLUME_RE = re.compile(r"max_volume:\s*(-?\d+(?:\.\d+)?) dB")

# A ProbeFn turns a path into MediaInfo; defaults to the real ffprobe-backed one.
ProbeFn = Callable[[Path], MediaInfo]


class CheckStatus(StrEnum):
    """Outcome of a single validation check."""

    PASS = "pass"
    FAIL = "fail"
    SKIP = "skip"


class ValidationCheck(BaseModel):
    """The result of one render check (e.g. 'duration within tolerance')."""

    name: str
    status: CheckStatus
    detail: str | None = None


class ValidationReport(BaseModel):
    """Aggregate result of validating a rendered output (PRD §9.4)."""

    output_path: str
    ok: bool = Field(description="True only if every non-skipped check passed.")
    checks: list[ValidationCheck] = Field(default_factory=list)

    @classmethod
    def from_checks(cls, output_path: str, checks: list[ValidationCheck]) -> ValidationReport:
        """Build a report, deriving ``ok`` from the checks.

        :param output_path: The validated file path.
        :param checks: The individual check results.
        :returns: A :class:`ValidationReport` with ``ok`` computed.
        """
        ok = all(c.status != CheckStatus.FAIL for c in checks)
        return cls(output_path=output_path, ok=ok, checks=checks)


class ExpectedRender(BaseModel):
    """Expectations to validate the output against (from the timeline)."""

    duration_seconds: float | None = Field(default=None, description="Expected duration.")
    expect_video: bool = Field(default=True, description="Whether a video stream is expected.")
    expect_audio: bool = Field(default=True, description="Whether an audio stream is expected.")
    duration_tolerance_seconds: float = Field(default=0.1, description="Allowed duration drift.")
    max_black_ratio: float = Field(
        default=EXPORT_MAX_BLACK_RATIO,
        description=(
            "Fail if at least this fraction of the video duration is black — i.e. the "
            "render is (near-)entirely black, the real failure mode. Not 1.0 because "
            "ffmpeg blackdetect undercounts the final frame, so a fully-black N-second "
            "clip reports ~ (N - 1 frame); 0.95 catches that while leaving ample room "
            "for legitimate black intros/dark scenes."
        ),
    )
    # --- the intended spec (goal.md Workstream F: "validate every export against the
    # intended spec — duration, resolution, frame rate, audio presence, no black or
    # silent tails"). Each is optional so a caller with no expectation gets a SKIP,
    # never a guess.
    width: int | None = Field(default=None, description="Expected output width in pixels.")
    height: int | None = Field(default=None, description="Expected output height in pixels.")
    fps: float | None = Field(default=None, description="Expected output frame rate.")
    fps_tolerance: float = Field(
        default=0.05,
        description=(
            "Allowed frame-rate drift. 29.97 is reported as 30000/1001 = 29.970029…, and "
            "a variable-rate source can land a hair off; 0.05 absorbs that and still "
            "catches a 30 fps export that came out at 25 or 60."
        ),
    )
    max_black_tail_seconds: float = Field(
        default=0.2,
        description=(
            "Fail if the picture ends on at least this much black. A render that runs a "
            "few frames past its last clip is the common shape of a duration mismatch "
            "that the duration tolerance alone lets through; 0.2 s is six frames at 30 fps, "
            "well above blackdetect's final-frame undercount and below anything an editor "
            "would call a fade-to-black."
        ),
    )
    max_silent_tail_seconds: float = Field(
        default=1.0,
        description=(
            "Fail if the audio ends on at least this much silence while the timeline's own "
            "audio was expected to run to the end (see expect_audio_to_end). A music fade "
            "ends quiet, not silent; a full second of digital silence at the end means the "
            "sound stopped before the picture did."
        ),
    )
    expect_audio_to_end: bool = Field(
        default=True,
        description=(
            "Whether the timeline's audio content reaches the programme end. False when the "
            "edit itself ends the sound early (a picture-only outro), in which case a silent "
            "tail is the edit, not a defect, and the check is skipped."
        ),
    )
    max_audio_dbfs: float = Field(
        default=EXPORT_MAX_AUDIO_DBFS,
        description=(
            "Fail if peak audio reaches/exceeds this dBFS. NOT 0.0: 0 dBFS is digital "
            "full scale — the normal ceiling, not clipping. Real audio routinely peaks "
            "at exactly 0.0 dBFS, and lossy (AAC) exports decode with sub-dB "
            "inter-sample overshoot that ``volumedetect`` reports as ~0.0 to +1 dB, so a "
            "0.0 threshold rejects perfectly good audio-packed exports. +1.0 dBFS "
            "absorbs that codec overshoot while still catching gross overflow/clipping."
        ),
    )


# --- Pure parsers (unit-testable without ffmpeg) -----------------------------


def parse_max_volume_dbfs(logs: str) -> float | None:
    """Extract ``max_volume`` (dBFS) from ffmpeg ``volumedetect`` output.

    :param logs: ffmpeg stderr text.
    :returns: The peak volume in dBFS, or ``None`` if not present.
    """
    match = _MAX_VOLUME_RE.search(logs)
    return float(match.group(1)) if match else None


# --- ffmpeg detection (injectable runner) ------------------------------------


def detect_max_volume_dbfs(path: Path, *, runner: Runner) -> float | None:
    """Run ffmpeg ``volumedetect`` on ``path`` and return peak dBFS (or None)."""
    argv = [
        find_ffmpeg(),
        "-hide_banner",
        "-nostats",
        "-i",
        str(path),
        "-vn",
        "-af",
        "volumedetect",
        "-f",
        "null",
        "-",
    ]
    return parse_max_volume_dbfs(runner(argv))


#: blackdetect tuned for render QC: even the shortest black run must be counted, so
#: the window is 0.05 s rather than the analyzer's editorial 0.5 s.
_QC_BLACKDETECT_PARAMS = "d=0.05:pic_th=0.98:pix_th=0.10"
#: silencedetect tuned for a silent TAIL: digital silence, not a quiet passage. -50 dB
#: is far below a music fade's last audible seconds and far above encoder noise.
_QC_SILENCE_NOISE_DB = -50
_QC_SILENCE_MIN_SECONDS = 0.1
#: How close to the end a black/silent span must reach to count as a tail. blackdetect
#: undercounts the final frame and silencedetect closes at the last decoded sample, so a
#: span ending within 0.1 s of the reported duration reaches the end.
_TAIL_REACH_SECONDS = 0.1


def detect_black_qc(path: Path, *, runner: Runner) -> tuple[float, list[BlackRange]]:
    """Run ``blackdetect`` once for QC and return (total black seconds, black spans).

    One ffmpeg pass serves both the whole-render black ratio and the black-tail check.
    """
    logs = runner(blackdetect_argv(path, _QC_BLACKDETECT_PARAMS))
    return parse_black_seconds(logs), parse_black_ranges(logs)


def detect_silence_qc(
    path: Path, *, runner: Runner, total_duration: float | None
) -> list[SilentRange]:
    """Run ``silencedetect`` tuned for a silent tail and return the silent spans."""
    argv = [
        find_ffmpeg(),
        "-hide_banner",
        "-nostats",
        "-i",
        str(path),
        "-vn",
        "-af",
        f"silencedetect=noise={_QC_SILENCE_NOISE_DB}dB:d={_QC_SILENCE_MIN_SECONDS}",
        "-f",
        "null",
        "-",
    ]
    return parse_silence_ranges(runner(argv), total_duration=total_duration)


def tail_seconds(spans: list[BlackRange] | list[SilentRange], duration: float) -> float:
    """How much of the end of a ``duration``-second file the last span covers (pure).

    Zero when no span reaches the end. Spans are start-ordered by their parsers, so the
    last one is the only candidate; its reach is judged against
    :data:`_TAIL_REACH_SECONDS`.
    """
    if not spans or duration <= 0:
        return 0.0
    last = spans[-1]
    if last.end < duration - _TAIL_REACH_SECONDS:
        return 0.0
    return max(0.0, duration - last.start)


# --- Top-level validation ----------------------------------------------------


def validate_render(
    path: Path,
    expected: ExpectedRender,
    *,
    probe: ProbeFn | None = None,
    log_runner: Runner | None = None,
    timeout: float | None = 60.0,
) -> ValidationReport:
    """Validate a rendered file against expectations (PRD §9.4).

    Checks: file exists, non-zero bytes, video stream present, audio stream
    present if expected, duration within tolerance, no (near-)fully-black video,
    no audio clipping. Stream/black/clipping checks ``SKIP`` when not applicable.

    :param path: Path to the rendered output (assumed already sandbox-resolved).
    :param expected: Expected duration/streams/thresholds from the timeline.
    :param probe: Media prober; defaults to the ffprobe-backed
        :func:`framepilot_engine.media.probe.inspect_media`.
    :param log_runner: ffmpeg stderr runner; defaults to
        :func:`framepilot_engine.media.ffmpeg.run_logs`.
    :param timeout: Per-ffmpeg-call timeout in seconds.
    :returns: A :class:`ValidationReport` (``ok`` derived from the checks).
    """
    probe = probe or inspect_media
    log_runner = log_runner or (lambda argv: run_logs(argv, timeout=timeout))
    checks: list[ValidationCheck] = []

    # 1. File exists — without it nothing else can be checked.
    if not path.exists():
        checks.append(
            ValidationCheck(name="file_exists", status=CheckStatus.FAIL, detail="missing")
        )
        return ValidationReport.from_checks(str(path), checks)
    checks.append(ValidationCheck(name="file_exists", status=CheckStatus.PASS))

    # 2. Non-zero bytes.
    size = path.stat().st_size
    if size == 0:
        checks.append(ValidationCheck(name="non_empty", status=CheckStatus.FAIL, detail="0 bytes"))
        return ValidationReport.from_checks(str(path), checks)
    checks.append(
        ValidationCheck(name="non_empty", status=CheckStatus.PASS, detail=f"{size} bytes")
    )

    # 3. Probe — a probe failure on a non-empty file means a corrupt/invalid render.
    try:
        info = probe(path)
    except FFmpegError as exc:
        checks.append(ValidationCheck(name="probe", status=CheckStatus.FAIL, detail=str(exc)))
        return ValidationReport.from_checks(str(path), checks)

    checks.append(_video_stream_check(info, expected))
    checks.append(_audio_stream_check(info, expected))
    checks.append(_duration_check(info, expected))
    checks.append(_resolution_check(info, expected))
    checks.append(_frame_rate_check(info, expected))
    checks.extend(_black_checks(path, info, expected, log_runner))
    checks.append(_audio_clipping_check(path, info, expected, log_runner))
    checks.append(_silent_tail_check(path, info, expected, log_runner))

    return ValidationReport.from_checks(str(path), checks)


#: Plain-language sentences for the checks an editor can act on. Anything not listed
#: falls back to "<name>: <detail>", which is still true, just less friendly.
def plain_failures(report: ValidationReport) -> list[str]:
    """One sentence per failed check, in words a non-technical user can act on.

    :param report: The validation report.
    :returns: The failed checks as sentences (empty when the report is ok).
    """
    lines: list[str] = []
    for check in report.checks:
        if check.status != CheckStatus.FAIL:
            continue
        detail = check.detail or ""
        match check.name:
            case "duration":
                lines.append(f"The export is not the length of the timeline ({detail}).")
            case "resolution":
                lines.append(f"The export is not the requested size ({detail}).")
            case "frame_rate":
                lines.append(f"The export is not the requested frame rate ({detail}).")
            case "black_tail":
                lines.append(f"The export ends on black ({detail}).")
            case "silent_tail":
                lines.append(f"The export ends on silence ({detail}).")
            case "black_frames":
                lines.append("The export is black — nothing was drawn.")
            case "video_stream":
                lines.append("The export has no picture.")
            case "audio_stream":
                lines.append("The export has no sound.")
            case "audio_clipping":
                lines.append(f"The export's audio clips ({detail}).")
            case _:
                lines.append(f"{check.name}: {detail}" if detail else check.name)
    return lines


def _video_stream_check(info: MediaInfo, expected: ExpectedRender) -> ValidationCheck:
    if not expected.expect_video:
        return ValidationCheck(name="video_stream", status=CheckStatus.SKIP, detail="not expected")
    status = CheckStatus.PASS if info.has_video else CheckStatus.FAIL
    return ValidationCheck(name="video_stream", status=status)


def _audio_stream_check(info: MediaInfo, expected: ExpectedRender) -> ValidationCheck:
    if not expected.expect_audio:
        return ValidationCheck(name="audio_stream", status=CheckStatus.SKIP, detail="not expected")
    status = CheckStatus.PASS if info.has_audio else CheckStatus.FAIL
    return ValidationCheck(name="audio_stream", status=status)


def _duration_check(info: MediaInfo, expected: ExpectedRender) -> ValidationCheck:
    if expected.duration_seconds is None:
        return ValidationCheck(name="duration", status=CheckStatus.SKIP, detail="no expectation")
    if info.duration_seconds is None:
        return ValidationCheck(name="duration", status=CheckStatus.FAIL, detail="unknown duration")
    drift = abs(info.duration_seconds - expected.duration_seconds)
    detail = f"actual={info.duration_seconds:.3f}s expected={expected.duration_seconds:.3f}s"
    status = CheckStatus.PASS if drift <= expected.duration_tolerance_seconds else CheckStatus.FAIL
    return ValidationCheck(name="duration", status=status, detail=detail)


def _resolution_check(info: MediaInfo, expected: ExpectedRender) -> ValidationCheck:
    if expected.width is None or expected.height is None:
        return ValidationCheck(name="resolution", status=CheckStatus.SKIP, detail="no expectation")
    if not info.has_video:
        return ValidationCheck(name="resolution", status=CheckStatus.SKIP, detail="no video")
    stream = info.video_streams[0]
    if stream.width is None or stream.height is None:
        return ValidationCheck(name="resolution", status=CheckStatus.FAIL, detail="unknown size")
    detail = f"actual={stream.width}x{stream.height} expected={expected.width}x{expected.height}"
    ok = stream.width == expected.width and stream.height == expected.height
    return ValidationCheck(
        name="resolution", status=CheckStatus.PASS if ok else CheckStatus.FAIL, detail=detail
    )


def _frame_rate_check(info: MediaInfo, expected: ExpectedRender) -> ValidationCheck:
    if expected.fps is None:
        return ValidationCheck(name="frame_rate", status=CheckStatus.SKIP, detail="no expectation")
    if not info.has_video:
        return ValidationCheck(name="frame_rate", status=CheckStatus.SKIP, detail="no video")
    fps = info.video_streams[0].fps
    if fps is None:
        return ValidationCheck(
            name="frame_rate", status=CheckStatus.FAIL, detail="unknown frame rate"
        )
    detail = f"actual={fps:.3f} expected={expected.fps:.3f}"
    ok = abs(fps - expected.fps) <= expected.fps_tolerance
    return ValidationCheck(
        name="frame_rate", status=CheckStatus.PASS if ok else CheckStatus.FAIL, detail=detail
    )


def _black_checks(
    path: Path,
    info: MediaInfo,
    expected: ExpectedRender,
    log_runner: Runner,
) -> list[ValidationCheck]:
    """The whole-render black ratio and the black tail, from ONE blackdetect pass."""
    if not info.has_video:
        skip = ValidationCheck(status=CheckStatus.SKIP, detail="no video", name="black_frames")
        return [skip, skip.model_copy(update={"name": "black_tail"})]
    black_seconds, spans = detect_black_qc(path, runner=log_runner)
    if not info.duration_seconds:
        # Can't compute a ratio or a tail; report the raw figure without failing.
        return [
            ValidationCheck(
                name="black_frames", status=CheckStatus.PASS, detail=f"{black_seconds:.3f}s black"
            ),
            ValidationCheck(name="black_tail", status=CheckStatus.SKIP, detail="unknown duration"),
        ]
    ratio = black_seconds / info.duration_seconds
    ratio_status = CheckStatus.FAIL if ratio >= expected.max_black_ratio else CheckStatus.PASS
    tail = tail_seconds(spans, info.duration_seconds)
    tail_status = CheckStatus.FAIL if tail >= expected.max_black_tail_seconds else CheckStatus.PASS
    # A render that is black throughout already failed the ratio; naming its tail as
    # well would report one defect twice.
    if ratio_status == CheckStatus.FAIL:
        tail_status = CheckStatus.SKIP
    return [
        ValidationCheck(
            name="black_frames", status=ratio_status, detail=f"black_ratio={ratio:.3f}"
        ),
        ValidationCheck(
            name="black_tail",
            status=tail_status,
            detail=f"black_tail={tail:.3f}s"
            if tail_status != CheckStatus.SKIP
            else "black throughout",
        ),
    ]


def _silent_tail_check(
    path: Path,
    info: MediaInfo,
    expected: ExpectedRender,
    log_runner: Runner,
) -> ValidationCheck:
    if not expected.expect_audio or not info.has_audio:
        return ValidationCheck(name="silent_tail", status=CheckStatus.SKIP, detail="no audio")
    if not expected.expect_audio_to_end:
        return ValidationCheck(
            name="silent_tail", status=CheckStatus.SKIP, detail="audio ends early by design"
        )
    if not info.duration_seconds:
        return ValidationCheck(
            name="silent_tail", status=CheckStatus.SKIP, detail="unknown duration"
        )
    spans = detect_silence_qc(path, runner=log_runner, total_duration=info.duration_seconds)
    tail = tail_seconds(spans, info.duration_seconds)
    status = CheckStatus.FAIL if tail >= expected.max_silent_tail_seconds else CheckStatus.PASS
    return ValidationCheck(name="silent_tail", status=status, detail=f"silent_tail={tail:.3f}s")


def _audio_clipping_check(
    path: Path,
    info: MediaInfo,
    expected: ExpectedRender,
    log_runner: Runner,
) -> ValidationCheck:
    if not info.has_audio:
        return ValidationCheck(name="audio_clipping", status=CheckStatus.SKIP, detail="no audio")
    peak = detect_max_volume_dbfs(path, runner=log_runner)
    if peak is None:
        return ValidationCheck(
            name="audio_clipping", status=CheckStatus.SKIP, detail="no measurement"
        )
    status = CheckStatus.FAIL if peak >= expected.max_audio_dbfs else CheckStatus.PASS
    return ValidationCheck(name="audio_clipping", status=status, detail=f"max_volume={peak} dBFS")
