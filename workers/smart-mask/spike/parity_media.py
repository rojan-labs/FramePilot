"""Parity clips: short segments of Sintel (Blender Foundation, CC-BY 3.0, durian.blender.org).

Fetched by HTTP range seeking with ffmpeg and stored losslessly (FFV1) in the git-ignored
cache, so a Windows maintainer machine (MO-9) reproduces the exact same frames. Decoding for
parity uses ffmpeg to raw RGB24 (not cv2.VideoCapture), matching the pack's decode rule.
"""

from __future__ import annotations

import shutil
import subprocess

import numpy as np

import common

SINTEL_URL = "https://download.blender.org/durian/movies/Sintel.2010.1080p.mkv"
LICENCE = "Sintel (c) Blender Foundation | durian.blender.org, CC-BY 3.0"

#: name -> (start, seconds, prompt points in source pixels, labels)
CLIPS = {
    "sintel_000240": ("00:02:40", 3, [[715.0, 470.0]], [1]),
    "sintel_000705": ("00:07:05", 3, [[880.0, 450.0], [1300.0, 250.0]], [1, 0]),
}


def ensure_clip(name: str) -> str:
    path = common.MEDIA / f"{name}.mkv"
    if not path.exists():
        if shutil.which("ffmpeg") is None:
            raise RuntimeError("ffmpeg is required to fetch parity media")
        common.MEDIA.mkdir(parents=True, exist_ok=True)
        start, secs, _, _ = CLIPS[name]
        subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-ss", start, "-i", SINTEL_URL, "-t", str(secs),
                        "-an", "-c:v", "ffv1", "-y", str(path)], check=True)
    return str(path)


def probe_size(path: str) -> tuple[int, int]:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                          "-of", "csv=p=0", path], check=True, capture_output=True, text=True).stdout.strip()
    w, h = out.split(",")[:2]
    return int(w), int(h)


def decode_rgb(path: str, max_frames: int) -> np.ndarray:
    """(T, H, W, 3) uint8, decoded by ffmpeg in source order."""
    w, h = probe_size(path)
    raw = subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-i", path, "-frames:v", str(max_frames),
                          "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], check=True, capture_output=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3)


def first_cut(frames: np.ndarray, ratio: float = 8.0, floor: float = 8.0) -> int:
    """Index of the first hard cut, or len(frames).

    A cut is a frame difference far above the clip's running median; a fixed threshold misses
    low-contrast cuts (snow to snow in Sintel 07:05 is a 30.6 jump over a ~1.3 baseline).
    """
    diffs: list[float] = []
    for i in range(1, len(frames)):
        d = float(np.abs(frames[i].astype(np.int16) - frames[i - 1].astype(np.int16)).mean())
        if diffs and d > max(floor, ratio * float(np.median(diffs))):
            return i
        diffs.append(d)
    return len(frames)
