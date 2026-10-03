"""A footage-map or describe request never waits on Pegasus longer than its budget.

The defect, measured: on a 58:51 reel, ``map_footage`` failed after 121 s with "The read
operation timed out". Pegasus reads the whole video before it answers, so the chapter
call outlasted the client's flat 120 s bound, and the route held the HTTP request for
every asset's three Pegasus calls in turn, behind Node's 300 s headers timeout. An hour
of footage never got a map.

Each asset's map now runs as one ``SliceWork`` unit. A request waits a bounded time and
answers with what is cached plus the assets still mapping; the next call collects them.
These tests inject a ``SliceWork`` whose units run only when the test says so, and set
the wait to zero, so "still mapping" is a state the test controls and nothing sleeps.
The TwelveLabs client is faked at the service seam; every brain write is real SQLite.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

import framepilot_engine.service as service_module
from framepilot_engine.brain.slice_work import SliceWork
from framepilot_engine.brain.store import open_brain
from framepilot_engine.brain.twelvelabs import (
    TLChapter,
    TLGist,
    TLHighlight,
    TwelveLabsClientResolution,
    TwelveLabsError,
)
from framepilot_engine.brain.twelvelabs_index import (
    read_cached_pegasus,
    store_cached_pegasus,
    store_index_id,
    store_video_mapping,
)
from framepilot_engine.config import Settings
from framepilot_engine.media.probe import MediaInfo, StreamInfo
from framepilot_engine.service import MAPPING_IN_PROGRESS_REASON, create_app

#: The measured source: 58:51.
_LONG_SOURCE_SECONDS = 3531.0


class _ManualSpawn:
    """A ``SliceWork`` spawn that queues each unit until :meth:`run_all`."""

    def __init__(self) -> None:
        self.queued: list[Callable[[], None]] = []

    def __call__(self, target: Callable[[], None], name: str) -> None:
        self.queued.append(target)

    def run_all(self) -> None:
        queued, self.queued = self.queued, []
        for target in queued:
            target()


class _PegasusTL:
    """Only the calls the map and describe routes make; records every Pegasus call."""

    #: The real client derives this from its key; a fixed value is one stable "account".
    key_fingerprint = "fp-current"

    def __init__(self, *, error: Exception | None = None) -> None:
        self.error = error
        #: ``(call, uploaded asset, duration_seconds)`` per Pegasus call.
        self.calls: list[tuple[str, str, float | None]] = []

    def source_asset_id(self, index_id: str, video_id: str) -> str | None:
        return f"upload-{video_id}"

    def _record(self, call: str, asset_ref: str, duration_seconds: float | None) -> None:
        self.calls.append((call, asset_ref, duration_seconds))
        if self.error is not None:
            raise self.error

    def summarize_chapters(
        self, asset_ref: str, *, duration_seconds: float | None = None
    ) -> list[TLChapter]:
        self._record("chapters", asset_ref, duration_seconds)
        return [TLChapter(start=0.0, end=40.0, title="Launch pad", summary="The rocket.")]

    def summarize_highlights(
        self, asset_ref: str, *, duration_seconds: float | None = None
    ) -> list[TLHighlight]:
        self._record("highlights", asset_ref, duration_seconds)
        return [TLHighlight(start=12.0, end=14.0, label="Ignition")]

    def summarize_gist(self, asset_ref: str, *, duration_seconds: float | None = None) -> TLGist:
        self._record("gist", asset_ref, duration_seconds)
        return TLGist(summary="An interview about the Moon.")


@pytest.fixture
def root(tmp_path: Path) -> Path:
    """A sandbox of this test's own (the conftest ``projects_root`` is session-wide)."""
    path = tmp_path / "projects"
    path.mkdir()
    return path


def _probe(duration: float) -> dict[str, Any]:
    return MediaInfo(
        path="/moon-watch.mp4",
        duration_seconds=duration,
        format_name="mov,mp4,m4a",
        streams=[StreamInfo(index=0, codec_type="video", width=1080, height=608, fps=30.0)],
    ).model_dump(mode="json")


def _seed_indexed(root: Path, asset_id: str, *, duration: float = _LONG_SOURCE_SECONDS) -> None:
    """One asset indexed and ready on TwelveLabs, with no cached Pegasus map yet."""
    (root / f"{asset_id}.mp4").write_bytes(b"\x00\x00fake\x00\x00")
    with open_brain(root, "p1") as store:
        store.upsert_asset(
            asset_id,
            path=f"{asset_id}.mp4",
            content_sha256=f"sha-{asset_id}",
            probe=_probe(duration),
        )
        store_index_id(store, "idx-1")
        store_video_mapping(
            store,
            asset_id,
            content_hash=f"sha-{asset_id}",
            status="ready",
            video_id=f"video-{asset_id}",
            source_asset_id=f"upload-{asset_id}",
        )


def _client(
    root: Path, fake: _PegasusTL, spawn: _ManualSpawn, monkeypatch: pytest.MonkeyPatch
) -> TestClient:
    monkeypatch.setattr(
        service_module,
        "resolve_twelvelabs",
        lambda key=None: TwelveLabsClientResolution(client=fake),  # type: ignore[arg-type]
    )
    monkeypatch.setattr(service_module, "PEGASUS_MAP_WAIT_SECONDS", 0.0)
    return TestClient(
        create_app(
            Settings(projects_root=root, twelvelabs_api_key="tl-key"),
            slice_work=SliceWork(spawn=spawn),
        )
    )


def _map(client: TestClient, **body: Any) -> Any:
    return client.post(
        "/brain/visual/footage-map", json={"projectId": "p1", "assetTime": True, **body}
    ).json()


def _cached(root: Path, asset_id: str) -> object:
    with open_brain(root, "p1") as store:
        return read_cached_pegasus(store, asset_id, content_hash=f"sha-{asset_id}")


# --- a long map --------------------------------------------------------------------


def test_a_long_map_answers_mapping_and_a_later_call_collects_it(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_indexed(root, "moon")
    fake, spawn = _PegasusTL(), _ManualSpawn()
    client = _client(root, fake, spawn, monkeypatch)

    first = _map(client)
    # Not `not_indexed`: that tells the model to give up on footage minutes from a map.
    assert first["available"] is True
    assert first["reason"] == MAPPING_IN_PROGRESS_REASON
    assert first["pendingAssets"] == ["moon"]
    assert first["chapters"] == []
    assert _cached(root, "moon") is None

    # Asked again while Pegasus is still reading: the same work, never a second bill.
    again = _map(client)
    assert again["pendingAssets"] == ["moon"]
    assert len(spawn.queued) == 1

    spawn.run_all()
    collected = _map(client)

    assert collected["reason"] is None
    assert collected["pendingAssets"] == []
    assert [c["title"] for c in collected["chapters"]] == ["Launch pad"]
    assert [h["label"] for h in collected["highlights"]] == ["Ignition"]
    assert collected["summary"] == "An interview about the Moon."
    # Written by the collecting request, so the next open is a free cache hit.
    assert _cached(root, "moon") is not None
    assert [call for call, _, _ in fake.calls] == ["chapters", "highlights", "gist"]


def test_the_assets_duration_sizes_every_pegasus_call(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_indexed(root, "moon")
    fake, spawn = _PegasusTL(), _ManualSpawn()
    client = _client(root, fake, spawn, monkeypatch)

    _map(client)
    spawn.run_all()

    assert fake.calls == [
        ("chapters", "upload-moon", _LONG_SOURCE_SECONDS),
        ("highlights", "upload-moon", _LONG_SOURCE_SECONDS),
        ("gist", "upload-moon", _LONG_SOURCE_SECONDS),
    ]


def test_a_partial_map_serves_the_cached_assets_and_lists_the_rest(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_indexed(root, "moon")
    _seed_indexed(root, "x59", duration=467.0)
    with open_brain(root, "p1") as store:
        store_cached_pegasus(
            store,
            "x59",
            content_hash="sha-x59",
            chapters=[TLChapter(start=0.0, end=30.0, title="Taxi", summary="")],
            highlights=[],
            summary="The X-59 rolls out.",
        )
    fake, spawn = _PegasusTL(), _ManualSpawn()
    client = _client(root, fake, spawn, monkeypatch)

    body = _map(client)

    # A usable map NOW, with the missing asset named rather than silently absent.
    assert body["reason"] is None
    assert [(c["assetId"], c["title"]) for c in body["chapters"]] == [("x59", "Taxi")]
    assert body["pendingAssets"] == ["moon"]


def test_every_miss_starts_in_the_same_request(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """One wait for the whole request, not one per asset: both maps start at once."""
    _seed_indexed(root, "moon")
    _seed_indexed(root, "x59", duration=467.0)
    fake, spawn = _PegasusTL(), _ManualSpawn()
    client = _client(root, fake, spawn, monkeypatch)

    body = _map(client)

    assert sorted(body["pendingAssets"]) == ["moon", "x59"]
    assert len(spawn.queued) == 2


def test_a_cached_only_read_never_starts_a_map(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _seed_indexed(root, "moon")
    fake, spawn = _PegasusTL(), _ManualSpawn()
    client = _client(root, fake, spawn, monkeypatch)

    body = _map(client, cachedOnly=True)

    assert body["chapters"] == [] and body["pendingAssets"] == []
    assert spawn.queued == [] and fake.calls == []


def test_a_transport_error_on_collection_degrades_as_before_and_can_be_retried(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_indexed(root, "moon")
    fake = _PegasusTL(
        error=TwelveLabsError("TwelveLabs request failed: The read operation timed out")
    )
    spawn = _ManualSpawn()
    client = _client(root, fake, spawn, monkeypatch)

    assert _map(client)["reason"] == MAPPING_IN_PROGRESS_REASON
    spawn.run_all()
    failed = _map(client)

    # Exactly the answer the route gave when the call ran inline and failed.
    assert failed["available"] is False
    assert failed["reason"] == "TwelveLabs request failed: The read operation timed out"
    assert _cached(root, "moon") is None
    # Reported, not remembered: the next call asks Pegasus again.
    assert _map(client)["reason"] == MAPPING_IN_PROGRESS_REASON
    assert len(spawn.queued) == 1


# --- describe shares the work ------------------------------------------------------


def _describe(client: TestClient) -> Any:
    return client.post("/brain/visual/describe", json={"projectId": "p1", "assetId": "moon"}).json()


def test_describe_answers_mapping_and_shares_the_maps_work(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_indexed(root, "moon")
    fake, spawn = _PegasusTL(), _ManualSpawn()
    client = _client(root, fake, spawn, monkeypatch)

    assert _map(client)["pendingAssets"] == ["moon"]
    pending = _describe(client)
    assert pending["available"] is True
    assert pending["reason"] == MAPPING_IN_PROGRESS_REASON
    assert pending["packets"] == []
    # The map's unit, not a second one: one asset is paid for once.
    assert len(spawn.queued) == 1

    spawn.run_all()
    described = _describe(client)

    assert described["reason"] is None
    assert len(described["packets"]) == 1
    assert len(fake.calls) == 3
    assert _cached(root, "moon") is not None
