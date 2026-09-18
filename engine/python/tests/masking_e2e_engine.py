"""The ENGINE side of the masking end-to-end specs (plan/background-removal-ai 07, E2E.1-E2E.8).

``tests/e2e/specs/masking-e2e-*.spec.ts`` drive the real editor in real Chrome and need the
export's half of every claim they make: the media both sides read, the matte artifacts a pack
would have written, the frame the export composites at a time, and a finished export with its
validation report. This script is that half, one command per call::

    cd engine/python && uv run python -m tests.masking_e2e_engine <command> <request.json>

It prints exactly one JSON line on stdout (logs go to stderr). Commands:

``media``
    Encode sentinel videos with :func:`tests.px4_parity_frames.encode_video` — the same encoder
    settings as the engine's preview proxies, so the monitor and the export decode the same bytes
    and every difference the spec measures is the renderer's.
``matte``
    Write one matte artifact (FFV1 ``matte.mkv`` + ``foreground.mkv`` + ``frames.json``) in the
    project's ``.framepilot-derived/mattes/<key>/`` over a source frame range, exactly as the
    Smart Mask pack's output contract (``render/mattes.py``) describes. **This is the simulated
    part of every background-removal spec**: no model runs; the alpha is a synthetic ramp or disc.
``frames``
    ``grab_frame(..., lossless=True)`` at the program monitor's canvas size for each time: the
    export's own compositor (``compile_timeline``), which is what the PX4 oracle compares against.
``export``
    ``render()`` the project file exactly as the desktop export does (validation included) and
    report the job state, its plain error, the validation checks, the probed streams and the
    sha256 of the file.
``frame-hashes``
    ``frames``, but only the sha256 of each frame's RGB pixels (the cross-platform archive check,
    E2E.7, compares these between runners).

Memory: every command opens one composition at a time and the specs use 640x360 media of a
few seconds, so a call peaks well under 1 GB. Nothing here is safe to point at the Scale row.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import sys
from pathlib import Path
from typing import Any

_log = logging.getLogger("masking_e2e_engine")

#: The program monitor's canvas long edge (`CANVAS_MAX_EDGE` in `WebCodecsPreviewPlayer.tsx`).
PREVIEW_CANVAS_MAX_EDGE = 1280


def _canvas(width: int, height: int) -> tuple[int, int]:
    """The monitor canvas for a project frame, as the player sizes it (JS `Math.round`)."""
    scale = min(1.0, PREVIEW_CANVAS_MAX_EDGE / max(width, height))
    return (max(1, math.floor(width * scale + 0.5)), max(1, math.floor(height * scale + 0.5)))


def _tuple3(value: Any) -> tuple[int, int, int]:
    red, green, blue = (int(channel) for channel in value)
    return (red, green, blue)


def cmd_media(request: dict[str, Any]) -> dict[str, Any]:
    """Encode each requested sentinel video under ``outDir``."""
    from framepilot_engine.media.ffmpeg import find_ffmpeg
    from tests.px4_parity_frames import VideoSpec, encode_video

    out_dir = Path(request["outDir"])
    ffmpeg = find_ffmpeg()
    written = []
    for video in request["videos"]:
        spec = VideoSpec(
            rel_path=str(video["path"]),
            width=int(video["width"]),
            height=int(video["height"]),
            fps=float(video["fps"]),
            seconds=float(video["seconds"]),
            primary=_tuple3(video["primary"]),
            secondary=_tuple3(video["secondary"]),
        )
        encode_video(ffmpeg, out_dir, spec)
        target = out_dir / spec.rel_path
        written.append({"path": spec.rel_path, "bytes": target.stat().st_size})
    return {"written": written}


def cmd_matte(request: dict[str, Any]) -> dict[str, Any]:
    """Write one synthetic matte artifact and return the fields a matte mask pins."""
    from framepilot_engine.render.mattes import MATTES_DIR
    from framepilot_engine.render.pts_reader import video_timing
    from tests.px4_parity_frames import _write_artifact

    project_dir = Path(request["projectDir"])
    source = project_dir / str(request["assetPath"])
    timing = video_timing(source)
    fps = float(request["fps"])
    if "firstFrame" in request:
        # The host's own frame range (`frameRange` in the desktop's matte.ts), when the caller
        # has one: the artifact then covers exactly what a real job would have covered.
        first = int(request["firstFrame"])
        last = int(request["lastFrame"])
    else:
        seconds = timing.relative_seconds()
        start = float(request["sourceStart"])
        end = float(request["sourceEnd"])
        # Every frame whose presentation interval touches [start, end), as a pack covers a range.
        first = max(index for index, t in enumerate(seconds) if t <= start + 1e-9)
        last = max(index for index, t in enumerate(seconds) if t < end - 1e-9)
    last = min(timing.count - 1, last)
    key = hashlib.sha256(
        json.dumps(
            {
                "asset": str(request["assetPath"]),
                "shape": request.get("shape", "ramp"),
                "first": first,
                "last": last,
                "variant": request.get("variant", ""),
            },
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()
    artifact = _write_artifact(
        project_dir / MATTES_DIR / key,
        int(request["width"]),
        int(request["height"]),
        str(request.get("shape", "ramp")),
        _tuple3(request["foreground"]),
        timing,
        first,
        last,
        fps,
    )
    return {
        "key": key,
        **artifact,
        "timeBase": [timing.time_base.numerator, timing.time_base.denominator],
        "pts": list(timing.pts[first : last + 1]),
        "firstFrame": first,
    }


def _load(project_path: Path) -> Any:
    from framepilot_engine.timeline.models import ProjectFile

    return ProjectFile.load(project_path)


def _grab(project_path: Path, times: list[float], burn: bool) -> list[tuple[float, Any]]:
    from framepilot_engine.render.compiler import timeline_duration
    from framepilot_engine.render.composition_cache import COMPOSITION_CACHE
    from framepilot_engine.render.frame_grab import grab_frame

    project = _load(project_path)
    canvas = _canvas(int(project.resolution.width), int(project.resolution.height))
    duration = timeline_duration(project.timeline)
    frames = []
    for time in times:
        if time >= duration:
            raise ValueError(f"sample {time}s is past the end of the timeline ({duration}s)")
        frame = grab_frame(
            project,
            project_path.parent,
            float(time),
            image_format="png",
            burn_captions=burn,
            lossless=True,
            lossless_size=canvas,
        )
        COMPOSITION_CACHE.clear()
        frames.append((time, frame))
    return frames


def cmd_frames(request: dict[str, Any]) -> dict[str, Any]:
    """Lossless export frames at the monitor's canvas size, one PNG per time."""
    project_path = Path(request["projectPath"])
    out_dir = Path(request["outDir"])
    out_dir.mkdir(parents=True, exist_ok=True)
    frames = []
    for index, (time, frame) in enumerate(
        _grab(project_path, [float(t) for t in request["times"]], bool(request.get("burn", False)))
    ):
        target = out_dir / f"{request.get('prefix', 'frame')}-{index}.png"
        target.write_bytes(frame.data)
        frames.append(
            {
                "time": time,
                "renderedTime": frame.time_seconds,
                "path": str(target),
                "width": frame.width,
                "height": frame.height,
            }
        )
    return {"frames": frames}


def cmd_frame_hashes(request: dict[str, Any]) -> dict[str, Any]:
    """sha256 of each lossless export frame's decoded RGB pixels (not of the PNG bytes)."""
    import io

    from PIL import Image

    project_path = Path(request["projectPath"])
    hashes = []
    for time, frame in _grab(
        project_path, [float(t) for t in request["times"]], bool(request.get("burn", False))
    ):
        with Image.open(io.BytesIO(frame.data)) as image:
            pixels = image.convert("RGB").tobytes()
        hashes.append(
            {
                "time": time,
                "width": frame.width,
                "height": frame.height,
                "sha256": hashlib.sha256(pixels).hexdigest(),
            }
        )
    return {"frames": hashes}


def _settings(raw: dict[str, Any] | None) -> Any:
    from framepilot_engine.render.export_settings import ExportSettings

    names = {"bitrateKbps": "bitrate_kbps", "videoCodec": "video_codec"}
    return ExportSettings.model_validate(
        {names.get(key, key): value for key, value in (raw or {}).items()}
    )


def cmd_export(request: dict[str, Any]) -> dict[str, Any]:
    """Render the saved project as the desktop export does; report state, validation, probe."""
    from framepilot_engine.media.probe import inspect_media
    from framepilot_engine.render.pipeline import RenderOptions, render

    project_path = Path(request["projectPath"])
    try:
        project = _load(project_path)
    except Exception as exc:  # a refused load is an export refusal, reported like one
        return {"state": "failed", "error": str(exc), "errorDetail": str(exc)}
    opts = RenderOptions(
        settings=_settings(request.get("settings")),
        preview=False,
        burn_captions=bool(request.get("burnCaptions", False)),
        output_path=str(request["output"]),
    )
    job = render(project, opts, base_dir=project_path.parent)
    result: dict[str, Any] = {
        "state": str(job.state.value),
        "error": job.error,
        "errorDetail": job.error_detail,
        "outputPath": job.output_path,
    }
    if job.validation is not None:
        result["validation"] = {
            "ok": job.validation.ok,
            "checks": [
                {"name": check.name, "status": str(check.status.value), "detail": check.detail}
                for check in job.validation.checks
            ],
        }
    if job.output_path is not None and Path(job.output_path).is_file():
        output = Path(job.output_path)
        info = inspect_media(output)
        result["probe"] = {
            "durationSeconds": info.duration_seconds,
            "formatName": info.format_name,
            "streams": [
                {
                    "codecType": stream.codec_type,
                    "codecName": stream.codec_name,
                    "width": stream.width,
                    "height": stream.height,
                }
                for stream in info.streams
            ],
        }
        result["sha256"] = hashlib.sha256(output.read_bytes()).hexdigest()
    return result


COMMANDS = {
    "media": cmd_media,
    "matte": cmd_matte,
    "frames": cmd_frames,
    "frame-hashes": cmd_frame_hashes,
    "export": cmd_export,
}


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(name)s: %(message)s")
    if len(args) != 2 or args[0] not in COMMANDS:
        sys.stderr.write(f"usage: masking_e2e_engine {{{','.join(COMMANDS)}}} <request.json>\n")
        return 2
    request = json.loads(Path(args[1]).read_text(encoding="utf-8"))
    result = COMMANDS[args[0]](request)
    sys.stdout.write(json.dumps(result) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
