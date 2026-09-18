"""Measure the BR2.5 pts probe (``render/pts_reader.video_timing``) on large files (PX5).

BR2.5 measured the probe on a 2-minute 1080p file only. It demuxes every video packet of the
file once per export (then caches by path, size and mtime), so its cost grows with BOTH the
bytes read and the packet count. Two generated files separate the two::

    pnpm px5:pts-probe            # == cd engine/python && uv run python -m tests.px5_pts_probe

* ``camera`` - multi-GB, camera-like bitrate (about 100 Mb/s 1080p, several minutes): bytes.
* ``long`` - two hours at a low bitrate (216,000 packets in a few hundred MB): packets.

Each encodes one short period and stream-copies it to length (one ffmpeg at a time), into the
gitignored PX5 cache, and is DELETED after measuring unless ``--keep`` (they are gigabytes).
The result is printed as JSON and written to ``<out>/results/pts-probe.json``.

Honest limit: the OS page cache cannot be dropped without root, so "first call" is the first
call in this process on a file that was just written - warm storage. A cold read of a multi-GB
file from a slow disk adds that disk's sequential read time on top.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import platform
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

_log = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_OUT_DIR = REPO_ROOT / "tests" / "e2e" / ".tmp-px5-scale"

#: name -> (lavfi source for one period, period seconds, total seconds, x264 rate arguments)
FILES: dict[str, tuple[str, int, int, list[str]]] = {
    "camera": (
        "testsrc2=s=1920x1080:r=30,noise=alls=40:allf=t",
        20,
        300,
        ["-b:v", "100M", "-minrate", "100M", "-maxrate", "100M", "-bufsize", "200M"],
    ),
    "long": ("testsrc2=s=320x180:r=30", 60, 7200, ["-crf", "30"]),
}


def _run(argv: list[str]) -> None:
    result = subprocess.run(argv, capture_output=True, check=False)
    if result.returncode != 0:
        tail = result.stderr.decode(errors="replace")[-600:]
        raise RuntimeError(f"{Path(argv[0]).name} failed ({result.returncode}): {tail}")


def generate(ffmpeg: str, out: Path, name: str) -> None:
    source, period_seconds, seconds, rate = FILES[name]
    if out.exists():
        return
    out.parent.mkdir(parents=True, exist_ok=True)
    period = out.with_suffix(".period.mp4")
    _run(
        [
            ffmpeg,
            "-y",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            source,
            "-t",
            str(period_seconds),
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-g",
            "15",
            "-bf",
            "0",
            *rate,
            "-an",
            str(period),
        ]
    )
    partial = out.with_suffix(".partial.mp4")
    _run(
        [
            ffmpeg,
            "-y",
            "-loglevel",
            "error",
            "-stream_loop",
            str(math.ceil(seconds / period_seconds) - 1),
            "-i",
            str(period),
            "-c",
            "copy",
            "-t",
            str(seconds),
            str(partial),
        ]
    )
    period.unlink()
    partial.rename(out)


def measure(path: Path) -> dict[str, Any]:
    from framepilot_engine.render import pts_reader

    pts_reader._TIMINGS.clear()
    started = time.perf_counter()
    timing = pts_reader.video_timing(path)
    first = time.perf_counter() - started
    started = time.perf_counter()
    pts_reader.video_timing(path)
    cached = time.perf_counter() - started
    return {
        "bytes": path.stat().st_size,
        "frames": timing.count,
        "constantRate": timing.constant_rate,
        "firstCallSeconds": round(first, 3),
        "cachedCallSeconds": round(cached, 6),
    }


def main(argv: list[str] | None = None) -> int:
    from framepilot_engine.media.ffmpeg import find_ffmpeg

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument("--keep", action="store_true", help="keep the generated files")
    parser.add_argument("--only", choices=sorted(FILES), default=None)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    ffmpeg = find_ffmpeg()
    results: dict[str, Any] = {"machine": f"{platform.system()} {platform.machine()}"}
    for name in [args.only] if args.only else sorted(FILES):
        path = args.out / "pts-probe" / f"{name}.mp4"
        generate(ffmpeg, path, name)
        results[name] = measure(path)
        if not args.keep:
            path.unlink()
        _log.info("%s: %s", name, json.dumps(results[name]))
    target = args.out / "results" / "pts-probe.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(results, indent=1) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
