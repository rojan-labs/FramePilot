"""Service tests for the TwelveLabs backend on the ``/brain/visual/*`` routes.

When a TwelveLabs key resolves, index/search/describe/status delegate to the
hosted backend instead of the built-in NVIDIA-embed pipeline. The client is
mocked at the service seam (no live API); the brain reads/writes are real SQLite,
so the asset↔video mapping and clip→packet mapping run end to end. A companion
regression test proves the built-in path is untouched when no TwelveLabs key is
set.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

import framepilot_engine.service as service_module
from framepilot_engine.audio.asr import WhisperCliNotFoundError
from framepilot_engine.brain.store import open_brain
from framepilot_engine.brain.twelvelabs import (
    TaskStatus,
    TLChapter,
    TLClip,
    TLGist,
    TLHighlight,
    TLWord,
    TwelveLabsAuthError,
    TwelveLabsClientResolution,
    TwelveLabsPegasusUnavailableError,
)
from framepilot_engine.brain.twelvelabs_index import store_index_id, store_video_mapping
from framepilot_engine.config import Settings
from framepilot_engine.media.probe import MediaInfo, StreamInfo
from framepilot_engine.service import create_app


def _video_probe() -> dict[str, Any]:
    return MediaInfo(
        path="/clip.mp4",
        duration_seconds=3.0,
        format_name="mov,mp4,m4a",
        streams=[StreamInfo(index=0, codec_type="video", width=1920, height=1080, fps=30.0)],
    ).model_dump(mode="json")


def _seed_asset(root: Path, tmp: Path) -> None:
    (tmp / "clip.mp4").write_bytes(b"\x00\x00fake\x00\x00")
    with open_brain(root, "p1") as store:
        store.upsert_asset("vid", path="clip.mp4", content_sha256="sha-vid", probe=_video_probe())


class _FakeTL:
    """A fake TwelveLabs client covering the routes' calls."""

    def __init__(
        self,
        *,
        clips: list[TLClip] | None = None,
        words: list[TLWord] | None = None,
        chapters: list[TLChapter] | None = None,
        highlights: list[TLHighlight] | None = None,
        gist: str = "",
        auth_fail: bool = False,
        pegasus_unavailable: bool = False,
    ) -> None:
        self.clips = clips or []
        self.words = words or []
        self.chapters = chapters or []
        self.highlights = highlights or []
        self.gist = gist
        self.auth_fail = auth_fail
        self.pegasus_unavailable = pegasus_unavailable
        self.source_lookups = 0

    def get_transcription(self, index_id: str, video_id: str) -> list[TLWord]:
        if self.auth_fail:
            raise TwelveLabsAuthError("bad key")
        return self.words

    def _pegasus_guard(self) -> None:
        if self.auth_fail:
            raise TwelveLabsAuthError("bad key")
        if self.pegasus_unavailable:
            raise TwelveLabsPegasusUnavailableError("no entitlement")

    def summarize_chapters(self, asset_ref: str) -> list[TLChapter]:
        self._pegasus_guard()
        return self.chapters

    def summarize_highlights(self, asset_ref: str) -> list[TLHighlight]:
        self._pegasus_guard()
        return self.highlights

    def summarize_gist(self, asset_ref: str) -> TLGist:
        self._pegasus_guard()
        return TLGist(summary=self.gist)

    def source_asset_id(self, index_id: str, video_id: str) -> str | None:
        """Recover the uploaded asset id an older mapping never stored."""
        self.source_lookups += 1
        return f"upload-{video_id}"

    def create_index(self, name: str) -> str:
        if self.auth_fail:
            raise TwelveLabsAuthError("bad key")
        return "idx-1"

    def create_index_task(self, index_id: str, media_path: Path) -> str:
        return "task-1"

    def get_task(self, task_id: str) -> TaskStatus:
        return TaskStatus(task_id, "ready", "video-xyz")

    def search(
        self, index_id: str, query: str, *, options: Any = None, page_limit: int = 10
    ) -> list[TLClip]:
        if self.auth_fail:
            raise TwelveLabsAuthError("bad key")
        return self.clips


def _client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fake: _FakeTL | None) -> TestClient:
    if fake is not None:
        monkeypatch.setattr(
            service_module,
            "resolve_twelvelabs",
            lambda key=None: TwelveLabsClientResolution(client=fake),  # type: ignore[arg-type]
        )
    settings = Settings(projects_root=tmp_path, twelvelabs_api_key="tl-key")
    return TestClient(create_app(settings))


def _project_doc() -> dict[str, Any]:
    return {
        "id": "p1",
        "name": "Demo",
        "timeline": {
            "tracks": [
                {
                    "id": "t1",
                    "type": "video",
                    "clips": [
                        {
                            "id": "c1",
                            "assetId": "vid",
                            "trackId": "t1",
                            "start": 0.0,
                            "end": 3.0,
                            "sourceStart": 0.0,
                            "sourceEnd": 3.0,
                        }
                    ],
                }
            ]
        },
        "transcript": [{"word": "app", "start": 0.6, "end": 0.9}],
    }


# --- index -----------------------------------------------------------------------


def test_index_uploads_and_completes_via_twelvelabs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_asset(tmp_path, tmp_path)
    client = _client(tmp_path, monkeypatch, _FakeTL())
    body = client.post("/brain/visual/index", json={"projectId": "p1"}).json()
    assert body["available"] is True
    assert body["done"] is True
    assert body["indexed"] == 1
    assert "TwelveLabs" in body["captionsReason"]
    # The mapping is persisted so search can resolve video → asset.
    status = client.get("/brain/visual/status", params={"projectId": "p1"}).json()
    assert status["backend"] == "twelvelabs"
    assert status["indexedAssets"] == 1
    assert status["totalAssets"] == 1
    assert status["keyConfigured"] is True


def test_index_auth_failure_is_honest(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _seed_asset(tmp_path, tmp_path)
    client = _client(tmp_path, monkeypatch, _FakeTL(auth_fail=True))
    body = client.post("/brain/visual/index", json={"projectId": "p1"}).json()
    assert body["available"] is True and body["reason"] == "invalid_api_key"


def test_index_unavailable_without_projects_root(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        service_module,
        "resolve_twelvelabs",
        lambda key=None: TwelveLabsClientResolution(client=_FakeTL()),  # type: ignore[arg-type]
    )
    client = TestClient(create_app(Settings(twelvelabs_api_key="tl-key")))
    body = client.post("/brain/visual/index", json={"projectId": "p1"}).json()
    assert body["available"] is False and "sandbox root" in body["reason"]


def test_status_detects_twelvelabs_backend_without_env_key(tmp_path: Path) -> None:
    """A project indexed via a host/Settings key (engine env unset) must still
    report the ``twelvelabs`` backend — detected from its stored index id — not
    mislabel itself as ``sqlite-vec`` (the "stuck on sqlite-vec" report)."""
    _seed_asset(tmp_path, tmp_path)
    with open_brain(tmp_path, "p1") as store:
        store_index_id(store, "idx-1")
        store_video_mapping(
            store, "vid", content_hash="sha-vid", status="ready", task_id="t", video_id="video-xyz"
        )
    # No TwelveLabs env key on the engine — the key lived only in the host body.
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    status = client.get("/brain/visual/status", params={"projectId": "p1"}).json()
    assert status["available"] is True
    assert status["backend"] == "twelvelabs"
    assert status["indexedAssets"] == 1
    # The engine env holds no key, so it honestly reports none is configured there.
    assert status["keyConfigured"] is False


# --- transcribe ------------------------------------------------------------------


def _project_doc_with_asset() -> dict[str, Any]:
    """A project doc that also declares the asset in its bin (transcribe resolves
    the media from the project's ``assets``, not just the timeline)."""
    doc = _project_doc()
    doc["assets"] = [{"id": "vid", "path": "clip.mp4", "kind": "video"}]
    return doc


def test_transcribe_returns_twelvelabs_transcription(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A TwelveLabs-indexed asset transcribes from TwelveLabs' native words — no
    whisper — and returns them in the project ``TranscriptWord`` shape."""
    _seed_asset(tmp_path, tmp_path)
    with open_brain(tmp_path, "p1") as store:
        store_index_id(store, "idx-1")
        store_video_mapping(
            store, "vid", content_hash="sha-vid", status="ready", task_id="t", video_id="video-xyz"
        )
    fake = _FakeTL(words=[TLWord(0.0, 0.4, "World"), TLWord(0.4, 0.8, "Cup")])
    client = _client(tmp_path, monkeypatch, fake)
    body = client.post(
        "/transcribe",
        json={
            "projectId": "p1",
            "assetId": "vid",
            "provider": "twelvelabs",
            "twelveLabsKey": "tl-key",
            "project": _project_doc_with_asset(),
        },
    ).json()
    assert body["assetId"] == "vid"
    # TwelveLabs' ``value`` becomes the schema's ``word``; timings pass through.
    assert body["words"] == [
        {"word": "World", "start": 0.0, "end": 0.4, "assetId": "vid"},
        {"word": "Cup", "start": 0.4, "end": 0.8, "assetId": "vid"},
    ]


def test_local_transcription_does_not_implicitly_use_twelvelabs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The explicit local provider never changes behavior because a TL key exists."""
    _seed_asset(tmp_path, tmp_path)
    with open_brain(tmp_path, "p1") as store:
        store_index_id(store, "idx-1")  # project indexed, but this asset is not mapped

    def unavailable_transcribe(*_args: Any, **_kwargs: Any) -> None:
        raise WhisperCliNotFoundError("whisper-cli unavailable in this test")

    monkeypatch.setattr(service_module, "transcribe", unavailable_transcribe)
    fake = _FakeTL(words=[TLWord(0.0, 0.4, "unused")])
    client = _client(tmp_path, monkeypatch, fake)
    resp = client.post(
        "/transcribe",
        json={"projectId": "p1", "assetId": "vid", "project": _project_doc_with_asset()},
    )
    # Whisper is not set up in the test env → honest 503, never TwelveLabs' words.
    assert resp.status_code == 503


def test_twelvelabs_transcription_requires_an_indexed_asset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_asset(tmp_path, tmp_path)
    with open_brain(tmp_path, "p1") as store:
        store_index_id(store, "idx-1")
    client = _client(tmp_path, monkeypatch, _FakeTL())

    resp = client.post(
        "/transcribe",
        json={
            "projectId": "p1",
            "assetId": "vid",
            "provider": "twelvelabs",
            "twelveLabsKey": "tl-key",
            "project": _project_doc_with_asset(),
        },
    )

    assert resp.status_code == 409
    assert "indexing" in resp.json()["detail"].lower()


# --- search ----------------------------------------------------------------------


def test_search_maps_twelvelabs_clips_to_packets(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_asset(tmp_path, tmp_path)
    with open_brain(tmp_path, "p1") as store:
        store_index_id(store, "idx-1")
        store_video_mapping(
            store, "vid", content_hash="sha-vid", status="ready", task_id="t", video_id="video-xyz"
        )
    fake = _FakeTL(clips=[TLClip("video-xyz", 0.5, 1.5, 84.0, "high", "spoken")])
    client = _client(tmp_path, monkeypatch, fake)
    body = client.post(
        "/brain/visual/search",
        json={"projectId": "p1", "query": "the app", "project": _project_doc()},
    ).json()
    assert body["available"] is True and body["backend"] == "twelvelabs"
    assert len(body["packets"]) == 1
    packet = body["packets"][0]
    assert packet["assetId"] == "vid"
    assert packet["t0"] == 0.5 and packet["t1"] == 1.5
    assert packet["sources"] == ["twelvelabs"]
    assert "app" in packet["transcriptOverlap"]  # from the project transcript


def test_search_reports_not_indexed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _seed_asset(tmp_path, tmp_path)
    client = _client(tmp_path, monkeypatch, _FakeTL())
    body = client.post("/brain/visual/search", json={"projectId": "p1", "query": "x"}).json()
    assert body["available"] is True and body["reason"] == "not_indexed"
    assert body["packets"] == []


def test_search_auth_failure_is_honest(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _seed_asset(tmp_path, tmp_path)
    with open_brain(tmp_path, "p1") as store:
        store_index_id(store, "idx-1")
    client = _client(tmp_path, monkeypatch, _FakeTL(auth_fail=True))
    body = client.post("/brain/visual/search", json={"projectId": "p1", "query": "x"}).json()
    assert body["available"] is True and body["reason"] == "invalid_api_key"


# --- describe --------------------------------------------------------------------


def test_describe_walks_pegasus_chapters(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """describe on TwelveLabs enumerates Pegasus chapters in time order (FI2.2)."""
    _seed_asset(tmp_path, tmp_path)
    with open_brain(tmp_path, "p1") as store:
        store_index_id(store, "idx-1")
        store_video_mapping(
            store,
            "vid",
            content_hash="sha-vid",
            status="ready",
            video_id="video-xyz",
            source_asset_id="upload-video-xyz",
        )
    fake = _FakeTL(
        chapters=[
            TLChapter(start=0.0, end=1.5, title="Intro", summary="setup"),
            TLChapter(start=1.5, end=3.0, title="Reveal", summary="payoff"),
        ]
    )
    client = _client(tmp_path, monkeypatch, fake)
    body = client.post("/brain/visual/describe", json={"projectId": "p1", "assetId": "vid"}).json()
    assert body["available"] is True and body["backend"] == "twelvelabs"
    assert [p["t0"] for p in body["packets"]] == [0.0, 1.5]
    assert "Intro" in body["packets"][0]["caption"]


def test_describe_reports_not_indexed_without_mapping(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_asset(tmp_path, tmp_path)
    client = _client(tmp_path, monkeypatch, _FakeTL())
    body = client.post("/brain/visual/describe", json={"projectId": "p1", "assetId": "vid"}).json()
    assert body["available"] is True and body["reason"] == "not_indexed"
    assert body["packets"] == []


# --- footage-map: cache is authoritative (no re-billing; survives reopen) --------


class _CountingTL(_FakeTL):
    """A fake that counts every Pegasus call, to prove the cache prevents re-billing."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.pegasus_calls = 0

    def summarize_chapters(self, asset_ref: str) -> list[TLChapter]:
        self.pegasus_calls += 1
        return super().summarize_chapters(asset_ref)

    def summarize_highlights(self, asset_ref: str) -> list[TLHighlight]:
        self.pegasus_calls += 1
        return super().summarize_highlights(asset_ref)

    def summarize_gist(self, asset_ref: str) -> TLGist:
        self.pegasus_calls += 1
        return super().summarize_gist(asset_ref)


def _seed_ready_mapping(root: Path) -> None:
    """A project with one asset indexed + a ready TwelveLabs mapping (no cache yet)."""
    _seed_asset(root, root)
    with open_brain(root, "p1") as store:
        store_index_id(store, "idx-1")
        store_video_mapping(
            store,
            "vid",
            content_hash="sha-vid",
            status="ready",
            video_id="video-xyz",
            source_asset_id="upload-video-xyz",
        )


def _footage_map(client: TestClient) -> dict[str, Any]:
    body: dict[str, Any] = client.post(
        "/brain/visual/footage-map", json={"projectId": "p1", "project": _project_doc()}
    ).json()
    return body


def test_footage_map_caches_and_never_re_bills_unchanged_footage(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The first map fetches Pegasus once; every later open on unchanged bytes is a
    pure cache hit — zero further API calls (the "costing more" report, plan FI2.3)."""
    _seed_ready_mapping(tmp_path)
    fake = _CountingTL(
        chapters=[TLChapter(start=0.0, end=1.5, title="Intro", summary="setup")],
        highlights=[TLHighlight(start=1.0, end=1.2, label="beat")],
        gist="A short demo.",
    )
    client = _client(tmp_path, monkeypatch, fake)

    first = _footage_map(client)
    assert first["available"] is True and first["backend"] == "twelvelabs"
    assert [c["title"] for c in first["chapters"]] == ["Intro"]
    assert fake.pegasus_calls == 3  # chapters + highlights + gist, once

    second = _footage_map(client)
    assert second["chapters"] == first["chapters"]
    assert fake.pegasus_calls == 3  # unchanged bytes → cache hit → no new calls


def test_footage_map_cached_only_never_calls_the_provider_on_a_miss(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`cachedOnly` is for callers that enrich something else and must not pay for it.

    A run's context reads this map so the model knows the shape of the footage before it
    answers. That read has to be free and fast: on a cache miss it must return an empty
    map, NOT reach for Pegasus — otherwise merely starting a run on new footage would
    stall for a slow generative round-trip and bill for it.
    """
    _seed_ready_mapping(tmp_path)
    fake = _CountingTL(
        chapters=[TLChapter(start=0.0, end=1.5, title="Intro", summary="setup")],
        highlights=[TLHighlight(start=1.0, end=1.2, label="beat")],
        gist="A short demo.",
    )
    client = _client(tmp_path, monkeypatch, fake)

    # Cold cache: the map is empty and nothing was charged.
    cold: dict[str, Any] = client.post(
        "/brain/visual/footage-map",
        json={"projectId": "p1", "project": _project_doc(), "cachedOnly": True},
    ).json()
    assert cold["available"] is True
    assert cold["chapters"] == []
    assert fake.pegasus_calls == 0

    # An ordinary (fetching) call warms it...
    assert _footage_map(client)["chapters"]
    warmed = fake.pegasus_calls
    assert warmed > 0

    # ...and now the same cache-only read serves the real map, still charging nothing.
    warm: dict[str, Any] = client.post(
        "/brain/visual/footage-map",
        json={"projectId": "p1", "project": _project_doc(), "cachedOnly": True},
    ).json()
    assert [c["title"] for c in warm["chapters"]] == ["Intro"]
    assert fake.pegasus_calls == warmed


def test_footage_map_survives_reopen_when_live_index_is_gone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Once cached, the map is served from the content-hash cache even if the live
    index id and the mapping's ``ready`` flag are gone — the "understanding gone on
    reopen" report. The cache, not the live index, is the source of truth."""
    _seed_ready_mapping(tmp_path)
    fake = _CountingTL(
        chapters=[TLChapter(start=0.0, end=1.5, title="Intro", summary="setup")],
        gist="A short demo.",
    )
    client = _client(tmp_path, monkeypatch, fake)
    assert _footage_map(client)["chapters"]  # warm the cache

    # Simulate a reopen where the live TwelveLabs index is no longer resolvable:
    # drop the index id and mark the mapping not-ready (both live-only signals). The
    # `tl:video` row itself persists with its video id, as it does on a real reopen.
    with open_brain(tmp_path, "p1") as store:
        store._conn.execute("DELETE FROM fields")
        store._conn.commit()
        store_video_mapping(
            store, "vid", content_hash="sha-vid", status="indexing", video_id="video-xyz"
        )

    reopened = _footage_map(client)
    assert reopened["available"] is True
    assert [c["title"] for c in reopened["chapters"]] == ["Intro"]
    # Nothing new was charged — the cache served it without any live index.
    assert fake.pegasus_calls == 3


def test_footage_map_incrementally_fetches_only_new_footage(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With one asset already cached, adding a second indexed asset fetches Pegasus
    for the NEW asset only — the existing one is served from cache (multi-footage,
    "handle intelligently as things add on")."""
    _seed_ready_mapping(tmp_path)
    fake = _CountingTL(
        chapters=[TLChapter(start=0.0, end=1.5, title="Intro", summary="setup")],
        gist="A demo.",
    )
    client = _client(tmp_path, monkeypatch, fake)
    assert _footage_map(client)["chapters"]
    assert fake.pegasus_calls == 3

    # A second asset arrives, freshly indexed with a different content hash.
    with open_brain(tmp_path, "p1") as store:
        store.upsert_asset("vid2", path="clip.mp4", content_sha256="sha-vid2", probe=_video_probe())
        store_video_mapping(
            store, "vid2", content_hash="sha-vid2", status="ready", video_id="video-2"
        )

    again = _footage_map(client)
    assert again["available"] is True
    # Only the new asset triggered Pegasus (3 more calls); the first stayed cached.
    assert fake.pegasus_calls == 6


def test_footage_map_refresh_re_fetches_past_the_cache(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The explicit ``refresh`` escape hatch re-fetches Pegasus even on a cache hit —
    the manual "rebuild", never the default path."""
    _seed_ready_mapping(tmp_path)
    fake = _CountingTL(
        chapters=[TLChapter(start=0.0, end=1.5, title="Intro", summary="setup")],
        gist="A demo.",
    )
    client = _client(tmp_path, monkeypatch, fake)
    assert _footage_map(client)["chapters"]
    assert fake.pegasus_calls == 3

    refreshed = client.post(
        "/brain/visual/footage-map",
        json={"projectId": "p1", "project": _project_doc(), "refresh": True},
    ).json()
    assert refreshed["available"] is True
    assert fake.pegasus_calls == 6  # refresh bypassed the cache


def test_footage_map_asset_time_returns_source_seconds_untouched_by_timeline(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`assetTime` returns each chapter in the footage's OWN source seconds and tags
    the owning asset — the understanding reflects the footage, not the edit, so it is
    complete even when the asset is trimmed to a sliver on the timeline."""
    _seed_ready_mapping(tmp_path)
    fake = _CountingTL(
        chapters=[
            TLChapter(start=0.0, end=40.0, title="Long intro", summary="a"),
            TLChapter(start=40.0, end=120.0, title="Body", summary="b"),
        ],
        gist="A long clip.",
    )
    client = _client(tmp_path, monkeypatch, fake)
    # The timeline trims the 120s asset down to its first 3 seconds — a projection
    # would collapse both chapters, but asset-time must keep the full structure.
    body = client.post(
        "/brain/visual/footage-map",
        json={"projectId": "p1", "project": _project_doc(), "assetTime": True},
    ).json()
    assert body["available"] is True
    assert [(c["t0"], c["t1"]) for c in body["chapters"]] == [(0.0, 40.0), (40.0, 120.0)]
    # Every chapter carries its owning asset id so the UI can group + project on demand.
    assert {c["assetId"] for c in body["chapters"]} == {"vid"}


def test_footage_map_reports_not_indexed_without_mapping_or_cache(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No mapping and no cache → honest ``not_indexed``, never a fabricated map."""
    _seed_asset(tmp_path, tmp_path)
    client = _client(tmp_path, monkeypatch, _CountingTL())
    body = _footage_map(client)
    assert body["available"] is True and body["reason"] == "not_indexed"
    assert body["chapters"] == []


# --- regression: built-in path untouched without a TwelveLabs key ----------------


def test_no_twelvelabs_key_uses_builtin_path(tmp_path: Path) -> None:
    """With no TL key and no NVIDIA key, search reports the built-in no_api_key."""
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    body = client.post("/brain/visual/search", json={"projectId": "p1", "query": "x"}).json()
    # This reason comes from the built-in embedder gate, proving the TL branch was skipped.
    assert body["available"] is True and body["reason"] == "no_api_key"
