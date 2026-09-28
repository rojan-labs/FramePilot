"""Tests for the multi-source sheet (``render/source_sheet.py``, ``/render/frame { sources }``).

Real generated media through the real compiler, like ``test_render_frame_grab.py``: the tile
order and labels are the model's only way to refer back to what it saw, so they are checked
on the actual pixels, not on a mocked layout.
"""

from __future__ import annotations

import base64
import io
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from framepilot_engine.render.frame_grab import FrameGrabError
from framepilot_engine.render.source_sheet import (
    MAX_SHEET_SOURCES,
    SheetSource,
    grab_source_sheet,
    grid_shape,
)
from framepilot_engine.timeline.models import Project

#: (asset id, file, ffmpeg colour, expected dominant channel) — one colour per source so a
#: tile's centre pixel says which source it is.
_SOURCES = (
    ("a_red", "red.mp4", "red", 0),
    ("a_green", "green.mp4", "lime", 1),
    ("a_blue", "blue.mp4", "blue", 2),
)


def _project(extra_assets: list[dict[str, Any]] | None = None) -> Project:
    assets: list[dict[str, Any]] = [
        {
            "id": asset_id,
            "path": path,
            "kind": "video",
            "durationSeconds": 2.0,
            "media": {"width": 640, "height": 360},
        }
        for asset_id, path, _color, _channel in _SOURCES
    ]
    assets += extra_assets or []
    return Project.model_validate(
        {
            "id": "p1",
            "name": "T",
            "fps": 30,
            "resolution": {"width": 360, "height": 640},
            "assets": assets,
            "timeline": {"tracks": [{"id": "v", "type": "video", "clips": []}]},
        }
    )


@pytest.fixture
def media_dir(media_factory: Callable[..., Path], tmp_project_dir: Path) -> Path:
    """Three 2s 640x360 clips — red, green, blue — inside the project sandbox."""
    for _asset_id, path, color, _channel in _SOURCES:
        src = media_factory(path, seconds=2.0, with_audio=False, color=color, size="640x360")
        (tmp_project_dir / path).write_bytes(src.read_bytes())
    return tmp_project_dir


def _decode(data: bytes) -> Any:
    from PIL import Image

    return Image.open(io.BytesIO(data)).convert("RGB")


def _cells(width: int, height: int, columns: int, rows: int) -> list[tuple[int, int, int, int]]:
    """Each tile's (picture box) as the layout draws it: 4px gaps, label strip under it."""
    from framepilot_engine.render import source_sheet

    gap = source_sheet._GAP
    cell_w = (width - (columns + 1) * gap) // columns
    row_h = (height - (rows + 1) * gap) // rows
    return [
        (gap + c * (cell_w + gap), gap + r * (row_h + gap), cell_w, row_h)
        for r in range(rows)
        for c in range(columns)
    ]


class TestGridShape:
    @pytest.mark.parametrize(
        ("count", "shape"),
        [
            (1, (1, 1)),
            (2, (2, 1)),
            (3, (2, 2)),
            (4, (2, 2)),
            (6, (3, 2)),
            (9, (3, 3)),
            (12, (4, 3)),
        ],
    )
    def test_is_as_square_as_possible_and_never_taller_than_wide(
        self, count: int, shape: tuple[int, int]
    ) -> None:
        assert grid_shape(count) == shape

    def test_refuses_zero(self) -> None:
        with pytest.raises(FrameGrabError):
            grid_shape(0)


class TestTileLabel:
    def test_a_narrow_tile_shortens_the_name_and_keeps_the_index_and_time(self) -> None:
        pytest.importorskip("PIL")
        from framepilot_engine.render.source_sheet import _load_font, _tile_label

        font = _load_font(12)
        wide = _tile_label(7, "camp-breakfast.mp4", 4.4, font, 400)
        narrow = _tile_label(7, "camp-breakfast.mp4", 4.4, font, 110)
        assert wide == "7  camp-breakfast.mp4  4.4s"
        assert narrow.startswith("7  ")
        assert narrow.endswith("…  4.4s")
        assert font.getlength(narrow) <= 110


class TestGrabSourceSheet:
    def test_tiles_are_in_the_order_asked_and_each_shows_its_source(self, media_dir: Path) -> None:
        pytest.importorskip("PIL")
        order = ["a_blue", "a_red", "a_green"]
        sheet = grab_source_sheet(
            _project(), media_dir, [SheetSource(asset_id) for asset_id in order], image_format="png"
        )
        assert [tile.asset_id for tile in sheet.tiles] == order
        assert [tile.index for tile in sheet.tiles] == [1, 2, 3]
        assert [tile.name for tile in sheet.tiles] == ["blue.mp4", "red.mp4", "green.mp4"]
        assert (sheet.columns, sheet.rows) == (2, 2)
        image = _decode(sheet.data)
        channel = {asset_id: ch for asset_id, _p, _c, ch in _SOURCES}
        for (x, y, w, h), asset_id in zip(
            _cells(image.width, image.height, 2, 2), order, strict=False
        ):
            # The picture's centre (above the label strip) is the source's colour.
            pixel = image.getpixel((x + w // 2, y + h // 3))
            assert max(range(3), key=lambda i: pixel[i]) == channel[asset_id], (asset_id, pixel)

    def test_every_tile_carries_a_label_and_the_empty_cell_does_not(self, media_dir: Path) -> None:
        pytest.importorskip("PIL")
        from framepilot_engine.render import source_sheet

        sheet = grab_source_sheet(
            _project(),
            media_dir,
            [SheetSource(asset_id) for asset_id, *_rest in _SOURCES],
            image_format="png",
        )
        image = _decode(sheet.data)
        cells = _cells(image.width, image.height, 2, 2)
        font_size = max(12, min(18, 1024 // 64))
        label_h = font_size + 8
        white_counts = []
        for x, y, w, h in cells:
            strip = image.crop((x, y + h - label_h, x + w, y + h))
            white_counts.append(sum(1 for px in strip.getdata() if min(px) > 200))
        assert all(count > 20 for count in white_counts[:3]), white_counts
        assert white_counts[3] == 0
        assert max(image.size) == source_sheet.DEFAULT_SHEET_MAX_DIMENSION

    def test_omitted_seconds_is_the_middle_and_named_seconds_are_kept(
        self, media_dir: Path
    ) -> None:
        pytest.importorskip("PIL")
        sheet = grab_source_sheet(
            _project(),
            media_dir,
            [SheetSource("a_red"), SheetSource("a_red", 0.5), SheetSource("a_red", 99.0)],
        )
        assert sheet.tiles[0].seconds == pytest.approx(1.0)
        assert sheet.tiles[1].seconds == pytest.approx(0.5)
        # Clamped into the file, and reported as what was actually shown.
        assert sheet.tiles[2].seconds < 2.0
        assert all(tile.duration_seconds == pytest.approx(2.0) for tile in sheet.tiles)

    def test_the_whole_sheet_honours_max_dimension(self, media_dir: Path) -> None:
        pytest.importorskip("PIL")
        sources = [SheetSource(asset_id) for asset_id, *_rest in _SOURCES]
        sheet = grab_source_sheet(_project(), media_dir, sources, max_dimension=512)
        assert max(sheet.width, sheet.height) <= 512
        assert max(_decode(sheet.data).size) <= 512

    def test_is_deterministic(self, media_dir: Path) -> None:
        pytest.importorskip("PIL")
        sources = [SheetSource(asset_id) for asset_id, *_rest in _SOURCES]
        first = grab_source_sheet(_project(), media_dir, sources, image_format="png")
        second = grab_source_sheet(_project(), media_dir, sources, image_format="png")
        assert first.data == second.data

    def test_leaves_the_timeline_frame_cache_alone(self, media_dir: Path) -> None:
        """Twelve one-off source views must not evict the timeline windows the agent reuses."""
        pytest.importorskip("PIL")
        from framepilot_engine.render.composition_cache import FRAME_WINDOW_CACHE

        before = (FRAME_WINDOW_CACHE.hits, FRAME_WINDOW_CACHE.misses)
        grab_source_sheet(
            _project(), media_dir, [SheetSource(asset_id) for asset_id, *_rest in _SOURCES]
        )
        assert (FRAME_WINDOW_CACHE.hits, FRAME_WINDOW_CACHE.misses) == before

    def test_tiles_take_the_process_wide_build_gate_for_their_whole_life(
        self, media_dir: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Four tile workers, but never more composites alive than the heavy gate allows.

        The tiles are uncached, so nothing but the gate stops them stacking their readers on
        top of a review's or a grab's (run-3's memory watchdog).
        """
        pytest.importorskip("PIL")
        import threading

        from framepilot_engine.render import frame_grab
        from framepilot_engine.render.composition_cache import BuildGate

        monkeypatch.setattr(frame_grab, "HEAVY_BUILD_GATE", BuildGate(1))
        alive = 0
        peak = 0
        lock = threading.Lock()
        from framepilot_engine.render.compiler import compile_timeline as real_compile
        from framepilot_engine.render.resources import close_clip_tree as real_close

        def compile_timeline(*args: Any, **kwargs: Any) -> Any:
            nonlocal alive, peak
            with lock:
                alive += 1
                peak = max(peak, alive)
            return real_compile(*args, **kwargs)

        def close_clip_tree(clip: Any) -> None:
            nonlocal alive
            real_close(clip)
            with lock:
                alive -= 1

        monkeypatch.setattr(f"{frame_grab.__name__}.compile_timeline", compile_timeline)
        monkeypatch.setattr(f"{frame_grab.__name__}.close_clip_tree", close_clip_tree)
        sheet = grab_source_sheet(
            _project(), media_dir, [SheetSource(asset_id) for asset_id, *_rest in _SOURCES]
        )
        assert all(tile.error is None for tile in sheet.tiles)
        assert peak == 1
        assert alive == 0

    def test_refuses_more_than_the_cap(self, media_dir: Path) -> None:
        sources = [SheetSource("a_red")] * (MAX_SHEET_SOURCES + 1)
        with pytest.raises(FrameGrabError, match="at most 12"):
            grab_source_sheet(_project(), media_dir, sources)

    def test_refuses_no_sources(self, media_dir: Path) -> None:
        with pytest.raises(FrameGrabError, match="at least one"):
            grab_source_sheet(_project(), media_dir, [])

    def test_names_every_unknown_asset(self, media_dir: Path) -> None:
        with pytest.raises(FrameGrabError, match="Asset not found: nope, gone"):
            grab_source_sheet(
                _project(),
                media_dir,
                [SheetSource("nope"), SheetSource("a_red"), SheetSource("gone")],
            )

    def test_refuses_an_audio_asset(self, media_dir: Path) -> None:
        project = _project([{"id": "song", "path": "song.mp3", "kind": "audio"}])
        with pytest.raises(FrameGrabError, match="No picture to show for song"):
            grab_source_sheet(project, media_dir, [SheetSource("a_red"), SheetSource("song")])

    def test_a_missing_file_is_a_labelled_error_tile_not_a_failed_sheet(
        self, media_dir: Path
    ) -> None:
        pytest.importorskip("PIL")
        project = _project(
            [
                {
                    "id": "lost",
                    "path": "lost.mp4",
                    "kind": "video",
                    "durationSeconds": 2.0,
                    "media": {"width": 640, "height": 360},
                }
            ]
        )
        sheet = grab_source_sheet(project, media_dir, [SheetSource("a_red"), SheetSource("lost")])
        assert sheet.tiles[0].error is None
        assert sheet.tiles[1].error


class TestRenderFrameRouteSources:
    def _client(self, base: Path) -> Any:
        from fastapi.testclient import TestClient

        from framepilot_engine.config import Settings
        from framepilot_engine.service import create_app

        return TestClient(create_app(Settings(projects_root=base)))

    def test_serves_one_sheet_with_its_tiles_in_order(self, media_dir: Path) -> None:
        pytest.importorskip("PIL")
        response = self._client(media_dir).post(
            "/render/frame",
            json={
                "project": _project().model_dump(by_alias=True, mode="json"),
                "sources": [
                    {"asset_id": "a_green", "source_seconds": 0.25},
                    {"asset_id": "a_red"},
                ],
                "max_dimension": 640,
            },
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert [tile["asset_id"] for tile in body["tiles"]] == ["a_green", "a_red"]
        assert [tile["index"] for tile in body["tiles"]] == [1, 2]
        assert body["tiles"][0]["source_seconds"] == pytest.approx(0.25)
        assert body["tiles"][1]["source_seconds"] == pytest.approx(1.0)
        assert max(body["width"], body["height"]) <= 640
        image = _decode(base64.b64decode(body["base64"]))
        assert image.size == (body["width"], body["height"])

    @pytest.mark.parametrize(
        "extra",
        [{"time_seconds": 1.0}, {"asset_id": "a_red"}, {"source_seconds": 1.0}],
    )
    def test_sources_exclude_the_other_modes(self, media_dir: Path, extra: dict[str, Any]) -> None:
        response = self._client(media_dir).post(
            "/render/frame",
            json={
                "project": _project().model_dump(by_alias=True, mode="json"),
                "sources": [{"asset_id": "a_red"}],
                **extra,
            },
        )
        assert response.status_code == 422

    @pytest.mark.parametrize("count", [0, MAX_SHEET_SOURCES + 1])
    def test_refuses_an_empty_or_over_cap_list(self, media_dir: Path, count: int) -> None:
        response = self._client(media_dir).post(
            "/render/frame",
            json={
                "project": _project().model_dump(by_alias=True, mode="json"),
                "sources": [{"asset_id": "a_red"}] * count,
            },
        )
        assert response.status_code == 422

    def test_an_unknown_asset_is_a_422_with_the_reason(self, media_dir: Path) -> None:
        response = self._client(media_dir).post(
            "/render/frame",
            json={
                "project": _project().model_dump(by_alias=True, mode="json"),
                "sources": [{"asset_id": "nope"}],
            },
        )
        assert response.status_code == 422
        assert "Asset not found: nope" in response.json()["detail"]
