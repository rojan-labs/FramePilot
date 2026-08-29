"""Tests for the FastAPI sidecar service (plan 2.4)."""

from __future__ import annotations

import asyncio
import threading
import time
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from framepilot_engine.audio.asr import AsrSetupTracker, ModelDownload
from framepilot_engine.config import Settings
from framepilot_engine.render.pipeline import RenderJob, RenderState
from framepilot_engine.render.queue import JobCancelled, RenderQueue
from framepilot_engine.render.queue import RenderRequest as QueuedRenderRequest
from framepilot_engine.service import create_app
from framepilot_engine.timeline.models import Project, ProjectFile


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


def _write_video_project(directory: Path) -> Path:
    project = Project.model_validate(
        {
            "id": "p1",
            "name": "T",
            "fps": 30,
            "assets": [{"id": "a1", "path": "clip.mp4", "kind": "video"}],
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
                                "end": 1.0,
                                "sourceStart": 0.0,
                                "sourceEnd": 1.0,
                            }
                        ],
                    }
                ]
            },
        }
    )
    dest = directory / "demo.project.fp.json"
    ProjectFile.save(project, dest)
    return dest


def test_health(client: TestClient) -> None:
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_no_route_blocks_the_event_loop() -> None:
    """Every route either awaits or runs in the threadpool. Never both-neither.

    A route declared ``async def`` that does blocking work occupies the event loop
    for its whole duration, and uvicorn cannot even *read* another request until it
    returns.  One 409-second TwelveLabs footage map did exactly that: `/detect-beats`
    and `/brain/visual/search` never reached the server at all and were killed by the
    client's 120s timeout, so a beat-synced montage was built with no beats.

    This is a structural guard because the failure is invisible in a single-request
    test — the route returns the right answer, just at everyone else's expense.
    """
    import ast
    import inspect

    import framepilot_engine.service as service_module

    tree = ast.parse(inspect.getsource(service_module))
    offenders = [
        node.name
        for node in ast.walk(tree)
        if isinstance(node, ast.AsyncFunctionDef)
        and any(ast.unparse(decorator).startswith("app.") for decorator in node.decorator_list)
        and not any(
            isinstance(inner, ast.Await | ast.AsyncFor | ast.AsyncWith) for inner in ast.walk(node)
        )
    ]
    assert offenders == [], (
        "These routes are `async def` but never await, so their bodies run on the "
        f"event loop and starve every other request: {offenders}. Declare them `def` "
        "(FastAPI runs sync routes in a threadpool) or await the blocking work via "
        "`run_in_threadpool`."
    )


def test_a_slow_route_does_not_stall_other_requests(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A long analysis must not hold the whole sidecar hostage."""
    import framepilot_engine.service as service_module

    started = threading.Event()
    release = threading.Event()
    real_status = service_module.get_status

    def slow_status(model: str) -> object:
        started.set()
        release.wait(timeout=10)
        return real_status(model)

    monkeypatch.setattr(service_module, "get_status", slow_status)
    # As a context manager the client keeps ONE portal (and so one event loop) for
    # every request. Constructed bare it starts a fresh portal per call, which hides
    # exactly the starvation this test exists to catch.
    with TestClient(create_app()) as client:

        def call_slow() -> None:
            client.get("/asr/status")

        worker = threading.Thread(target=call_slow, daemon=True)
        worker.start()
        try:
            assert started.wait(timeout=10), "the slow route never started"
            # The slow route is *inside* its blocking section right now. Before the
            # fix this request could not even be read until that section returned.
            began = time.monotonic()
            health = client.get("/health")
            assert health.status_code == 200
            assert time.monotonic() - began < 5
        finally:
            release.set()
            worker.join(timeout=10)


@pytest.mark.usefixtures("require_ffprobe")
def test_inspect_media_route(client: TestClient, media_factory: Callable[..., Path]) -> None:
    path = media_factory("svc_probe.mp4", seconds=1.0)
    resp = client.post("/inspect-media", json={"input_path": str(path)})
    assert resp.status_code == 200
    assert resp.json()["streams"]


def test_inspect_media_route_missing_file(client: TestClient, projects_root: Path) -> None:
    resp = client.post("/inspect-media", json={"input_path": str(projects_root / "no-such.mp4")})
    assert resp.status_code == 404


@pytest.mark.usefixtures("require_ffprobe")
def test_inspect_media_route_non_media_returns_422(client: TestClient, tmp_path: Path) -> None:
    bogus = tmp_path / "notmedia.mp4"
    bogus.write_text("this is not a media file")
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    resp = client.post("/inspect-media", json={"input_path": str(bogus)})
    assert resp.status_code == 422


@pytest.mark.usefixtures("require_ffprobe")
def test_asset_media_route_returns_peaks(
    client: TestClient, media_factory: Callable[..., Path]
) -> None:
    path = media_factory("svc_asset.mp4", seconds=1.0, with_audio=True)
    resp = client.post("/asset-media", json={"input_path": str(path), "buckets": 64})
    assert resp.status_code == 200
    body = resp.json()
    assert body["kind"] == "video"
    assert body["durationSeconds"] is not None
    assert body["peaks"] and len(body["peaks"]) == 64
    assert body["peaksPerSecond"] and body["peaksPerSecond"] > 0


@pytest.mark.usefixtures("require_ffprobe")
def test_asset_media_audio_only(client: TestClient, media_factory: Callable[..., Path]) -> None:
    path = media_factory("svc_audio.m4a", seconds=1.0, with_audio=True, with_video=False)
    resp = client.post("/asset-media", json={"input_path": str(path)})
    assert resp.status_code == 200
    body = resp.json()
    assert body["kind"] == "audio"
    assert body["peaks"]


@pytest.mark.usefixtures("require_ffprobe")
def test_asset_media_silent_video_has_no_peaks(
    client: TestClient, media_factory: Callable[..., Path]
) -> None:
    path = media_factory("svc_silent.mp4", seconds=1.0, with_audio=False)
    resp = client.post("/asset-media", json={"input_path": str(path)})
    assert resp.status_code == 200
    body = resp.json()
    assert body["kind"] == "video"
    assert body["peaks"] is None  # no audio track → skeleton fallback in the UI


# --- Thumbnail derivation on /asset-media (plan Phase 8) ----------------------
#
# These use a sandboxed app (``projects_root`` set) and monkeypatch the media
# layer so they exercise the route's thumbnail wiring deterministically without
# spawning ffmpeg, mirroring the injection style of the render tests above.


def _fake_media_module(
    monkeypatch: pytest.MonkeyPatch,
    *,
    has_video: bool,
    duration: float | None,
    with_audio: bool = True,
    format_name: str | None = None,
) -> None:
    """Patch service-level ``inspect_media``/``extract_waveform`` to fakes.

    ``is_image`` mirrors the real :class:`MediaInfo.is_image` so the route's
    kind classification is exercised faithfully — including a still image with a
    bogus (truthy) ``duration`` when a still-image ``format_name`` is supplied.
    """
    import framepilot_engine.service as service_module
    from framepilot_engine.media.ffmpeg import FFmpegError
    from framepilot_engine.media.probe import _STILL_IMAGE_FORMATS

    class _FakeInfo:
        def __init__(self) -> None:
            self.video_streams = [object()] if has_video else []
            self.duration_seconds = duration
            self.has_audio = with_audio
            self.format_name = format_name
            # Schema v21: the real ``MediaInfo`` reads these off the first video stream,
            # and ``/asset-media`` carries them through so a run can tell a landscape
            # source from a portrait one. A landscape shape here, since that is the case
            # the response exists to make visible.
            self.width = 1920 if has_video else None
            self.height = 1080 if has_video else None

        @property
        def is_image(self) -> bool:
            if not self.video_streams or self.has_audio:
                return False
            tokens = {t.strip() for t in (self.format_name or "").split(",")}
            if tokens & _STILL_IMAGE_FORMATS:
                return True
            return not self.duration_seconds

    def _fake_inspect(_p: Path, *, timeout: float | None = None) -> _FakeInfo:
        return _FakeInfo()

    monkeypatch.setattr(service_module, "inspect_media", _fake_inspect)

    class _FakeWaveform:
        def __init__(self) -> None:
            self.peaks = [0.0, 0.5, 1.0]
            self.duration_seconds = duration or 1.0
            self.bucket_count = 3

    def _fake_waveform(_path: Path, *, buckets: int, timeout: float | None = None) -> _FakeWaveform:
        if not with_audio:
            raise FFmpegError("no audio stream")
        return _FakeWaveform()

    monkeypatch.setattr(service_module, "extract_waveform", _fake_waveform)


def _sandboxed_client_with_source(tmp_path: Path, name: str) -> tuple[TestClient, Path]:
    src = tmp_path / name
    src.write_bytes(b"fake media bytes")
    return TestClient(create_app(Settings(projects_root=tmp_path))), src


def _concurrency_probe(monkeypatch: pytest.MonkeyPatch, hold: threading.Event) -> Callable[[], int]:
    """Make every derivation block on ``hold`` and report the peak overlap seen.

    The overlap is counted INSIDE the derivation, so it measures requests that actually
    reached ffmpeg — not requests that merely arrived. A gate that only delayed
    responses while still running the work would read as no gate at all here.
    """
    import framepilot_engine.service as service_module

    lock = threading.Lock()
    live = 0
    peak = 0

    def _blocking_inspect(_p: Path, *, timeout: float | None = None) -> object:
        nonlocal live, peak
        with lock:
            live += 1
            peak = max(peak, live)
        try:
            hold.wait(timeout=10)
        finally:
            with lock:
                live -= 1
        raise FileNotFoundError("probe stops here; the gate is what is under test")

    monkeypatch.setattr(service_module, "inspect_media", _blocking_inspect)
    return lambda: peak


def _asset_media_endpoint(app: Any) -> Callable[..., Any]:
    """The `/asset-media` handler itself.

    Driven directly rather than through ``TestClient``: that client dispatches every
    request through one blocking portal from a caller thread, so what it would measure
    is the portal's threading, not this route's gate.
    """
    from fastapi.routing import APIRoute

    for route in app.routes:
        if isinstance(route, APIRoute) and route.path == "/asset-media":
            return route.endpoint
    raise AssertionError("asset-media route is not registered")


async def _gathered_asset_media(
    app: Any, source: Path, callers: int, hold: threading.Event, peak: Callable[[], int]
) -> tuple[int, list[Any]]:
    """Fire `callers` derivations at once; return the peak overlap while they were held."""
    from framepilot_engine.service import AssetMediaRequest

    endpoint = _asset_media_endpoint(app)
    # Distinct requests on purpose: identical ones are coalesced into a single derivation
    # (P5.4, `test_asset_media_coalesces_identical_concurrent_requests`), which would make
    # the gate look tighter than it is.
    tasks = [
        asyncio.create_task(endpoint(AssetMediaRequest(input_path=str(source), buckets=400 + i)))
        for i in range(callers)
    ]
    # Let the admitted callers pile up against the gate before releasing them, so the
    # peak is a real measurement rather than an artefact of how fast they were served.
    await asyncio.sleep(0.3)
    observed = peak()
    hold.set()
    results = await asyncio.gather(*tasks, return_exceptions=True)
    return observed, results


@pytest.mark.asyncio
async def test_asset_media_gate_holds_under_a_sixty_asset_burst(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """P5.4: importing a folder is a burst, and the cap must hold for all of it.

    Six callers proves the gate exists; sixty proves it does not sag under the load it was
    actually built for — a user dragging in a shoot, or the agent warming a sourcing pass.
    Every request is distinct (different bucket counts) so this measures the CAP and not
    the in-flight coalescing, which has its own test.
    """
    hold = threading.Event()
    peak = _concurrency_probe(monkeypatch, hold)
    src = tmp_path / "vid.mp4"
    src.write_bytes(b"fake media bytes")
    app = create_app(Settings(projects_root=tmp_path, asset_media_concurrency=3))
    endpoint = _asset_media_endpoint(app)

    from framepilot_engine.service import AssetMediaRequest

    tasks = [
        asyncio.create_task(endpoint(AssetMediaRequest(input_path=str(src), buckets=100 + i)))
        for i in range(60)
    ]
    await asyncio.sleep(0.5)
    observed = peak()
    hold.set()
    results = await asyncio.gather(*tasks, return_exceptions=True)

    assert observed == 3, f"the gate admitted {observed} derivations, not 3"
    assert peak() == 3
    # The gate queues, it never sheds: all sixty are served.
    assert len(results) == 60


@pytest.mark.asyncio
async def test_asset_media_coalesces_identical_concurrent_requests(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Six identical requests in flight together derive ONCE and all get the answer (P5.4).

    The sidebar, the agent and a retry can all ask for the same asset's media within a
    second of each other; each used to be its own ffmpeg pipeline producing the same
    peaks. Keyed on the request's inputs, so a different bucket count is a different job.
    """
    import framepilot_engine.service as service_module
    from framepilot_engine.service import AssetMediaRequest

    calls = 0
    hold = threading.Event()

    def _counting_inspect(_p: Path, *, timeout: float | None = None) -> object:
        nonlocal calls
        calls += 1
        hold.wait(timeout=10)
        raise FileNotFoundError("probe stops here; coalescing is what is under test")

    monkeypatch.setattr(service_module, "inspect_media", _counting_inspect)
    src = tmp_path / "vid.mp4"
    src.write_bytes(b"fake media bytes")
    app = create_app(Settings(projects_root=tmp_path, asset_media_concurrency=4))
    endpoint = _asset_media_endpoint(app)
    request = AssetMediaRequest(input_path=str(src))
    tasks = [asyncio.create_task(endpoint(request)) for _ in range(6)]
    await asyncio.sleep(0.3)
    hold.set()
    results = await asyncio.gather(*tasks, return_exceptions=True)

    assert calls == 1
    assert len(results) == 6
    # Every caller saw the leader's outcome — the same failure here, the same media in life.
    assert {type(r).__name__ for r in results} == {type(results[0]).__name__}


@pytest.mark.asyncio
async def test_asset_media_admits_only_as_many_derivations_as_the_gate_allows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Six callers at once must not become six simultaneous ffmpeg pipelines.

    Ungated, this route's only bound was arrival rate: the desktop agent warms four
    sourcing downloads at a time and a human can drop in dozens of files, and each one
    held a Starlette threadpool slot AND an ffmpeg process against the same cores and
    the same memory.
    """
    hold = threading.Event()
    peak = _concurrency_probe(monkeypatch, hold)
    src = tmp_path / "vid.mp4"
    src.write_bytes(b"fake media bytes")
    app = create_app(Settings(projects_root=tmp_path, asset_media_concurrency=2))

    observed, results = await _gathered_asset_media(app, src, 6, hold, peak)

    assert observed == 2
    assert peak() == 2
    # The gate queues, it never sheds: every caller is still served.
    assert len(results) == 6
    assert all(isinstance(r, HTTPException) and r.status_code == 404 for r in results)


@pytest.mark.asyncio
async def test_asset_media_concurrency_of_one_serializes_derivations(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`FRAMEPILOT_ASSET_MEDIA_CONCURRENCY=1` restores strictly-serial derivation."""
    hold = threading.Event()
    peak = _concurrency_probe(monkeypatch, hold)
    src = tmp_path / "vid.mp4"
    src.write_bytes(b"fake media bytes")
    app = create_app(Settings(projects_root=tmp_path, asset_media_concurrency=1))

    observed, results = await _gathered_asset_media(app, src, 4, hold, peak)

    assert observed == 1
    assert peak() == 1
    assert len(results) == 4


def test_asset_media_video_returns_relative_thumbnail_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import framepilot_engine.service as service_module

    _fake_media_module(monkeypatch, has_video=True, duration=8.0)

    def _fake_generate(
        source: Path, output_dir: Path, *, count: int, timeout: float | None = None
    ) -> list[Path]:
        output_dir.mkdir(parents=True, exist_ok=True)
        out: list[Path] = []
        for i in range(count):
            p = output_dir / f"thumb_{i:03d}.png"
            p.write_bytes(b"png")
            out.append(p)
        return out

    monkeypatch.setattr(service_module, "generate_thumbnails", _fake_generate)
    client, src = _sandboxed_client_with_source(tmp_path, "vid.mp4")

    resp = client.post("/asset-media", json={"input_path": str(src), "thumbnails": 3})
    assert resp.status_code == 200
    body = resp.json()
    assert body["kind"] == "video"
    paths = body["thumbnailPaths"]
    assert paths is not None and len(paths) == 3
    # Project-root-relative POSIX strings under the derived-media dir.
    for p in paths:
        assert not p.startswith("/")
        assert p.startswith(".framepilot-derived/")
        assert (tmp_path / p).is_file()
    # Deterministic hash dir: stable across calls for the same source.
    resp2 = client.post("/asset-media", json={"input_path": str(src), "thumbnails": 3})
    assert resp2.json()["thumbnailPaths"] == paths


def test_asset_media_carries_source_dimensions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Schema v21: the probe already measures the source, so the response carries it.

    WHY it matters: the renderer FITS a clip into the frame (``_place_video_clip`` uses
    ``min(target_w/w, target_h/h)``, which is *contain*), so a landscape source in a
    portrait sequence renders with black bars unless the clip carries a crop. Nothing
    anywhere held an asset's shape, so neither the editor nor the agent could tell which
    assets those were — run ``fc10301a`` placed 34 landscape photos in a 1080x1920 frame
    against a brief reading "No black bars".
    """
    _fake_media_module(monkeypatch, has_video=True, duration=8.0)
    client, src = _sandboxed_client_with_source(tmp_path, "wide.mp4")

    body = client.post("/asset-media", json={"input_path": str(src)}).json()
    assert body["width"] == 1920
    assert body["height"] == 1080


def test_asset_media_omits_dimensions_for_audio(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Absent means "not measured", never "square" — a guess would misdirect a crop."""
    _fake_media_module(monkeypatch, has_video=False, duration=2.0, with_audio=True)
    client, src = _sandboxed_client_with_source(tmp_path, "bed.mp3")

    body = client.post("/asset-media", json={"input_path": str(src)}).json()
    assert body["width"] is None
    assert body["height"] is None


def test_asset_media_audio_thumbnails_null(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_media_module(monkeypatch, has_video=False, duration=2.0, with_audio=True)
    client, src = _sandboxed_client_with_source(tmp_path, "song.m4a")

    resp = client.post("/asset-media", json={"input_path": str(src)})
    assert resp.status_code == 200
    body = resp.json()
    assert body["kind"] == "audio"
    assert body["thumbnailPaths"] is None
    assert body["peaks"]  # peaks still derived


def test_asset_media_image_single_relative_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Image = video stream with no duration; its own single-frame preview.
    _fake_media_module(monkeypatch, has_video=True, duration=None, with_audio=False)
    client, src = _sandboxed_client_with_source(tmp_path, "pic.png")

    resp = client.post("/asset-media", json={"input_path": str(src)})
    assert resp.status_code == 200
    body = resp.json()
    assert body["kind"] == "image"
    assert body["thumbnailPaths"] == ["pic.png"]


def test_asset_media_still_image_with_bogus_duration_is_image(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Regression: ffprobe reports a still image (WhatsApp JPEG) as a single-frame
    # video stream with a bogus ~0.04s duration. Classifying on duration mislabels
    # it "video" and derives thumbs/proxy the timeline then chases (fp-media ENOENT
    # flood). We must classify on the container format → "image", own-source thumb.
    _fake_media_module(
        monkeypatch,
        has_video=True,
        duration=0.04,
        with_audio=False,
        format_name="image2",
    )
    client, src = _sandboxed_client_with_source(tmp_path, "WhatsApp_photo.jpeg")

    resp = client.post("/asset-media", json={"input_path": str(src)})
    assert resp.status_code == 200
    body = resp.json()
    assert body["kind"] == "image"
    assert body["thumbnailPaths"] == ["WhatsApp_photo.jpeg"]
    assert body["proxyPath"] is None


def test_asset_media_thumbnails_zero_returns_null(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import framepilot_engine.service as service_module

    _fake_media_module(monkeypatch, has_video=True, duration=8.0)

    def _must_not_call(*_a: object, **_k: object) -> list[Path]:
        raise AssertionError("generate_thumbnails must not be called when thumbnails=0")

    monkeypatch.setattr(service_module, "generate_thumbnails", _must_not_call)
    client, src = _sandboxed_client_with_source(tmp_path, "vid.mp4")

    resp = client.post("/asset-media", json={"input_path": str(src), "thumbnails": 0})
    assert resp.status_code == 200
    assert resp.json()["thumbnailPaths"] is None


def test_asset_media_thumbnail_ffmpeg_failure_degrades(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import framepilot_engine.service as service_module
    from framepilot_engine.media.ffmpeg import FFmpegError

    _fake_media_module(monkeypatch, has_video=True, duration=8.0)

    def _boom(*_a: object, **_k: object) -> list[Path]:
        raise FFmpegError("ffmpeg exploded")

    monkeypatch.setattr(service_module, "generate_thumbnails", _boom)
    client, src = _sandboxed_client_with_source(tmp_path, "vid.mp4")

    resp = client.post("/asset-media", json={"input_path": str(src), "thumbnails": 5})
    assert resp.status_code == 200
    body = resp.json()
    # Thumbnails degrade to null, but kind/duration/peaks still return.
    assert body["thumbnailPaths"] is None
    assert body["kind"] == "video"
    assert body["durationSeconds"] == 8.0
    assert body["peaks"]


def test_asset_media_video_derive_failure_thumbnails_null(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Undecodable media → thumbnail derivation fails → honest null (never 500).
    _fake_media_module(monkeypatch, has_video=True, duration=8.0)
    src = tmp_path / "vid.mp4"
    src.write_bytes(b"fake media bytes")
    client = TestClient(create_app(Settings(projects_root=tmp_path)))

    resp = client.post("/asset-media", json={"input_path": str(src), "thumbnails": 5})
    assert resp.status_code == 200
    assert resp.json()["thumbnailPaths"] is None


def test_asset_media_threads_configured_timeout_to_subprocesses(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The configured asset-media timeout must bound every ffmpeg/ffprobe call so
    a crafted/looping source cannot hang derivation (plan Phase 9.5)."""
    import framepilot_engine.service as service_module

    seen: dict[str, float | None] = {}

    class _FakeInfo:
        def __init__(self) -> None:
            self.video_streams = [object()]
            self.duration_seconds = 8.0
            self.is_image = False  # a real-duration video clip
            self.width = 1920
            self.height = 1080

    def _fake_inspect(_p: Path, *, timeout: float | None = None) -> _FakeInfo:
        seen["inspect"] = timeout
        return _FakeInfo()

    class _FakeWaveform:
        def __init__(self) -> None:
            self.peaks = [0.1, 0.2]
            self.duration_seconds = 8.0
            self.bucket_count = 2

    def _fake_waveform(_p: Path, *, buckets: int, timeout: float | None = None) -> _FakeWaveform:
        seen["waveform"] = timeout
        return _FakeWaveform()

    def _fake_generate(
        source: Path, output_dir: Path, *, count: int, timeout: float | None = None
    ) -> list[Path]:
        seen["thumbnails"] = timeout
        output_dir.mkdir(parents=True, exist_ok=True)
        p = output_dir / "thumb_000.png"
        p.write_bytes(b"png")
        return [p]

    monkeypatch.setattr(service_module, "inspect_media", _fake_inspect)
    monkeypatch.setattr(service_module, "extract_waveform", _fake_waveform)
    monkeypatch.setattr(service_module, "generate_thumbnails", _fake_generate)

    settings = Settings(projects_root=tmp_path, asset_media_timeout_seconds=17)
    client = TestClient(create_app(settings))
    src = tmp_path / "vid.mp4"
    src.write_bytes(b"fake media bytes")

    resp = client.post("/asset-media", json={"input_path": str(src), "thumbnails": 1})
    assert resp.status_code == 200
    assert seen == {"inspect": 17.0, "waveform": 17.0, "thumbnails": 17.0}


def test_asset_media_missing_file_returns_404(client: TestClient, projects_root: Path) -> None:
    resp = client.post("/asset-media", json={"input_path": str(projects_root / "no-such.mp4")})
    assert resp.status_code == 404


def test_asset_media_probe_timeout_returns_422(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A probe that times out surfaces as a typed 422 rather than hanging."""
    import framepilot_engine.service as service_module
    from framepilot_engine.media.ffmpeg import FFmpegError

    def _timeout_inspect(_p: Path, *, timeout: float | None = None) -> object:
        raise FFmpegError(f"Timed out after {timeout}s: 'ffprobe'")

    monkeypatch.setattr(service_module, "inspect_media", _timeout_inspect)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    src = tmp_path / "evil.mp4"
    src.write_bytes(b"fake media bytes")

    resp = client.post("/asset-media", json={"input_path": str(src)})
    assert resp.status_code == 422
    assert "Timed out" in resp.json()["detail"]


def test_asset_media_thumbnail_timeout_degrades(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A thumbnail extraction that times out degrades to null thumbnails while
    duration/kind/peaks still return (import never blocks)."""
    import framepilot_engine.service as service_module
    from framepilot_engine.media.ffmpeg import FFmpegError

    _fake_media_module(monkeypatch, has_video=True, duration=8.0)

    def _timeout_generate(*_a: object, **_k: object) -> list[Path]:
        raise FFmpegError("Timed out after 60.0s: 'ffmpeg'")

    monkeypatch.setattr(service_module, "generate_thumbnails", _timeout_generate)
    client, src = _sandboxed_client_with_source(tmp_path, "vid.mp4")

    resp = client.post("/asset-media", json={"input_path": str(src), "thumbnails": 5})
    assert resp.status_code == 200
    body = resp.json()
    assert body["thumbnailPaths"] is None
    assert body["kind"] == "video"
    assert body["durationSeconds"] == 8.0
    assert body["peaks"]


def test_serve_invokes_uvicorn(monkeypatch: pytest.MonkeyPatch) -> None:
    # serve() must hand the app + host/port to uvicorn without binding a socket.
    import framepilot_engine.service as service_module

    captured: dict[str, Any] = {}

    def fake_run(app: Any, **kwargs: Any) -> None:
        captured["kwargs"] = kwargs

    import uvicorn

    monkeypatch.setattr(uvicorn, "run", fake_run)
    service_module.serve(host="127.0.0.1", port=1234)
    assert captured["kwargs"]["host"] == "127.0.0.1"
    assert captured["kwargs"]["port"] == 1234


@pytest.mark.usefixtures("require_ffprobe")
def test_validate_render_route(client: TestClient, media_factory: Callable[..., Path]) -> None:
    path = media_factory("svc_validate.mp4", seconds=1.0, with_audio=False)
    resp = client.post(
        "/validate-render",
        json={"output_path": str(path), "expected_duration_seconds": 1.0, "expect_audio": False},
    )
    assert resp.status_code == 200
    assert resp.json()["ok"]


def test_render_route_bad_project_returns_400(client: TestClient) -> None:
    resp = client.post("/render", json={"project_path": "/no/such/project.fp.json"})
    assert resp.status_code == 400


@pytest.mark.usefixtures("require_ffprobe")
def test_render_preview_route_completes(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    src = media_factory("clip.mp4", seconds=1.0, with_audio=False)
    (tmp_project_dir / "clip.mp4").write_bytes(src.read_bytes())
    project_path = _write_video_project(tmp_project_dir)

    client = TestClient(create_app(Settings(projects_root=tmp_project_dir)))
    resp = client.post("/render/preview", json={"project_path": str(project_path)})
    assert resp.status_code == 200
    job: dict[str, Any] = resp.json()
    assert job["state"] == "completed"
    assert Path(job["output_path"]).is_file()


# --- Async /render (plan H1.3): submit + poll + cancel -----------------------
#
# These use a fake, deterministic executor (mirroring test_render_queue.py's
# injection style) instead of spawning a real subprocess, so the queue's HTTP
# wiring is tested without paying for ffmpeg or a real render pipeline.


def _client_with_fake_queue(
    executor: Callable[..., RenderJob], projects_root: Path | None = None
) -> TestClient:
    queue = RenderQueue(executor=executor)
    settings = Settings(projects_root=projects_root) if projects_root else Settings()
    return TestClient(create_app(settings, render_queue=queue))


def _gated_executor() -> tuple[Callable[..., RenderJob], threading.Event, threading.Event]:
    """An executor that blocks until released, so a test can observe RUNNING."""
    started = threading.Event()
    release = threading.Event()

    def executor(
        req: QueuedRenderRequest, cancel_event: threading.Event, timeout: float | None
    ) -> RenderJob:
        started.set()
        release.wait(5.0)
        if cancel_event.is_set():
            raise JobCancelled
        return RenderJob(id="job", project_id=req.project.id, state=RenderState.COMPLETED)

    return executor, started, release


def _poll_until(
    client: TestClient, job_id: str, status_value: str, timeout: float = 3.0
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    final: dict[str, Any] = {}
    while time.monotonic() < deadline:
        final = client.get(f"/render/jobs/{job_id}").json()
        if final["status"] == status_value:
            return final
        time.sleep(0.01)
    raise AssertionError(f"timed out waiting for status={status_value}; last seen {final}")


def test_render_route_returns_202_with_job_id_immediately(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    """Regression guard for the OLD synchronous behaviour: submitting a render
    must return before the (gated) render has even started running, not just
    fast-because-mocked — a synchronous handler would block on the executor's
    `release.wait(5.0)` below and take >=5s."""
    src = media_factory("clip.mp4", seconds=1.0, with_audio=False)
    (tmp_project_dir / "clip.mp4").write_bytes(src.read_bytes())
    project_path = _write_video_project(tmp_project_dir)

    executor, _started, release = _gated_executor()
    fake_client = _client_with_fake_queue(executor, projects_root=tmp_project_dir)
    try:
        start = time.monotonic()
        resp = fake_client.post(
            "/render",
            json={"project_path": str(project_path), "burn_captions": True},
        )
        elapsed = time.monotonic() - start

        assert resp.status_code == 202
        body = resp.json()
        assert body["status"] == "queued"
        assert body["jobId"]
        # Proof the OLD synchronous behaviour is gone: the executor blocks for up
        # to 5s (`release.wait(5.0)`) before returning, so a request that waited
        # for it to finish would take >=5s. Returning in well under that proves
        # the HTTP response is not waiting on the render.
        assert elapsed < 2.0
    finally:
        release.set()


def test_render_job_status_transitions_queued_running_completed(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    src = media_factory("clip.mp4", seconds=1.0, with_audio=False)
    (tmp_project_dir / "clip.mp4").write_bytes(src.read_bytes())
    project_path = _write_video_project(tmp_project_dir)

    executor, started, release = _gated_executor()
    fake_client = _client_with_fake_queue(executor, projects_root=tmp_project_dir)
    try:
        resp = fake_client.post("/render", json={"project_path": str(project_path)})
        job_id = resp.json()["jobId"]

        assert started.wait(3.0)  # worker picked it up
        running = fake_client.get(f"/render/jobs/{job_id}")
        assert running.status_code == 200
        assert running.json()["status"] in ("running", "queued")

        release.set()
        final = _poll_until(fake_client, job_id, "completed")
        assert final["result"]["state"] == "completed"
    finally:
        release.set()


def test_render_job_status_failed(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    src = media_factory("clip.mp4", seconds=1.0, with_audio=False)
    (tmp_project_dir / "clip.mp4").write_bytes(src.read_bytes())
    project_path = _write_video_project(tmp_project_dir)

    def failing_executor(
        req: QueuedRenderRequest, cancel_event: threading.Event, timeout: float | None
    ) -> RenderJob:
        return RenderJob(
            id="job", project_id=req.project.id, state=RenderState.FAILED, error="boom"
        )

    fake_client = _client_with_fake_queue(failing_executor, projects_root=tmp_project_dir)
    resp = fake_client.post("/render", json={"project_path": str(project_path)})
    job_id = resp.json()["jobId"]

    final = _poll_until(fake_client, job_id, "failed")
    assert final["error"] == "boom"


def test_render_job_status_unknown_returns_404(client: TestClient) -> None:
    resp = client.get("/render/jobs/does-not-exist")
    assert resp.status_code == 404


def test_render_job_cancel_unknown_returns_404(client: TestClient) -> None:
    resp = client.post("/render/jobs/does-not-exist/cancel")
    assert resp.status_code == 404


def test_render_job_cancel_while_running(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    src = media_factory("clip.mp4", seconds=1.0, with_audio=False)
    (tmp_project_dir / "clip.mp4").write_bytes(src.read_bytes())
    project_path = _write_video_project(tmp_project_dir)

    executor, started, release = _gated_executor()
    fake_client = _client_with_fake_queue(executor, projects_root=tmp_project_dir)
    try:
        resp = fake_client.post("/render", json={"project_path": str(project_path)})
        job_id = resp.json()["jobId"]
        assert started.wait(3.0)

        cancel_resp = fake_client.post(f"/render/jobs/{job_id}/cancel")
        assert cancel_resp.status_code == 200
        release.set()

        final = _poll_until(fake_client, job_id, "cancelled")
        assert final["status"] == "cancelled"
    finally:
        release.set()


def test_render_job_cancel_is_idempotent_on_terminal_job() -> None:
    queue = RenderQueue(
        executor=lambda req, ev, to: RenderJob(id="j", project_id="p", state=RenderState.COMPLETED)
    )
    fake_client = TestClient(create_app(render_queue=queue))
    task_id = queue.submit(
        QueuedRenderRequest(
            project=Project.model_validate({"id": "p", "name": "T", "assets": [], "timeline": {}}),
            base_dir="/tmp",
        )
    )
    _poll_until(fake_client, task_id, "completed")

    resp = fake_client.post(f"/render/jobs/{task_id}/cancel")
    assert resp.status_code == 200
    assert resp.json()["status"] == "completed"  # unchanged — cancel on terminal is a no-op


# --- Path-sandbox containment (PRD §18.1, security finding 1.2) ---------------


@pytest.fixture
def sandboxed_client(tmp_path: Path) -> TestClient:
    """A client whose app has ``projects_root`` set, enforcing containment."""
    settings = Settings(projects_root=tmp_path)
    return TestClient(create_app(settings))


# Paths that MUST be rejected by every guarded route when a root is configured:
# (a) a ``..`` traversal escape and (b) an absolute path outside the root.
_ESCAPE_PATHS = ["../../etc/passwd", "/etc/passwd"]


@pytest.mark.parametrize("bad_path", _ESCAPE_PATHS)
def test_inspect_media_rejects_paths_outside_sandbox(
    sandboxed_client: TestClient, bad_path: str
) -> None:
    resp = sandboxed_client.post("/inspect-media", json={"input_path": bad_path})
    assert resp.status_code == 400
    assert "escapes sandbox" in resp.json()["detail"]


@pytest.mark.parametrize("bad_path", _ESCAPE_PATHS)
def test_validate_render_rejects_paths_outside_sandbox(
    sandboxed_client: TestClient, bad_path: str
) -> None:
    resp = sandboxed_client.post("/validate-render", json={"output_path": bad_path})
    assert resp.status_code == 400
    assert "escapes sandbox" in resp.json()["detail"]


@pytest.mark.parametrize("bad_path", _ESCAPE_PATHS)
def test_render_rejects_paths_outside_sandbox(sandboxed_client: TestClient, bad_path: str) -> None:
    resp = sandboxed_client.post("/render", json={"project_path": bad_path})
    assert resp.status_code == 400
    assert "escapes sandbox" in resp.json()["detail"]


@pytest.mark.parametrize("bad_path", _ESCAPE_PATHS)
def test_asset_media_rejects_paths_outside_sandbox(
    sandboxed_client: TestClient, bad_path: str
) -> None:
    resp = sandboxed_client.post("/asset-media", json={"input_path": bad_path})
    assert resp.status_code == 400
    assert "escapes sandbox" in resp.json()["detail"]


@pytest.mark.parametrize("bad_path", _ESCAPE_PATHS)
def test_render_preview_rejects_paths_outside_sandbox(
    sandboxed_client: TestClient, bad_path: str
) -> None:
    resp = sandboxed_client.post("/render/preview", json={"project_path": bad_path})
    assert resp.status_code == 400
    assert "escapes sandbox" in resp.json()["detail"]


# With NO root configured the sidecar fails closed (503): there is no sandbox
# boundary to enforce, so caller-supplied paths are refused, not accepted.
def test_inspect_media_fails_closed_without_projects_root(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("FRAMEPILOT_PROJECTS_ROOT", raising=False)
    client = TestClient(create_app())
    resp = client.post("/inspect-media", json={"input_path": "/tmp/whatever.mp4"})
    assert resp.status_code == 503
    detail = resp.json()["detail"]
    assert "projects_root is not configured" in detail
    assert "FRAMEPILOT_PROJECTS_ROOT" in detail


def test_asset_media_fails_closed_without_projects_root(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("FRAMEPILOT_PROJECTS_ROOT", raising=False)
    client = TestClient(create_app())
    resp = client.post("/asset-media", json={"input_path": "/tmp/whatever.mp4"})
    assert resp.status_code == 503
    assert "projects_root is not configured" in resp.json()["detail"]


@pytest.mark.usefixtures("require_ffprobe")
def test_inspect_media_allows_path_inside_sandbox(
    tmp_path: Path, media_factory: Callable[..., Path]
) -> None:
    # A media file that genuinely lives inside the configured root must work.
    src = media_factory("inside.mp4", seconds=1.0)
    dest = tmp_path / "inside.mp4"
    dest.write_bytes(src.read_bytes())
    client = TestClient(create_app(Settings(projects_root=tmp_path)))

    resp = client.post("/inspect-media", json={"input_path": str(dest)})
    assert resp.status_code == 200
    assert resp.json()["streams"]


@pytest.mark.usefixtures("require_ffprobe")
def test_render_preview_allows_project_inside_sandbox(
    tmp_path: Path, media_factory: Callable[..., Path]
) -> None:
    # An in-sandbox project still renders end-to-end through the guarded route.
    project_dir = tmp_path / "demo_project"
    project_dir.mkdir()
    src = media_factory("clip.mp4", seconds=1.0, with_audio=False)
    (project_dir / "clip.mp4").write_bytes(src.read_bytes())
    project_path = _write_video_project(project_dir)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))

    resp = client.post("/render/preview", json={"project_path": str(project_path)})
    assert resp.status_code == 200
    assert resp.json()["state"] == "completed"


# --- Analysis routes: /analyze-silence & /detect-scenes (plan Phase 9.2) ------


def _write_analysis_project(directory: Path) -> Path:
    """A project with a video + an audio asset for the analysis routes."""
    project = Project.model_validate(
        {
            "id": "pa",
            "name": "A",
            "assets": [
                {"id": "vid", "path": "clip.mp4", "kind": "video"},
                {"id": "mus", "path": "song.mp3", "kind": "audio"},
            ],
            "timeline": {"tracks": []},
        }
    )
    dest = directory / "analysis.project.fp.json"
    ProjectFile.save(project, dest)
    return dest


def test_analyze_silence_route(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import framepilot_engine.service as service_module
    from framepilot_engine.analysis.silence import SilentRange

    seen: dict[str, object] = {}

    def _fake_detect(
        path: Path, *, timeout: float | None = None, **kwargs: object
    ) -> list[SilentRange]:
        seen["path"] = str(path)
        seen["timeout"] = timeout
        seen["kwargs"] = kwargs
        return [SilentRange(start=1.0, end=2.5, duration=1.5)]

    monkeypatch.setattr(service_module, "detect_silence", _fake_detect)
    project_path = _write_analysis_project(tmp_path)
    client = TestClient(
        create_app(Settings(projects_root=tmp_path, asset_media_timeout_seconds=11))
    )

    resp = client.post(
        "/analyze-silence",
        json={"project_path": str(project_path), "min_silence_seconds": 0.75},
    )
    assert resp.status_code == 200
    body = resp.json()
    # Default (no asset_id) picks the first audio-bearing asset (the video here).
    assert body["assetId"] == "vid"
    assert body["ranges"] == [{"start": 1.0, "end": 2.5, "duration": 1.5}]
    assert seen["timeout"] == 11.0
    # Omitted noise floor falls back to the default; the given min-gap is threaded.
    assert seen["kwargs"] == {"noise_floor_db": -30.0, "min_silence_seconds": 0.75}
    assert seen["path"] == str(project_path.parent / "clip.mp4")


def test_analyze_silence_route_selects_named_asset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import framepilot_engine.service as service_module
    from framepilot_engine.analysis.silence import SilentRange

    seen: dict[str, object] = {}

    def _fake_detect(
        path: Path, *, timeout: float | None = None, **kwargs: object
    ) -> list[SilentRange]:
        seen["path"] = str(path)
        return []

    monkeypatch.setattr(service_module, "detect_silence", _fake_detect)
    project_path = _write_analysis_project(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))

    resp = client.post(
        "/analyze-silence",
        json={"project_path": str(project_path), "asset_id": "mus", "noise_floor_db": -45.0},
    )
    assert resp.status_code == 200
    assert resp.json()["assetId"] == "mus"
    assert seen["path"] == str(project_path.parent / "song.mp3")


def test_analyze_silence_route_unknown_asset_404(tmp_path: Path) -> None:
    project_path = _write_analysis_project(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    resp = client.post(
        "/analyze-silence", json={"project_path": str(project_path), "asset_id": "ghost"}
    )
    assert resp.status_code == 404


def test_analyze_silence_route_bad_project_400(tmp_path: Path) -> None:
    bad = tmp_path / "broken.project.fp.json"
    bad.write_text("{ not json", encoding="utf-8")
    client = TestClient(create_app())
    resp = client.post("/analyze-silence", json={"project_path": str(bad)})
    assert resp.status_code == 400


def test_analyze_silence_route_ffmpeg_error_422(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import framepilot_engine.service as service_module
    from framepilot_engine.media.ffmpeg import FFmpegError

    def _boom(path: Path, *, timeout: float | None = None, **kwargs: object) -> object:
        raise FFmpegError("no audio stream")

    monkeypatch.setattr(service_module, "detect_silence", _boom)
    project_path = _write_analysis_project(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    resp = client.post("/analyze-silence", json={"project_path": str(project_path)})
    assert resp.status_code == 422


def test_analyze_silence_route_reports_a_video_only_asset_as_an_empty_result(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Video-only footage has no silence to report — that is a RESULT with a reason, not an
    error. Mirrors ``test_detect_beats_route_reports_a_silent_asset_as_an_empty_result``:
    reporting it as a 4xx terminated whole agent runs over one silent-video asset."""
    import framepilot_engine.service as service_module
    from framepilot_engine.media.ffmpeg import NoAudioStreamError

    def _silent(path: Path, *, timeout: float | None = None, **kwargs: object) -> object:
        raise NoAudioStreamError(f"{path.name} has no audio track, so there is no silence.")

    monkeypatch.setattr(service_module, "detect_silence", _silent)
    project_path = _write_analysis_project(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    resp = client.post("/analyze-silence", json={"project_path": str(project_path)})
    assert resp.status_code == 200
    body = resp.json()
    assert body["ranges"] == []
    assert "has no audio track" in body["reason"]


def test_detect_scenes_route(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import framepilot_engine.service as service_module
    from framepilot_engine.analysis.scenes import SceneCut

    seen: dict[str, object] = {}

    def _fake_detect(
        path: Path, *, timeout: float | None = None, **kwargs: object
    ) -> list[SceneCut]:
        seen["path"] = str(path)
        seen["kwargs"] = kwargs
        return [SceneCut(time=0.0), SceneCut(time=12.5)]

    monkeypatch.setattr(service_module, "detect_scenes", _fake_detect)
    project_path = _write_analysis_project(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))

    resp = client.post("/detect-scenes", json={"project_path": str(project_path), "threshold": 0.6})
    assert resp.status_code == 200
    body = resp.json()
    assert body["assetId"] == "vid"  # first video asset
    assert body["cuts"] == [{"time": 0.0}, {"time": 12.5}]
    assert seen["kwargs"] == {"threshold": 0.6}
    assert seen["path"] == str(project_path.parent / "clip.mp4")  # first video asset


def test_detect_scenes_route_no_video_asset_404(tmp_path: Path) -> None:
    project = Project.model_validate(
        {
            "id": "pa",
            "name": "A",
            "assets": [{"id": "mus", "path": "song.mp3", "kind": "audio"}],
            "timeline": {"tracks": []},
        }
    )
    dest = tmp_path / "audio_only.project.fp.json"
    ProjectFile.save(project, dest)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    resp = client.post("/detect-scenes", json={"project_path": str(dest)})
    assert resp.status_code == 404


def test_detect_scenes_route_ffmpeg_error_422(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import framepilot_engine.service as service_module
    from framepilot_engine.media.ffmpeg import FFmpegError

    def _boom(path: Path, *, timeout: float | None = None, **kwargs: object) -> object:
        raise FFmpegError("decode failed")

    monkeypatch.setattr(service_module, "detect_scenes", _boom)
    project_path = _write_analysis_project(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    resp = client.post("/detect-scenes", json={"project_path": str(project_path)})
    assert resp.status_code == 422


# --- Proxy derivation on /asset-media (plan Phase 15 H3) -----------------------


def test_asset_media_proxy_derives_and_reuses(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import framepilot_engine.service as service_module

    _fake_media_module(monkeypatch, has_video=True, duration=8.0)
    calls: list[Path] = []

    def _fake_proxy(source: Path, output: Path, *, timeout: float | None = None) -> Path:
        calls.append(source)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"mp4")
        return output

    monkeypatch.setattr(service_module, "generate_proxy", _fake_proxy)
    client, src = _sandboxed_client_with_source(tmp_path, "vid.mp4")

    resp = client.post(
        "/asset-media", json={"input_path": str(src), "thumbnails": 0, "proxy": True}
    )
    assert resp.status_code == 200
    proxy_path = resp.json()["proxyPath"]
    assert proxy_path is not None
    assert proxy_path.startswith(".framepilot-derived/")
    assert proxy_path.endswith("proxy.mp4")
    assert (tmp_path / proxy_path).is_file()

    # Idempotent reuse: a second import of the same source does NOT re-transcode.
    resp2 = client.post(
        "/asset-media", json={"input_path": str(src), "thumbnails": 0, "proxy": True}
    )
    assert resp2.json()["proxyPath"] == proxy_path
    assert len(calls) == 1


def test_asset_media_proxy_cache_invalidates_on_encode_version_bump(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """P-1 (preview WebCodecs compositor plan): bumping PROXY_ENCODE_VERSION must
    re-derive rather than silently reuse a proxy encoded under the old ffmpeg
    args — the whole point of salting the cache digest with it."""
    import framepilot_engine.service as service_module

    _fake_media_module(monkeypatch, has_video=True, duration=8.0)
    calls: list[Path] = []

    def _fake_proxy(source: Path, output: Path, *, timeout: float | None = None) -> Path:
        calls.append(source)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"mp4")
        return output

    monkeypatch.setattr(service_module, "generate_proxy", _fake_proxy)
    client, src = _sandboxed_client_with_source(tmp_path, "vid.mp4")

    resp = client.post(
        "/asset-media", json={"input_path": str(src), "thumbnails": 0, "proxy": True}
    )
    old_proxy_path = resp.json()["proxyPath"]
    assert len(calls) == 1

    monkeypatch.setattr(service_module, "PROXY_ENCODE_VERSION", "v3-test-bump")
    resp2 = client.post(
        "/asset-media", json={"input_path": str(src), "thumbnails": 0, "proxy": True}
    )
    new_proxy_path = resp2.json()["proxyPath"]

    assert new_proxy_path is not None
    assert new_proxy_path != old_proxy_path
    assert len(calls) == 2  # re-derived under the new digest, not reused


def test_asset_media_proxy_default_off_and_non_video_skipped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _fake_media_module(monkeypatch, has_video=True, duration=8.0)
    client, src = _sandboxed_client_with_source(tmp_path, "vid.mp4")
    # Flag omitted → no proxy work.
    resp = client.post("/asset-media", json={"input_path": str(src), "thumbnails": 0})
    assert resp.json()["proxyPath"] is None

    _fake_media_module(monkeypatch, has_video=False, duration=3.0)
    client2, song = _sandboxed_client_with_source(tmp_path, "song.m4a")
    resp2 = client2.post(
        "/asset-media", json={"input_path": str(song), "thumbnails": 0, "proxy": True}
    )
    assert resp2.json()["proxyPath"] is None


def test_asset_media_proxy_skips_over_cap_sources(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import framepilot_engine.service as service_module

    _fake_media_module(monkeypatch, has_video=True, duration=100.0)

    def _fail_proxy(source: Path, output: Path, *, timeout: float | None = None) -> Path:
        raise AssertionError("proxy must not be generated past the duration cap")

    monkeypatch.setattr(service_module, "generate_proxy", _fail_proxy)
    src = tmp_path / "long.mp4"
    src.write_bytes(b"fake media bytes")
    client = TestClient(create_app(Settings(projects_root=tmp_path, proxy_max_duration_seconds=60)))
    resp = client.post(
        "/asset-media", json={"input_path": str(src), "thumbnails": 0, "proxy": True}
    )
    assert resp.status_code == 200
    assert resp.json()["proxyPath"] is None


def test_asset_media_proxy_failure_degrades_to_none(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import framepilot_engine.service as service_module
    from framepilot_engine.media.ffmpeg import FFmpegError

    _fake_media_module(monkeypatch, has_video=True, duration=8.0)

    def _boom(source: Path, output: Path, *, timeout: float | None = None) -> Path:
        raise FFmpegError("transcode failed")

    monkeypatch.setattr(service_module, "generate_proxy", _boom)
    client, src = _sandboxed_client_with_source(tmp_path, "vid.mp4")
    resp = client.post(
        "/asset-media", json={"input_path": str(src), "thumbnails": 0, "proxy": True}
    )
    assert resp.status_code == 200
    assert resp.json()["proxyPath"] is None


# --- /detect-beats + inline-project analysis (plan AGENT-NATIVE-UX T3/T6) -----


def test_detect_beats_route(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import framepilot_engine.service as service_module
    from framepilot_engine.analysis.beats import Beat, BeatAnalysis

    seen: dict[str, object] = {}

    def _fake_detect(
        path: Path, *, sensitivity: float, timeout: float | None = None
    ) -> BeatAnalysis:
        seen["path"] = str(path)
        seen["sensitivity"] = sensitivity
        seen["timeout"] = timeout
        return BeatAnalysis(beats=[Beat(time=0.5, strength=1.0)], bpm=120.0)

    monkeypatch.setattr(service_module, "detect_beats", _fake_detect)
    project_path = _write_analysis_project(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path, asset_media_timeout_seconds=9)))

    resp = client.post(
        "/detect-beats",
        json={"project_path": str(project_path), "asset_id": "mus", "sensitivity": 2.0},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["assetId"] == "mus"
    assert body["beats"] == [{"time": 0.5, "strength": 1.0, "on_grid": True}]
    assert body["bpm"] == 120.0
    assert seen["sensitivity"] == 2.0
    assert seen["timeout"] == 9.0
    assert seen["path"] == str(project_path.parent / "song.mp3")


def test_detect_beats_route_defaults_and_ffmpeg_error_422(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import framepilot_engine.service as service_module
    from framepilot_engine.analysis.beats import DEFAULT_SENSITIVITY
    from framepilot_engine.media.ffmpeg import FFmpegError

    seen: dict[str, object] = {}

    def _boom(path: Path, *, sensitivity: float, timeout: float | None = None) -> object:
        seen["sensitivity"] = sensitivity
        raise FFmpegError("decode failed")

    monkeypatch.setattr(service_module, "detect_beats", _boom)
    project_path = _write_analysis_project(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    resp = client.post("/detect-beats", json={"project_path": str(project_path)})
    assert resp.status_code == 422
    assert seen["sensitivity"] == DEFAULT_SENSITIVITY


def test_detect_beats_route_reports_a_silent_asset_as_an_empty_result(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Silent footage has no beats — that is a RESULT with a reason, not an error.

    Reported as a 4xx it terminated whole agent runs over one video-only asset; as an
    empty analysis the caller reads the reason and picks a music asset (or edits without
    a grid).
    """
    import framepilot_engine.service as service_module
    from framepilot_engine.media.ffmpeg import NoAudioStreamError

    def _silent(path: Path, *, sensitivity: float, timeout: float | None = None) -> object:
        raise NoAudioStreamError(f"{path.name} has no audio track, so there are no beats.")

    monkeypatch.setattr(service_module, "detect_beats", _silent)
    project_path = _write_analysis_project(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    resp = client.post("/detect-beats", json={"project_path": str(project_path)})
    assert resp.status_code == 200
    body = resp.json()
    assert body["beats"] == []
    assert body["bpm"] is None
    assert "has no audio track" in body["reason"]


def test_detect_beats_route_prefers_an_audio_asset_when_given_no_id(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Beat detection wants the soundtrack: an id-less call must not land on footage
    just because it comes first in the bin."""
    import framepilot_engine.service as service_module
    from framepilot_engine.analysis.beats import BeatAnalysis

    seen: dict[str, object] = {}

    def _detect(path: Path, *, sensitivity: float, timeout: float | None = None) -> BeatAnalysis:
        seen["path"] = path.name
        return BeatAnalysis(beats=[], bpm=None)

    monkeypatch.setattr(service_module, "detect_beats", _detect)
    # The fixture lists the video first and the music track second.
    project_path = _write_analysis_project(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    resp = client.post("/detect-beats", json={"project_path": str(project_path)})
    assert resp.status_code == 200
    assert resp.json()["assetId"] == "mus"
    assert seen["path"] == "song.mp3"


def test_detect_beats_route_logs_an_underivable_tempo_without_crashing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Too few beats to estimate a tempo returns ``bpm: null`` — the log must not
    try to format ``None`` as a float and turn a valid answer into a 500."""
    import framepilot_engine.service as service_module
    from framepilot_engine.analysis.beats import BeatAnalysis

    monkeypatch.setattr(
        service_module,
        "detect_beats",
        lambda path, *, sensitivity, timeout=None: BeatAnalysis(beats=[], bpm=None),
    )
    project_path = _write_analysis_project(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    resp = client.post("/detect-beats", json={"project_path": str(project_path)})
    assert resp.status_code == 200
    assert resp.json()["bpm"] is None


def test_analysis_route_accepts_inline_project(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The agent loop analyses its unsaved WORKING copy by inlining the document."""
    import framepilot_engine.service as service_module
    from framepilot_engine.analysis.silence import SilentRange

    seen: dict[str, object] = {}

    def _fake_detect(
        path: Path, *, timeout: float | None = None, **kwargs: object
    ) -> list[SilentRange]:
        seen["path"] = str(path)
        return []

    monkeypatch.setattr(service_module, "detect_silence", _fake_detect)
    (tmp_path / "song.mp3").write_bytes(b"x")
    inline = {
        "schemaVersion": 1,
        "id": "p1",
        "name": "Inline",
        "assets": [{"id": "mus", "path": "song.mp3", "kind": "audio"}],
        "timeline": {"tracks": []},
    }
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    resp = client.post("/analyze-silence", json={"project": inline, "asset_id": "mus"})
    assert resp.status_code == 200
    # Inline asset paths resolve against the configured projects root, sandboxed.
    assert seen["path"] == str(tmp_path / "song.mp3")


def test_analysis_route_rejects_invalid_inline_project(tmp_path: Path) -> None:
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    resp = client.post("/analyze-silence", json={"project": {"id": 42}})
    assert resp.status_code == 400
    assert "Invalid inline project" in resp.text


def test_analysis_route_requires_exactly_one_project_source(tmp_path: Path) -> None:
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    # Neither source.
    assert client.post("/analyze-silence", json={}).status_code == 422
    # Both sources.
    resp = client.post(
        "/analyze-silence",
        json={"project_path": "p.fp.json", "project": {"id": "x", "name": "y"}},
    )
    assert resp.status_code == 422


def test_inline_project_media_path_is_sandboxed(tmp_path: Path) -> None:
    """An inline project cannot point analysis at a file outside the sandbox."""
    inline = {
        "id": "p1",
        "name": "Escape",
        "assets": [{"id": "mus", "path": "../../etc/passwd", "kind": "audio"}],
        "timeline": {"tracks": []},
    }
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    resp = client.post("/analyze-silence", json={"project": inline, "asset_id": "mus"})
    assert resp.status_code == 400


# --- ASR routes: /asr/status, /asr/setup, /transcribe (plan H0.1) -------------


def test_asr_status_route_reports_unavailable_honestly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(tmp_path))
    monkeypatch.delenv("FRAMEPILOT_WHISPER_CLI", raising=False)
    monkeypatch.setattr("shutil.which", lambda _name: None)
    client = TestClient(create_app())
    resp = client.get("/asr/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["binaryAvailable"] is False
    assert body["model"] == "large-v3-turbo-q5_0"
    assert body["modelPresent"] is False


def test_asr_status_route_honours_model_query_param(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(tmp_path))
    client = TestClient(create_app())
    resp = client.get("/asr/status", params={"model": "base.en"})
    assert resp.status_code == 200
    assert resp.json()["model"] == "base.en"


def _asr_tracker(chunks: Sequence[bytes], *, total_bytes: int | None = None) -> AsrSetupTracker:
    """A tracker whose downloader yields fixed chunks instead of hitting the network."""

    @contextmanager
    def opener(_url: str) -> Iterator[ModelDownload]:
        yield ModelDownload(total_bytes=total_bytes, chunks=iter(chunks))

    return AsrSetupTracker(downloader=opener)


def test_asr_status_route_reports_the_download_size(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The UI reports the professional default's real download size before setup.
    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(tmp_path))
    resp = TestClient(create_app()).get("/asr/status")
    assert resp.json()["downloadSizeBytes"] == 574041195


def test_asr_setup_route_installs_model(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import hashlib

    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(tmp_path))
    payload = b"fake-model-bytes"
    monkeypatch.setenv("FRAMEPILOT_ASR_BASE_EN_SHA256", hashlib.sha256(payload).hexdigest())

    client = TestClient(create_app(asr_setup=_asr_tracker([payload], total_bytes=len(payload))))
    resp = client.post("/asr/setup", json={"model": "base.en"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["model"] == "base.en"
    assert body["installed"] is True
    assert (tmp_path / "ggml-base.en.bin").read_bytes() == payload

    # Post-run the progress route reports the terminal state, not a stale spinner.
    progress = client.get("/asr/setup/progress").json()
    assert progress["state"] == "installed"
    assert progress["downloadedBytes"] == len(payload)
    assert progress["totalBytes"] == len(payload)
    assert progress["error"] is None


def test_asr_setup_progress_route_is_idle_before_any_setup(tmp_path: Path) -> None:
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    body = client.get("/asr/setup/progress").json()
    assert body["state"] == "idle"
    assert body["downloadedBytes"] == 0
    assert body["totalBytes"] is None


def test_asr_setup_progress_route_reports_live_bytes_mid_download(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The whole point of the route: real byte counts while the POST is still in flight."""
    import hashlib

    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(tmp_path))
    payload = b"0123456789"
    monkeypatch.setenv("FRAMEPILOT_ASR_BASE_EN_SHA256", hashlib.sha256(payload).hexdigest())

    tracker = AsrSetupTracker()
    seen: list[dict[str, Any]] = []

    @contextmanager
    def opener(_url: str) -> Iterator[ModelDownload]:
        def chunks() -> Iterator[bytes]:
            yield payload[:4]
            # Poll from inside the download — the setup POST runs on a worker
            # thread, so the event loop is free to serve this concurrently.
            seen.append(api.get("/asr/setup/progress").json())
            yield payload[4:]

        yield ModelDownload(total_bytes=len(payload), chunks=chunks())

    tracker._downloader = opener
    api = TestClient(create_app(asr_setup=tracker))

    assert api.post("/asr/setup", json={"model": "base.en"}).status_code == 200
    assert seen == [
        {
            "state": "downloading",
            "model": "base.en",
            "downloadedBytes": 4,
            "totalBytes": 10,
            "error": None,
        }
    ]


def test_asr_setup_cancel_route_aborts_the_download(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(tmp_path))
    monkeypatch.setenv("FRAMEPILOT_ASR_BASE_EN_SHA256", "0" * 64)
    tracker = AsrSetupTracker()

    @contextmanager
    def opener(_url: str) -> Iterator[ModelDownload]:
        def chunks() -> Iterator[bytes]:
            yield b"abcd"
            assert api.post("/asr/setup/cancel").json()["state"] == "downloading"
            yield b"efgh"

        yield ModelDownload(total_bytes=8, chunks=chunks())

    tracker._downloader = opener
    api = TestClient(create_app(asr_setup=tracker))

    resp = api.post("/asr/setup", json={"model": "base.en"})
    assert resp.status_code == 409
    assert "cancelled" in resp.json()["detail"]

    progress = api.get("/asr/setup/progress").json()
    assert progress["state"] == "cancelled"
    assert progress["downloadedBytes"] == 4
    # Nothing installed, nothing left behind.
    assert list(tmp_path.iterdir()) == []


def test_asr_setup_cancel_route_is_a_no_op_when_idle(tmp_path: Path) -> None:
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    resp = client.post("/asr/setup/cancel")
    assert resp.status_code == 200
    assert resp.json()["state"] == "idle"


def test_asr_setup_route_rejects_a_concurrent_setup_with_409(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import hashlib

    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(tmp_path))
    payload = b"abcd"
    monkeypatch.setenv("FRAMEPILOT_ASR_BASE_EN_SHA256", hashlib.sha256(payload).hexdigest())
    tracker = AsrSetupTracker()
    second: list[int] = []

    @contextmanager
    def opener(_url: str) -> Iterator[ModelDownload]:
        def chunks() -> Iterator[bytes]:
            second.append(api.post("/asr/setup", json={"model": "base.en"}).status_code)
            yield payload

        yield ModelDownload(total_bytes=4, chunks=chunks())

    tracker._downloader = opener
    api = TestClient(create_app(asr_setup=tracker))

    assert api.post("/asr/setup", json={"model": "base.en"}).status_code == 200
    assert second == [409]


def test_asr_setup_route_checksum_mismatch_422(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(tmp_path))
    monkeypatch.setenv("FRAMEPILOT_ASR_BASE_EN_SHA256", "0" * 64)
    client = TestClient(create_app(asr_setup=_asr_tracker([b"wrong-bytes"])))

    resp = client.post("/asr/setup", json={"model": "base.en"})
    assert resp.status_code == 422
    assert "checksum verification" in resp.json()["detail"]

    # The failure message reaches a poller too, so the UI can explain itself.
    progress = client.get("/asr/setup/progress").json()
    assert progress["state"] == "error"
    assert "checksum verification" in progress["error"]


def test_asr_setup_route_unknown_model_400(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    resp = client.post("/asr/setup", json={"model": "does-not-exist"})
    assert resp.status_code == 400


def test_transcribe_route_returns_words(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import framepilot_engine.service as service_module
    from framepilot_engine.timeline.models import TranscriptWord

    seen: dict[str, object] = {}

    def _fake_transcribe(
        path: Path, *, model: str, timeout: float | None = None, use_cache: bool = True
    ) -> list[TranscriptWord]:
        seen["path"] = str(path)
        seen["model"] = model
        seen["use_cache"] = use_cache
        return [TranscriptWord(word="hi", start=0.0, end=0.5)]

    monkeypatch.setattr(service_module, "transcribe", _fake_transcribe)
    project_path = _write_analysis_project(tmp_path)
    client = TestClient(
        create_app(Settings(projects_root=tmp_path, asset_media_timeout_seconds=13))
    )

    resp = client.post("/transcribe", json={"project_path": str(project_path), "asset_id": "mus"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["assetId"] == "mus"
    # v12: the route stamps the asset it transcribed onto every word, aliased to
    # the camelCase the TS contract reads (ADR 0076).
    assert body["words"] == [
        {
            "word": "hi",
            "start": 0.0,
            "end": 0.5,
            "assetId": "mus",
            "confidence": None,
            "speaker": None,
        }
    ]
    assert seen["model"] == "large-v3-turbo-q5_0"
    assert seen["use_cache"] is True
    assert seen["path"] == str(project_path.parent / "song.mp3")


def test_asr_prepare_audio_route_returns_wav_bytes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import framepilot_engine.service as service_module

    seen: dict[str, object] = {}

    def _fake_extract(path: Path, *, timeout: float | None = None) -> bytes:
        seen["path"] = str(path)
        return b"RIFF....WAVEfake"

    monkeypatch.setattr(service_module, "extract_mono16k_wav", _fake_extract)
    project_path = _write_analysis_project(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))

    resp = client.post(
        "/asr/prepare-audio", json={"project_path": str(project_path), "asset_id": "mus"}
    )
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "audio/wav"
    assert resp.content == b"RIFF....WAVEfake"
    # Decoded from the same sandbox-resolved media the /transcribe route uses.
    assert seen["path"] == str(project_path.parent / "song.mp3")


def test_asr_prepare_audio_route_maps_asr_error_to_422(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import framepilot_engine.service as service_module
    from framepilot_engine.audio.asr import AsrTranscriptionError

    def _boom(path: Path, *, timeout: float | None = None) -> bytes:
        raise AsrTranscriptionError("ffmpeg unavailable for ASR audio prep")

    monkeypatch.setattr(service_module, "extract_mono16k_wav", _boom)
    project_path = _write_analysis_project(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    resp = client.post(
        "/asr/prepare-audio", json={"project_path": str(project_path), "asset_id": "mus"}
    )
    assert resp.status_code == 422
    assert "ffmpeg unavailable" in resp.text


def test_transcribe_route_binary_missing_returns_503(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import framepilot_engine.service as service_module
    from framepilot_engine.audio.asr import WhisperCliNotFoundError

    def _boom(
        path: Path, *, model: str, timeout: float | None = None, use_cache: bool = True
    ) -> object:
        raise WhisperCliNotFoundError("whisper-cli not found on PATH.")

    monkeypatch.setattr(service_module, "transcribe", _boom)
    project_path = _write_analysis_project(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    resp = client.post("/transcribe", json={"project_path": str(project_path), "asset_id": "mus"})
    assert resp.status_code == 503
    assert "whisper-cli" in resp.text


def test_transcribe_route_model_missing_returns_503(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import framepilot_engine.service as service_module
    from framepilot_engine.audio.asr import AsrModelMissingError

    def _boom(
        path: Path, *, model: str, timeout: float | None = None, use_cache: bool = True
    ) -> object:
        raise AsrModelMissingError(model, Path("/tmp/ggml-base.en.bin"))

    monkeypatch.setattr(service_module, "transcribe", _boom)
    project_path = _write_analysis_project(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    resp = client.post("/transcribe", json={"project_path": str(project_path), "asset_id": "mus"})
    assert resp.status_code == 503
    assert "setup" in resp.text.lower()


def test_transcribe_route_asr_error_returns_422(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import framepilot_engine.service as service_module
    from framepilot_engine.audio.asr import AsrTranscriptionError

    def _boom(
        path: Path, *, model: str, timeout: float | None = None, use_cache: bool = True
    ) -> object:
        raise AsrTranscriptionError("whisper-cli exited 1")

    monkeypatch.setattr(service_module, "transcribe", _boom)
    project_path = _write_analysis_project(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    resp = client.post("/transcribe", json={"project_path": str(project_path), "asset_id": "mus"})
    assert resp.status_code == 422


# --- CORS: renderer fetch() to the sidecar is cross-origin -------------------


def test_asr_setup_preflight_succeeds_for_allowed_renderer_origin() -> None:
    """A browser sends an OPTIONS preflight before a JSON POST; without CORS
    middleware Starlette has no route for it and answers 405 — the bug reported
    as "Method Not Allowed" clicking Settings' ASR "Set up" button."""
    client = TestClient(create_app())
    resp = client.options(
        "/asr/setup",
        headers={
            "origin": "http://localhost:5173",
            "access-control-request-method": "POST",
        },
    )
    assert resp.status_code == 200
    assert resp.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_asr_setup_preflight_succeeds_for_packaged_app_null_origin() -> None:
    """The packaged desktop app's file:// renderer sends the literal Origin: null."""
    client = TestClient(create_app())
    resp = client.options(
        "/asr/setup",
        headers={"origin": "null", "access-control-request-method": "POST"},
    )
    assert resp.status_code == 200
    assert resp.headers["access-control-allow-origin"] == "null"


def test_asr_setup_preflight_rejected_for_unknown_origin() -> None:
    client = TestClient(create_app())
    resp = client.options(
        "/asr/setup",
        headers={
            "origin": "https://evil.example",
            "access-control-request-method": "POST",
        },
    )
    assert "access-control-allow-origin" not in resp.headers


# An INLINE project document carries project-RELATIVE media paths, so it needs the
# sandbox root just as much as an explicit `project_path` does. Before the fix the
# inline branch fell back to `Path.cwd()`, which (a) silently resolved media against
# wherever the process was launched and (b) raised an UNHANDLED FileNotFoundError once
# that launch directory was replaced — surfacing to the agent as an opaque
# "Analysis failed (500): Internal Server Error" instead of the actionable 503, and
# stalling whole agent runs on a pure misconfiguration.
INLINE_PROJECT_FIXTURE = {
    "id": "inline-no-root",
    "name": "Inline",
    "assets": [{"id": "mus", "path": "song.mp3", "kind": "audio"}],
    "timeline": {"tracks": []},
}


@pytest.mark.parametrize(
    ("route", "body"),
    [
        ("/detect-beats", {"project": INLINE_PROJECT_FIXTURE}),
        ("/detect-scenes", {"project": INLINE_PROJECT_FIXTURE}),
        ("/analyze-silence", {"project": INLINE_PROJECT_FIXTURE}),
        ("/transcribe", {"project": INLINE_PROJECT_FIXTURE}),
        ("/asr/prepare-audio", {"project": INLINE_PROJECT_FIXTURE}),
        ("/analyze", {"project": INLINE_PROJECT_FIXTURE, "assetId": "mus"}),
    ],
)
def test_inline_project_routes_fail_closed_without_projects_root(
    monkeypatch: pytest.MonkeyPatch, route: str, body: dict[str, object]
) -> None:
    monkeypatch.delenv("FRAMEPILOT_PROJECTS_ROOT", raising=False)
    client = TestClient(create_app())
    resp = client.post(route, json=body)
    assert resp.status_code == 503, resp.text
    detail = resp.json()["detail"]
    assert "projects_root is not configured" in detail
    assert "FRAMEPILOT_PROJECTS_ROOT" in detail


def test_inline_project_fails_closed_before_asset_lookup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The misconfiguration is reported even when the asset id is also wrong.

    Guards the ordering: `Path.cwd()` used to run *before* the 404, so a
    missing root masked every other diagnosis on the route.
    """
    monkeypatch.delenv("FRAMEPILOT_PROJECTS_ROOT", raising=False)
    client = TestClient(create_app())
    resp = client.post(
        "/detect-beats", json={"project": INLINE_PROJECT_FIXTURE, "asset_id": "nope"}
    )
    assert resp.status_code == 503, resp.text


def test_inline_project_still_400s_on_an_invalid_document(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A malformed inline document is a CLIENT error, and stays one without a root."""
    monkeypatch.delenv("FRAMEPILOT_PROJECTS_ROOT", raising=False)
    client = TestClient(create_app())
    resp = client.post("/detect-beats", json={"project": {"assets": []}})
    assert resp.status_code == 400, resp.text
    assert "Invalid inline project" in resp.json()["detail"]


def test_inline_project_never_resolves_media_against_the_process_cwd(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The incident itself: an unusable CWD must not become a 500.

    `Path.cwd()` raises `FileNotFoundError` when the launch directory has been
    unlinked (a checkout/rebuild under a long-running sidecar is enough). While
    the inline branch used it as a fallback base that error escaped the route as
    a bare 500 "Internal Server Error", which is what the agent saw for every
    analysis call. The base is the sandbox root or nothing, so `cwd` is never read.
    """
    monkeypatch.delenv("FRAMEPILOT_PROJECTS_ROOT", raising=False)

    def _unlinked_cwd() -> Path:
        raise FileNotFoundError(2, "No such file or directory")

    monkeypatch.setattr(Path, "cwd", staticmethod(_unlinked_cwd))
    client = TestClient(create_app())
    resp = client.post("/detect-beats", json={"project": INLINE_PROJECT_FIXTURE})
    assert resp.status_code == 503, resp.text
    assert "projects_root is not configured" in resp.json()["detail"]
