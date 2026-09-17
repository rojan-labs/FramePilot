"""Render goldens for ``matte`` masks (BR2.4): text behind a subject, and a matte in the stack.

A synthetic 96x54 shot: a gradient background and an orange disc (the "subject") moving right,
whose edge pixels are blended with the background the way a real camera blends hair into a wall.
The matte artifact is the disc's soft alpha, with the pure subject colour as the foreground
estimate inside the soft band. Each case compiles a real timeline (``compile_timeline``) and
records sampled frames as 8x6 block means, like ``mask_render_goldens.py``.

The headline case is plan 04's composite: video -> text -> matted copy of the same video, so the
words sit behind the subject.

Regenerate after a deliberate render change::

    pnpm matte-render:goldens

``test_matte_render_golden.py`` compares against ``tests/fixtures/golden/matte_render.json``.
"""

from __future__ import annotations

import json
import logging
import sys
import tempfile
from pathlib import Path
from typing import Any

import numpy as np

from framepilot_engine.media.assets import index_assets
from framepilot_engine.render.compiler import compile_timeline
from framepilot_engine.render.presets import frame_target
from framepilot_engine.render.resources import close_clip_tree
from framepilot_engine.timeline.models import Project
from tests import matte_fixtures as fx
from tests.mask_render_goldens import block_means

_log = logging.getLogger(__name__)

GOLDEN = Path(__file__).parent / "fixtures" / "golden" / "matte_render.json"
WIDTH, HEIGHT, FPS = 96, 54, 30
FRAMES = 12
SECONDS = FRAMES / FPS
SAMPLES = (0.05, 0.2, 0.35)
SUBJECT_RGB = (236, 118, 36)
RADIUS = 14.0


def subject_centre(frame: int) -> tuple[float, float]:
    return 28.0 + 3.0 * frame, 27.0


def matte_frames() -> list[np.ndarray]:
    """Soft disc alpha: 1 inside, a two-pixel linear edge band, 0 outside."""
    ys, xs = np.mgrid[0:HEIGHT, 0:WIDTH]
    frames = []
    for k in range(FRAMES):
        cx, cy = subject_centre(k)
        distance = np.sqrt((xs + 0.5 - cx) ** 2 + (ys + 0.5 - cy) ** 2)
        frames.append(np.clip(np.rint((RADIUS + 1.0 - distance) * 127.5), 0, 255).astype(np.uint8))
    return frames


def background() -> np.ndarray:
    ys, xs = np.mgrid[0:HEIGHT, 0:WIDTH]
    return np.stack([xs * 2 + 20, ys * 3 + 40, np.full_like(xs, 150)], axis=-1).astype(np.float64)


def pictures(mattes: list[np.ndarray]) -> list[np.ndarray]:
    """The camera picture: subject over background by the matte (contaminated edges)."""
    base = background()
    subject = np.asarray(SUBJECT_RGB, dtype=np.float64)
    frames = []
    for alpha in mattes:
        weight = alpha.astype(np.float64)[:, :, None] / 255.0
        frames.append(np.rint(base + (subject - base) * weight).astype(np.uint8))
    return frames


def foregrounds(mattes: list[np.ndarray]) -> list[np.ndarray]:
    """The pack's foreground estimate: subject colour inside the soft band, zero elsewhere."""
    frames = []
    for alpha in mattes:
        band = (alpha > 0) & (alpha < 255)
        frame = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
        frame[band] = SUBJECT_RGB
        frames.append(frame)
    return frames


def make_media(root: Path) -> dict[str, Any]:
    """Write ``src.mkv`` and the matte artifact into ``root``; return the artifact JSON."""
    mattes = matte_frames()
    fx.write_source(root / "src.mkv", pictures(mattes))
    return fx.write_artifact(
        root,
        pts=list(range(FRAMES)),
        time_base=(1, FPS),
        mattes=mattes,
        foregrounds=foregrounds(mattes),
    )


def _clip(clip_id: str, track_id: str, **extra: Any) -> dict[str, Any]:
    return {
        "id": clip_id,
        "assetId": "a",
        "trackId": track_id,
        "start": 0.0,
        "end": SECONDS,
        "sourceStart": 0.0,
        "sourceEnd": SECONDS,
        **extra,
    }


TEXT_CLIP = {
    "id": "words",
    "assetId": "__text__",
    "trackId": "t",
    "start": 0.0,
    "end": SECONDS,
    "sourceStart": 0.0,
    "sourceEnd": SECONDS,
    "effects": [
        {
            "id": "text",
            "type": "text",
            "params": {"text": "BEHIND", "fontSizePercent": 38, "color": "#1d4ed8"},
        }
    ],
}


def text_behind_subject(matte: dict[str, Any]) -> list[dict[str, Any]]:
    """Plan 04's composite, front first: matted copy, text, the untouched video."""
    return [
        {"id": "copy", "type": "video", "clips": [_clip("copy", "copy", masks=[matte])]},
        {"id": "t", "type": "overlay", "clips": [TEXT_CLIP]},
        {"id": "base", "type": "video", "clips": [_clip("base", "base")]},
    ]


def single(clip: dict[str, Any]) -> list[dict[str, Any]]:
    return [{"id": "v", "type": "video", "clips": [clip]}]


def cases(artifact: dict[str, Any]) -> list[dict[str, Any]]:
    """Every golden case's tracks over ``artifact``."""
    matte = fx.matte_mask
    return [
        {"id": "text-behind-subject", "tracks": text_behind_subject(matte("m", artifact))},
        {
            "id": "text-behind-subject-no-decontamination",
            "tracks": text_behind_subject(matte("m", artifact, decontaminate=False)),
        },
        {
            "id": "text-behind-subject-sharp-grown",
            "tracks": text_behind_subject(
                matte("m", artifact, edgeMode="sharp", edgeShiftPx=2.5, decontaminate=False)
            ),
        },
        {
            "id": "matte-inverted-limits-grade-feathered",
            "tracks": single(
                _clip(
                    "c",
                    "v",
                    effects=[
                        {
                            "id": "grade",
                            "type": "color_grade",
                            "params": {"exposure": -1.5, "saturation": -1},
                        }
                    ],
                    masks=[
                        matte(
                            "m",
                            artifact,
                            invert=True,
                            featherOuterPx=3,
                            target={"kind": "effect", "effectId": "grade"},
                        )
                    ],
                )
            ),
        },
        {
            "id": "matte-minus-rectangle",
            "tracks": single(
                _clip(
                    "c",
                    "v",
                    masks=[
                        matte("m", artifact),
                        {
                            "kind": "rectangle",
                            "id": "stand",
                            "cx": 48,
                            "cy": 44,
                            "width": 96,
                            "height": 20,
                            "mode": "subtract",
                        },
                    ],
                )
            ),
        },
        {
            "id": "matte-cropped-speed-ramp",
            "tracks": single(
                {
                    **_clip(
                        "c",
                        "v",
                        crop={"x": 0.125, "y": 0.0, "width": 0.75, "height": 1.0},
                        masks=[matte("m", artifact, opacity=0.8)],
                        speedRamp=[
                            {"id": "p0", "sourceTime": 0.0, "rate": 0.5},
                            {"id": "p1", "sourceTime": SECONDS, "rate": 2.0},
                        ],
                    ),
                }
            ),
        },
    ]


def project_for(tracks: list[dict[str, Any]]) -> Project:
    from framepilot_engine.effects.speed_curve import clip_timeline_duration
    from framepilot_engine.timeline.models import Clip

    for track in tracks:
        for clip in track["clips"]:
            if clip.get("speedRamp"):
                duration = clip_timeline_duration(Clip.model_validate(clip))
                assert duration is not None
                clip["end"] = clip["start"] + duration
    return Project.model_validate(
        {
            "id": "matte-golden",
            "name": "matte golden",
            "fps": FPS,
            "resolution": {"width": WIDTH, "height": HEIGHT},
            "assets": [
                {
                    "id": "a",
                    "path": "src.mkv",
                    "kind": "video",
                    "media": {"width": WIDTH, "height": HEIGHT},
                }
            ],
            "timeline": {"tracks": tracks},
        }
    )


def render_frames(tracks: list[dict[str, Any]], root: Path) -> list[np.ndarray]:
    """The composite at every sample time, as uint8 RGB."""
    project = project_for(tracks)
    index = index_assets([a.model_dump(by_alias=True) for a in project.assets], root)
    composite = compile_timeline(project, index, frame_target(WIDTH, HEIGHT, FPS))
    try:
        return [np.asarray(composite.get_frame(t)).astype(np.uint8) for t in SAMPLES]
    finally:
        close_clip_tree(composite)


def render_all() -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="fp-matte-golden-") as tmp:
        root = Path(tmp)
        artifact = make_media(root)
        rendered = {
            case["id"]: [
                block_means(frame.astype(np.float64))
                for frame in render_frames(case["tracks"], root)
            ]
            for case in cases(artifact)
        }
    return {
        "source": {"size": [WIDTH, HEIGHT], "fps": FPS, "frames": FRAMES, "codec": "png rgb24"},
        "samples": list(SAMPLES),
        "blocks": [8, 6],
        "tolerance": 1.0,
        "cases": rendered,
    }


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(name)s: %(message)s")
    document = render_all()
    GOLDEN.write_text(json.dumps(document, indent=1) + "\n", encoding="utf-8")
    _log.info("wrote %s (%d cases)", GOLDEN.name, len(document["cases"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
