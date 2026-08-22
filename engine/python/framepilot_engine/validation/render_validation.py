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

# Black-frame parsing/detection is shared with the first-class analyzer
# (plan B1.1) — QC and analysis must never drift apart on what "black" means.
from framepilot_engine.analysis.black import (  # re-exported for QC callers/tests
    detect_black_seconds as detect_black_seconds,
)
from framepilot_engine.analysis.black import (
    parse_black_seconds as parse_black_seconds,
)
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
    checks.append(_black_frame_check(path, info, expected, log_runner))
    checks.append(_audio_clipping_check(path, info, expected, log_runner))

    return ValidationReport.from_checks(str(path), checks)


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


def _black_frame_check(
    path: Path,
    info: MediaInfo,
    expected: ExpectedRender,
    log_runner: Runner,
) -> ValidationCheck:
    if not info.has_video:
        return ValidationCheck(name="black_frames", status=CheckStatus.SKIP, detail="no video")
    black_seconds = detect_black_seconds(path, runner=log_runner)
    if not info.duration_seconds:
        # Can't compute a ratio; report the raw figure without failing.
        return ValidationCheck(
            name="black_frames", status=CheckStatus.PASS, detail=f"{black_seconds:.3f}s black"
        )
    ratio = black_seconds / info.duration_seconds
    status = CheckStatus.FAIL if ratio >= expected.max_black_ratio else CheckStatus.PASS
    return ValidationCheck(name="black_frames", status=status, detail=f"black_ratio={ratio:.3f}")


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
