"""Write the FFV1/Matroska fixtures the preview's matte decoder is checked against (BR5.1).

Each case is a tiny FFV1 Matroska file encoded by the local ffmpeg, plus the SHA-256 of the
frames ffmpeg itself decodes from it (``rawvideo`` in the export's pixel format, the way
``render/mattes.py`` reads an artifact). ``ffv1-decoder.test.ts`` decodes every file and must
produce the identical bytes. Regenerate after adding a case::

    cd engine/python && uv run python ../../tests/fixtures/matte-ffv1/make_fixtures.py
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent

# id, width, height, frames, source pix_fmt, stored pix_fmt, decoded pix_fmt, extra encoder args, content
CASES = [
    ("gray-pack", 64, 48, 4, "gray", "gray", "gray", ["-level", "3", "-g", "1", "-slicecrc", "1"], "edges"),
    ("gray-gop", 32, 24, 15, "gray", "gray", "gray", ["-level", "3"], "edges"),
    ("gray-noise-rice", 40, 30, 3, "gray", "gray", "gray", ["-level", "3", "-g", "1"], "noise"),
    ("gray-range-custom", 64, 48, 5, "gray", "gray", "gray", ["-level", "3", "-coder", "range_tab", "-context", "1", "-slices", "4", "-g", "2"], "edges"),
    ("gray-range-default-odd", 37, 23, 3, "gray", "gray", "gray", ["-level", "3", "-coder", "range_def", "-slices", "6"], "noise"),
    ("gray-multislice-default", 400, 300, 2, "gray", "gray", "gray", ["-level", "3", "-g", "1", "-slicecrc", "1"], "blocks"),
    ("gray16-range", 48, 36, 3, "gray16le", "gray16le", "gray16le", ["-level", "3", "-coder", "range_tab", "-g", "1"], "noise16"),
    ("gray16-rice", 48, 36, 3, "gray16le", "gray16le", "gray16le", ["-level", "3", "-g", "1"], "edges16"),
    ("bgr0-pack", 64, 48, 3, "rgb24", "bgr0", "rgb24", ["-level", "3", "-g", "1", "-slicecrc", "1"], "rgb"),
    ("bgr0-range-custom", 50, 34, 4, "rgb24", "bgr0", "rgb24", ["-level", "3", "-coder", "range_tab", "-context", "1", "-slices", "4", "-g", "3"], "rgbnoise"),
    ("bgra-range", 40, 30, 2, "rgba", "bgra", "rgb24", ["-level", "3", "-coder", "range_tab", "-g", "1"], "rgba"),
    ("gray-v4", 64, 48, 3, "gray", "gray", "gray", ["-level", "4", "-strict", "experimental", "-g", "1", "-slicecrc", "1"], "edges"),
    ("bgr0-v4", 64, 48, 3, "rgb24", "bgr0", "rgb24", ["-level", "4", "-strict", "experimental", "-coder", "range_tab", "-g", "1"], "rgb"),
    ("bgr0-v4-rice", 44, 40, 2, "rgb24", "bgr0", "rgb24", ["-level", "4", "-strict", "experimental", "-g", "1"], "rgbnoise"),
]


def content(kind: str, width: int, height: int, frame: int) -> np.ndarray:
    y, x = np.mgrid[0:height, 0:width].astype(np.int64)
    rng = np.random.default_rng(1234 + frame)
    edges = ((x * x + 3 * x * y + 17 * frame) >> 3) ^ np.where(((x ^ y) & 16) != 0, 255, 0)
    if kind == "blocks":
        return ((((x // 16 + y // 16 + frame) % 2) * 200 + x % 7) & 255).astype(np.uint8)
    if kind == "edges":
        return (edges & 255).astype(np.uint8)
    if kind == "noise":
        return rng.integers(0, 256, (height, width), dtype=np.uint8)
    if kind == "noise16":
        return rng.integers(0, 65536, (height, width), dtype=np.uint16)
    if kind == "edges16":
        return ((edges * 257 + x * 3) & 65535).astype(np.uint16)
    if kind in ("rgb", "rgbnoise", "rgba"):
        base = np.stack([edges & 255, (x * 5 + frame * 9) & 255, (y * 7) & 255], axis=-1)
        if kind == "rgbnoise":
            base = rng.integers(0, 256, (height, width, 3))
        if kind == "rgba":
            base = np.concatenate([base, ((x + y) & 255)[..., None]], axis=-1)
        return base.astype(np.uint8)
    raise ValueError(kind)


def main() -> None:
    index = []
    for case_id, width, height, count, source, stored, decoded, extra, kind in CASES:
        path = HERE / f"{case_id}.mkv"
        frames = b"".join(
            (content(kind, width, height, f).astype("<u2") if source == "gray16le" else content(kind, width, height, f)).tobytes()
            for f in range(count)
        )
        subprocess.run(
            ["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", source,
             "-s", f"{width}x{height}", "-r", "30", "-i", "-", "-c:v", "ffv1", *extra,
             "-pix_fmt", stored, "-fflags", "+bitexact", "-flags:v", "+bitexact", str(path)],
            input=frames, check=True,
        )  # fmt: skip
        raw = subprocess.run(
            ["ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-map", "0:v:0",
             "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", decoded, "-"],
            capture_output=True, check=True,
        ).stdout  # fmt: skip
        frame_bytes = len(raw) // count
        index.append(
            {
                "id": case_id,
                "file": path.name,
                "width": width,
                "height": height,
                "frames": count,
                "format": {"gray": "gray8", "gray16le": "gray16", "rgb24": "rgb24"}[decoded],
                "encoder": extra,
                "sha256": [
                    hashlib.sha256(raw[i * frame_bytes : (i + 1) * frame_bytes]).hexdigest()
                    for i in range(count)
                ],
            }
        )
    (HERE / "cases.json").write_text(json.dumps({"cases": index}, indent=1) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
