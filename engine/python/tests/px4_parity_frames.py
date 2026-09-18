"""Generate the ENGINE side of the preview/export pixel parity oracle (PX4.2, PX0.3).

The oracle (``tests/e2e/specs/preview-parity-oracle.spec.ts``) seeks the editor's preview to
every sample time of every frame-plan matrix case (``tests/fixtures/frame-plan/*.json``), reads
its canvas back, and compares it with the frame the export composites at the same time. This
script writes everything the spec reads, into a gitignored directory::

    pnpm px4:frames            # == cd engine/python && uv run python -m tests.px4_parity_frames

1. **Synthetic media**, one file per fixture asset, at the asset's declared size, duration and
   probed frame rate, encoded exactly like the engine's preview proxies (``media/derive.py``:
   H.264 high, yuv420p, BT.709 tags, GOP = fps/2, no B-frames). BOTH sides read these same
   bytes, so codec loss is identical and every difference the oracle reports is the
   renderer's. Each asset is a flat **sentinel colour** with a second sentinel colour in its
   top-right quadrant (orientation and crop become visible) and a binary frame counter along
   the top-left edge (a wrong source frame changes pixels, not just a reported number).
2. **Engine frames**: ``grab_frame(..., lossless=True)`` (full resolution PNG through
   ``compile_timeline``, the export path) at every sample of every case.
3. **Colour test patterns** (PX0.3): one clip per BT.601/BT.709 x limited/full range, and the
   engine's decoded RGB for each patch.
4. ``manifest.json``: the sentinel palette, per-sample frame paths (or the engine's error),
   the colour measurements, and a hash of the inputs so the spec refuses stale output.

**Memory bounds (read before running this locally).** A full run once took a maintainer's
machine past 70 GB: a multi-worker pool, each worker holding compositions with an ffmpeg reader
per clip, next to a local Chromium. So: one worker by default (``--workers``), a fresh process
per case (``max_tasks_per_child=1``), the composition cache cleared after every frame, and an
optional ``--max-rss-mb`` watchdog that kills the workers and exits 2. The full matrix runs in
CI only (the ``preview-parity-oracle`` job). Locally, render ONE case to debug ONE failure::

    pnpm px4:frames --case layering/layers-2 --max-rss-mb 4000

Colours are chosen on a 96-level grid so any two sentinels differ by at least 96/255 on some
channel: the spec classifies pixels within 40/255 of a sentinel, and a sentinel check must
never confuse two layers because of codec or colour-matrix drift.
"""

from __future__ import annotations

import argparse
import contextlib
import copy
import hashlib
import json
import logging
import math
import multiprocessing
import os
import platform
import signal
import struct
import subprocess
import sys
import threading
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any

from tests.matte_fixtures import frame_pts_expression

_log = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURE_DIR = REPO_ROOT / "tests" / "fixtures" / "frame-plan"
DEFAULT_OUT_DIR = REPO_ROOT / "tests" / "e2e" / ".tmp-px4-parity"
#: Bumped when the output layout changes in a way the input hash cannot see.
MANIFEST_VERSION = 3
#: The program monitor's canvas long edge (`CANVAS_MAX_EDGE` in `WebCodecsPreviewPlayer.tsx`).
#: The preview may be lower resolution than the project; the oracle compares at the preview's
#: size by having the export's compositor run at that size, never by rescaling either image.
PREVIEW_CANVAS_MAX_EDGE = 1280

#: (primary, top-right quadrant) sentinel colours per fixture asset id. Grid levels 44/140/236.
SENTINELS: dict[str, tuple[tuple[int, int, int], tuple[int, int, int]]] = {
    "land": ((236, 44, 44), (140, 44, 44)),
    "port": ((44, 236, 44), (44, 140, 44)),
    "square": ((44, 44, 236), (44, 44, 140)),
    "cine": ((236, 236, 44), (140, 140, 44)),
    "four3": ((236, 44, 236), (140, 44, 140)),
    "orig": ((44, 236, 236), (44, 140, 140)),
    "land24": ((236, 140, 44), (140, 236, 44)),
    "png": ((140, 44, 236), (44, 140, 236)),
    "anam": ((140, 140, 236), (140, 236, 140)),
    "phone": ((236, 140, 140), (140, 140, 140)),
    "vfr": ((140, 236, 236), (236, 236, 140)),
    "anamrot": ((236, 44, 140), (44, 236, 140)),
}
#: Bits of the frame counter. 12 bits index 4096 frames: a 60 s asset at 30 fps is 1800.
COUNTER_BITS = 12
#: Transparent border of the PNG asset, as a fraction of its short edge ("PNG with alpha").
PNG_ALPHA_BORDER = 0.08

#: PX0.3 test-pattern patches, row-major on a 4x3 grid: 75% bars, extremes, a skin tone, greys.
COLOUR_PATCHES: list[tuple[str, tuple[int, int, int]]] = [
    ("white75", (191, 191, 191)),
    ("yellow75", (191, 191, 0)),
    ("cyan75", (0, 191, 191)),
    ("green75", (0, 191, 0)),
    ("magenta75", (191, 0, 191)),
    ("red75", (191, 0, 0)),
    ("blue75", (0, 0, 191)),
    ("red100", (255, 0, 0)),
    ("grey50", (128, 128, 128)),
    ("skin", (224, 172, 140)),
    ("nearBlack", (16, 16, 16)),
    ("nearWhite", (235, 235, 235)),
]
COLOUR_GRID = (4, 3)
COLOUR_SIZE = (1280, 720)
COLOUR_SAMPLE_TIME = 1.0
#: The four encodings PX0.3 measures: (id, ffmpeg matrix, ffmpeg range, colour tag).
COLOUR_ENCODINGS: list[tuple[str, str, str, str]] = [
    ("bt601-limited", "bt601", "tv", "smpte170m"),
    ("bt601-full", "bt601", "pc", "smpte170m"),
    ("bt709-limited", "bt709", "tv", "bt709"),
    ("bt709-full", "bt709", "pc", "bt709"),
]


@dataclass(frozen=True)
class VideoSpec:
    """One synthetic video asset to encode."""

    rel_path: str
    width: int
    height: int
    fps: float
    seconds: float
    primary: tuple[int, int, int]
    secondary: tuple[int, int, int]
    #: Sample (pixel) aspect ratio written into the stream; 1 = square pixels.
    pixel_aspect_ratio: float = 1.0
    #: Clockwise display rotation written into the track matrix (``Asset.media.rotation``).
    rotation: int = 0
    #: Variable frame rate: each frame's pts in milliseconds (``probe.frameTimes``); empty = CFR.
    frame_times_ms: tuple[int, ...] = ()
    #: PX5.6: every frame is :func:`key_picture` (through a lossless PNG) instead of a sentinel.
    key_picture: bool = False
    #: MK8.4: every frame is :func:`luma_picture` (through a lossless PNG) instead of a sentinel.
    luma_picture: bool = False


def export_host_hints() -> dict[str, str]:
    """This engine's platform in the browser's client-hint vocabulary (MK6.4).

    The preview draws a same-size decode with the unscaled converter the export host's ffmpeg
    runs (`apps/web-editor/src/preview/engine/raster/sws-host.ts`). The desktop reads that from
    its own client hints; the oracle's browser reports a spoofed device, so the harness hands the
    page the platform these frames were rendered on instead.
    """
    system = platform.system()
    machine = platform.machine().lower()
    return {
        "platform": {"Darwin": "macOS", "Windows": "Windows", "Linux": "Linux"}.get(system, system),
        "architecture": "arm" if machine in ("arm64", "aarch64") else "x86",
    }


def input_hash() -> str:
    """Hash of the inputs the spec can see: the manifest version and every fixture.

    Not this script: iterating on it would invalidate a 10-minute render for a comment. A change
    here that alters the output bumps :data:`MANIFEST_VERSION` (and the spec's copy of it).
    """
    digest = hashlib.sha256()
    digest.update(f"v{MANIFEST_VERSION}".encode())
    for path in sorted(FIXTURE_DIR.glob("*.json")):
        digest.update(path.name.encode("utf-8"))
        digest.update(path.read_bytes())
    return digest.hexdigest()


def load_cases() -> list[tuple[str, dict[str, Any]]]:
    """Every matrix case as ``(area, case)``, in a stable order, media paths made distinct."""
    cases: list[tuple[str, dict[str, Any]]] = []
    for path in sorted(FIXTURE_DIR.glob("*.json")):
        document = json.loads(path.read_text(encoding="utf-8"))
        cases.extend((path.stem, case) for case in document["cases"])
    _separate_media_variants(cases)
    return cases


def _video_facts(case: dict[str, Any], asset: dict[str, Any]) -> tuple[float, ...]:
    media = asset.get("media") or {}
    return (
        float(media.get("width") or 0),
        float(media.get("height") or 0),
        float(case["probe"]["fps"].get(asset["id"], 0)),
        float(asset.get("durationSeconds") or 10.0),
        float(media.get("pixelAspectRatio") or 1.0),
        float(media.get("rotation") or 0),
    )


def _separate_media_variants(cases: list[tuple[str, dict[str, Any]]]) -> None:
    """Point a case at its own file when it describes a shared path with different facts.

    Cases are written independently, so two may name ``proxies/land.mp4`` at different frame
    rates or durations. Each distinct set of facts gets its own synthetic file
    (``proxies/land.2.mp4``, in encounter order). Mirrored by ``separateMediaVariants`` in
    ``preview-parity-oracle.spec.ts``: both sides must read the same bytes.
    """
    variants: dict[str, list[tuple[float, ...]]] = {}
    for _area, case in cases:
        for asset in case["project"]["assets"]:
            if asset["kind"] != "video":
                continue
            rel = engine_asset_path(asset)
            facts = _video_facts(case, asset)
            known = variants.setdefault(rel, [])
            if facts not in known:
                known.append(facts)
            index = known.index(facts)
            if index == 0:
                continue
            stem, dot, suffix = rel.rpartition(".")
            variant = f"{stem}.{index + 1}.{suffix}" if dot else f"{rel}.{index + 1}"
            media = asset.get("media") or {}
            if media.get("proxyPath"):
                media["proxyPath"] = variant
            else:
                asset["path"] = variant


def engine_asset_path(asset: dict[str, Any]) -> str:
    """The file both sides read: the proxy when the asset has one, else the original."""
    media = asset.get("media") or {}
    proxy = media.get("proxyPath")
    return str(proxy) if proxy else str(asset["path"])


def _hex(colour: tuple[int, int, int]) -> str:
    return "0x{:02X}{:02X}{:02X}".format(*colour)


def _run(args: list[str]) -> None:
    result = subprocess.run(args, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(
            f"ffmpeg failed ({result.returncode}): {' '.join(args)}\n{result.stderr}"
        )


def _even(value: int) -> int:
    return max(2, value - value % 2)


def _sar(pixel_aspect_ratio: float) -> str:
    fraction = Fraction(pixel_aspect_ratio).limit_denominator(1000)
    return f"{fraction.numerator}/{fraction.denominator}"


#: ISO BMFF ``tkhd`` display matrices (16.16 / 2.30) for a CLOCKWISE display rotation, as
#: ffprobe reads them back (its ``rotation`` is counter-clockwise: -90 for a clockwise turn).
_TKHD_MATRICES: dict[int, tuple[int, ...]] = {
    90: (0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x40000000),
    180: (-0x10000, 0, 0, 0, -0x10000, 0, 0, 0, 0x40000000),
    270: (0, -0x10000, 0, 0x10000, 0, 0, 0, 0, 0x40000000),
}


def set_display_rotation(path: Path, clockwise: int) -> None:
    """Write a display rotation into the (single) video track's ``tkhd`` matrix.

    Written into the container directly rather than through an ffmpeg option, whose name and
    availability differ between the ffmpeg versions CI and workstations run.
    """
    matrix = _TKHD_MATRICES.get(clockwise % 360)
    if matrix is None:
        return
    data = bytearray(path.read_bytes())
    index = data.find(b"tkhd")
    while index != -1:
        version = data[index + 4]
        # version/flags, times, track id, reserved, duration, reserved(8), layer, group, volume,
        # reserved(2), then the 36-byte matrix.
        offset = index + 4 + 4 + (28 if version == 1 else 20) + 8 + 2 + 2 + 2 + 2
        width, height = struct.unpack(">II", data[offset + 36 : offset + 44])
        if width and height:
            data[offset : offset + 36] = struct.pack(">9i", *matrix)
            path.write_bytes(bytes(data))
            return
        index = data.find(b"tkhd", index + 4)


def encode_video(ffmpeg: str, out_dir: Path, spec: VideoSpec) -> None:
    """Encode one sentinel asset the way ``media/derive.py`` encodes a preview proxy."""
    out = out_dir / spec.rel_path
    out.parent.mkdir(parents=True, exist_ok=True)
    block = _even(min(spec.width, spec.height) // 36)
    counter = [
        f"drawbox=x=0:y=0:w={block * COUNTER_BITS}:h={block}:color=black:t=fill",
        *(
            f"drawbox=x={bit * block}:y=0:w={block}:h={block}:color=white:t=fill"
            f":enable='mod(floor(n/{2**bit})\\,2)'"
            for bit in range(COUNTER_BITS)
        ),
    ]
    variable = len(spec.frame_times_ms) > 0
    frames_seconds = len(spec.frame_times_ms) / spec.fps if variable else spec.seconds
    # A VFR source: one frame per listed pts, restamped in a millisecond time base.
    restamp = (
        [
            "settb=1/1000",
            "setpts=" + frame_pts_expression(spec.frame_times_ms),
        ]
        if variable
        else []
    )
    if spec.key_picture or spec.luma_picture:
        # PX5.6 / MK8.4: the numpy still through a lossless PNG (never a lavfi test source).
        still = out.with_suffix(".source.png")
        if spec.luma_picture:
            write_luma_picture(still, spec.width, spec.height)
        else:
            write_key_picture(still, spec.width, spec.height)
        source = [
            f"movie={still}:loop=0,setpts=N/({spec.fps:g}*TB),fps={spec.fps:g}",
            f"trim=duration={frames_seconds:g}",
            "format=rgb24",
        ]
    else:
        source = [
            f"color=c={_hex(spec.primary)}:s={spec.width}x{spec.height}:r={spec.fps:g}"
            f":d={frames_seconds:g}",
            "format=rgb24",
            f"drawbox=x=iw/2:y=0:w=iw/2:h=ih/2:color={_hex(spec.secondary)}:t=fill",
        ]
    graph = ",".join(
        [
            *source,
            *counter,
            "scale=out_color_matrix=bt709:out_range=tv",
            "format=yuv420p",
            *(
                [f"setsar={_sar(spec.pixel_aspect_ratio)}"]
                if spec.pixel_aspect_ratio != 1.0
                else []
            ),
            *restamp,
        ]
    )
    keyframe_interval = str(max(1, round(spec.fps) // 2))
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
            "-f",
            "lavfi",
            "-i",
            f"anullsrc=r=48000:cl=stereo:d={spec.seconds:g}",
            "-map",
            "0:v",
            "-map",
            "1:a",
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
            keyframe_interval,
            "-keyint_min",
            keyframe_interval,
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
            *(
                [
                    "-fps_mode",
                    "passthrough",
                    "-enc_time_base",
                    "1/1000",
                    "-video_track_timescale",
                    "1000",
                ]
                if variable
                else []
            ),
            "-movflags",
            "+faststart",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-t",
            f"{spec.seconds:g}",
            str(out),
        ]
    )
    if spec.rotation:
        set_display_rotation(out, spec.rotation)


def write_png_asset(out_dir: Path, rel_path: str, width: int, height: int) -> None:
    """The still asset: sentinel fill, secondary top-right quadrant, a fully transparent border."""
    from PIL import Image, ImageDraw

    primary, secondary = SENTINELS["png"]
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    border = round(min(width, height) * PNG_ALPHA_BORDER)
    draw.rectangle((border, border, width - border - 1, height - border - 1), fill=(*primary, 255))
    draw.rectangle(
        (width // 2, border, width - border - 1, height // 2 - 1), fill=(*secondary, 255)
    )
    target = out_dir / rel_path
    target.parent.mkdir(parents=True, exist_ok=True)
    image.save(target, format="PNG")


#: PX5.6: the image asset the ``key`` rows qualify. Not a sentinel: a key needs colour to read.
KEY_PICTURE_ASSET = "keyed"
#: Every pixel of the key picture has this blue, 48 levels from every sentinel level (44, 140,
#: 236), so no pixel of it can be classified as a sentinel however red and green vary.
KEY_PICTURE_BLUE = 92


def key_picture(width: int, height: int) -> Any:
    """The ``key`` rows' still (PX5.6): numpy, deterministic, stored as a lossless PNG.

    A green backdrop (brighter to the right, redder downwards) behind a warm subject ellipse
    with a 24 px smoothstep edge, so the key has a soft band to qualify; one-pixel holes in the
    subject every 48 px (``morphClosePx``) and 3x3 specks of subject colour in the backdrop
    every 64 px (``denoise``, ``morphOpenPx``); and a bottom stripe sweeping green to red, so
    the hue and saturation softness ramps are crossed at every level. Blue is constant
    (:data:`KEY_PICTURE_BLUE`).
    """
    import numpy as np

    y, x = np.mgrid[0:height, 0:width].astype(np.float64)
    u, v = x / width, y / height
    blue = np.full_like(u, float(KEY_PICTURE_BLUE))
    backdrop = np.stack([10 + 30 * v, 150 + 80 * u, blue], axis=-1)
    subject = np.stack([170 + 40 * u, 70 + 60 * v, blue], axis=-1)
    radius = np.hypot((x - width * 0.44) / (width * 0.24), (y - height * 0.5) / (height * 0.36))
    edge = np.clip((1.0 - radius) * min(width, height) * 0.36 / 24.0 + 0.5, 0.0, 1.0)
    edge = edge * edge * (3.0 - 2.0 * edge)
    column, row = x.astype(np.int64), y.astype(np.int64)
    holes = (column % 48 < 2) & (row % 48 < 2) & (radius < 0.8)
    specks = (column % 64 >= 30) & (column % 64 < 33) & (row % 64 >= 30) & (row % 64 < 33)
    edge = np.where(holes, 0.0, np.where(specks & (radius > 1.2), 1.0, edge))
    picture = backdrop + (subject - backdrop) * edge[:, :, None]
    sweep = np.stack([20 + 200 * u, 220 - 200 * u, blue], axis=-1)
    picture = np.where((y >= height * 0.86)[:, :, None], sweep, picture)
    return np.clip(np.rint(picture), 0, 255).astype(np.uint8)


def write_key_picture(target: Path, width: int, height: int) -> None:
    """:func:`key_picture` as a lossless RGB PNG, the still the key asset's video is encoded from.

    The export ignores masks on image clips, so the key rows read a VIDEO made of this still,
    encoded like every other asset: both sides decode the same H.264 bytes (the monitor with
    the engine's own swscale), so the key is judged on the pixels it qualifies, not on codecs.
    """
    from PIL import Image

    target.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(key_picture(width, height), mode="RGB").save(target, format="PNG")


#: MK8.4: the grey picture the ``layer-*`` rows read as a LUMA track matte. Never visible itself:
#: the frame plan marks its clip ``matteOnly``, so both renderers draw it only as a matte.
LUMA_PICTURE_ASSET = "lumaramp"


def luma_picture(width: int, height: int) -> Any:
    """The luma track matte's still (MK8.4): numpy, deterministic, stored as a lossless PNG.

    A left-to-right grey ramp (black to white), a bright soft disc on the upper right and two
    black bars on the lower left, so a luma matte crosses every level, a smooth edge and two
    hard ones. Grey (R = G = B), so its luma is its level whatever the coefficients' rounding.
    """
    import numpy as np

    y, x = np.mgrid[0:height, 0:width].astype(np.float64)
    level = 255.0 * x / max(width - 1, 1)
    radius = np.hypot((x - width * 0.72) / (width * 0.14), (y - height * 0.32) / (height * 0.22))
    disc = np.clip((1.0 - radius) * 3.0, 0.0, 1.0)
    level = level + (255.0 - level) * disc
    bars = (y > height * 0.62) & (
        ((x > width * 0.1) & (x < width * 0.16)) | ((x > width * 0.24) & (x < width * 0.3))
    )
    level = np.where(bars, 0.0, level)
    grey = np.clip(np.rint(level), 0, 255).astype(np.uint8)
    return np.repeat(grey[:, :, None], 3, axis=2)


def write_luma_picture(target: Path, width: int, height: int) -> None:
    """:func:`luma_picture` as a lossless RGB PNG, the still the luma asset's video is made from."""
    from PIL import Image

    target.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(luma_picture(width, height), mode="RGB").save(target, format="PNG")


def write_audio_asset(ffmpeg: str, out_dir: Path, rel_path: str, seconds: float) -> None:
    """A silent WAV: audio assets draw nothing, they only have to exist."""
    target = out_dir / rel_path
    target.parent.mkdir(parents=True, exist_ok=True)
    _run(
        [
            ffmpeg,
            "-y",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"anullsrc=r=48000:cl=stereo:d={seconds:g}",
            "-c:a",
            "pcm_s16le",
            str(target),
        ]
    )


def write_lut(out_dir: Path, rel_path: str) -> None:
    """A deterministic 17^3 ``.cube``: a gentle warm S-curve, so the LUT visibly does something."""
    size = 17
    lines = ['TITLE "px4 film"', f"LUT_3D_SIZE {size}"]
    for b in range(size):
        for g in range(size):
            for r in range(size):

                def curve(v: float) -> float:
                    return min(1.0, max(0.0, v * v * (3 - 2 * v)))

                red = curve(r / (size - 1)) * 0.9 + 0.1 * (r / (size - 1))
                green = curve(g / (size - 1))
                blue = curve(b / (size - 1)) * 0.85
                lines.append(f"{red:.6f} {green:.6f} {blue:.6f}")
    target = out_dir / rel_path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("\n".join(lines) + "\n", encoding="utf-8")


def collect_media(
    cases: list[tuple[str, dict[str, Any]]],
) -> tuple[list[VideoSpec], dict[str, Any]]:
    """Every distinct asset file the cases reference, with the facts needed to synthesise it."""
    videos: dict[str, VideoSpec] = {}
    others: dict[str, Any] = {}
    for _area, case in cases:
        fps = case["probe"]["fps"]
        for asset in case["project"]["assets"]:
            rel = engine_asset_path(asset)
            media = asset.get("media") or {}
            if asset["kind"] == "video":
                keyed = asset["id"] == KEY_PICTURE_ASSET
                luma = asset["id"] == LUMA_PICTURE_ASSET
                if not keyed and not luma and asset["id"] not in SENTINELS:
                    raise KeyError(f"No sentinel colour for video asset {asset['id']!r}")
                primary, secondary = (
                    ((0, 0, 0), (0, 0, 0)) if keyed or luma else SENTINELS[asset["id"]]
                )
                spec = VideoSpec(
                    rel_path=rel,
                    width=int(media["width"]),
                    height=int(media["height"]),
                    fps=float(fps[asset["id"]]),
                    seconds=float(asset.get("durationSeconds") or 10.0),
                    primary=primary,
                    secondary=secondary,
                    pixel_aspect_ratio=float(media.get("pixelAspectRatio") or 1.0),
                    rotation=int(media.get("rotation") or 0),
                    frame_times_ms=tuple(
                        round(float(value) * 1000)
                        for value in case["probe"].get("frameTimes", {}).get(asset["id"], [])
                    ),
                    key_picture=keyed,
                    luma_picture=luma,
                )
                if videos.setdefault(rel, spec) != spec:
                    raise ValueError(f"Cases disagree about the media facts of {rel!r}")
            elif asset["kind"] == "image":
                others[rel] = ("image", int(media["width"]), int(media["height"]))
            elif asset["kind"] == "audio":
                others[rel] = ("audio", float(asset.get("durationSeconds") or 10.0))
        for track in case["project"]["timeline"]["tracks"]:
            for clip in track.get("clips", []):
                for effect in clip.get("effects", []):
                    if effect.get("type") == "lut":
                        others[str(effect["params"]["path"])] = ("lut",)
    return sorted(videos.values(), key=lambda spec: spec.rel_path), others


#: Matte frames synthesised either side of the source range the clips read.
MATTE_FRAME_MARGIN = 3
#: Where a progressive (partially processed) artifact's PREVIEW copy lives in the output.
PREVIEW_MATTES_DIR = "preview-mattes"
#: Where that copy's monitor tier lives (PX5.3); a whole artifact's is in ``MATTE_TIERS_DIR``.
PREVIEW_MATTE_TIERS_DIR = "preview-matte-tiers"
#: The foreground estimate a ``disc`` matte carries: no sentinel, so decontamination shows.
DISC_FOREGROUND = (96, 200, 160)


def _matte_frame(width: int, height: int, shape: str, index: int) -> Any:
    """One synthetic matte frame.

    ``ramp`` (the text-behind-subject case): an opaque subject over the left 40%, a 64 px soft
    edge, then clear, the same every frame. ``disc``: an anti-aliased hard-edged disc that moves
    two pixels per frame, a band of one-pixel strands and a soft 12 px ramp, so edge modes,
    edge shift, feathers and frame identity all change pixels.
    """
    import numpy as np

    if shape == "ramp":
        columns = np.arange(width, dtype=np.float64)
        edge = width * 0.4
        ramp = np.clip((edge + 32 - columns) / 64.0, 0.0, 1.0)
        return np.broadcast_to(np.round(ramp * 255).astype(np.uint8), (height, width)).copy()
    y, x = np.mgrid[0:height, 0:width].astype(np.float64)
    unit = min(width, height)
    cx = width * 0.35 + 2.0 * index
    cy = height * 0.5
    disc = np.clip(0.5 - (np.hypot(x - cx, y - cy) - unit * 0.28), 0.0, 1.0)
    ramp = np.clip((x - width * 0.7) / 12.0, 0.0, 1.0) * (y < height * 0.4)
    alpha = np.maximum(disc, ramp)
    strands = (y > height * 0.65) & (y < height * 0.85) & ((x.astype(np.int64) % 9) == 0)
    alpha[strands & (x > width * 0.55)] = 1.0
    return np.round(alpha * 255).astype(np.uint8)


def _encode_ffv1_frames(path: Path, frames: Any, pixel_format: str, stored_format: str) -> None:
    """Stream ``frames`` (an iterable of arrays) into intra-only FFV1 Matroska, as the pack does.

    ``-g 1 -slicecrc 1``: one key frame per packet with slice CRCs (``encode.py`` of the pack).
    """
    from framepilot_engine.media.ffmpeg import find_ffmpeg

    process: subprocess.Popen[bytes] | None = None
    try:
        for frame in frames:
            if process is None:
                height, width = frame.shape[:2]
                argv = [
                    find_ffmpeg(), "-nostdin", "-v", "error", "-y",
                    "-f", "rawvideo", "-pix_fmt", pixel_format, "-s", f"{width}x{height}",
                    "-r", "30", "-i", "-", "-c:v", "ffv1", "-level", "3", "-g", "1",
                    "-slicecrc", "1", "-pix_fmt", stored_format, str(path),
                ]  # fmt: skip
                process = subprocess.Popen(argv, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
            assert process.stdin is not None
            process.stdin.write(frame.tobytes())
    finally:
        if process is not None and process.stdin is not None:
            process.stdin.close()
    assert process is not None and process.stderr is not None
    # Not `communicate()`: it flushes stdin, which is closed above (Python 3.11 raises on that).
    stderr = process.stderr.read()
    process.wait(timeout=600)
    if process.returncode != 0:
        raise RuntimeError(f"ffv1 encode failed: {stderr.decode(errors='replace')[:400]}")


def _write_artifact(
    directory: Path,
    width: int,
    height: int,
    shape: str,
    foreground_rgb: tuple[int, int, int],
    timing: Any,
    first: int,
    last: int,
    fps: float,
) -> dict[str, Any]:
    """Write one artifact over source frames ``[first, last]``; return its pinned fields."""
    import numpy as np

    from framepilot_engine.render.mattes import (
        FOREGROUND_FILE,
        FRAMES_FILE,
        MATTE_FILE,
        file_sha256,
    )

    directory.mkdir(parents=True, exist_ok=True)
    indices = range(first, last + 1)
    _encode_ffv1_frames(
        directory / MATTE_FILE,
        (_matte_frame(width, height, shape, i) for i in indices),
        "gray",
        "gray",
    )
    foreground = np.broadcast_to(
        np.asarray(foreground_rgb, dtype=np.uint8), (height, width, 3)
    ).copy()
    _encode_ffv1_frames(directory / FOREGROUND_FILE, (foreground for _ in indices), "rgb24", "bgr0")
    (directory / FRAMES_FILE).write_text(
        json.dumps(
            {
                "version": 1,
                "timeBase": [timing.time_base.numerator, timing.time_base.denominator],
                "originPts": timing.pts[0],
                "firstFrame": first,
                "pts": list(timing.pts[first : last + 1]),
            }
        ),
        encoding="utf-8",
    )
    seconds = timing.relative_seconds()
    step = seconds[1] - seconds[0] if len(seconds) > 1 else 1.0 / fps
    return {
        "files": [
            {"name": name, "sha256": file_sha256(directory / name)}
            for name in (MATTE_FILE, FOREGROUND_FILE, FRAMES_FILE)
        ],
        "width": width,
        "height": height,
        "coverage": {"sourceStart": seconds[first], "sourceEnd": seconds[last] + step},
    }


def write_case_mattes(out_dir: Path, cases: list[tuple[str, dict[str, Any]]]) -> dict[str, Any]:
    """Synthesise every matte artifact a case pins, and pin the real digests in the case.

    The frame-plan fixtures name an artifact key with placeholder digests: no pack runs in CI.
    The export refuses a matte it cannot verify, so the generator writes one to the artifact
    contract (``render/mattes.py``: FFV1 ``matte.mkv`` + ``foreground.mkv`` at the source's
    display size, ``frames.json`` with the source's own pts) over the source frames the clips
    read, and rewrites the artifact JSON the ENGINE project carries.

    A case's ``matteArtifacts`` names each key's ``shape`` (``ramp`` by default, ``disc``) and
    optionally ``processedFrames``: a progressive job. The export always has the whole artifact
    (it never renders an unfinished one); the PREVIEW reads a copy holding only the first
    ``processedFrames`` frames, under :data:`PREVIEW_MATTES_DIR`. Samples past that range are
    rendered by the export with the matte disabled (the original picture), which is what the
    monitor shows for a range still processing.

    :returns: Per key, the artifact the PREVIEW project pins and the directory it is served
        from (the manifest's ``mattes``).
    """
    from framepilot_engine.render.mattes import MATTES_DIR, matte_display_size
    from framepilot_engine.render.pts_reader import video_timing
    from framepilot_engine.timeline.models import AssetMedia

    served: dict[str, Any] = {}
    for _area, case in cases:
        assets = {asset["id"]: asset for asset in case["project"]["assets"]}
        synthesis = case.get("matteArtifacts") or {}
        mattes = [
            (clip, mask)
            for track in case["project"]["timeline"]["tracks"]
            for clip in track.get("clips", [])
            for mask in clip.get("masks", []) or []
            if mask.get("kind") == "matte"
        ]
        by_key: dict[str, list[tuple[dict[str, Any], dict[str, Any]]]] = {}
        for clip, mask in mattes:
            by_key.setdefault(str(mask["artifact"]["key"]), []).append((clip, mask))
        for key, users in by_key.items():
            if key in served:
                raise ValueError(
                    f"Matte artifact {key[:12]} is pinned by two cases; give each its own key"
                )
            spec = synthesis.get(key, {})
            shape = str(spec.get("shape", "ramp"))
            asset = assets[users[0][0]["assetId"]]
            source = out_dir / engine_asset_path(asset)
            timing = video_timing(source)
            fps = float(case["probe"]["fps"][asset["id"]])
            first = max(
                0, min(int(float(c["sourceStart"]) * fps) for c, _ in users) - MATTE_FRAME_MARGIN
            )
            last = min(
                timing.count - 1,
                max(math.ceil(float(c["sourceEnd"]) * fps) for c, _ in users) + MATTE_FRAME_MARGIN,
            )
            size = matte_display_size(AssetMedia.model_validate(asset["media"]))
            assert size is not None, f"matte asset {asset['id']} has no measured size"
            width, height = size
            foreground = DISC_FOREGROUND if shape == "disc" else SENTINELS[asset["id"]][0]
            artifact = _write_artifact(
                out_dir / MATTES_DIR / key,
                width,
                height,
                shape,
                foreground,
                timing,
                first,
                last,
                fps,
            )
            for _clip, mask in users:
                mask["artifact"].update(copy.deepcopy(artifact))
            entry: dict[str, Any] = {"root": MATTES_DIR, "artifact": artifact}
            processed = spec.get("processedFrames")
            if processed is not None:
                processed_last = min(last, first + int(processed) - 1)
                entry = {
                    "root": PREVIEW_MATTES_DIR,
                    "artifact": _write_artifact(
                        out_dir / PREVIEW_MATTES_DIR / key,
                        width,
                        height,
                        shape,
                        foreground,
                        timing,
                        first,
                        processed_last,
                        fps,
                    ),
                    "processedSourceFrames": [first, processed_last],
                }
            served[key] = entry
            case.setdefault("_processed", {})[key] = entry.get("processedSourceFrames")
            _log.info(
                "synthesised matte %s: %d frames at %dx%d",
                key[:12],
                last - first + 1,
                width,
                height,
            )
    return served


def _unprocessed_matte_keys(case: dict[str, Any], plan: dict[str, Any]) -> set[str]:
    """Matte keys whose frame at this sample is outside the preview's processed range."""
    ranges = {key: value for key, value in (case.get("_processed") or {}).items() if value}
    keys: set[str] = set()
    for layer in plan.get("layers", []):
        for masked in (layer.get("mask") or {}).get("layers", []):
            matte = masked.get("matte")
            if not matte or matte["artifactKey"] not in ranges:
                continue
            first, last = ranges[matte["artifactKey"]]
            frame = matte.get("sourceFrame")
            if frame is None or frame < first or frame > last:
                keys.add(matte["artifactKey"])
    return keys


def _without_mattes(case: dict[str, Any], keys: set[str]) -> dict[str, Any]:
    """The case with every matte mask of ``keys`` disabled (a range still processing)."""
    changed = copy.deepcopy(case)
    for track in changed["project"]["timeline"]["tracks"]:
        for clip in track.get("clips", []):
            for mask in clip.get("masks", []) or []:
                if mask.get("kind") == "matte" and mask["artifact"]["key"] in keys:
                    mask["enabled"] = False
    return changed


def engine_project(case: dict[str, Any]) -> dict[str, Any]:
    """The case's project with every asset pointed at the file the preview also reads."""
    project: dict[str, Any] = copy.deepcopy(case["project"])
    for asset in project["assets"]:
        asset["path"] = engine_asset_path(asset)
    return project


#: Seconds either side of a sample within which a clip is kept in the per-sample project.
SAMPLE_WINDOW_SECONDS = 1.0


def sample_project(case: dict[str, Any], t: float) -> dict[str, Any]:
    """The case's engine project reduced to the clips that can affect the frame at ``t``.

    A composition opens a reader per clip (~400 MB each at 1080p on CI), so compiling all 29
    clips of the every-transition-kind case for each sample passed 10 GB. Kept: every clip whose
    span is within :data:`SAMPLE_WINDOW_SECONDS` of ``t``, plus its immediate neighbours on the
    same track, so transition partners and under-layer handles stay adjacent. The caller only
    uses the reduction when the engine's own frame plan at ``t`` is unchanged by it.
    """
    project = engine_project(case)
    for track in project["timeline"]["tracks"]:
        clips = sorted(track.get("clips", []), key=lambda clip: float(clip["start"]))
        near = {
            index
            for index, clip in enumerate(clips)
            if float(clip["end"]) >= t - SAMPLE_WINDOW_SECONDS
            and float(clip["start"]) <= t + SAMPLE_WINDOW_SECONDS
        }
        keep = {n for index in near for n in (index - 1, index, index + 1) if 0 <= n < len(clips)}
        track["clips"] = [clip for index, clip in enumerate(clips) if index in keep]
    return project


def preview_canvas_size(width: int, height: int) -> tuple[int, int]:
    """The monitor canvas for a project frame, exactly as the player sizes it (JS `Math.round`)."""
    scale = min(1.0, PREVIEW_CANVAS_MAX_EDGE / max(width, height))
    return (max(1, math.floor(width * scale + 0.5)), max(1, math.floor(height * scale + 0.5)))


def _write_background_png(target: Path, size: tuple[int, int]) -> None:
    """The frame past the end of a timeline: nothing is composited, only the black background."""
    from PIL import Image

    target.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", size, (0, 0, 0)).save(target, format="PNG")


def _grab_case(
    args: tuple[str, str, dict[str, Any], bool],
) -> tuple[list[dict[str, Any]], dict[str, list[int]]]:
    """Render every sample of ONE case, then release everything it opened.

    Runs in a worker process that exits after this one task (``max_tasks_per_child=1``), and
    also clears the composition cache after every frame: a composition holds an ffmpeg reader
    per clip, and a case like every-transition-kind opens dozens. Keeping one composition alive
    at a time is what bounds this script's memory.

    :returns: The samples, and per matte artifact key the size the export decoded its picture
        at (PX5.3: the size its monitor tier must be made at for the preview to use it).
    """
    out_dir_text, area, case, keep_existing = args
    import framepilot_engine.render.compiler as compiler_module

    decoded_sizes: dict[str, list[int]] = {}
    unwrapped = compiler_module._clip_mask_stacks

    def recording(clip: Any, media_size: Any, *rest: Any, **named: Any) -> Any:
        # `_clip_mask_stacks(clip, media_size, mattes, decoded_size, tracks)`: the export's own
        # decode size, read where it is used rather than recomputed here.
        size = named.get("decoded_size", rest[1] if len(rest) > 1 else None)
        if size is not None:
            for mask in getattr(clip, "masks", None) or []:
                if getattr(mask, "kind", None) == "matte":
                    decoded_sizes.setdefault(str(mask.artifact.key), [int(size[0]), int(size[1])])
        return unwrapped(clip, media_size, *rest, **named)

    compiler_module._clip_mask_stacks = recording
    from framepilot_engine.render.compiler import timeline_duration
    from framepilot_engine.render.composition_cache import COMPOSITION_CACHE
    from framepilot_engine.render.frame_grab import grab_frame
    from framepilot_engine.render.frame_plan import frame_plan_at
    from framepilot_engine.timeline.models import Project

    out_dir = Path(out_dir_text)
    full_project = Project.model_validate(engine_project(case))
    resolution = case["project"]["resolution"]
    canvas = preview_canvas_size(int(resolution["width"]), int(resolution["height"]))
    duration = timeline_duration(full_project.timeline)
    source_fps = {asset: float(rate) for asset, rate in case["probe"]["fps"].items()}
    burn = bool(case["burnCaptions"])
    results: list[dict[str, Any]] = []
    for index, sample in enumerate(case["samples"]):
        rel = f"frames/{area}/{case['id']}/{index}.png"
        entry: dict[str, Any] = {"time": sample, "frame": None, "error": None}
        results.append(entry)
        if keep_existing and (out_dir / rel).exists():
            entry["frame"] = rel
            continue
        try:
            if float(sample) >= duration:
                # `grab_frame` clamps a time past the end to the last frame, but the frame plan
                # at that time is empty (clips are end-exclusive) and so is the preview. The
                # export has no frame there; its background is the honest expectation.
                target = out_dir / rel
                _write_background_png(target, canvas)
                entry.update(frame=rel, renderedTime=float(sample), size=list(canvas), pastEnd=True)
                continue
            unprocessed = _unprocessed_matte_keys(case, case["expected"][index])
            if unprocessed:
                # The monitor leaves a still-processing matte out: the export's frame is the
                # same timeline with that matte disabled.
                frame = grab_frame(
                    Project.model_validate(engine_project(_without_mattes(case, unprocessed))),
                    out_dir,
                    float(sample),
                    image_format="png",
                    burn_captions=burn,
                    lossless=True,
                    lossless_size=canvas,
                )
                target = out_dir / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(frame.data)
                entry.update(
                    frame=rel,
                    renderedTime=frame.time_seconds,
                    size=[frame.width, frame.height],
                    matteProcessing=sorted(unprocessed),
                )
                del frame
                continue
            reduced = Project.model_validate(sample_project(case, float(sample)))
            reduced_plan = frame_plan_at(
                reduced, float(sample), burn_captions=burn, source_fps=source_fps
            ).to_json()
            # The reduction is only an optimisation: if it changes what the export would
            # composite at this time, render the whole timeline instead.
            same_frame = json.dumps(reduced_plan, sort_keys=True) == json.dumps(
                case["expected"][index], sort_keys=True
            )
            entry["reducedProject"] = same_frame
            frame = grab_frame(
                reduced if same_frame else full_project,
                out_dir,
                float(sample),
                image_format="png",
                burn_captions=burn,
                lossless=True,
                lossless_size=canvas,
            )
            target = out_dir / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(frame.data)
            entry.update(
                frame=rel, renderedTime=frame.time_seconds, size=[frame.width, frame.height]
            )
            del frame
        except Exception as exc:  # recorded, not raised: the spec reports it as a failure kind
            entry["error"] = f"{type(exc).__name__}: {exc}"
        finally:
            # Closes every reader of the composition (close_clip_tree); nothing is retained.
            COMPOSITION_CACHE.clear()
    return results, decoded_sizes


def write_case_tiers(
    out_dir: Path, mattes: dict[str, Any], decoded_sizes: dict[str, list[int]]
) -> None:
    """Make each served artifact's monitor tier (PX5.3) at the size the export decoded its
    picture at, so the oracle judges the tier path wherever the preview can take it.

    ``render/matte_tier.py`` writes it, digests before pixels, from exactly the copy the
    PREVIEW reads (a progressive job's truncated copy for that row), into a directory beside
    it; the served entry names that directory (``tierRoot``). An artifact without a foreground,
    or whose picture no sample decoded, gets none, and the preview decodes the masters.
    """
    from framepilot_engine.render.matte_tier import MATTE_TIERS_DIR, write_monitor_tier
    from framepilot_engine.render.mattes import FOREGROUND_FILE, MATTES_DIR

    for key, entry in mattes.items():
        size = decoded_sizes.get(key)
        artifact = entry["artifact"]
        names = {file["name"] for file in artifact["files"]}
        if size is None or FOREGROUND_FILE not in names:
            continue
        root = str(entry["root"])
        tier_root = MATTE_TIERS_DIR if root == MATTES_DIR else PREVIEW_MATTE_TIERS_DIR
        tier = write_monitor_tier(
            out_dir,
            {**artifact, "key": key},
            (int(size[0]), int(size[1])),
            artifact_dir=out_dir / root / key,
            tier_dir=out_dir / tier_root / key,
        )
        entry["tierRoot"] = tier_root
        _log.info("matte tier %s: %dx%d, %d frames", key[:12], *size, tier.frame_count)


def _patch_boxes() -> list[tuple[int, int, int, int]]:
    columns, rows = COLOUR_GRID
    width, height = COLOUR_SIZE
    cell_w, cell_h = width // columns, height // rows
    return [
        (col * cell_w, row * cell_h, cell_w, cell_h)
        for row in range(rows)
        for col in range(columns)
    ]


def write_colour_pattern(out_dir: Path) -> Path:
    from PIL import Image, ImageDraw

    image = Image.new("RGB", COLOUR_SIZE, (0, 0, 0))
    draw = ImageDraw.Draw(image)
    for (x, y, w, h), (_name, rgb) in zip(_patch_boxes(), COLOUR_PATCHES, strict=True):
        draw.rectangle((x, y, x + w - 1, y + h - 1), fill=rgb)
    target = out_dir / "colour" / "pattern.png"
    target.parent.mkdir(parents=True, exist_ok=True)
    image.save(target, format="PNG")
    return target


def encode_colour_clip(
    ffmpeg: str, pattern: Path, out_dir: Path, encoding: tuple[str, str, str, str]
) -> None:
    clip_id, matrix, colour_range, tag = encoding
    _run(
        [
            ffmpeg,
            "-y",
            "-loglevel",
            "error",
            "-loop",
            "1",
            "-framerate",
            "30",
            "-i",
            str(pattern),
            "-t",
            "2",
            "-vf",
            f"scale=out_color_matrix={matrix}:out_range={colour_range},format=yuv420p",
            "-c:v",
            "libx264",
            "-profile:v",
            "high",
            "-pix_fmt",
            "yuv420p",
            "-preset",
            "veryfast",
            "-crf",
            "12",
            "-g",
            "15",
            "-bf",
            "0",
            "-colorspace",
            tag,
            "-color_primaries",
            tag,
            "-color_trc",
            tag,
            "-color_range",
            colour_range,
            "-movflags",
            "+faststart",
            str(out_dir / "colour" / f"{clip_id}.mp4"),
        ]
    )


def colour_project(clip_id: str) -> dict[str, Any]:
    """A one-clip project over a PX0.3 test pattern; the spec loads the same document."""
    width, height = COLOUR_SIZE
    return {
        "id": f"px03-{clip_id}",
        "name": f"px03-{clip_id}",
        "version": 1,
        "fps": 30,
        "resolution": {"width": width, "height": height},
        "assets": [
            {
                "id": "pattern",
                "path": f"colour/{clip_id}.mp4",
                "kind": "video",
                "media": {
                    "width": width,
                    "height": height,
                    "proxyPath": f"colour/{clip_id}.mp4",
                },
                "durationSeconds": 2.0,
            }
        ],
        "timeline": {
            "tracks": [
                {
                    "id": "v1",
                    "type": "video",
                    "clips": [
                        {
                            "id": "c1",
                            "assetId": "pattern",
                            "trackId": "v1",
                            "start": 0.0,
                            "end": 2.0,
                            "sourceStart": 0.0,
                            "sourceEnd": 2.0,
                            "effects": [],
                            "keyframes": [],
                        }
                    ],
                }
            ]
        },
        "transcript": [],
    }


def patch_means(png_bytes: bytes) -> list[list[float]]:
    """Mean RGB of the central half of every patch (edges carry chroma-subsampling bleed)."""
    import io

    import numpy as np
    from PIL import Image

    pixels = np.asarray(Image.open(io.BytesIO(png_bytes)).convert("RGB"), dtype=np.float64)
    means: list[list[float]] = []
    for x, y, w, h in _patch_boxes():
        region = pixels[y + h // 4 : y + 3 * h // 4, x + w // 4 : x + 3 * w // 4]
        means.append([round(float(v), 3) for v in region.reshape(-1, 3).mean(axis=0)])
    return means


def measure_colour(out_dir: Path) -> dict[str, Any]:
    from framepilot_engine.render.composition_cache import COMPOSITION_CACHE
    from framepilot_engine.render.frame_grab import grab_frame
    from framepilot_engine.timeline.models import Project

    measured: dict[str, Any] = {}
    for clip_id, matrix, colour_range, tag in COLOUR_ENCODINGS:
        document = colour_project(clip_id)
        frame = grab_frame(
            Project.model_validate(document),
            out_dir,
            COLOUR_SAMPLE_TIME,
            image_format="png",
            lossless=True,
        )
        (out_dir / "colour" / f"{clip_id}.engine.png").write_bytes(frame.data)
        COMPOSITION_CACHE.clear()
        measured[clip_id] = {
            "matrix": matrix,
            "range": colour_range,
            "tag": tag,
            "project": document,
            "engine": patch_means(frame.data),
        }
    return {
        "time": COLOUR_SAMPLE_TIME,
        "patches": [
            {"name": name, "authored": list(rgb), "box": list(box)}
            for (name, rgb), box in zip(COLOUR_PATCHES, _patch_boxes(), strict=True)
        ],
        "encodings": measured,
    }


class MemoryBudgetExceeded(RuntimeError):
    """The generator and its children (workers, ffmpeg readers) exceeded ``--max-rss-mb``."""


def tree_rss_mb(root_pid: int) -> float:
    """Resident memory of ``root_pid`` and all its descendants, in MB (``ps``, macOS and Linux)."""
    listing = subprocess.run(
        ["ps", "-A", "-o", "pid=,ppid=,rss="], capture_output=True, text=True, check=True
    ).stdout
    children: dict[int, list[int]] = {}
    rss_kb: dict[int, int] = {}
    for line in listing.splitlines():
        fields = line.split()
        if len(fields) != 3:
            continue
        pid, ppid, rss = (int(field) for field in fields)
        children.setdefault(ppid, []).append(pid)
        rss_kb[pid] = rss
    total, stack = 0, [root_pid]
    while stack:
        pid = stack.pop()
        total += rss_kb.get(pid, 0)
        stack.extend(children.get(pid, []))
    return total / 1024


class MemoryWatchdog:
    """Polls this process tree's RSS and kills the tree's children when it passes the cap.

    Checked from a thread rather than between frames, because the expensive moment is inside
    one compile, which a between-frames check would only see after the fact.
    """

    POLL_SECONDS = 0.5

    def __init__(self, max_rss_mb: float | None) -> None:
        self.max_rss_mb = max_rss_mb
        self.peak_mb = 0.0
        self.tripped_at_mb: float | None = None
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="px4-rss-watchdog", daemon=True)

    def __enter__(self) -> MemoryWatchdog:
        if self.max_rss_mb is not None:
            self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self._stop.set()
        if self._thread.is_alive():
            self._thread.join()

    def check(self) -> None:
        """Raise if the cap was hit (call between phases and after the pool returns)."""
        if self.tripped_at_mb is not None:
            raise MemoryBudgetExceeded(
                f"PX4 frame generation used {self.tripped_at_mb:.0f} MB (process tree RSS), over "
                f"--max-rss-mb {self.max_rss_mb:.0f}. Its children were killed. Render fewer "
                "cases (--case), use --workers 1, or raise the cap on a machine that has it."
            )

    def _run(self) -> None:
        me = os.getpid()
        while not self._stop.wait(self.POLL_SECONDS):
            used = tree_rss_mb(me)
            self.peak_mb = max(self.peak_mb, used)
            if self.max_rss_mb is not None and used > self.max_rss_mb:
                self.tripped_at_mb = used
                self._kill_children(me)
                return

    @staticmethod
    def _kill_children(root_pid: int) -> None:
        listing = subprocess.run(
            ["ps", "-A", "-o", "pid=,ppid="], capture_output=True, text=True, check=True
        ).stdout
        children: dict[int, list[int]] = {}
        for line in listing.splitlines():
            fields = line.split()
            if len(fields) == 2:
                children.setdefault(int(fields[1]), []).append(int(fields[0]))
        stack = list(children.get(root_pid, []))
        while stack:
            pid = stack.pop()
            stack.extend(children.get(pid, []))
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.kill(pid, signal.SIGKILL)


def generate(
    out_dir: Path,
    workers: int = 1,
    *,
    keep_existing: bool = False,
    only_case: str | None = None,
    watchdog: MemoryWatchdog | None = None,
) -> dict[str, Any]:
    """Write media, engine frames and the manifest. See the module note on memory bounds."""
    from framepilot_engine.media.ffmpeg import find_ffmpeg
    from framepilot_engine.render.composition_cache import COMPOSITION_CACHE

    guard = watchdog or MemoryWatchdog(None)
    ffmpeg = find_ffmpeg()
    cases = load_cases()
    if only_case is not None:
        cases = [(area, case) for area, case in cases if f"{area}/{case['id']}" == only_case]
        if not cases:
            raise KeyError(
                f"No matrix case {only_case!r} (expected area/id, e.g. layering/layers-2)"
            )
    out_dir.mkdir(parents=True, exist_ok=True)

    videos, others = collect_media(cases)
    _log.info("encoding %d sentinel videos with %d worker(s)", len(videos), workers)
    with ThreadPoolExecutor(max_workers=workers) as threads:
        list(
            threads.map(
                lambda spec: encode_video(ffmpeg, out_dir, spec),
                [v for v in videos if not (keep_existing and (out_dir / v.rel_path).exists())],
            )
        )
        pattern = write_colour_pattern(out_dir)
        list(
            threads.map(
                lambda enc: encode_colour_clip(ffmpeg, pattern, out_dir, enc), COLOUR_ENCODINGS
            )
        )
    mattes = write_case_mattes(out_dir, cases)
    for rel, facts in others.items():
        if facts[0] == "image":
            write_png_asset(out_dir, rel, facts[1], facts[2])
        elif facts[0] == "audio":
            write_audio_asset(ffmpeg, out_dir, rel, facts[1])
        else:
            write_lut(out_dir, rel)
    guard.check()

    _log.info("rendering engine frames for %d case(s), one case per process", len(cases))
    tasks = [(str(out_dir), area, case, keep_existing) for area, case in cases]
    rendered: list[list[dict[str, Any]]] = []
    matte_sizes: dict[str, list[int]] = {}
    # A fresh process per case: whatever MoviePy, numpy or ffmpeg readers hold is returned to
    # the OS when the case ends, not accumulated across 43 cases.
    context = multiprocessing.get_context("spawn")
    with ProcessPoolExecutor(
        max_workers=workers, mp_context=context, max_tasks_per_child=1
    ) as pool:
        for (area, case), (samples, sizes) in zip(cases, pool.map(_grab_case, tasks), strict=True):
            rendered.append(samples)
            for key, size in sizes.items():
                matte_sizes.setdefault(key, size)
            _log.info("rendered %s/%s (peak tree RSS %.0f MB)", area, case["id"], guard.peak_mb)
            guard.check()

    write_case_tiers(out_dir, mattes, matte_sizes)
    colour = measure_colour(out_dir)
    COMPOSITION_CACHE.clear()
    guard.check()
    manifest = {
        "version": MANIFEST_VERSION,
        "inputHash": input_hash(),
        "sentinels": {
            asset: {"primary": list(primary), "secondary": list(secondary)}
            for asset, (primary, secondary) in SENTINELS.items()
        },
        "media": {
            spec.rel_path: {"width": spec.width, "height": spec.height, "fps": spec.fps}
            for spec in videos
        },
        "cases": [
            {"area": area, "id": case["id"], "samples": samples}
            for (area, case), samples in zip(cases, rendered, strict=True)
        ],
        "colour": colour,
        "mattes": mattes,
        "engineHost": export_host_hints(),
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument(
        "--workers",
        type=int,
        default=1,
        help="render processes (default 1; CI passes 2). Each holds one composition at a time.",
    )
    parser.add_argument(
        "--max-rss-mb",
        type=float,
        default=None,
        help="abort (killing workers) when this process tree's resident memory passes this",
    )
    parser.add_argument(
        "--case",
        default=None,
        help="render only this case (area/id), for debugging ONE failure locally",
    )
    parser.add_argument(
        "--keep-existing",
        action="store_true",
        help="local iteration only: reuse media and frames already on disk (CI never passes it)",
    )
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(name)s: %(message)s")
    with MemoryWatchdog(args.max_rss_mb) as watchdog:
        try:
            manifest = generate(
                args.out.resolve(),
                max(1, args.workers),
                keep_existing=args.keep_existing,
                only_case=args.case,
                watchdog=watchdog,
            )
        except MemoryBudgetExceeded as exc:
            _log.error("%s", exc)
            return 2
        except BrokenProcessPool:
            watchdog.check()  # a worker killed by the watchdog surfaces as a broken pool
            raise
    errors = sum(1 for case in manifest["cases"] for s in case["samples"] if s["error"])
    _log.info("wrote %s (%d engine errors recorded)", args.out / "manifest.json", errors)
    return 0


if __name__ == "__main__":
    sys.exit(main())
