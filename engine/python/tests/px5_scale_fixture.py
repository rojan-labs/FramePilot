"""Generate the PX5 "Scale row" fixture: a 3-minute 4K timeline with 4 layers + text + a matte.

The row is named in ``plan/background-removal-ai/PX0-INVENTORY.md`` and budgeted in
``09-PREVIEW-EXPORT-PARITY.md`` ("PX5 - performance evidence") and ``06`` ("Production
budgets": export with masks and 4K mattes <= 1.5x the same timeline without). Nothing here is
committed: everything is written once into a gitignored directory and reused::

    pnpm px5:fixture                 # == uv run python -m tests.px5_scale_fixture
    pnpm px5:fixture --seconds 20    # a short copy for a smoke run (a different cache key)

What it writes (``tests/e2e/.tmp-px5-scale/``):

* ``media/scale-{a,b,c,d}.mp4`` - 3840x2160, 30 fps, H.264 high, GOP 15, no B-frames, NO audio.
  Four DIFFERENT sources, because four layers of one source share a decoded picture and would
  understate the row. ``proxies/`` holds the same pictures at 540p, encoded with the arguments
  of ``media/derive.py`` (what the desktop monitor plays).
* ``.framepilot-derived/mattes/<key>/`` - a 4K matte artifact to the contract of
  ``render/mattes.py`` (intra-only FFV1 ``matte.mkv`` + ``foreground.mkv`` + ``frames.json``)
  covering every frame of ``scale-d``.
* ``projects/*.json`` - the Scale timeline and its A/B variants (see :func:`write_projects`).
* ``manifest.json`` - paths, sizes and the recipe hash the consumers check.

**Cheap on purpose.** A 4K encode is the cost, so each file encodes ONE 12-second period and
stream-copies it to length (``-stream_loop``, no re-encode). Decode cost per frame is that of
any 4K H.264 stream of this profile, which is what the row measures; the pictures repeating
every 12 s is irrelevant to a decoder. The matte does the same with a disc whose motion has a
12-second period. ONE ffmpeg runs at a time (this machine has been taken down by parallel 4K
jobs before).

**Honest limit.** Synthetic ``testsrc2`` compresses far better than camera footage: these 4K
files are tens of megabytes, not gigabytes. Hardware decode time is nearly independent of
bitrate; a software decoder (CI's) is not. The numbers say which they are.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import math
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

_log = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_OUT_DIR = REPO_ROOT / "tests" / "e2e" / ".tmp-px5-scale"
#: Bumped when the recipe changes in a way the arguments below do not show.
RECIPE_VERSION = 1

WIDTH, HEIGHT = 3840, 2160
PROXY_HEIGHT = 540
FPS = 30
PERIOD_SECONDS = 12
DEFAULT_SECONDS = 180
GOP = FPS // 2
SOURCES = ("a", "b", "c", "d")
MATTE_SOURCE = "d"
#: A subject-like foreground estimate: any colour that is not the picture makes
#: decontamination do work.
FOREGROUND_RGB = (96, 200, 160)
VERTICES = 200

#: Each source is `testsrc2` with its own hue rotation, so the four layers are told apart by eye.
_HUES = {"a": 0, "b": 90, "c": 180, "d": 270}


def _run(argv: list[str], **kwargs: Any) -> None:
    result = subprocess.run(argv, capture_output=True, check=False, **kwargs)
    if result.returncode != 0:
        tail = result.stderr.decode(errors="replace")[-600:]
        raise RuntimeError(f"{Path(argv[0]).name} failed ({result.returncode}): {tail}")


def _recipe_hash(seconds: int) -> str:
    payload = json.dumps(
        [RECIPE_VERSION, WIDTH, HEIGHT, PROXY_HEIGHT, FPS, PERIOD_SECONDS, GOP, seconds, _HUES],
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode()).hexdigest()


def _x264_args() -> list[str]:
    """``media/derive.py``'s proxy arguments, bit-exact flags added so a rebuild is identical."""
    return [
        "-c:v",
        "libx264",
        "-profile:v",
        "high",
        "-pix_fmt",
        "yuv420p",
        "-preset",
        "veryfast",
        "-crf",
        "28",
        "-g",
        str(GOP),
        "-keyint_min",
        str(GOP),
        "-sc_threshold",
        "0",
        "-flags",
        "+cgop",
        "-bf",
        "0",
        "-colorspace",
        "bt709",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-color_range",
        "tv",
        "-an",
        "-map_metadata",
        "-1",
        "-fflags",
        "+bitexact",
        "-flags:v",
        "+bitexact",
        "-movflags",
        "+faststart",
    ]


def _loop_copy(ffmpeg: str, period: Path, out: Path, seconds: int, extra: list[str]) -> None:
    """Stream-copy ``period`` end to end until it is ``seconds`` long (no re-encode)."""
    loops = math.ceil(seconds / PERIOD_SECONDS) - 1
    _run(
        [
            ffmpeg,
            "-y",
            "-loglevel",
            "error",
            "-stream_loop",
            str(loops),
            "-i",
            str(period),
            "-c",
            "copy",
            "-t",
            str(seconds),
            "-map_metadata",
            "-1",
            "-fflags",
            "+bitexact",
            *extra,
            str(out),
        ]
    )


def encode_source(ffmpeg: str, out_dir: Path, name: str, seconds: int) -> None:
    """One 4K source and its 540p proxy (same pictures, scaled)."""
    period_seconds = min(PERIOD_SECONDS, seconds)
    for rel, height in (
        (f"media/scale-{name}.mp4", HEIGHT),
        (f"proxies/scale-{name}.mp4", PROXY_HEIGHT),
    ):
        out = out_dir / rel
        if out.exists():
            continue
        out.parent.mkdir(parents=True, exist_ok=True)
        width = round(WIDTH * height / HEIGHT / 2) * 2
        period = out.with_suffix(".period.mp4")
        graph = (
            f"testsrc2=s={width}x{height}:r={FPS}:d={period_seconds},hue=h={_HUES[name]},"
            "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p"
        )
        started = time.monotonic()
        _run(
            [
                ffmpeg,
                "-y",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                graph,
                *_x264_args(),
                str(period),
            ]
        )
        partial = out.with_suffix(".partial.mp4")
        _loop_copy(ffmpeg, period, partial, seconds, ["-movflags", "+faststart"])
        period.unlink()
        partial.rename(out)
        _log.info(
            "%s: %.1f MB in %.0f s", rel, out.stat().st_size / 1e6, time.monotonic() - started
        )


def _matte_frames(count: int) -> Any:
    """``count`` 4K matte frames: a soft-edged disc whose sweep has a PERIOD_SECONDS period."""
    import numpy as np

    radius, soft = 620, 24
    size = 2 * (radius + soft) + 2
    y, x = np.mgrid[0:size, 0:size].astype(np.float64)
    distance = np.hypot(x - size / 2, y - size / 2)
    patch = np.round(np.clip((radius + soft - distance) / soft, 0.0, 1.0) * 255).astype(np.uint8)
    for index in range(count):
        phase = 2 * math.pi * index / (PERIOD_SECONDS * FPS)
        left = int(WIDTH / 2 + 900 * math.sin(phase)) - size // 2
        top = int(HEIGHT / 2 + 300 * math.sin(2 * phase)) - size // 2
        frame = np.zeros((HEIGHT, WIDTH), dtype=np.uint8)
        frame[top : top + size, left : left + size] = patch
        yield frame


def _ffv1_args() -> list[str]:
    """The pack's encode (``encode.py``): intra-only FFV1 level 3 with slice CRCs."""
    return [
        "-c:v",
        "ffv1",
        "-level",
        "3",
        "-g",
        "1",
        "-slicecrc",
        "1",
        "-an",
        "-map_metadata",
        "-1",
        "-fflags",
        "+bitexact",
        "-flags:v",
        "+bitexact",
    ]


def write_matte(ffmpeg: str, out_dir: Path, seconds: int) -> dict[str, Any]:
    """The 4K matte artifact for ``scale-d``; returns the fields a mask pins."""
    from framepilot_engine.render.mattes import (
        FOREGROUND_FILE,
        FRAMES_FILE,
        MATTE_FILE,
        MATTES_DIR,
        file_sha256,
    )
    from framepilot_engine.render.pts_reader import video_timing

    key = hashlib.sha256(f"px5-scale-matte:{_recipe_hash(seconds)}".encode()).hexdigest()
    directory = out_dir / MATTES_DIR / key
    directory.mkdir(parents=True, exist_ok=True)
    period_seconds = min(PERIOD_SECONDS, seconds)
    period_frames = period_seconds * FPS

    matte = directory / MATTE_FILE
    if not matte.exists():
        started = time.monotonic()
        period = directory / "matte.period.mkv"
        process = subprocess.Popen(
            [
                ffmpeg,
                "-nostdin",
                "-v",
                "error",
                "-y",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "gray",
                "-s",
                f"{WIDTH}x{HEIGHT}",
                "-r",
                str(FPS),
                "-i",
                "-",
                *_ffv1_args(),
                "-pix_fmt",
                "gray",
                str(period),
            ],
            stdin=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        assert process.stdin is not None and process.stderr is not None
        for frame in _matte_frames(period_frames):
            process.stdin.write(frame.tobytes())
        process.stdin.close()
        stderr = process.stderr.read()
        if process.wait(timeout=600) != 0:
            raise RuntimeError(
                f"ffv1 matte encode failed: {stderr.decode(errors='replace')[-400:]}"
            )
        partial = directory / "matte.partial.mkv"
        _loop_copy(ffmpeg, period, partial, seconds, [])
        period.unlink()
        partial.rename(matte)
        _log.info(
            "matte.mkv: %.1f MB in %.0f s", matte.stat().st_size / 1e6, time.monotonic() - started
        )

    foreground = directory / FOREGROUND_FILE
    if not foreground.exists():
        started = time.monotonic()
        period = directory / "foreground.period.mkv"
        colour = "0x{:02x}{:02x}{:02x}".format(*FOREGROUND_RGB)
        _run(
            [
                ffmpeg,
                "-y",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                f"color=c={colour}:s={WIDTH}x{HEIGHT}:r={FPS}:d={period_seconds},format=rgb24",
                *_ffv1_args(),
                "-pix_fmt",
                "bgr0",
                str(period),
            ]
        )
        partial = directory / "foreground.partial.mkv"
        _loop_copy(ffmpeg, period, partial, seconds, [])
        period.unlink()
        partial.rename(foreground)
        _log.info(
            "foreground.mkv: %.1f MB in %.0f s",
            foreground.stat().st_size / 1e6,
            time.monotonic() - started,
        )

    timing = video_timing(out_dir / "media" / f"scale-{MATTE_SOURCE}.mp4")
    (directory / FRAMES_FILE).write_text(
        json.dumps(
            {
                "version": 1,
                "timeBase": [timing.time_base.numerator, timing.time_base.denominator],
                "originPts": timing.pts[0],
                "firstFrame": 0,
                "pts": list(timing.pts),
            }
        ),
        encoding="utf-8",
    )
    relative = timing.relative_seconds()
    return {
        "key": key,
        "files": [
            {"name": name, "sha256": file_sha256(directory / name)}
            for name in (MATTE_FILE, FOREGROUND_FILE, FRAMES_FILE)
        ],
        "width": WIDTH,
        "height": HEIGHT,
        "coverage": {"sourceStart": relative[0], "sourceEnd": relative[-1] + 1.0 / FPS},
        "packId": "framepilot.smart-mask",
        "packVersion": "1.0.0",
        "modelDigests": [],
    }


def _outline(radius: float, phase: float) -> list[float]:
    """A closed 200-vertex outline of real cubics in 4K source pixels (x, y, in, out)."""
    points: list[float] = []
    for vertex in range(VERTICES):
        angle = vertex / VERTICES * math.pi * 2
        wobble = 1 + 0.08 * math.sin(angle * 9 + phase)
        x = WIDTH / 2 + radius * 1.4 * wobble * math.cos(angle)
        y = HEIGHT / 2 + radius * wobble * math.sin(angle)
        tx, ty = -math.sin(angle) * 12, math.cos(angle) * 12
        points += [x, y, -tx, -ty, tx, ty]
    return points


def _clip(name: str, seconds: int, **extra: Any) -> dict[str, Any]:
    return {
        "id": f"clip-{name}",
        "assetId": f"scale-{name}",
        "trackId": f"v-{name}",
        "start": 0.0,
        "end": float(seconds),
        "sourceStart": 0.0,
        "sourceEnd": float(seconds),
        "effects": [],
        "keyframes": [],
        **extra,
    }


def _inset(prefix: str, scale: float, x: float, y: float) -> list[dict[str, Any]]:
    return [
        {"id": f"{prefix}-s", "property": "scale", "time": 0.0, "value": scale},
        {"id": f"{prefix}-x", "property": "x", "time": 0.0, "value": x},
        {"id": f"{prefix}-y", "property": "y", "time": 0.0, "value": y},
    ]


def scale_project(seconds: int, artifact: dict[str, Any], variant: str) -> dict[str, Any]:
    """The Scale timeline. Back to front: a, b (inset, graded), c (inset), d (matted), text.

    Variants (each differs from ``scale`` by exactly one thing, so an A/B isolates it):

    * ``scale`` - the row: 4 picture layers + text + the 4K matte on the top layer.
    * ``scale-plain`` - the same timeline with NO masks: the export budget's "without".
    * ``scale-path`` - plus an animated, feathered 200-vertex path on layer b.
    * ``scale-key`` - plus a key mask with the whole finesse chain on layer c.
    * ``scale-key-nofinesse`` - the same key with finesse at its defaults (the chain's cost).
    """
    matte = {
        "id": "subject",
        "kind": "matte",
        "artifact": artifact,
        "edgeMode": "sharp",
        "decontaminate": True,
    }
    path = {
        "id": "roto",
        "kind": "path",
        "featherInnerPx": 8,
        "featherOuterPx": 24,
        "pathKeyframes": [
            {
                "id": "k0",
                "sourceTime": 0.0,
                "points": _outline(700, 0.0),
                "vertexTypes": [1] * VERTICES,
            },
            {
                "id": "k1",
                "sourceTime": float(seconds),
                "points": _outline(900, 2.0),
                "vertexTypes": [1] * VERTICES,
            },
        ],
    }
    key: dict[str, Any] = {
        "id": "key",
        "kind": "key",
        "model": "hsl",
        "ranges": [
            {"channel": "hue", "low": 0.2, "high": 0.5, "softness": 0.1},
            {"channel": "saturation", "low": 0.2, "high": 1.0, "softness": 0.2},
        ],
        "despill": "green",
    }
    if variant == "scale-key":
        key["finesse"] = {
            "denoise": 0.5,
            "morphOpenPx": 6,
            "morphClosePx": 6,
            "shrinkGrowPx": -2,
            "blurPx": 4,
            "inOutRatio": 0.2,
            "cleanBlack": 0.1,
            "cleanWhite": 0.9,
        }
    grade = {"id": "grade", "type": "color_grade", "params": {"exposure": -0.5, "saturation": 1.2}}
    clips = {
        "a": _clip("a", seconds),
        "b": _clip("b", seconds, effects=[grade], keyframes=_inset("b", 0.5, -900.0, -500.0)),
        "c": _clip("c", seconds, keyframes=_inset("c", 0.5, 900.0, -500.0)),
        "d": _clip("d", seconds),
    }
    if variant != "scale-plain":
        clips["d"]["masks"] = [matte]
    if variant == "scale-path":
        clips["b"]["masks"] = [path]
    if variant in ("scale-key", "scale-key-nofinesse"):
        clips["c"]["masks"] = [key]
    text = {
        "id": "title",
        "assetId": "__text__",
        "trackId": "words",
        "start": 0.0,
        "end": float(seconds),
        "sourceStart": 0.0,
        "sourceEnd": float(seconds),
        "effects": [{"id": "tx", "type": "text", "params": {"text": "SCALE ROW"}, "keyframes": []}],
        "keyframes": [],
    }
    # Track order is front to back, as in the frame-plan fixtures (first track draws on top).
    tracks = [
        {"id": "words", "type": "overlay", "clips": [text]},
        *({"id": f"v-{n}", "type": "video", "clips": [clips[n]]} for n in reversed(SOURCES)),
    ]
    return {
        "id": f"fp-px5-{variant}",
        "name": f"px5-{variant}",
        "version": 1,
        "fps": FPS,
        "resolution": {"width": WIDTH, "height": HEIGHT},
        "assets": [
            {
                "id": f"scale-{n}",
                "path": f"media/scale-{n}.mp4",
                "kind": "video",
                "media": {"width": WIDTH, "height": HEIGHT, "proxyPath": f"proxies/scale-{n}.mp4"},
                "durationSeconds": float(seconds),
            }
            for n in SOURCES
        ],
        "timeline": {"tracks": tracks},
        "transcript": [],
    }


VARIANTS = ("scale", "scale-plain", "scale-path", "scale-key", "scale-key-nofinesse")


def write_projects(out_dir: Path, seconds: int, artifact: dict[str, Any]) -> list[str]:
    directory = out_dir / "projects"
    directory.mkdir(parents=True, exist_ok=True)
    for variant in VARIANTS:
        (directory / f"{variant}.json").write_text(
            json.dumps(scale_project(seconds, artifact, variant)), encoding="utf-8"
        )
    return [f"projects/{variant}.json" for variant in VARIANTS]


def generate(out_dir: Path, seconds: int) -> dict[str, Any]:
    from framepilot_engine.media.ffmpeg import find_ffmpeg
    from framepilot_engine.render.mattes import MATTES_DIR

    ffmpeg = find_ffmpeg()
    recipe = _recipe_hash(seconds)
    manifest_path = out_dir / "manifest.json"
    if manifest_path.exists():
        previous = json.loads(manifest_path.read_text(encoding="utf-8"))
        if previous.get("recipe") != recipe:
            _log.info("recipe changed; regenerating %s", out_dir)
            shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    for name in SOURCES:
        encode_source(ffmpeg, out_dir, name, seconds)
    artifact = write_matte(ffmpeg, out_dir, seconds)
    projects = write_projects(out_dir, seconds, artifact)
    files = sorted(p for p in out_dir.rglob("*") if p.is_file() and p.name != "manifest.json")
    manifest = {
        "recipe": recipe,
        "seconds": seconds,
        "fps": FPS,
        "resolution": [WIDTH, HEIGHT],
        "matte": {"key": artifact["key"], "root": MATTES_DIR},
        "projects": projects,
        "bytes": {str(p.relative_to(out_dir)): p.stat().st_size for p in files},
    }
    manifest_path.write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument("--seconds", type=int, default=DEFAULT_SECONDS)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    if args.seconds < 1:
        parser.error("--seconds must be at least 1")
    manifest = generate(args.out, args.seconds)
    total = sum(manifest["bytes"].values())
    _log.info(
        "PX5 Scale fixture: %d files, %.1f MB in %s", len(manifest["bytes"]), total / 1e6, args.out
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
