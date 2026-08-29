"""Tests for the single-frame grab (``render/frame_grab.py`` and ``POST /render/frame``).

These exercise the real compiler against real generated media — the whole point
of the module is that the model inspects what the export actually produces, so a
test that mocked the compile away would be testing nothing worth testing.
"""

from __future__ import annotations

import base64
import io
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from framepilot_engine.render.compiler import compile_timeline as real_compile
from framepilot_engine.render.frame_grab import (
    MAX_ALLOWED_DIMENSION,
    FrameGrabError,
    _fit_within,
    grab_frame,
)
from framepilot_engine.timeline.models import Project

#: Patched by name rather than by module attribute: `frame_grab` re-imports this
#: symbol, and reaching through the module to read it trips mypy's
#: no-implicit-reexport.
_COMPILE_TARGET = "framepilot_engine.render.frame_grab.compile_timeline"


def _video_project(
    asset_path: str = "clip.mp4",
    *,
    seconds: float = 1.0,
    width: int = 640,
    height: int = 360,
) -> Project:
    """A one-video-track project referencing ``asset_path``."""
    return Project.model_validate(
        {
            "id": "p1",
            "name": "T",
            "fps": 30,
            "resolution": {"width": width, "height": height},
            "assets": [{"id": "a1", "path": asset_path, "kind": "video"}],
            "timeline": {
                "tracks": [
                    {
                        "id": "v",
                        "type": "video",
                        "clips": [
                            {
                                "id": "c1",
                                "assetId": "a1",
                                "trackId": "v",
                                "start": 0.0,
                                "end": seconds,
                                "sourceStart": 0.0,
                                "sourceEnd": seconds,
                            }
                        ],
                    }
                ]
            },
        }
    )


def _place_asset(media_factory: Callable[..., Path], base: Path, name: str, **kw: Any) -> None:
    src = media_factory(name, **kw)
    (base / name).write_bytes(src.read_bytes())


@pytest.fixture
def project_with_media(
    media_factory: Callable[..., Path], tmp_project_dir: Path
) -> tuple[Project, Path]:
    """A 2s red 640x360 clip, on disk inside the project sandbox."""
    _place_asset(
        media_factory,
        tmp_project_dir,
        "clip.mp4",
        seconds=2.0,
        with_audio=False,
        color="red",
        size="640x360",
    )
    return _video_project(seconds=2.0), tmp_project_dir


class TestFitWithin:
    def test_leaves_an_already_small_frame_alone(self) -> None:
        assert _fit_within(320, 180, 512) == (320, 180)

    def test_scales_the_longest_edge_down_and_keeps_the_aspect(self) -> None:
        assert _fit_within(1920, 1080, 480) == (480, 270)
        assert _fit_within(1080, 1920, 480) == (270, 480)

    def test_never_scales_up(self) -> None:
        # Asking for more pixels than the source has would cost more tokens for an
        # interpolated blur — see the function's note.
        assert _fit_within(320, 180, 4000) == (320, 180)

    def test_keeps_at_least_one_pixel_on_a_degenerate_aspect(self) -> None:
        width, height = _fit_within(4000, 1, 100)
        assert (width, height) == (100, 1)


class TestGrabFrame:
    def test_renders_a_jpeg_of_the_project_resolution_by_default(
        self, project_with_media: tuple[Project, Path]
    ) -> None:
        pytest.importorskip("PIL")
        from PIL import Image

        project, base = project_with_media
        frame = grab_frame(project, base, 1.0)

        assert frame.media_type == "image/jpeg"
        assert frame.time_seconds == pytest.approx(1.0)
        assert frame.duration_seconds == pytest.approx(2.0)
        # The project is 640x360, so its long edge exceeds the 512 default and the
        # frame comes back scaled to 512 wide with the aspect kept.
        assert max(frame.width, frame.height) == 512
        decoded = Image.open(io.BytesIO(base64.b64decode(frame.base64)))
        assert decoded.size == (frame.width, frame.height)

    def test_clamps_a_time_past_the_end_to_the_last_frame(
        self, project_with_media: tuple[Project, Path]
    ) -> None:
        pytest.importorskip("PIL")
        project, base = project_with_media
        # Exactly the duration is PAST the last frame; a model asking "show me the
        # end" must get the end, not an error about float boundaries.
        frame = grab_frame(project, base, 2.0)
        assert frame.time_seconds < 2.0
        assert frame.time_seconds == pytest.approx(2.0 - 1 / 30, abs=1e-6)

    def test_clamps_a_negative_time_to_the_start(
        self, project_with_media: tuple[Project, Path]
    ) -> None:
        pytest.importorskip("PIL")
        project, base = project_with_media
        assert grab_frame(project, base, -5.0).time_seconds == 0.0

    def test_honours_png_and_a_larger_max_dimension(
        self, project_with_media: tuple[Project, Path]
    ) -> None:
        pytest.importorskip("PIL")
        project, base = project_with_media
        frame = grab_frame(project, base, 0.5, image_format="png", max_dimension=640)
        assert frame.media_type == "image/png"
        assert (frame.width, frame.height) == (640, 360)

    def test_clamps_an_over_large_request_to_the_ceiling(
        self, project_with_media: tuple[Project, Path]
    ) -> None:
        pytest.importorskip("PIL")
        project, base = project_with_media
        # The source is only 640 wide, so the ceiling clamp is observable as "no
        # upscale" rather than as MAX_ALLOWED_DIMENSION pixels.
        frame = grab_frame(project, base, 0.5, max_dimension=MAX_ALLOWED_DIMENSION * 10)
        assert max(frame.width, frame.height) <= MAX_ALLOWED_DIMENSION

    def test_refuses_an_unknown_format_by_name(
        self, project_with_media: tuple[Project, Path]
    ) -> None:
        project, base = project_with_media
        with pytest.raises(FrameGrabError, match="gif"):
            grab_frame(project, base, 0.0, image_format="gif")

    def test_refuses_an_empty_timeline_with_a_readable_reason(self, tmp_project_dir: Path) -> None:
        empty = Project.model_validate(
            {"id": "p", "name": "T", "timeline": {"tracks": [{"id": "v", "type": "video"}]}}
        )
        with pytest.raises(FrameGrabError, match="no frame to render"):
            grab_frame(empty, tmp_project_dir, 0.0)


class TestRenderFrameRoute:
    """``POST /render/frame`` — the sidecar surface the ``get_frame`` tool calls."""

    def test_serves_the_frame_inline_as_base64(
        self, project_with_media: tuple[Project, Path]
    ) -> None:
        pytest.importorskip("PIL")
        from fastapi.testclient import TestClient

        from framepilot_engine.config import Settings
        from framepilot_engine.service import create_app

        project, base = project_with_media
        project_file = base / "project.fp.json"
        project_file.write_text(project.model_dump_json(by_alias=True), encoding="utf-8")

        client = TestClient(create_app(Settings(projects_root=str(base.parent))))
        response = client.post(
            "/render/frame",
            json={"project_path": str(project_file), "time_seconds": 1.0},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["media_type"] == "image/jpeg"
        assert body["time_seconds"] == pytest.approx(1.0)
        assert body["duration_seconds"] == pytest.approx(2.0)
        # Real bytes, not a placeholder: it decodes, and to the reported size.
        assert len(base64.b64decode(body["base64"])) > 0

    def test_reports_an_unrenderable_request_as_422_with_the_reason(
        self, tmp_project_dir: Path
    ) -> None:
        from fastapi.testclient import TestClient

        from framepilot_engine.config import Settings
        from framepilot_engine.service import create_app

        empty = Project.model_validate(
            {"id": "p", "name": "T", "timeline": {"tracks": [{"id": "v", "type": "video"}]}}
        )
        project_file = tmp_project_dir / "project.fp.json"
        project_file.write_text(empty.model_dump_json(by_alias=True), encoding="utf-8")

        client = TestClient(create_app(Settings(projects_root=str(tmp_project_dir.parent))))
        response = client.post(
            "/render/frame",
            json={"project_path": str(project_file), "time_seconds": 0.0},
        )
        assert response.status_code == 422
        assert "no frame to render" in response.json()["detail"]

    def test_renders_the_inline_working_copy_the_agent_actually_holds(
        self, project_with_media: tuple[Project, Path]
    ) -> None:
        """The agent's unsaved edits must be what the frame shows.

        A path-only route would render the timeline as it was BEFORE the edit
        under review, which is the one picture that cannot answer "did my change
        look right?".
        """
        pytest.importorskip("PIL")
        from fastapi.testclient import TestClient

        from framepilot_engine.config import Settings
        from framepilot_engine.service import create_app

        project, base = project_with_media
        # Nothing is written to disk: only the in-memory document is sent.
        client = TestClient(create_app(Settings(projects_root=base)))
        response = client.post(
            "/render/frame",
            json={
                "project": project.model_dump(by_alias=True, mode="json"),
                "time_seconds": 0.5,
            },
        )
        assert response.status_code == 200, response.text
        assert len(base64.b64decode(response.json()["base64"])) > 0

    def test_refuses_a_request_that_names_neither_a_path_nor_a_document(self) -> None:
        from fastapi.testclient import TestClient

        from framepilot_engine.config import Settings
        from framepilot_engine.service import create_app

        client = TestClient(create_app(Settings()))
        response = client.post("/render/frame", json={"time_seconds": 0.0})
        assert response.status_code == 422


class TestCompositeSizedToTheRequest:
    """A picture for a model to look at has no reason to be composited at UHD.

    The result is downscaled to `max_dimension` before it is ever returned, so
    compositing the project's full resolution first decodes ~25 MB per source
    and throws away almost all of it. The export path still reads masters; this
    one does not have to.
    """

    def test_composites_and_decodes_at_the_size_asked_for(
        self,
        media_factory: Callable[..., Path],
        tmp_project_dir: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        _place_asset(
            media_factory,
            tmp_project_dir,
            "clip.mp4",
            seconds=1.0,
            with_audio=False,
            size="640x480",
        )
        project = _video_project(seconds=1.0, width=640, height=480)
        seen: list[tuple[int, int, int | None]] = []

        def _spy(*args: Any, **kwargs: Any) -> Any:
            preset = args[2]
            seen.append((preset.width, preset.height, kwargs.get("max_decode_dimension")))
            return real_compile(*args, **kwargs)

        monkeypatch.setattr(_COMPILE_TARGET, _spy)
        frame = grab_frame(project, tmp_project_dir, 0.0, max_dimension=160)

        assert (frame.width, frame.height) == (160, 120)
        # The composite was BUILT at the answer's size, and no source was decoded
        # larger than that — not composited at 640x480 and shrunk afterwards.
        assert seen == [(160, 120, 160)]

    def test_never_composites_larger_than_the_project(
        self,
        project_with_media: tuple[Project, Path],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Asking for more pixels than the project has must not upscale the composite."""
        project, base = project_with_media
        seen: list[tuple[int, int]] = []

        def _spy(*args: Any, **kwargs: Any) -> Any:
            seen.append((args[2].width, args[2].height))
            return real_compile(*args, **kwargs)

        monkeypatch.setattr(_COMPILE_TARGET, _spy)
        grab_frame(project, base, 0.0, max_dimension=MAX_ALLOWED_DIMENSION)

        # The project is 640x360 and the request allows 1280; the composite stays
        # at the project's own resolution.
        assert seen == [(640, 360)]

    def test_a_named_export_preset_is_composited_as_authored(
        self,
        project_with_media: tuple[Project, Path],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Naming a preset is a question about that format, so its frame is not resized.

        The returned IMAGE is still downscaled for the prompt; the composite is
        not, because a 9:16 Reels question must be composited as 9:16.
        """
        project, base = project_with_media
        seen: list[tuple[int, int]] = []

        def _spy(*args: Any, **kwargs: Any) -> Any:
            seen.append((args[2].width, args[2].height))
            return real_compile(*args, **kwargs)

        monkeypatch.setattr(_COMPILE_TARGET, _spy)
        frame = grab_frame(project, base, 0.0, max_dimension=256)

        # Composites at the size of the answer, in the project's aspect — never larger.
        assert len(seen) == 1 and max(seen[0]) <= 256
        assert max(frame.width, frame.height) == 256
