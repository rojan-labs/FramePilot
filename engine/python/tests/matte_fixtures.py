"""Synthetic matte artifacts for engine tests (BR2.4): tiny FFV1 files made by ffmpeg.

Every artifact is a few KB (64x36, a handful of frames). Frame identity is written INTO the
pixels, so a test can tell which frame it got: matte frame ``i`` is filled with
:func:`frame_level` ``(i)`` unless a caller supplies its own frames, and its foreground with
:func:`foreground_rgb` ``(i)``.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import numpy as np
import numpy.typing as npt

from framepilot_engine.media.ffmpeg import find_ffmpeg
from framepilot_engine.render.mattes import FOREGROUND_FILE, FRAMES_FILE, MATTE_FILE, MATTES_DIR

WIDTH, HEIGHT = 64, 36
KEY = "a" * 64


def frame_level(index: int) -> int:
    """The gray level of synthetic matte frame ``index`` (distinct for 0..27)."""
    return 5 + 9 * index


def foreground_rgb(index: int) -> tuple[int, int, int]:
    """The flat foreground colour of synthetic frame ``index``."""
    return (200 - 7 * index, 40 + 5 * index, 90)


def encode_ffv1(
    path: Path,
    frames: Sequence[npt.NDArray[Any]],
    pixel_format: str,
    stored_format: str,
    *,
    ts_offset: float = 0.0,
    fps: str = "30",
) -> None:
    """Write ``frames`` (rawvideo in ``pixel_format``) to an FFV1 Matroska file."""
    height, width = frames[0].shape[:2]
    argv = [
        find_ffmpeg(),
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-f",
        "rawvideo",
        "-pix_fmt",
        pixel_format,
        "-s",
        f"{width}x{height}",
        "-r",
        fps,
        "-i",
        "-",
        "-c:v",
        "ffv1",
        "-level",
        "3",
        "-pix_fmt",
        stored_format,
    ]
    if ts_offset:
        argv += ["-output_ts_offset", repr(ts_offset)]
    argv.append(str(path))
    payload = b"".join(np.ascontiguousarray(frame).tobytes() for frame in frames)
    subprocess.run(argv, input=payload, check=True, capture_output=True, timeout=60)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def level_frames(
    count: int, *, width: int = WIDTH, height: int = HEIGHT
) -> list[npt.NDArray[np.uint8]]:
    return [np.full((height, width), frame_level(i), dtype=np.uint8) for i in range(count)]


def colour_frames(
    count: int, *, width: int = WIDTH, height: int = HEIGHT
) -> list[npt.NDArray[np.uint8]]:
    return [
        np.broadcast_to(np.asarray(foreground_rgb(i), dtype=np.uint8), (height, width, 3)).copy()
        for i in range(count)
    ]


def write_artifact(
    project_dir: Path,
    *,
    pts: Sequence[int],
    time_base: tuple[int, int] = (1, 30),
    origin_pts: int = 0,
    first_frame: int = 0,
    mattes: Sequence[npt.NDArray[Any]] | None = None,
    foregrounds: Sequence[npt.NDArray[np.uint8]] | None = None,
    matte_format: str = "gray",
    key: str = KEY,
    ts_offset: float = 0.0,
    fps: str = "30",
) -> dict[str, Any]:
    """Write an artifact into ``project_dir`` and return the ``artifact`` JSON a mask pins.

    ``coverage`` spans the first frame's source time to one step past the last.
    """
    directory = project_dir / MATTES_DIR / key
    directory.mkdir(parents=True, exist_ok=True)
    count = len(pts)
    matte_frames = list(mattes) if mattes is not None else level_frames(count)
    height, width = matte_frames[0].shape[:2]
    raw_format = "gray16le" if matte_format == "gray16le" else "gray"
    encode_ffv1(
        directory / MATTE_FILE, matte_frames, raw_format, matte_format, ts_offset=ts_offset, fps=fps
    )
    fg_frames = (
        list(foregrounds)
        if foregrounds is not None
        else colour_frames(count, width=width, height=height)
    )
    encode_ffv1(
        directory / FOREGROUND_FILE, fg_frames, "rgb24", "bgr0", ts_offset=ts_offset, fps=fps
    )
    (directory / FRAMES_FILE).write_text(
        json.dumps(
            {
                "version": 1,
                "timeBase": list(time_base),
                "originPts": origin_pts,
                "firstFrame": first_frame,
                "pts": list(pts),
            }
        ),
        encoding="utf-8",
    )
    num, den = time_base
    step = (pts[-1] - pts[0]) // (count - 1) if count > 1 else den // num
    start = (pts[0] - origin_pts) * num / den
    end = (pts[-1] + step - origin_pts) * num / den
    return {
        "key": key,
        "files": [
            {"name": name, "sha256": sha256(directory / name)}
            for name in (MATTE_FILE, FOREGROUND_FILE, FRAMES_FILE)
        ],
        "width": width,
        "height": height,
        "coverage": {"sourceStart": start, "sourceEnd": end},
        "packId": "framepilot.smart-mask",
        "packVersion": "0.0.0-test",
        "modelDigests": [],
    }


def matte_mask(mask_id: str, artifact: dict[str, Any], **extra: Any) -> dict[str, Any]:
    """A ``matte`` mask layer JSON over ``artifact``."""
    return {"kind": "matte", "id": mask_id, "artifact": artifact, **extra}


def write_source(
    path: Path,
    frames: Sequence[npt.NDArray[np.uint8]],
    *,
    fps: str = "30",
    ts_offset: float = 0.0,
) -> None:
    """A lossless RGB picture source (PNG frames in Matroska: no YUV step on decode)."""
    height, width = frames[0].shape[:2]
    argv = [
        find_ffmpeg(),
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-s",
        f"{width}x{height}",
        "-r",
        fps,
        "-i",
        "-",
        "-c:v",
        "png",
        "-pix_fmt",
        "rgb24",
    ]
    if ts_offset:
        argv += ["-output_ts_offset", repr(ts_offset)]
    argv.append(str(path))
    payload = b"".join(np.ascontiguousarray(frame).tobytes() for frame in frames)
    subprocess.run(argv, input=payload, check=True, capture_output=True, timeout=60)


def write_vfr_source(
    path: Path, frames: Sequence[npt.NDArray[np.uint8]], pts_ms: Sequence[int]
) -> None:
    """A variable-frame-rate lossless RGB source: frame ``i`` is presented at ``pts_ms[i]``."""
    height, width = frames[0].shape[:2]
    expression = "+".join(f"eq(N\\,{i})*{value}" for i, value in enumerate(pts_ms))
    argv = [
        find_ffmpeg(),
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-s",
        f"{width}x{height}",
        "-r",
        "30",
        "-i",
        "-",
        "-vf",
        f"settb=1/1000,setpts={expression}",
        "-fps_mode",
        "passthrough",
        "-enc_time_base",
        "1/1000",
        "-c:v",
        "png",
        "-pix_fmt",
        "rgb24",
        str(path),
    ]
    payload = b"".join(np.ascontiguousarray(frame).tobytes() for frame in frames)
    subprocess.run(argv, input=payload, check=True, capture_output=True, timeout=60)
