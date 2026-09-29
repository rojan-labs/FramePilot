"""Compiling a composite renders no frame (render/lazy_frames.py, AL38).

Pinned: a lazy clip's size is the size MoviePy's eager frame-0 measure gives, for every stage
the compiler stacks (time maps, its own same-size stages, crop, resize, rotate); its frames are
MoviePy's; and building the export's composite or a grab's window decodes no source frame and
runs no transition, grade or effect-layer pass. The work happens when a frame is asked for.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from moviepy import ImageClip, VideoClip, vfx

from framepilot_engine.media.assets import index_assets
from framepilot_engine.render import compiler, transition_passes
from framepilot_engine.render import frame_effects as frame_effects_module
from framepilot_engine.render.compiler import compile_timeline
from framepilot_engine.render.frame_grab import _resolve_preset
from framepilot_engine.render.lazy_frames import FrameClip, same_size_transform
from framepilot_engine.render.picture_window import picture_window_at
from framepilot_engine.render.presets import ExportPreset
from framepilot_engine.render.resources import close_clip_tree
from framepilot_engine.render.video_reader import ProbedVideoReader
from framepilot_engine.timeline.models import Clip
from tests.test_render_picture_window import GRAB_DIMENSION, KINDS, _edit, media_dir

__all__ = ["media_dir"]  # the module-scoped media fixture, shared with the window tests

INSTANTS = (0.0, 0.4, 1.3, 2.9)


def _moving(width: int = 48, height: int = 32) -> Callable[[float], np.ndarray]:
    def frame(t: float) -> np.ndarray:
        value = int(t * 60) % 256
        pixels = np.full((height, width, 3), value, dtype=np.uint8)
        pixels[: height // 2, : width // 3] = 255 - value
        return pixels

    return frame


class _Counted:
    """A frame function that counts its calls."""

    def __init__(self, frame: Callable[[float], np.ndarray]) -> None:
        self.frame = frame
        self.calls = 0

    def __call__(self, t: float) -> np.ndarray:
        self.calls += 1
        return self.frame(t)


def _eager(frame: Callable[[float], np.ndarray]) -> Any:
    return VideoClip(frame_function=frame).with_duration(3.0).with_fps(30)


def _lazy(frame: Callable[[float], np.ndarray], size: tuple[int, int] = (48, 32)) -> Any:
    """A lazy source of known size, as the compiler's reader is (its probe gives the size)."""
    return FrameClip(frame, size=size).with_duration(3.0).with_fps(30)


STAGES: dict[str, Callable[[Any], Any]] = {
    "subclip": lambda c: c.subclipped(0.5, 2.5),
    "speed": lambda c: c.with_effects([vfx.MultiplySpeed(factor=2.0)]),
    "reverse": lambda c: c.with_effects([vfx.TimeMirror()]),
    "crop": lambda c: c.with_effects([vfx.Crop(x1=5.5, y1=3.2, x2=40.9, y2=31.0)]),
    "resize": lambda c: c.resized(0.73),
    "animated resize": lambda c: c.resized(lambda t: 1.0 + 0.2 * t),
    "rotate": lambda c: c.rotated(lambda t: 30 * t, expand=False),
    "transform": lambda c: c.transform(lambda get_frame, t: get_frame(t)[::2, ::3]),
}


@pytest.mark.parametrize("stage", STAGES, ids=list(STAGES))
def test_a_lazy_clip_measures_what_moviepy_measures(stage: str) -> None:
    counted = _Counted(_moving())
    lazy = STAGES[stage](_lazy(counted))
    assert counted.calls == 0, "building the stage rendered a frame"
    eager = STAGES[stage](_eager(_moving()))
    assert tuple(lazy.size) == tuple(eager.size)
    assert lazy.duration == eager.duration
    for t in INSTANTS:
        if t < eager.duration:
            np.testing.assert_array_equal(lazy.get_frame(t), eager.get_frame(t), f"t={t}")


@pytest.mark.parametrize("source", ["video", "still"])
def test_a_same_size_stage_is_moviepys_transform(source: str) -> None:
    def darken(get_frame: Callable[[float], np.ndarray], t: float) -> np.ndarray:
        return get_frame(t) // 2

    def build() -> Any:
        if source == "still":
            return ImageClip(_moving()(0.7)).with_duration(3.0)
        return _eager(_moving())

    ours = same_size_transform(build(), darken)
    moviepys = build().transform(darken, keep_duration=True)
    assert tuple(ours.size) == tuple(moviepys.size)
    assert ours.duration == moviepys.duration
    # A still becomes a moving picture, as MoviePy's ImageClip.transform makes it.
    assert not isinstance(ours, ImageClip)
    for t in INSTANTS:
        np.testing.assert_array_equal(ours.get_frame(t), moviepys.get_frame(t))


def test_a_same_size_stage_maps_the_mask_and_keeps_its_size() -> None:
    counted = _Counted(lambda t: np.full((32, 48), min(1.0, t), dtype=np.float64))
    clip = _lazy(_moving()).with_mask(FrameClip(counted, size=(48, 32), is_mask=True))
    later = same_size_transform(
        clip, lambda get_frame, t: get_frame(t + 1.0), apply_to=["mask"], keep_duration=False
    )
    assert counted.calls == 0
    assert tuple(later.mask.size) == (48, 32)
    assert later.duration is None
    np.testing.assert_array_equal(later.mask.get_frame(0.5), np.full((32, 48), 1.0))


def test_the_compiler_declares_a_crop_by_moviepys_slice() -> None:
    """``_apply_crop`` names the size MoviePy's Crop measures, for bounds on and off the grid."""
    crops = (
        {"x": 0.1, "y": 0.0, "width": 0.5, "height": 1.0},
        {"x": 0.33, "y": 0.17, "width": 0.41, "height": 0.62},
        {"x": 0.0, "y": 0.5, "width": 1.0, "height": 0.5},
        {"x": 0.9, "y": 0.9, "width": 0.1, "height": 0.1},
    )
    for crop in crops:
        clip = Clip.model_validate(
            {"id": "c", "assetId": "a", "trackId": "t", "start": 0, "end": 1, "crop": crop}
        )
        counted = _Counted(_moving(97, 61))
        ours = compiler._apply_crop(_lazy(counted, (97, 61)), clip)
        assert counted.calls == 0
        moviepys = compiler._apply_crop(_eager(_moving(97, 61)), clip)
        assert tuple(ours.size) == tuple(moviepys.size), crop
        np.testing.assert_array_equal(ours.get_frame(1.1), moviepys.get_frame(1.1))


class _FrameWork:
    """Source frames decoded and picture passes run, by kind."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.counts: Counter[str] = Counter()
        real_read = ProbedVideoReader.get_frame
        real_transition = transition_passes.apply_transition_to_frame
        from framepilot_engine.render.color import apply_color_grade as real_grade

        real_layer = frame_effects_module.apply_layer_to_frame

        def read(reader: Any, t: float) -> Any:
            self.counts["source frame"] += 1
            return real_read(reader, t)

        def counted(kind: str, real: Callable[..., Any]) -> Callable[..., Any]:
            def run(*args: Any, **kwargs: Any) -> Any:
                self.counts[kind] += 1
                return real(*args, **kwargs)

            return run

        monkeypatch.setattr(ProbedVideoReader, "get_frame", read)
        monkeypatch.setattr(
            transition_passes,
            "apply_transition_to_frame",
            counted("transition pass", real_transition),
        )
        # The compiler binds the grade by name when it builds a stage.
        monkeypatch.setattr(f"{compiler.__name__}.apply_color_grade", counted("grade", real_grade))
        monkeypatch.setattr(
            frame_effects_module, "apply_layer_to_frame", counted("effect layer", real_layer)
        )


@pytest.fixture
def work(monkeypatch: pytest.MonkeyPatch) -> Iterator[_FrameWork]:
    yield _FrameWork(monkeypatch)


def test_the_export_compile_renders_no_frame(media_dir: Path, work: _FrameWork) -> None:
    project = _edit(B=DIRECTIONAL_BLUR_IN)
    index = index_assets([a.model_dump() for a in project.assets], base_dir=media_dir)
    preset = ExportPreset(id="p", label="P", width=160, height=96, fps=30)
    composite = compile_timeline(project, index, preset, burn_captions=True)
    try:
        assert work.counts == Counter(), "the compile rendered frames it does not use"
        composite.get_frame(1.2)
        assert work.counts["source frame"] > 0
        assert work.counts["transition pass"] > 0
        assert work.counts["effect layer"] > 0
    finally:
        close_clip_tree(composite)


#: Shot B entering on a catalog transition that runs a pixel pass (the travel reel's costliest).
DIRECTIONAL_BLUR_IN = {
    "effects": [
        {
            "id": "B_in",
            "type": "transition",
            "params": {"kind": "directional-blur", "durationSeconds": 0.4, "fromClipId": "A"},
            "keyframes": [],
        }
    ]
}


@pytest.mark.parametrize(
    ("at", "then_runs"),
    [(1.2, "transition pass"), (2.5, "grade"), (3.5, "source frame")],
    ids=["blur-transition", "cropped-graded", "sped-up"],
)
def test_a_grab_window_compile_renders_no_frame(
    media_dir: Path, work: _FrameWork, at: float, then_runs: str
) -> None:
    project = _edit(B=DIRECTIONAL_BLUR_IN)
    index = index_assets([a.model_dump() for a in project.assets], base_dir=media_dir)
    window = picture_window_at(project, at, KINDS)
    assert window is not None
    composite = compile_timeline(
        project,
        index,
        _resolve_preset(project, GRAB_DIMENSION),
        burn_captions=True,
        window=window,
        decoder_threads=compiler.PREVIEW_DECODER_THREADS,
    )
    try:
        assert work.counts == Counter(), "the compile rendered frames it does not use"
        composite.get_frame(at)
        assert work.counts["source frame"] > 0
        assert work.counts[then_runs] > 0, "the counters must see the frame's own work"
    finally:
        close_clip_tree(composite)
