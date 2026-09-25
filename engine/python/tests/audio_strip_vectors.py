"""Write the export's channel strip output into ``tests/fixtures/audio-mix/strips.json``.

The ffmpeg side of the ``audio/filters.py`` <-> ``preview/audio/channel-strip.ts`` parity pair.
A fixed test signal (built from a formula both languages evaluate identically) goes through
exactly what ``compiler._stream_audio_processors`` does to a clip with a channel strip: MoviePy's
16-bit writer (clamped to ±0.99, truncated to int16, written as float WAV), the export's own
``peak_normalize_gain_db``, ``build_clip_filter`` and ``apply_audio_filter``. The processed file
is read back and sampled.

Regenerate with ``pnpm audio-mix:vectors``. ffmpeg's float DSP is what is being recorded, so the
drift test compares with a tolerance rather than byte-for-byte: CI's ffmpeg is not this one.
"""

from __future__ import annotations

import json
import logging
import math
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import numpy as np

from framepilot_engine.audio.filters import (
    apply_audio_filter,
    build_clip_filter,
    peak_normalize_gain_db,
)
from framepilot_engine.media.ffmpeg import find_ffmpeg

_log = logging.getLogger(__name__)

REPO = Path(__file__).resolve().parents[3]
FIXTURE = REPO / "tests" / "fixtures" / "audio-mix" / "strips.json"

SAMPLE_RATE = 44_100
FRAMES = SAMPLE_RATE
#: Every Nth output frame is recorded; the test checks all of them.
STRIDE = 97

#: (name, params as `audio_gain` carries them)
STRIPS: list[tuple[str, dict[str, Any]]] = [
    ("normalize", {"normalize": True}),
    (
        "eq-shelves-and-bell",
        {
            "eq": {
                "bands": [
                    {"kind": "low-shelf", "frequencyHz": 120.0, "gainDb": -4.0},
                    {"kind": "peaking", "frequencyHz": 1000.0, "gainDb": 6.0, "q": 1.4},
                    {"kind": "high-shelf", "frequencyHz": 8000.0, "gainDb": 3.0, "q": 0.9},
                ]
            }
        },
    ),
    (
        "eq-pass-filters",
        {
            "eq": {
                "bands": [
                    {"kind": "high-pass", "frequencyHz": 150.0},
                    {"kind": "low-pass", "frequencyHz": 6000.0, "q": 1.2},
                ]
            }
        },
    ),
    (
        "compressor",
        {
            "dynamics": {
                "thresholdDb": -24.0,
                "ratio": 4.0,
                "attackMs": 5.0,
                "releaseMs": 120.0,
                "makeupGainDb": 6.0,
            }
        },
    ),
    (
        "compressor-fast-limiting",
        {"dynamics": {"thresholdDb": -12.0, "ratio": 20.0, "attackMs": 0.1, "releaseMs": 10.0}},
    ),
    (
        "full-strip",
        {
            "normalize": True,
            "eq": {
                "bands": [
                    {"kind": "high-pass", "frequencyHz": 80.0},
                    {"kind": "peaking", "frequencyHz": 3500.0, "gainDb": 4.0, "q": 1.0},
                    {"kind": "high-shelf", "frequencyHz": 9000.0, "gainDb": 2.0},
                ]
            },
            "dynamics": {
                "thresholdDb": -18.0,
                "ratio": 3.0,
                "attackMs": 20.0,
                "releaseMs": 250.0,
                "makeupGainDb": 4.0,
            },
        },
    ),
]


def test_signal() -> np.ndarray:
    """(FRAMES, 2) float32: two tones and a noise bed under a stepped level.

    The level steps exercise the compressor's attack (0.2 s), release (0.45 s) and a silent gap.
    The noise is a 32-bit LCG so TypeScript reproduces it exactly (`channel-strip.test.ts`).
    """
    t = np.arange(FRAMES, dtype=np.float64) / SAMPLE_RATE
    level = np.select(
        [t < 0.2, t < 0.45, t < 0.7, t < 0.8],
        [0.25, 0.55, 0.05, 0.0],
        default=0.4,
    )
    state = 12345
    noise = np.empty(FRAMES, dtype=np.float64)
    for index in range(FRAMES):
        state = (state * 1664525 + 1013904223) & 0xFFFFFFFF
        noise[index] = state / 4294967296.0 * 2.0 - 1.0
    left = level * (0.7 * np.sin(2 * math.pi * 220.0 * t) + 0.3 * np.sin(2 * math.pi * 3100.0 * t))
    right = level * (0.6 * np.sin(2 * math.pi * 90.0 * t) + 0.4 * noise)
    return np.stack([left, right], axis=1).astype(np.float32)


def _moviepy_wav(signal: np.ndarray, path: Path) -> None:
    """What `source.write_audiofile(path, codec="pcm_f32le")` writes: 16-bit samples in."""
    quantized = (32768 * np.clip(signal.astype(np.float64), -0.99, 0.99)).astype(np.int16)
    subprocess.run(
        [
            find_ffmpeg(),
            "-y",
            "-loglevel",
            "error",
            "-f",
            "s16le",
            "-acodec",
            "pcm_s16le",
            "-ar",
            str(SAMPLE_RATE),
            "-ac",
            "2",
            "-i",
            "-",
            "-vn",
            "-acodec",
            "pcm_f32le",
            "-ar",
            str(SAMPLE_RATE),
            str(path),
        ],
        input=quantized.tobytes(),
        check=True,
    )


def _read_f32(path: Path) -> np.ndarray:
    raw = subprocess.run(
        [find_ffmpeg(), "-loglevel", "error", "-i", str(path), "-f", "f32le", "-"],
        capture_output=True,
        check=True,
    ).stdout
    return np.frombuffer(raw, dtype="<f4").reshape(-1, 2)


def strip_case(name: str, params: dict[str, Any], signal: np.ndarray) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="fp-strip-vectors-") as tmp:
        raw = Path(tmp) / "source.wav"
        processed = Path(tmp) / "processed.wav"
        _moviepy_wav(signal, raw)
        normalize_db = peak_normalize_gain_db(raw) if params.get("normalize") else None
        dynamics = params.get("dynamics")
        filter_str = build_clip_filter(
            eq_bands=params.get("eq", {}).get("bands", []),
            dynamics=dynamics,
            normalize_gain_db=normalize_db,
        )
        assert filter_str is not None, name
        apply_audio_filter(raw, processed, filter_str)
        out = _read_f32(processed)
    frames = np.arange(0, FRAMES, STRIDE)
    return {
        "name": name,
        "params": params,
        "filter": filter_str,
        "normalizeGainDb": normalize_db,
        "frames": frames.tolist(),
        "left": [float(v) for v in out[frames, 0]],
        "right": [float(v) for v in out[frames, 1]],
    }


#: Impulse-response length: long enough for every band's poles to have rung down past 1e-9.
IMPULSE_FRAMES = 2048


def band_impulse(band: dict[str, Any]) -> dict[str, Any]:
    """One band's impulse response from the export's own filter string, in double precision.

    The strip cases run the way the export does, in float32, where a low shelf's recursion
    rounds by about 3e-5; this pins the filter DESIGN itself to within 1e-9.
    """
    filter_str = build_clip_filter(eq_bands=[band])
    assert filter_str is not None, band
    impulse = np.zeros(IMPULSE_FRAMES, dtype="<f8")
    impulse[0] = 1.0
    raw = subprocess.run(
        [
            find_ffmpeg(),
            "-loglevel",
            "error",
            "-f",
            "f64le",
            "-ar",
            str(SAMPLE_RATE),
            "-ac",
            "1",
            "-i",
            "-",
            "-af",
            filter_str,
            "-f",
            "f64le",
            "-c:a",
            "pcm_f64le",
            "-",
        ],
        input=impulse.tobytes(),
        capture_output=True,
        check=True,
    ).stdout
    response = np.frombuffer(raw, dtype="<f8")
    return {"band": band, "filter": filter_str, "response": [float(v) for v in response[:256]]}


def document() -> dict[str, Any]:
    signal = test_signal()
    bands = [band for _, params in STRIPS for band in params.get("eq", {}).get("bands", [])]
    return {
        "about": (
            "ffmpeg's output for each channel strip over test_signal() at 44.1 kHz, sampled "
            "every `stride` frames. Regenerate with `pnpm audio-mix:vectors`."
        ),
        "sampleRate": SAMPLE_RATE,
        "frames": FRAMES,
        "stride": STRIDE,
        "cases": [strip_case(name, params, signal) for name, params in STRIPS],
        "impulses": [band_impulse(band) for band in bands],
    }


def serialize(doc: dict[str, Any]) -> str:
    return json.dumps(doc, indent=1, ensure_ascii=False) + "\n"


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(name)s: %(message)s")
    doc = document()
    FIXTURE.write_text(serialize(doc), encoding="utf-8")
    _log.info("wrote %d strips to %s", len(doc["cases"]), FIXTURE)
    return 0


if __name__ == "__main__":
    sys.exit(main())
