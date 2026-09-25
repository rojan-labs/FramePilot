"""Write the export's per-clip mix envelope into ``tests/fixtures/audio-mix/envelopes.json``.

The Python side of the ``compiler._apply_audio_effects`` <-> ``preview/audio/mix-envelope.ts``
parity pair. Every expected value is what the export multiplies a clip's samples by: the
compiler's own function runs over a constant 1.0 signal and the result is read back at each
sample time, so the fader, the ``gainDb`` automation lane, the fades and their curves, the duck
and the mute all come from the code that renders the file, not from a re-derivation of it.

The second half, ``reads``, is how a clip's timeline time reads its source: the compiler's
``_subclipped_source`` then ``_apply_speed`` over an identity signal (each sample's value is its
own source time), so a reverse's one-frame mirror lag, a ramp's time table and every clamp are
the export's own. ``clip-audio.test.ts`` holds the preview's ``sourceReadOf`` to it.

Regenerate after a deliberate change to either side::

    pnpm audio-mix:vectors

``test_audio_mix_vectors.py`` fails when the stored file no longer matches the engine, and
``mix-envelope.test.ts`` fails when it no longer matches the preview.
"""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path
from typing import Any

import numpy as np

from framepilot_engine.effects.speed_curve import integrate_rate
from framepilot_engine.render import compiler
from framepilot_engine.timeline.models import Project

_log = logging.getLogger(__name__)

REPO = Path(__file__).resolve().parents[3]
FIXTURE_DIR = REPO / "tests" / "fixtures" / "audio-mix"
FIXTURE = FIXTURE_DIR / "envelopes.json"

#: Evenly spaced samples per case, on top of the instants each case names as its edges.
SAMPLES_PER_CASE = 97

_SPEECH_TRACK: dict[str, Any] = {
    "id": "speech",
    "type": "audio",
    "clips": [
        {"id": "vo-1", "assetId": "tone", "trackId": "speech", "start": 1.0, "end": 2.5},
        {"id": "vo-2", "assetId": "tone", "trackId": "speech", "start": 3.1, "end": 4.0},
    ],
}


def _gain_effect(params: dict[str, Any], keyframes: list[dict[str, Any]] | None = None) -> Any:
    return {"id": "mix", "type": "audio_gain", "params": params, "keyframes": keyframes or []}


def _lane(points: list[tuple[float, float, str]], **handles: Any) -> list[dict[str, Any]]:
    lane = []
    for index, (time, value, easing) in enumerate(points):
        keyframe: dict[str, Any] = {
            "id": f"k{index}",
            "time": time,
            "property": "gainDb",
            "value": value,
            "easing": easing,
        }
        if index in handles.get("with_handles", {}):
            keyframe["handles"] = handles["with_handles"][index]
        lane.append(keyframe)
    return lane


#: (name, clip start, clip end, audio_gain effect or None, edges worth sampling exactly)
CASES: list[tuple[str, float, float, Any, list[float]]] = [
    ("no-mix", 0.5, 4.5, None, []),
    ("fader-cut", 0.0, 3.0, _gain_effect({"gainDb": -6.0}), []),
    ("fader-boost", 0.0, 3.0, _gain_effect({"gainDb": 4.5}), []),
    ("muted", 0.0, 3.0, _gain_effect({"gainDb": 3.0, "muted": True}), []),
    (
        "fades-linear",
        2.0,
        6.0,
        _gain_effect({"gainDb": -3.0, "fadeInSeconds": 0.5, "fadeOutSeconds": 1.25}),
        [0.0, 0.5, 2.75, 4.0],
    ),
    (
        "fades-equal-power",
        0.0,
        4.0,
        _gain_effect({"fadeInSeconds": 1.0, "fadeOutSeconds": 1.0, "fadeCurve": "equal-power"}),
        [0.0, 1.0, 3.0, 4.0],
    ),
    (
        "fades-smooth-overlapping",
        0.0,
        2.0,
        _gain_effect({"fadeInSeconds": 1.5, "fadeOutSeconds": 1.5, "fadeCurve": "smooth"}),
        [0.0, 0.5, 1.0, 1.5, 2.0],
    ),
    (
        "duck-under-speech",
        0.0,
        5.0,
        _gain_effect({"duckUnderTrackId": "speech", "duckAmountDb": -18.0}),
        [0.85, 1.0, 2.5, 2.65, 2.95, 3.1, 4.0, 4.15],
    ),
    (
        "duck-starts-mid-clip",
        2.0,
        5.0,
        _gain_effect({"gainDb": -2.0, "duckUnderTrackId": "speech"}),
        [0.0, 0.5, 0.65, 0.95, 1.1, 2.0, 2.15],
    ),
    (
        "duck-missing-track",
        0.0,
        3.0,
        _gain_effect({"duckUnderTrackId": "gone", "duckAmountDb": -30.0}),
        [],
    ),
    (
        "lane-linear",
        0.0,
        3.0,
        _gain_effect(
            {"gainDb": 6.0},
            _lane([(0.5, -12.0, "linear"), (1.5, 0.0, "linear"), (2.5, -6.0, "linear")]),
        ),
        [0.0, 0.5, 1.0, 1.5, 2.5, 3.0],
    ),
    (
        "lane-eased-with-fades-and-duck",
        0.5,
        4.5,
        _gain_effect(
            {
                "fadeInSeconds": 0.4,
                "fadeOutSeconds": 0.6,
                "fadeCurve": "equal-power",
                "duckUnderTrackId": "speech",
                "duckAmountDb": -9.0,
            },
            _lane(
                [
                    (0.25, -20.0, "ease-in"),
                    (1.0, -3.0, "ease-in-out"),
                    (1.75, 2.0, "hold"),
                    (2.4, -8.0, "bezier"),
                    (3.2, 0.0, "ease-out"),
                    (3.6, -4.0, "linear"),
                ],
                with_handles={
                    3: {"out": [0.1, 0.9], "in": [0.3, 0.2]},
                    4: {"out": [0.5, 0.5], "in": [0.8, 1.4]},
                },
            ),
        ),
        [0.0, 0.25, 0.4, 1.0, 1.75, 2.4, 3.2, 3.4, 4.0],
    ),
]


def _project(start: float, end: float, effect: Any) -> Project:
    clip: dict[str, Any] = {
        "id": "subject",
        "assetId": "tone",
        "trackId": "bed",
        "start": start,
        "end": end,
        "sourceStart": 0.0,
        "sourceEnd": end - start,
        "effects": [] if effect is None else [effect],
    }
    return Project.model_validate(
        {
            "id": "p_audio_mix_vectors",
            "name": "Audio mix vectors",
            "fps": 30,
            "resolution": {"width": 64, "height": 64},
            "assets": [{"id": "tone", "path": "tone.wav", "kind": "audio"}],
            "timeline": {
                "tracks": [{"id": "bed", "type": "audio", "clips": [clip]}, _SPEECH_TRACK]
            },
        }
    )


def _times(duration: float, edges: list[float]) -> list[float]:
    even = np.linspace(0.0, duration, SAMPLES_PER_CASE).tolist()
    return sorted({round(t, 12) for t in [*even, *edges] if 0.0 <= t <= duration})


def expected_gains(project: Project, times: list[float]) -> list[float]:
    """What the export multiplies the clip's samples by at each clip-local time."""
    from moviepy import AudioClip

    track = project.timeline.tracks[0]
    clip = track.clips[0]
    duration = clip.end - clip.start

    def unity(t: Any) -> Any:
        return np.ones((np.size(t), 2)) if np.ndim(t) else np.ones(2)

    source = AudioClip(frame_function=unity, duration=duration, fps=44100)
    mixed = compiler._apply_audio_effects(source, clip, project.timeline)
    frames = np.asarray(mixed.get_frame(np.asarray(times, dtype=np.float64)))
    return [float(value) for value in frames[:, 0]]


#: (name, asset kind, reader fps, source seconds, clip fields beyond the placement)
READS: list[tuple[str, str, float, float, dict[str, Any]]] = [
    (
        "forward-sped-up",
        "audio",
        44100.0,
        10.0,
        {"sourceStart": 1.0, "sourceEnd": 7.0, "speed": 1.5},
    ),
    (
        "reverse-audio",
        "audio",
        44100.0,
        10.0,
        {"sourceStart": 2.0, "sourceEnd": 6.0, "speed": -1.0},
    ),
    (
        "reverse-footage-slowed",
        "video",
        30.0,
        10.0,
        {"sourceStart": 1.0, "sourceEnd": 3.0, "speed": -0.5},
    ),
    (
        "ramp",
        "audio",
        44100.0,
        10.0,
        {
            "sourceStart": 0.5,
            "sourceEnd": 3.5,
            "speedRamp": [
                {"id": "r0", "sourceTime": 0.0, "rate": 0.5, "easing": "linear"},
                {"id": "r1", "sourceTime": 1.0, "rate": 2.0, "easing": "ease-in-out"},
                {"id": "r2", "sourceTime": 2.5, "rate": 1.0, "easing": "linear"},
            ],
        },
    ),
]


def _read_clip(fields: dict[str, Any]) -> Any:
    """The clip placed at 0 for exactly the timeline span its source and speed imply."""
    from framepilot_engine.timeline.models import Clip

    placed = {**fields, "id": "subject", "assetId": "src", "trackId": "t", "start": 0.0}
    span = float(fields["sourceEnd"]) - float(fields["sourceStart"])
    ramp = Clip.model_validate({**placed, "end": 1.0}).speed_ramp
    duration = (
        integrate_rate(ramp, 0.0, span) if ramp else span / abs(float(fields.get("speed", 1.0)))
    )
    return Clip.model_validate({**placed, "end": duration})


def expected_reads(kind: str, fps: float, source_seconds: float, clip: Any) -> dict[str, Any]:
    """Absolute source seconds the export reads at each clip-local time."""
    from moviepy import AudioClip, ColorClip

    def identity(t: Any) -> Any:
        return np.column_stack([t, t]) if np.ndim(t) else np.array([t, t])

    sound = AudioClip(frame_function=identity, duration=source_seconds, fps=44100)
    if kind == "video":
        source: Any = ColorClip(size=(2, 2), color=(0, 0, 0), duration=source_seconds)
        source = source.with_fps(fps).with_audio(sound)
        mapped = compiler._apply_speed(compiler._subclipped_source(source, clip), clip).audio
    else:
        mapped = compiler._apply_speed(compiler._subclipped_source(sound, clip), clip)
    duration = clip.end - clip.start
    # Stop short of the very end: MoviePy's reader returns silence for a read at or past the
    # file's end, which is a value, not a source time.
    times = np.linspace(0.0, duration * 0.999, SAMPLES_PER_CASE)
    frames = np.asarray(mapped.get_frame(times))
    return {"times": times.tolist(), "sourceTimes": [float(v) for v in frames[:, 0]]}


def document() -> dict[str, Any]:
    cases = []
    for name, start, end, effect, edges in CASES:
        project = _project(start, end, effect)
        times = _times(end - start, edges)
        cases.append(
            {
                "name": name,
                "timeline": json.loads(project.timeline.model_dump_json(by_alias=True)),
                "clipId": "subject",
                "times": times,
                "expected": expected_gains(project, times),
            }
        )
    reads = []
    for name, kind, fps, source_seconds, fields in READS:
        clip = _read_clip(fields)
        reads.append(
            {
                "name": name,
                "kind": kind,
                "fps": fps,
                "sourceSeconds": source_seconds,
                "clip": json.loads(clip.model_dump_json(by_alias=True, exclude_none=True)),
                **expected_reads(kind, fps, source_seconds, clip),
            }
        )
    return {
        "about": (
            "Per-clip mix gain the export applies (compiler._apply_audio_effects over a "
            "constant signal), at clip-local seconds, and the source second each clip reads "
            "(compiler._apply_speed over an identity signal). Regenerate with "
            "`pnpm audio-mix:vectors`."
        ),
        "cases": cases,
        "reads": reads,
    }


def serialize(doc: dict[str, Any]) -> str:
    return json.dumps(doc, indent=1, ensure_ascii=False) + "\n"


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(name)s: %(message)s")
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    doc = document()
    FIXTURE.write_text(serialize(doc), encoding="utf-8")
    _log.info("wrote %d cases to %s", len(doc["cases"]), FIXTURE)
    return 0


if __name__ == "__main__":
    sys.exit(main())
