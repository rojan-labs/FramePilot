"""A single-frame grab compiles only the clips on screen, and gets the export's frame anyway.

``render/picture_window.py`` names the clips whose layers can be playing at one instant, and
``compile_timeline(..., window=...)`` builds only those. These tests pin both halves of the
bargain against real (generated) media: the frame is the full compile's frame to the pixel —
at a cut, inside a transition under-layer, under titles, captions and an effect layer, through
a speed change — and a clip outside the window never has a reader opened for it.
"""

from __future__ import annotations

import io
import math
import subprocess
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import moviepy
import numpy as np
import pytest

from framepilot_engine.media.assets import AssetIndex, index_assets
from framepilot_engine.render.compiler import compile_timeline
from framepilot_engine.render.composition_cache import (
    COMPOSITION_CACHE,
    FRAME_WINDOW_CACHE,
    composition_key,
)
from framepilot_engine.render.frame_grab import _resolve_preset, grab_frame
from framepilot_engine.render.picture_window import (
    REACH_SLACK_SECONDS,
    clip_reach,
    picture_window_at,
)
from framepilot_engine.render.presets import ExportPreset
from framepilot_engine.render.resources import close_clip_tree
from framepilot_engine.timeline.models import Clip, Project

FPS = 30
#: Asset kinds as the asset index reports them for :func:`_edit`.
KINDS: dict[str, str | None] = {"x": "video", "y": "video", "z": "video", "w": "audio"}
#: The grab's own composite size for these projects (``_resolve_preset(project, 160)``).
GRAB_DIMENSION = 160
#: Plain and frosted captions take different compositors (``_composite_captions`` for frost).
PLAIN_CAPTIONS: dict[str, Any] = {"fontFamily": "Inter", "background": {"color": "#000000b3"}}
FROSTED_CAPTIONS: dict[str, Any] = {
    "fontFamily": "Inter",
    "textColor": "#ffffff",
    "background": {"color": "#ffffff40", "radius": 0.2, "blur": 0.3},
}


@pytest.fixture(scope="module")
def media_dir(ffmpeg_bin: str, tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Three moving test patterns (told apart by hue) and a tone, as a project directory.

    Moving pictures, not flat colours: a composite that read the wrong source frame, or the
    right frame from the wrong clip, has to show up as a pixel difference.
    """
    base = tmp_path_factory.mktemp("picture-window")
    for name, hue in (("x.mp4", 0), ("y.mp4", 120), ("z.mp4", 240)):
        subprocess.run(
            [
                ffmpeg_bin,
                "-y",
                "-f",
                "lavfi",
                "-i",
                f"testsrc2=s=160x96:r={FPS}:d=3,hue=h={hue}",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=330:duration=3",
                "-pix_fmt",
                "yuv420p",
                "-shortest",
                str(base / name),
            ],
            check=True,
            capture_output=True,
        )
    subprocess.run(
        [
            ffmpeg_bin,
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=4",
            str(base / "w.wav"),
        ],
        check=True,
        capture_output=True,
    )
    return base


def _clip(
    clip_id: str, asset: str, track: str, start: float, end: float, **extra: Any
) -> dict[str, Any]:
    return {
        "id": clip_id,
        "assetId": asset,
        "trackId": track,
        "start": start,
        "end": end,
        "sourceStart": extra.pop("sourceStart", 0.0),
        "sourceEnd": extra.pop("sourceEnd", end - start),
        "effects": extra.pop("effects", []),
        "keyframes": extra.pop("keyframes", []),
        **extra,
    }


def _edit(caption_style: dict[str, Any] | None = None, **video_overrides: Any) -> Project:
    """A four-shot edit with every layer kind a frame can stack.

    ``tracks[0]`` is the front: captions, a faded-in title, an effect layer over the picture,
    the picture (a cross-dissolve at 1.0s borrowing A's handle, a cropped/graded punch-in, a
    2x speed-up) and music underneath.
    """
    style = caption_style or PLAIN_CAPTIONS
    video = [
        _clip("A", "x", "v", 0.0, 1.0),
        _clip(
            "B",
            "y",
            "v",
            1.0,
            2.0,
            sourceStart=0.5,
            sourceEnd=1.5,
            effects=[
                {
                    "id": "B_in",
                    "type": "transition",
                    "params": {"kind": "cross-dissolve", "durationSeconds": 0.4, "fromClipId": "A"},
                    "keyframes": [],
                }
            ],
        ),
        _clip(
            "C",
            "z",
            "v",
            2.0,
            3.0,
            crop={"x": 0.1, "y": 0.0, "width": 0.5, "height": 1.0},
            effects=[
                {
                    "id": "C_grade",
                    "type": "color_grade",
                    "params": {"exposure": 0.5},
                    "keyframes": [],
                }
            ],
            keyframes=[
                {"id": "k0", "time": 0.0, "property": "scale", "value": 1.0},
                {"id": "k1", "time": 1.0, "property": "scale", "value": 1.2},
            ],
        ),
        _clip("D", "x", "v", 3.0, 4.0, sourceStart=0.5, sourceEnd=2.5, speed=2.0),
    ]
    for clip in video:
        clip.update(video_overrides.get(clip["id"], {}))
    cue = {"captionStyle": style}
    return Project.model_validate(
        {
            "id": "window",
            "name": "Window",
            "fps": FPS,
            "resolution": {"width": 160, "height": 96},
            "assets": [
                {"id": "x", "path": "x.mp4", "kind": "video", "durationSeconds": 3.0},
                {"id": "y", "path": "y.mp4", "kind": "video", "durationSeconds": 3.0},
                {"id": "z", "path": "z.mp4", "kind": "video", "durationSeconds": 3.0},
                {"id": "w", "path": "w.wav", "kind": "audio", "durationSeconds": 4.0},
            ],
            "timeline": {
                "tracks": [
                    {
                        "id": "captions",
                        "type": "caption",
                        "clips": [
                            _clip(
                                "cue1",
                                "__caption__",
                                "captions",
                                0.3,
                                1.3,
                                captionCue={"text": "one two", "words": []},
                                **cue,
                            ),
                            _clip(
                                "cue2",
                                "__caption__",
                                "captions",
                                2.2,
                                3.4,
                                captionCue={"text": "three", "words": []},
                                **cue,
                            ),
                        ],
                    },
                    {
                        "id": "titles",
                        "type": "overlay",
                        "clips": [
                            _clip(
                                "title",
                                "__text__",
                                "titles",
                                0.5,
                                1.5,
                                effects=[
                                    {
                                        "id": "title_text",
                                        "type": "text",
                                        "params": {"text": "TITLE", "inAnimation": "fade"},
                                        "keyframes": [],
                                    }
                                ],
                            )
                        ],
                    },
                    {
                        "id": "fx",
                        "type": "effect",
                        "clips": [],
                        "effectLayers": [
                            {
                                "id": "look",
                                "effectId": "cinema-print",
                                "kind": "film-curve",
                                "start": 0.8,
                                "end": 2.5,
                                "params": {"contrast": 0.2, "strength": 0.6},
                                "intensity": 0.35,
                                "keyframes": [],
                            }
                        ],
                    },
                    {"id": "v", "type": "video", "clips": video},
                    {"id": "a", "type": "audio", "clips": [_clip("music", "w", "a", 0.0, 4.0)]},
                ]
            },
        }
    )


def _index(project: Project, base: Path) -> AssetIndex:
    return index_assets([asset.model_dump() for asset in project.assets], base_dir=base)


def _kinds(index: AssetIndex) -> dict[str, str | None]:
    return {entry.asset_id: entry.kind for entry in index.entries}


def _grab_preset(project: Project) -> tuple[ExportPreset, int]:
    preset = _resolve_preset(project, GRAB_DIMENSION)
    return preset, max(preset.width, preset.height)


#: Instants where a wrong window would show: first frame, a title's fade, both sides of each
#: cut, inside the dissolve's under-layer, a caption edge, the effect layer's end, the speed-up.
PARITY_TIMES = (
    0.0,
    0.5,
    29 / FPS,
    30 / FPS,
    1.2,
    1.4,
    59 / FPS,
    60 / FPS,
    2.2,
    2.5,
    89 / FPS,
    90 / FPS,
    3.5,
    119 / FPS,
)


class TestWindowedFrameIsTheExportFrame:
    @pytest.mark.parametrize("captions", [PLAIN_CAPTIONS, FROSTED_CAPTIONS], ids=["plain", "frost"])
    def test_every_instant_matches_the_whole_timeline_to_the_pixel(
        self, media_dir: Path, captions: dict[str, Any]
    ) -> None:
        project = _edit(captions)
        index = _index(project, media_dir)
        preset, budget = _grab_preset(project)
        full = compile_timeline(
            project, index, preset, burn_captions=True, max_decode_dimension=budget
        )
        try:
            reference = {t: np.asarray(full.get_frame(t)).copy() for t in PARITY_TIMES}
        finally:
            close_clip_tree(full)

        for t in PARITY_TIMES:
            window = picture_window_at(project, t, _kinds(index))
            assert window is not None, t
            part = compile_timeline(
                project,
                index,
                preset,
                burn_captions=True,
                max_decode_dimension=budget,
                window=window,
            )
            try:
                assert part.duration is None or t < part.duration, t
                np.testing.assert_array_equal(np.asarray(part.get_frame(t)), reference[t], str(t))
            finally:
                close_clip_tree(part)

    def test_grab_frame_returns_the_whole_timeline_frame(self, media_dir: Path) -> None:
        pytest.importorskip("PIL")
        from PIL import Image

        project = _edit()
        index = _index(project, media_dir)
        preset, budget = _grab_preset(project)
        at_cut, in_dissolve = 30 / FPS, 1.2
        full = compile_timeline(
            project, index, preset, burn_captions=True, max_decode_dimension=budget
        )
        try:
            expected = {t: np.asarray(full.get_frame(t)).copy() for t in (at_cut, in_dissolve)}
        finally:
            close_clip_tree(full)

        for t, pixels in expected.items():
            frame = grab_frame(
                project, media_dir, t, image_format="png", max_dimension=GRAB_DIMENSION
            )
            decoded = np.asarray(Image.open(io.BytesIO(frame.data)).convert("RGB"))
            np.testing.assert_array_equal(decoded, pixels[..., :3], str(t))


class _OpenedReaders:
    """Every ``VideoFileClip``/``AudioFileClip`` the compiler opens, by file name."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.video: list[tuple[str, dict[str, Any]]] = []
        self.audio: list[str] = []
        real_video, real_audio = moviepy.VideoFileClip, moviepy.AudioFileClip

        def video(path: str, *args: Any, **kwargs: Any) -> Any:
            self.video.append((Path(path).name, kwargs))
            return real_video(path, *args, **kwargs)

        def audio(path: str, *args: Any, **kwargs: Any) -> Any:
            self.audio.append(Path(path).name)
            return real_audio(path, *args, **kwargs)

        # `compile_timeline` imports both from `moviepy` when it runs, so the spies are seen.
        monkeypatch.setattr(moviepy, "VideoFileClip", video)
        monkeypatch.setattr(moviepy, "AudioFileClip", audio)

    @property
    def files(self) -> set[str]:
        return {name for name, _ in self.video}


@pytest.fixture
def opened(monkeypatch: pytest.MonkeyPatch) -> Iterator[_OpenedReaders]:
    yield _OpenedReaders(monkeypatch)


class TestOnlyTheWindowIsOpened:
    def test_a_grab_inside_one_shot_opens_only_that_shot_and_no_sound(
        self, media_dir: Path, opened: _OpenedReaders
    ) -> None:
        grab_frame(_edit(), media_dir, 0.5)

        # A (x.mp4) plays at 0.5s; B, C, D and the music never open.
        assert opened.files == {"x.mp4"}
        assert opened.audio == []
        # The picture's own reader skips the audio decoder too.
        assert all(kwargs.get("audio") is False for _, kwargs in opened.video)

    def test_a_grab_inside_a_dissolve_opens_both_sides_of_the_cut_only(
        self, media_dir: Path, opened: _OpenedReaders
    ) -> None:
        grab_frame(_edit(), media_dir, 1.2)

        # B (y.mp4) and the under-layer it borrows from A's handle (x.mp4); never C's z.mp4.
        assert opened.files == {"x.mp4", "y.mp4"}
        assert opened.audio == []

    def test_frames_of_one_shot_share_one_windowed_composite(
        self, media_dir: Path, opened: _OpenedReaders
    ) -> None:
        project = _edit()
        hits = FRAME_WINDOW_CACHE.hits
        grab_frame(project, media_dir, 2.3)
        first = len(opened.video)
        grab_frame(project, media_dir, 2.4)

        assert len(opened.video) == first
        assert FRAME_WINDOW_CACHE.hits == hits + 1

    def test_the_export_compile_is_untouched(self, media_dir: Path, opened: _OpenedReaders) -> None:
        project = _edit()
        index = _index(project, media_dir)
        composite = compile_timeline(project, index, _grab_preset(project)[0])
        try:
            assert opened.files == {"x.mp4", "y.mp4", "z.mp4"}
            assert opened.audio == ["w.wav"]
            assert composite.audio is not None
        finally:
            close_clip_tree(composite)


class TestFallsBackToTheWholeTimeline:
    def test_a_blend_mode_composites_everything(
        self, media_dir: Path, opened: _OpenedReaders
    ) -> None:
        project = _edit(C={"blendMode": "screen"})
        assert picture_window_at(project, 0.5, KINDS) is None

        misses = FRAME_WINDOW_CACHE.misses
        grab_frame(project, media_dir, 0.5)
        assert opened.files == {"x.mp4", "y.mp4", "z.mp4"}
        assert FRAME_WINDOW_CACHE.misses == misses

    def test_an_instant_past_the_windowed_picture_is_the_full_frame(self, media_dir: Path) -> None:
        """A natural-rate clip whose source runs out before its timeline span does.

        B plays 0.5s of source on a 1s slot, so its layer stops at 1.5s. At 1.7s the window
        holds B and builds a composite that ends at 1.5s; the frame must come from the full
        compile, not from reading the windowed one past its end.
        """
        pytest.importorskip("PIL")
        from PIL import Image

        project = _edit(B={"sourceEnd": 1.0, "effects": []})
        t = 1.7
        window = picture_window_at(project, t, KINDS)
        assert window is not None and window.clip_ids == {"B"}

        index = _index(project, media_dir)
        preset, budget = _grab_preset(project)
        full = compile_timeline(
            project, index, preset, burn_captions=True, max_decode_dimension=budget
        )
        try:
            expected = np.asarray(full.get_frame(t)).copy()
        finally:
            close_clip_tree(full)

        misses = COMPOSITION_CACHE.misses
        frame = grab_frame(project, media_dir, t, image_format="png", max_dimension=GRAB_DIMENSION)
        decoded = np.asarray(Image.open(io.BytesIO(frame.data)).convert("RGB"))
        np.testing.assert_array_equal(decoded, expected[..., :3])
        assert COMPOSITION_CACHE.misses == misses + 1


class TestPictureWindowPlanning:
    """The window's arithmetic, without media."""

    def test_an_exact_cut_keeps_both_neighbours_and_nothing_else(self) -> None:
        window = picture_window_at(_edit(), 60 / FPS, KINDS)
        assert window is not None
        # The outgoing and incoming shots; not A, D, the title, a caption or the music.
        assert window.clip_ids == {"B", "C"}

    def test_titles_and_captions_join_the_window_they_are_on_screen_for(self) -> None:
        window = picture_window_at(_edit(), 0.95, KINDS)
        assert window is not None
        assert window.clip_ids == {"A", "B", "title", "cue1"}

    def test_a_track_matte_composites_everything(self) -> None:
        matte = {
            "id": "m",
            "kind": "layer",
            "enabled": True,
            "source": {"kind": "clip", "clipId": "A"},
        }
        project = _edit(C={"masks": [matte]})
        assert picture_window_at(project, 2.5, KINDS) is None

    def test_a_gap_composites_everything(self) -> None:
        project = _edit(D={"start": 3.5, "end": 4.0, "sourceEnd": 1.5})
        assert picture_window_at(project, 3.25, KINDS) is None

    def test_a_natural_rate_clip_reaches_as_far_as_its_source_span(self) -> None:
        clip = Clip.model_validate(_clip("c", "x", "v", 1.0, 2.0, sourceStart=0.0, sourceEnd=1.5))
        assert clip_reach(clip, "video") == (
            1.0 - REACH_SLACK_SECONDS,
            2.5 + REACH_SLACK_SECONDS,
        )
        # A still, title or caption plays for exactly its span whatever its source says.
        assert clip_reach(clip, "image") == (1.0 - REACH_SLACK_SECONDS, 2.0 + REACH_SLACK_SECONDS)

    def test_a_video_with_no_out_point_reaches_to_its_assets_end(self) -> None:
        clip = Clip.model_validate(_clip("c", "x", "v", 1.0, 2.0, sourceEnd=None))
        assert clip_reach(clip, "video")[1] == math.inf

    def test_a_retimed_clip_is_fitted_to_its_span(self) -> None:
        ramp = [{"id": "r0", "sourceTime": 0, "rate": 2}, {"id": "r1", "sourceTime": 1, "rate": 1}]
        ramped = Clip.model_validate(_clip("c", "x", "v", 1.0, 2.0, sourceEnd=3.0, speedRamp=ramp))
        sped = Clip.model_validate(_clip("d", "x", "v", 1.0, 2.0, sourceEnd=2.0, speed=2.0))
        for clip in (ramped, sped):
            assert clip_reach(clip, "video")[1] == 2.0 + REACH_SLACK_SECONDS

    def test_the_windowed_key_never_names_the_full_composition(self, tmp_path: Path) -> None:
        project = _edit()
        preset = _grab_preset(project)[0]
        full = composition_key(project, tmp_path, preset, burn_captions=True)
        window = composition_key(
            project, tmp_path, preset, burn_captions=True, window=frozenset({"A", "B"})
        )
        reordered = composition_key(
            project, tmp_path, preset, burn_captions=True, window=frozenset({"B", "A"})
        )
        assert window != full
        assert window == reordered
