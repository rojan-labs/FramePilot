"""Tests for deterministic composition teardown (``render/resources.py``).

The unit tests pin the traversal contract with fakes (a real composition is not
needed to prove "every node is closed exactly once"). The leak regression at the
bottom uses REAL media and counts live ``ffmpeg`` child processes, because the
bug this module exists for was invisible to any test that mocked MoviePy away:
``CompositeVideoClip.close()`` returned happily while leaving one stalled ffmpeg
per source clip alive.
"""

from __future__ import annotations

import os
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from framepilot_engine.render.resources import close_clip_tree
from framepilot_engine.timeline.models import Project


class FakeClip:
    """A clip whose children mirror the attributes MoviePy compositions use."""

    def __init__(
        self,
        name: str,
        *,
        clips: list[FakeClip] | None = None,
        audio: FakeClip | None = None,
        mask: FakeClip | None = None,
        bg: FakeClip | None = None,
        raises: bool = False,
    ) -> None:
        self.name = name
        self.clips = clips
        self.audio = audio
        self.mask = mask
        self.bg = bg
        self.raises = raises
        self.close_count = 0

    def close(self) -> None:
        self.close_count += 1
        if self.raises:
            raise RuntimeError(f"{self.name} refuses to close")


class TestCloseClipTree:
    def test_closes_composited_clips_not_just_the_root(self) -> None:
        # The actual bug: MoviePy closes the root and stops.
        sources = [FakeClip("source-1"), FakeClip("source-2")]
        root = FakeClip("composite", clips=sources)

        assert close_clip_tree(root) == 3
        assert [clip.close_count for clip in sources] == [1, 1]
        assert root.close_count == 1

    def test_closes_audio_mask_and_background_children(self) -> None:
        audio, mask, bg = FakeClip("audio"), FakeClip("mask"), FakeClip("bg")
        root = FakeClip("composite", audio=audio, mask=mask, bg=bg)

        close_clip_tree(root)

        assert (audio.close_count, mask.close_count, bg.close_count) == (1, 1, 1)

    def test_closes_nested_compositions_transitively(self) -> None:
        leaf = FakeClip("leaf")
        inner = FakeClip("inner", clips=[leaf])
        root = FakeClip("root", clips=[inner])

        close_clip_tree(root)

        assert leaf.close_count == 1

    def test_closes_a_shared_clip_exactly_once(self) -> None:
        # MoviePy's `with_*` helpers return copies that SHARE one reader, so the
        # same object legitimately appears under several parents.
        shared = FakeClip("shared")
        root = FakeClip("root", clips=[shared, shared], audio=shared)

        close_clip_tree(root)

        assert shared.close_count == 1

    def test_terminates_on_a_cycle(self) -> None:
        a = FakeClip("a")
        b = FakeClip("b", clips=[a])
        a.clips = [b]  # cycle

        assert close_clip_tree(a) == 2

    def test_one_failing_close_does_not_strand_the_rest(self) -> None:
        # Teardown runs in a `finally`; a raising node must not keep the readers
        # behind it alive (that would reintroduce the leak on the error path).
        good = FakeClip("good")
        root = FakeClip("root", clips=[FakeClip("bad", raises=True), good])

        close_clip_tree(root)

        assert good.close_count == 1

    def test_skips_children_that_are_not_clips(self) -> None:
        root = FakeClip("root", clips=[])
        root.audio = None
        assert close_clip_tree(root) == 1

    def test_none_is_a_no_op(self) -> None:
        assert close_clip_tree(None) == 0

    def test_a_node_without_close_is_traversed_but_not_counted(self) -> None:
        class Opaque:
            def __init__(self) -> None:
                self.clips = [FakeClip("child")]

        opaque = Opaque()
        assert close_clip_tree(opaque) == 1
        assert opaque.clips[0].close_count == 1


def _live_children() -> list[str]:
    """PIDs of this process's live children — the leaked ffmpeg readers."""
    result = subprocess.run(
        ["pgrep", "-P", str(os.getpid())], capture_output=True, text=True, check=False
    )
    return [pid for pid in result.stdout.split() if pid]


class TestFrameGrabLeavesNoFfmpegBehind:
    """Regression: every frame grab used to leak one ffmpeg per source clip.

    In the long-lived sidecar those stalled readers accumulated until the machine
    ran out of memory (128 processes / 51 GB observed in the field), so this
    asserts on real process count, not on a mock's call log.
    """

    @pytest.mark.skipif(os.name == "nt", reason="pgrep -P is POSIX-only")
    def test_repeated_grabs_do_not_accumulate_ffmpeg_processes(
        self, media_factory: Callable[..., Path], tmp_project_dir: Path
    ) -> None:
        pytest.importorskip("PIL")
        from framepilot_engine.render.frame_grab import grab_frame

        for name in ("a.mp4", "b.mp4"):
            source = media_factory(name, seconds=2.0, with_audio=True, size="320x180")
            (tmp_project_dir / name).write_bytes(source.read_bytes())

        def clip(clip_id: str, asset_id: str, start: float) -> dict[str, Any]:
            return {
                "id": clip_id,
                "assetId": asset_id,
                "trackId": "v",
                "start": start,
                "end": start + 1.0,
                "sourceStart": 0.0,
                "sourceEnd": 1.0,
            }

        project = Project.model_validate(
            {
                "id": "leak",
                "name": "leak",
                "fps": 30,
                "resolution": {"width": 320, "height": 180},
                "assets": [
                    {"id": "a1", "path": "a.mp4", "kind": "video"},
                    {"id": "a2", "path": "b.mp4", "kind": "video"},
                ],
                "timeline": {
                    "tracks": [
                        {
                            "id": "v",
                            "type": "video",
                            "clips": [clip("c1", "a1", 0.0), clip("c2", "a2", 1.0)],
                        }
                    ]
                },
            }
        )

        grab_frame(project, tmp_project_dir, 0.5)  # warm-up: ignore one-off setup
        baseline = len(_live_children())

        for _ in range(3):
            grab_frame(project, tmp_project_dir, 0.5)

        assert len(_live_children()) <= baseline


class TestFailedCompileLeavesNoFfmpegBehind:
    """Regression: a compile that RAISES used to abandon what it had already opened.

    ``close_clip_tree`` releases a composition that was built and returned. A
    compile that failed on a later clip — a missing asset, an unreadable LUT —
    returned nothing, so there was nothing for any caller to close, and the
    readers for the earlier clips stayed alive. Same stalled-ffmpeg failure as the
    grab leak above, reached through the one path the original fix did not cover.
    """

    @pytest.mark.skipif(os.name == "nt", reason="pgrep -P is POSIX-only")
    def test_a_compile_that_raises_closes_the_clips_it_already_opened(
        self, media_factory: Callable[..., Path], tmp_project_dir: Path
    ) -> None:
        pytest.importorskip("PIL")
        from framepilot_engine.media.assets import index_assets
        from framepilot_engine.render.compiler import CompileError, compile_timeline
        from framepilot_engine.render.presets import ExportPreset

        source = media_factory("a.mp4", seconds=2.0, with_audio=True, size="320x180")
        (tmp_project_dir / "a.mp4").write_bytes(source.read_bytes())

        def clip(clip_id: str, asset_id: str, start: float) -> dict[str, Any]:
            return {
                "id": clip_id,
                "assetId": asset_id,
                "trackId": "v",
                "start": start,
                "end": start + 1.0,
                "sourceStart": 0.0,
                "sourceEnd": 1.0,
            }

        project = Project.model_validate(
            {
                "id": "partial",
                "name": "partial",
                "fps": 30,
                "resolution": {"width": 320, "height": 180},
                # Several good clips open readers before the bad one is reached.
                "assets": [{"id": "a1", "path": "a.mp4", "kind": "video"}],
                "timeline": {
                    "tracks": [
                        {
                            "id": "v",
                            "type": "video",
                            "clips": [
                                clip("c1", "a1", 0.0),
                                clip("c2", "a1", 1.0),
                                clip("c3", "a1", 2.0),
                                # Unknown asset: `_resolve_clip_asset` raises here,
                                # after c1-c3 already own live ffmpeg readers.
                                clip("c4", "missing", 3.0),
                            ],
                        }
                    ]
                },
            }
        )
        assets = index_assets(
            [asset.model_dump(mode="json") for asset in project.assets],
            base_dir=tmp_project_dir,
        )
        preset = ExportPreset(id="p", label="p", width=320, height=180, fps=30)

        # Warm-up: one failing compile absorbs any one-off ffmpeg setup.
        with pytest.raises(CompileError):
            compile_timeline(project, assets, preset, burn_captions=False)
        baseline = len(_live_children())

        for _ in range(3):
            with pytest.raises(CompileError):
                compile_timeline(project, assets, preset, burn_captions=False)

        assert len(_live_children()) <= baseline
