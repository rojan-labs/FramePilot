"""Shared pytest fixtures for the engine test suite."""

from __future__ import annotations

import subprocess
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest

from framepilot_engine.config import get_settings
from framepilot_engine.media.ffmpeg import FFmpegNotFoundError, find_ffmpeg, find_ffprobe
from framepilot_engine.render.composition_cache import COMPOSITION_CACHE

# Factory signature: (name, *, seconds, with_audio, with_video, color, size, fps) -> Path
MediaFactory = Callable[..., Path]


@pytest.fixture(autouse=True)
def _reset_settings_cache(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Isolate `get_settings()` from both cross-test caching AND a developer's `.env`.

    WHY: `get_settings()` is `@lru_cache`d for the *production* process lifetime,
    but a test session runs hundreds of independent scenarios, and MoviePy's
    ``config`` module calls ``python-dotenv``'s ``load_dotenv()`` as a side effect
    the *first* time it is imported (lazily, deep inside a real render/compile
    call) — which can inject a developer's local `.env` (e.g. a real
    `FRAMEPILOT_PROJECTS_ROOT`, as this repo's `.env.example` documents) into
    `os.environ` mid-session. Combined with the cache, whichever test happens to
    trigger either of those first "freezes" that value for every later test
    relying on "no explicit settings" (bare `TestClient(create_app())`/`main()`),
    turning previously-valid sandbox paths into spurious 400s — purely a function
    of test collection/execution order, not the code under test. Clearing the
    cache AND removing `FRAMEPILOT_PROJECTS_ROOT` from the environment before AND
    after each test makes every test see settings built fresh from *that test's*
    own environment (its own `monkeypatch.setenv`, applied after this fixture
    runs), independent of what any other test or dependency did.
    """
    monkeypatch.delenv("FRAMEPILOT_PROJECTS_ROOT", raising=False)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture(autouse=True)
def _reset_composition_cache() -> Iterator[None]:
    """Keep compiled compositions from leaking between tests.

    The cache is process-wide by design (the sidecar is one long-lived process),
    and it is keyed by project fingerprint — so two tests building the same
    fixture project would otherwise share one composition, and a test that
    monkeypatches ``compile_timeline`` could be served the previous test's fake.
    Clearing around each test also closes the readers it opened, which is what
    keeps the suite's leak assertions meaningful.
    """
    COMPOSITION_CACHE.clear()
    yield
    COMPOSITION_CACHE.clear()


@pytest.fixture
def sample_project_dict() -> dict[str, Any]:
    """A minimal valid project document mirroring the PRD §11 example."""
    return {
        "id": "project_001",
        "name": "Demo Video",
        "version": 1,
        "fps": 30,
        "resolution": {"width": 1920, "height": 1080},
        "assets": [],
        "timeline": {
            "tracks": [
                {"id": "video_1", "type": "video", "clips": []},
                {"id": "audio_1", "type": "audio", "clips": []},
            ]
        },
        "transcript": [],
        "aiMemory": {},
        "history": [],
    }


@pytest.fixture
def sample_clip_dict() -> dict[str, Any]:
    """A minimal valid clip mirroring the PRD §11.3 example."""
    return {
        "id": "clip_001",
        "assetId": "asset_001",
        "trackId": "video_1",
        "start": 0,
        "end": 12.5,
        "sourceStart": 4.0,
        "sourceEnd": 16.5,
        "effects": [],
        "keyframes": [],
    }


@pytest.fixture
def tmp_project_dir(tmp_path: Path) -> Path:
    """A temporary directory standing in for a project's sandbox root."""
    project_dir = tmp_path / "demo_project"
    project_dir.mkdir()
    return project_dir


@pytest.fixture(scope="session")
def ffmpeg_bin() -> str:
    """Path to a usable ffmpeg, or skip the test if none is available."""
    try:
        return find_ffmpeg()
    except FFmpegNotFoundError:  # pragma: no cover - environment-dependent
        pytest.skip("ffmpeg not available")


@pytest.fixture(scope="session")
def require_ffprobe() -> None:
    """Skip the requesting test unless ffprobe is available."""
    try:
        find_ffprobe()
    except FFmpegNotFoundError:  # pragma: no cover - environment-dependent
        pytest.skip("ffprobe not available")


@pytest.fixture(scope="session")
def media_factory(ffmpeg_bin: str, tmp_path_factory: pytest.TempPathFactory) -> MediaFactory:
    """Return a factory that synthesises tiny test media files with ffmpeg.

    Files are generated with ``lavfi`` sources (no real assets needed), kept
    small (default 320x240, 1s) so the suite stays fast. ``with_audio`` adds a
    sine tone; ``with_video=False`` produces an audio-only file.
    """
    out_dir = tmp_path_factory.mktemp("media")

    def _make(
        name: str,
        *,
        seconds: float = 1.0,
        with_audio: bool = True,
        with_video: bool = True,
        color: str = "red",
        size: str = "320x240",
        fps: int = 30,
    ) -> Path:
        out = out_dir / name
        args = [ffmpeg_bin, "-y"]
        if with_video:
            args += ["-f", "lavfi", "-i", f"color=c={color}:s={size}:r={fps}:d={seconds}"]
        if with_audio:
            args += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}"]
        if with_video:
            args += ["-pix_fmt", "yuv420p"]
        args += ["-shortest", str(out)]
        subprocess.run(args, check=True, capture_output=True)
        return out

    return _make
