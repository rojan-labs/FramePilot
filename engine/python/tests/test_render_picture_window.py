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
import numpy.typing as npt
import pytest
from pydantic import TypeAdapter

from framepilot_engine.media.assets import AssetIndex, index_assets
from framepilot_engine.render.compiler import compile_timeline
from framepilot_engine.render.compiler import compile_timeline as compile_timeline_for_real
from framepilot_engine.render.composition_cache import (
    COMPOSITION_CACHE,
    FRAME_WINDOW_CACHE,
    REVIEW_WINDOW_CACHE,
    BuildGate,
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
from framepilot_engine.render.resources import close_clip_tree as real_close_clip_tree
from framepilot_engine.timeline.models import Clip, Project
from framepilot_engine.validation import temporal_evidence as evidence_module
from framepilot_engine.validation.temporal_evidence import (
    RangeEvidenceRequest,
    ScopeEvidenceRequest,
    TemporalEvidenceCancelled,
    TemporalEvidenceRequest,
    acquire_temporal_evidence,
)

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


def _matted_edit(source: dict[str, Any], captions: dict[str, Any] | None = None) -> Project:
    """:func:`_edit` with shot C cut by a track matte reading ``source`` (AL33).

    The matte is a title on the titles track that starts before C and ends inside it, so C
    has instants where its source plays and instants where every source layer is idle — the
    case the window used to refuse. It grows while it plays (AL31: the matte follows it).
    """
    data = _edit(captions, C={"masks": [{"id": "tm", "kind": "layer", "source": source}]})
    payload = data.model_dump(mode="json", by_alias=True)
    # A source-space mask is resolved against the measured media size.
    for asset in payload["assets"]:
        if asset["kind"] == "video":
            asset["media"] = {"width": 160, "height": 96}
    titles = next(track for track in payload["timeline"]["tracks"] if track["id"] == "titles")
    titles["clips"].append(
        _clip(
            "matte_title",
            "__text__",
            "titles",
            1.9,
            2.6,
            effects=[
                {
                    "id": "matte_text",
                    "type": "text",
                    "params": {"text": "MATTE", "fontSizePercent": 30},
                    "keyframes": [],
                }
            ],
            keyframes=[
                {"id": "g0", "time": 0.0, "property": "scale", "value": 0.6},
                {"id": "g1", "time": 0.7, "property": "scale", "value": 1.4},
            ],
        )
    )
    return Project.model_validate(payload)


#: The matte source, as a clip and as its whole track (the track also holds ``title``).
MATTE_SOURCES = {
    "clip": {"kind": "clip", "clipId": "matte_title"},
    "track": {"kind": "track", "trackId": "titles"},
}
#: Instants of :func:`_matted_edit` either side of the matte source's span inside shot C.
MATTE_TIMES = (0.95, 1.95, 2.0, 2.3, 2.59, 2.6, 2.7, 2.95)


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

    @pytest.mark.parametrize("source", sorted(MATTE_SOURCES))
    def test_a_track_matte_frame_matches_the_whole_timeline_to_the_pixel(
        self, media_dir: Path, source: str
    ) -> None:
        """AL33: a shot cut by a track matte is windowed, and its frame is still the export's.

        Both while the matte's source plays (it is in the window and consumed as the matte)
        and after it ends (it is left out, and the matte is the same empty frame).
        """
        project = _matted_edit(MATTE_SOURCES[source])
        index = _index(project, media_dir)
        preset, budget = _grab_preset(project)
        full = compile_timeline(
            project, index, preset, burn_captions=True, max_decode_dimension=budget
        )
        try:
            reference = {t: np.asarray(full.get_frame(t)).copy() for t in MATTE_TIMES}
        finally:
            close_clip_tree(full)
        # The matte is not a no-op here: C shows only through the title's letters.
        assert not np.array_equal(reference[2.3], reference[2.7])

        for t in MATTE_TIMES:
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

    def test_a_grab_of_a_matted_shot_opens_only_that_shot(
        self, media_dir: Path, opened: _OpenedReaders
    ) -> None:
        """AL33: one track matte in the project no longer opens every clip for every grab."""
        misses = COMPOSITION_CACHE.misses
        grab_frame(_matted_edit(MATTE_SOURCES["clip"]), media_dir, 2.3)

        # C (z.mp4) and its title matte (no file); never A, B, D or the music.
        assert opened.files == {"z.mp4"}
        assert opened.audio == []
        assert COMPOSITION_CACHE.misses == misses

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


def _review_requests() -> list[TemporalEvidenceRequest]:
    """A post-edit review of :func:`_edit`, shaped like ``temporal-review.ts`` plans one.

    Representative frames plus five-frame windows around the A→B cut (its dissolve borrows A's
    handle as an under-layer), inside the dissolve, the B→C cut, the effect layer's end and the
    last frame; a comparison across the first cut; a scope across it.
    """
    common = {"schemaVersion": 1, "projectRevision": 0, "reason": "review"}
    adapter: TypeAdapter[TemporalEvidenceRequest] = TypeAdapter(TemporalEvidenceRequest)
    raw: list[dict[str, Any]] = [
        {"kind": "frame", "requestId": f"frame_{f}", "atFrame": f, "metrics": ["luma"]}
        for f in (0, 60, 105, 119)
    ]
    raw += [
        {
            "kind": "range",
            "requestId": f"range_{c}",
            "startFrame": c - 2,
            "endFrame": min(120, c + 3),
            "sampleEveryFrames": 1,
            "checks": ["black_frames", "flash_frames"],
        }
        for c in (30, 36, 60, 75, 119)
    ]
    raw.append(
        {
            "kind": "comparison",
            "requestId": "across_the_cut",
            "leftFrame": 29,
            "rightFrame": 31,
            "check": "transition_continuity",
            "maxDifference": 1,
        }
    )
    raw.append(
        {
            "kind": "scope",
            "requestId": "scope_cut",
            "startFrame": 28,
            "endFrame": 33,
            "channels": ["luma", "saturation", "skin_red"],
            "legalMin": 0.0625,
            "legalMax": 0.92,
        }
    )
    return [adapter.validate_python({**common, **request}) for request in raw]


class TestTemporalReviewSamplesAreTheExportFrames:
    """The post-edit review composites the clips on screen, and measures the export's frames.

    Run ``d8d2e445``'s review compiled all 29 clips for 16 frames (32.8s of 36.2s); it now
    compiles one window per run of frames. Pinned here: every sampled frame is the whole
    timeline's to the pixel, and every result the reviewer judges is unchanged.
    """

    @pytest.mark.parametrize("captions", [PLAIN_CAPTIONS, FROSTED_CAPTIONS], ids=["plain", "frost"])
    def test_every_sample_matches_the_whole_timeline_to_the_pixel(
        self, media_dir: Path, captions: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        project = _edit(captions)
        requests = _review_requests()
        sampled: dict[str, dict[int, npt.NDArray[np.uint8]]] = {}
        real_frame_sample = evidence_module._frame_sample
        real_scope_values = evidence_module._scope_values
        run = "windowed"

        def frame_sample(frame_index: int, pixels: npt.NDArray[np.uint8]) -> Any:
            sampled.setdefault(run, {})[frame_index] = pixels.copy()
            return real_frame_sample(frame_index, pixels)

        def scope_values(frame_index: int, pixels: npt.NDArray[np.uint8], channels: Any) -> Any:
            sampled.setdefault(f"{run}-scope", {})[frame_index] = pixels.copy()
            return real_scope_values(frame_index, pixels, channels)

        monkeypatch.setattr(evidence_module, "_frame_sample", frame_sample)
        monkeypatch.setattr(evidence_module, "_scope_values", scope_values)

        misses = COMPOSITION_CACHE.misses
        windowed = acquire_temporal_evidence(project, media_dir, requests)
        # Every instant of this edit has a window: nothing compiled the whole timeline.
        assert COMPOSITION_CACHE.misses == misses
        assert REVIEW_WINDOW_CACHE.misses > 0

        run = "whole"
        with monkeypatch.context() as whole_only:
            whole_only.setattr(evidence_module, "_review_windows", lambda *_a, **_k: {})
            whole = acquire_temporal_evidence(project, media_dir, requests)
        # The review's whole timeline is cached; the full-resolution scope's is the batch's own.
        assert COMPOSITION_CACHE.misses == misses + 1

        for kind in ("", "-scope"):
            expected, actual = sampled[f"whole{kind}"], sampled[f"windowed{kind}"]
            assert sorted(actual) == sorted(expected)
            for frame_index, pixels in expected.items():
                np.testing.assert_array_equal(actual[frame_index], pixels, f"{kind} {frame_index}")
        assert windowed.model_dump() == whole.model_dump()

    def test_a_review_opens_only_the_shots_it_samples_and_no_sound(
        self, media_dir: Path, opened: _OpenedReaders
    ) -> None:
        requests = [
            request
            for request in _review_requests()
            if isinstance(request, RangeEvidenceRequest) and request.start_frame == 34
        ]
        acquire_temporal_evidence(_edit(), media_dir, requests)

        # Frames 34-38 sit inside B's dissolve: B (y.mp4) and A's handle beneath it (x.mp4).
        assert opened.files == {"x.mp4", "y.mp4"}
        assert opened.audio == []


class TestScopeMeasurementWindow:
    """A scope (``measure_color``) samples its shot's first, middle and last frames.

    Planned per contiguous run those were three composites of the same shot at full
    resolution, each opening its own reader of it (run-3: six readers, ~2 GB resident, for one
    measurement). One window over the three instants gives the same frames.
    """

    def _scope(self) -> list[TemporalEvidenceRequest]:
        """Shot B whole, as ``measure_color`` asks: frames 30 (A→B), 45 (B) and 60 (B→C)."""
        scope = next(r for r in _review_requests() if isinstance(r, ScopeEvidenceRequest))
        return [scope.model_copy(update={"start_frame": 30, "end_frame": 61})]

    def _track_compiles(self, monkeypatch: pytest.MonkeyPatch) -> tuple[list[Any], list[Any]]:
        """Every composite the evidence module compiles, and every one it closes."""
        compiled: list[Any] = []
        closed: list[Any] = []

        def compile_timeline(*args: Any, **kwargs: Any) -> Any:
            composition = compile_timeline_for_real(*args, **kwargs)
            compiled.append(composition)
            return composition

        def close_clip_tree(clip: Any) -> None:
            closed.append(clip)
            real_close_clip_tree(clip)

        monkeypatch.setattr(f"{evidence_module.__name__}.compile_timeline", compile_timeline)
        monkeypatch.setattr(f"{evidence_module.__name__}.close_clip_tree", close_clip_tree)
        return compiled, closed

    def test_a_scope_compiles_one_windowed_composite_for_its_three_instants(
        self, media_dir: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        compiled, _closed = self._track_compiles(monkeypatch)
        result = acquire_temporal_evidence(_edit(), media_dir, self._scope())
        # Three instants with three different sets of clips on screen; one union holds them.
        assert len(compiled) == 1
        # And it measures the whole timeline's frames, number for number.
        monkeypatch.setattr(evidence_module, "_review_windows", lambda *_a, **_k: {})
        whole = acquire_temporal_evidence(_edit(), media_dir, self._scope())
        assert result.model_dump() == whole.model_dump()

    def test_a_scope_of_a_matted_shot_compiles_only_its_window(
        self, media_dir: Path, monkeypatch: pytest.MonkeyPatch, opened: _OpenedReaders
    ) -> None:
        """AL33: ``measure_color`` on a project with a track matte reads its shot, not them all.

        Run 15's six scopes each compiled the whole 65-clip timeline at full resolution
        because one opener clip carried a track matte; five timed out at 120 s.
        """
        compiled, _closed = self._track_compiles(monkeypatch)
        project = _matted_edit(MATTE_SOURCES["clip"])
        scope = self._scope()[0].model_copy(update={"start_frame": 64, "end_frame": 87})
        result = acquire_temporal_evidence(project, media_dir, [scope])
        assert len(compiled) == 1
        assert opened.files == {"z.mp4"}
        monkeypatch.setattr(evidence_module, "_review_windows", lambda *_a, **_k: {})
        whole = acquire_temporal_evidence(project, media_dir, [scope])
        assert result.model_dump() == whole.model_dump()

    def test_scope_composites_are_closed_before_the_batch_returns(
        self, media_dir: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Full-resolution scope readers must not linger in a cache after the measurement.

        Covers the windowed composite and the whole-timeline one a scope falls back to.
        """
        compiled, closed = self._track_compiles(monkeypatch)
        misses = (REVIEW_WINDOW_CACHE.misses, COMPOSITION_CACHE.misses)
        acquire_temporal_evidence(_edit(), media_dir, self._scope())
        monkeypatch.setattr(evidence_module, "_review_windows", lambda *_a, **_k: {})
        acquire_temporal_evidence(_edit(), media_dir, self._scope())

        assert len(compiled) == 2
        assert all(any(c is composition for c in closed) for composition in compiled)
        assert (REVIEW_WINDOW_CACHE.misses, COMPOSITION_CACHE.misses) == misses

    def test_two_scopes_of_one_shot_in_a_batch_share_one_composite(
        self, media_dir: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        compiled, closed = self._track_compiles(monkeypatch)
        first = self._scope()[0]
        again = first.model_copy(update={"request_id": "scope_again", "channels": ["luma"]})
        batch = acquire_temporal_evidence(_edit(), media_dir, [first, again])
        assert len(batch.results) == 2
        assert len(compiled) == 1
        assert closed == compiled

    def test_a_cancelled_wait_for_a_build_slot_is_a_cancelled_batch(
        self, media_dir: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Waiting behind another build must not make a batch the caller dropped uncancellable."""
        compiled, _closed = self._track_compiles(monkeypatch)
        gate = BuildGate(1)
        monkeypatch.setattr(evidence_module, "HEAVY_BUILD_GATE", gate)
        assert gate.acquire()  # another build holds the only slot
        try:
            polls = iter(range(1_000_000))
            # Not cancelled at the entry checks; cancelled by the time it waits for the slot.
            with pytest.raises(TemporalEvidenceCancelled):
                acquire_temporal_evidence(
                    _edit(), media_dir, self._scope(), lambda: next(polls) > 3
                )
        finally:
            gate.release()
        assert compiled == []  # it never built
        assert gate.acquire(lambda: True) is True  # and took no slot with it
        gate.release()


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

    def test_a_track_matte_is_windowed_with_the_source_playing_beside_it(self) -> None:
        project = _matted_edit({"kind": "clip", "clipId": "matte_title"})
        # The source plays at 2.3s, so it joins its reader's window ...
        playing = picture_window_at(project, 2.3, KINDS)
        assert playing is not None and playing.clip_ids == {"C", "cue2", "matte_title"}
        # ... and at 2.8s it is idle: an idle source draws the empty matte, so it stays out.
        idle = picture_window_at(project, 2.8, KINDS)
        assert idle is not None and idle.clip_ids == {"C", "cue2"}

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
