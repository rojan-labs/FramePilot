"""One-shot stdin/stdout bridge for rendered professional-operation evaluations.

The TypeScript scorecard owns resolver/compiler/apply/invert assertions. This bridge supplies the
missing deterministic render boundary: it stages tiny synthetic media for the case project, runs
the production temporal-evidence acquirer, and returns the real batch as JSON. It is intentionally
not a network service and never touches user media.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from pydantic import TypeAdapter

from framepilot_engine.media.ffmpeg import find_ffmpeg
from framepilot_engine.timeline.models import Project
from framepilot_engine.validation.temporal_evidence import (
    TemporalEvidenceRequest,
    acquire_temporal_evidence,
)

_REQUESTS = TypeAdapter(list[TemporalEvidenceRequest])
#: Band palettes, chosen so channels stay separated enough for a colour proof to
#: read one without contamination from its neighbours.
_BAND_PALETTES = (
    ("0x203080", "0x30A050", "0xB04030"),
    ("0x802030", "0x2050A0", "0xC0A030"),
    ("0x304080", "0xA03050", "0x40B080"),
)
#: Fraction of the frame width the tracked block travels over a clip's duration.
#: Staying under 1.0 keeps the block fully in frame, so a measured centroid is
#: never clipped by the frame edge — clipping silently under-reports travel.
_BLOCK_TRAVEL_FRACTION = 0.5
#: Block edge as a fraction of frame width.
_BLOCK_FRACTION = 0.2


def block_speed(width: int, duration: float) -> float:
    """Pixels per second the tracked block travels, as a formula a proof can reuse."""
    return (width * _BLOCK_TRAVEL_FRACTION) / max(duration, 1e-6)


def expected_block_left(width: int, duration: float, seconds: float) -> float:
    """Where the block's left edge is, in pixels, at ``seconds`` into the media."""
    return block_speed(width, duration) * seconds


def _band_filter(seed: int, width: int, height: int, speed: float, block: int) -> str:
    """Colour bands with a white block composited at ``speed * t``.

    The block is composited with ``overlay`` rather than drawn with ``drawbox``:
    a ``drawbox`` position expression silently draws nothing on ffmpeg 8.x, which
    would produce motionless fixture media — a fixture that fails open.
    """
    palette = _BAND_PALETTES[seed % len(_BAND_PALETTES)]
    band_height = height // len(palette)
    draws = ",".join(
        f"drawbox=x=0:y={index * band_height}:w={width}:h={band_height}:color={colour}:t=fill"
        for index, colour in enumerate(palette)
    )
    top = height // 2 - block // 2
    return f"[0:v]{draws}[bands];[bands][1:v]overlay=x={speed:.6f}*t:y={top}[v]"


def _duration_for(asset: dict[str, Any], project: Project) -> float:
    declared = asset.get("durationSeconds")
    if isinstance(declared, int | float) and declared > 0:
        return float(declared)
    asset_id = str(asset["id"])
    ends = [
        clip.source_end
        for track in project.timeline.tracks
        for clip in track.clips
        if clip.asset_id == asset_id and clip.source_end is not None
    ]
    return max(1.0, max(ends, default=1.0))


def _stage_asset(ffmpeg: str, root: Path, asset: dict[str, Any], project: Project) -> None:
    relative = Path(str(asset["path"]))
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError(f"Professional eval asset path must be relative: {relative}")
    output = root / relative
    output.parent.mkdir(parents=True, exist_ok=True)
    duration = _duration_for(asset, project)
    digest = hashlib.sha256(str(asset["id"]).encode()).digest()
    frequency = 220 + digest[1] * 3
    command = [ffmpeg, "-y"]
    if asset["kind"] == "audio":
        command += [
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency={frequency}:sample_rate=48000:duration={duration}",
            "-c:a",
            "pcm_s16le",
        ]
    else:
        # Content-coded rather than a flat colour fill. A solid frame cannot show
        # that anything moved, so motion/tracking/reframe proofs measured against
        # it could only ever assert metadata. This stages structure a rendered
        # proof can actually read: separated colour bands plus a white block whose
        # position is a known formula in t.
        width, height = 320, 240
        block = max(8, int(width * _BLOCK_FRACTION))
        speed = block_speed(width, duration)
        command += [
            "-f",
            "lavfi",
            "-i",
            f"color=c=black:s={width}x{height}:r={project.fps}:d={duration}",
            "-f",
            "lavfi",
            "-i",
            f"color=c=white:s={block}x{block}:r={project.fps}:d={duration}",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency={frequency}:sample_rate=48000:duration={duration}",
            "-filter_complex",
            _band_filter(digest[0], width, height, speed, block),
            "-pix_fmt",
            "yuv420p",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-c:a",
            "aac",
            "-shortest",
        ]
    if asset["kind"] != "audio":
        command += ["-map", "[v]", "-map", "2:a"]
    subprocess.run([*command, str(output)], check=True, capture_output=True)


def run(payload: dict[str, Any]) -> dict[str, Any]:
    project = Project.model_validate(payload["project"])
    # Professional fixtures prove semantics, not delivery resolution. Keeping the deterministic
    # render small makes all 33 rows practical as a release gate without changing timing/content.
    project.resolution.width = 320
    project.resolution.height = 240
    requests = _REQUESTS.validate_python(payload["requests"])
    with tempfile.TemporaryDirectory(prefix="framepilot-professional-eval-") as directory:
        root = Path(directory)
        ffmpeg = find_ffmpeg()
        for asset in payload["project"].get("assets", []):
            _stage_asset(ffmpeg, root, asset, project)
        batch = acquire_temporal_evidence(project, root, requests)
        return batch.model_dump(by_alias=True)


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        json.dump(run(payload), sys.stdout, separators=(",", ":"), allow_nan=False)
        sys.stdout.write("\n")
        return 0
    except Exception as exc:  # pragma: no cover - exercised from the TS process boundary
        print(f"professional eval bridge failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover - module entry point
    raise SystemExit(main())
