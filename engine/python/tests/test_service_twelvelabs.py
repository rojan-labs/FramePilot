"""Service tests for the TwelveLabs backend on the ``/brain/visual/*`` routes.

When a TwelveLabs key resolves, index/search/describe/status delegate to the
hosted backend instead of the built-in NVIDIA-embed pipeline. The client is
mocked at the service seam (no live API); the brain reads/writes are real SQLite,
so the asset↔video mapping and clip→packet mapping run end to end. A companion
regression test proves the built-in path is untouched when no TwelveLabs key is
set.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

import framepilot_engine.service as service_module
from framepilot_engine.analysis.visual_sampler import SAMPLER_VERSION
from framepilot_engine.audio.asr import WhisperCliNotFoundError
from framepilot_engine.brain.described import described_from_summary
from framepilot_engine.brain.ledger_models import ShotRecord
from framepilot_engine.brain.models import VisualCaptionRow, VisualSpanRow
from framepilot_engine.brain.store import BrainStore, open_brain
from framepilot_engine.brain.twelvelabs import (
    DEFAULT_BASE_URL,
    TaskStatus,
    TLChapter,
    TLClip,
    TLGist,
    TLHighlight,
    TLWord,
    TwelveLabsAuthError,
    TwelveLabsClient,
    TwelveLabsClientResolution,
    TwelveLabsIndexInaccessibleError,
    TwelveLabsMediaRejectedError,
    TwelveLabsPegasusUnavailableError,
    key_fingerprint,
)
from framepilot_engine.brain.twelvelabs_index import (
    TL_DESCRIBED_MODEL,
    read_index_id,
    read_video_mapping,
    store_index_id,
    store_video_mapping,
)
from framepilot_engine.brain.visual_embed import MODEL_ID
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
        reject: set[str] | None = None,
        inaccessible: bool = False,
    ) -> None:
        self.clips = clips or []
        self.words = words or []
        self.chapters = chapters or []
        self.highlights = highlights or []
        self.gist = gist
        self.auth_fail = auth_fail
        self.pegasus_unavailable = pegasus_unavailable
        self.source_lookups = 0
        #: File names TwelveLabs refuses for what they are (e.g. too long).
        self.reject = reject or set()
        self.uploads: list[str] = []
        #: The saved index is another account's (the key was switched).
        self.inaccessible = inaccessible
        self.searches = 0
        self.search_options: Any = None

    def get_transcription(self, index_id: str, video_id: str) -> list[TLWord]:
        if self.auth_fail:
            raise TwelveLabsAuthError("bad key")
        return self.words

    def _pegasus_guard(self) -> None:
        if self.auth_fail:
            raise TwelveLabsAuthError("bad key")
        if self.inaccessible:
            raise TwelveLabsIndexInaccessibleError("another account's index")
        if self.pegasus_unavailable:
            raise TwelveLabsPegasusUnavailableError("no entitlement")

    def summarize_chapters(self, asset_ref: str, **_kw: Any) -> list[TLChapter]:
        self._pegasus_guard()
        return self.chapters

    def summarize_highlights(self, asset_ref: str, **_kw: Any) -> list[TLHighlight]:
        self._pegasus_guard()
        return self.highlights

    def summarize_gist(self, asset_ref: str, **_kw: Any) -> TLGist:
        self._pegasus_guard()
        return TLGist(summary=self.gist)

    def source_asset_id(self, index_id: str, video_id: str) -> str | None:
        """Recover the uploaded asset id an older mapping never stored."""
        self.source_lookups += 1
        return f"upload-{video_id}"

    #: The real client derives this from its key; a fixed value is one stable "account".
    key_fingerprint = "fp-current"

    def index_accessible(self, index_id: str) -> bool:
        return True

    def find_index(self, name: str) -> str | None:
        return None

    def create_index(self, name: str) -> str:
        if self.auth_fail:
            raise TwelveLabsAuthError("bad key")
        return "idx-1"

    def create_index_task(self, index_id: str, media_path: Path) -> str:
        self.uploads.append(media_path.name)
        if media_path.name in self.reject:
            raise TwelveLabsMediaRejectedError(
                _rejection_reason(media_path.name), code="video_duration_too_long"
            )
        return "task-1"

    def get_task(self, task_id: str) -> TaskStatus:
        return TaskStatus(task_id, "ready", "video-xyz")

    def search(
        self, index_id: str, query: str, *, options: Any = None, page_limit: int = 10
    ) -> list[TLClip]:
        self.searches += 1
        self.search_options = options
        if self.auth_fail:
            raise TwelveLabsAuthError("bad key")
        if self.inaccessible:
            raise TwelveLabsIndexInaccessibleError("another account's index")
        return self.clips


def _rejection_reason(file_name: str) -> str:
    return f"TwelveLabs can't index {file_name}: the video is too long."


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


# --- files TwelveLabs refuses for what they are ----------------------------------


def _seed_videos(root: Path, names: list[str]) -> None:
    with open_brain(root, "p1") as store:
        for index, name in enumerate(names):
            (root / name).write_bytes(b"\x00\x00fake\x00\x00")
            store.upsert_asset(
                f"vid{index}", path=name, content_sha256=f"sha-{index}", probe=_video_probe()
            )


def _index_job(client: TestClient, *, max_slices: int = 20) -> dict[str, Any]:
    """Drive one paced job the way the desktop loop does; return the last slice."""
    body: dict[str, Any] = {"projectId": "p1", "maxAssets": 2, "tiers": ["labelled"]}
    last: dict[str, Any] = {}
    for _ in range(max_slices):
        last = client.post("/brain/visual/index", json=body).json()
        if not last["available"] or last["done"] or last.get("reason"):
            return last
        body["jobId"] = last["jobId"]
    return last


def test_rejected_file_reports_why_and_is_never_uploaded_again(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_videos(tmp_path, ["ro.mp4"])
    fake = _FakeTL(reject={"ro.mp4"})
    client = _client(tmp_path, monkeypatch, fake)

    first = _index_job(client)
    # The desktop shows `reason` verbatim: it must be the sentence, not "HTTP 400".
    assert first["done"] is False
    assert first["reason"] == _rejection_reason("ro.mp4")
    assert first["items"][0]["reason"] == _rejection_reason("ro.mp4")
    assert first["failed"] == 1

    # The reported defect: the next job uploaded the same 1 GB again, 6 ms later.
    second = _index_job(client)
    assert second["reason"] == _rejection_reason("ro.mp4")
    assert fake.uploads == ["ro.mp4"]


def test_a_project_of_rejected_files_is_not_a_broken_index(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Five oversized clips must each be tried, not stop the run as "a bad index"."""
    names = [f"clip{i}.mp4" for i in range(5)]
    _seed_videos(tmp_path, names)
    fake = _FakeTL(reject=set(names))
    client = _client(tmp_path, monkeypatch, fake)

    last = _index_job(client)

    assert len(names) > service_module.TL_CONSECUTIVE_FAILURE_LIMIT + 1
    assert sorted(fake.uploads) == names  # every file tried exactly once
    assert last["cursor"] == len(names)
    # A job that indexed nothing still never ends `done`, and says why.
    assert last["done"] is False
    assert last["reason"] == _rejection_reason("clip4.mp4")


def test_a_rejected_file_does_not_stop_the_footage_behind_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_videos(tmp_path, ["huge.mp4", "a.mp4", "b.mp4"])
    fake = _FakeTL(reject={"huge.mp4"})
    client = _client(tmp_path, monkeypatch, fake)

    last = _index_job(client)

    assert last["done"] is True, last
    assert last["reason"] is None
    assert sorted(fake.uploads) == ["a.mp4", "b.mp4", "huge.mp4"]
    with open_brain(tmp_path, "p1") as store:
        statuses = {
            asset_id: mapping.status
            for asset_id in ("vid0", "vid1", "vid2")
            if (mapping := read_video_mapping(store, asset_id)) is not None
        }
    assert statuses == {"vid0": "rejected", "vid1": "ready", "vid2": "ready"}


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
    mislabel itself as ``sqlite-vec`` (the "stuck on sqlite-vec" report).

    And it must report ``keyConfigured`` true. The stored index id only exists
    because a key was accepted on the index POST; answering "no key" made the agent
    tell the editor that visual search returns nothing on a project that was fully
    indexed and searchable (run a53b7c1f)."""
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
    # The stored index id is the proof a key was used, even though the engine env
    # holds none — the desktop forwards the Settings key on the POSTs only.
    assert status["keyConfigured"] is True


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
    # A picture search asks TwelveLabs for the picture only — never the speech or audio
    # modalities, which made a narrated video answer from its words (desktop run 001be135).
    assert fake.search_options == ("visual",)


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


# --- the saved index belongs to another account (the key was switched) ------------


def test_search_on_another_keys_index_is_not_indexed_without_a_call(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_asset(tmp_path, tmp_path)
    with open_brain(tmp_path, "p1") as store:
        store_index_id(store, "idx-old", key_fingerprint="fp-previous-account")
    fake = _FakeTL()
    client = _client(tmp_path, monkeypatch, fake)
    body = client.post("/brain/visual/search", json={"projectId": "p1", "query": "x"}).json()
    assert body["available"] is True and body["reason"] == "not_indexed"
    assert fake.searches == 0


def test_search_on_an_unreadable_index_is_not_indexed_not_a_bad_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_asset(tmp_path, tmp_path)
    with open_brain(tmp_path, "p1") as store:
        store_index_id(store, "idx-old")  # legacy: no fingerprint, so the call is made
    client = _client(tmp_path, monkeypatch, _FakeTL(inaccessible=True))
    body = client.post("/brain/visual/search", json={"projectId": "p1", "query": "x"}).json()
    assert body["available"] is True and body["reason"] == "not_indexed"


def test_footage_map_on_an_unreadable_index_is_not_indexed_not_a_bad_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_ready_mapping(tmp_path)
    client = _client(tmp_path, monkeypatch, _FakeTL(inaccessible=True))
    body = _footage_map(client)
    assert body["available"] is True and body["reason"] == "not_indexed"


TL_KEY = "tl-key"
OLD_INDEX = "6abffe6e15f501e4cc931e99"
NEW_INDEX = "6ac003925babcc57e15d6e97"
UPLOAD = "6ac008cf59655cfa9de0622d"
INDEXED = "6ac0aaaa0000000000000001"
NOT_READABLE = {
    "code": "read_not_allowed",
    "message": f"The caller is not authorized to read entity {OLD_INDEX}.",
}


def _tl_url(path: str) -> str:
    return f"{DEFAULT_BASE_URL}{path}"


def _real_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """The route over the REAL TwelveLabs client, every request answered by respx."""
    real = TwelveLabsClient(TL_KEY, http=httpx.Client())
    monkeypatch.setattr(
        service_module,
        "resolve_twelvelabs",
        lambda key=None: TwelveLabsClientResolution(client=real),
    )
    return TestClient(create_app(Settings(projects_root=tmp_path, twelvelabs_api_key=TL_KEY)))


def _mock_new_account_attach() -> tuple[respx.Route, respx.Route]:
    """The new account: no index of ours yet, the earlier upload readable and ready."""
    respx.get(_tl_url("/indexes")).respond(200, json={"data": [], "page_info": {}})
    create = respx.post(_tl_url("/indexes")).respond(201, json={"_id": NEW_INDEX})
    respx.get(_tl_url(f"/assets/{UPLOAD}")).respond(
        200, json={"_id": UPLOAD, "method": "multipart", "status": "ready"}
    )
    attach = respx.post(_tl_url(f"/indexes/{NEW_INDEX}/indexed-assets")).respond(
        201, json={"_id": INDEXED, "asset_id": UPLOAD}
    )
    respx.get(_tl_url(f"/indexes/{NEW_INDEX}/indexed-assets/{INDEXED}")).respond(
        200, json={"_id": INDEXED, "asset_id": UPLOAD, "status": "ready"}
    )
    return create, attach


def _seed_uploaded_into_old_index(root: Path, *, fingerprint: str | None) -> None:
    """The maintainer's project: 1 GB uploaded, token naming the old account's index."""
    _seed_videos(root, ["ro.mp4"])
    with open_brain(root, "p1") as store:
        store_index_id(store, OLD_INDEX, key_fingerprint=fingerprint)
        store_video_mapping(
            store,
            "vid0",
            content_hash="sha-0",
            status="indexing",
            task_id=f"asset-v1:{OLD_INDEX}:{UPLOAD}",
        )


@respx.mock  # every unmocked request (an upload, say) fails the test
def test_legacy_index_of_another_account_is_rebound_and_the_upload_re_attached(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_uploaded_into_old_index(tmp_path, fingerprint=None)
    check = respx.get(_tl_url(f"/indexes/{OLD_INDEX}")).respond(403, json=NOT_READABLE)
    create, attach = _mock_new_account_attach()
    # Any upload would be unmocked and fail the test; these make the intent explicit.
    direct = respx.post(_tl_url("/assets"))
    multipart = respx.post(_tl_url("/assets/multipart-uploads"))

    body = _index_job(_real_client(tmp_path, monkeypatch))

    assert body["done"] is True, body
    assert body["reason"] is None
    assert body["indexed"] == 1
    assert check.call_count == 1 and create.call_count == 1  # one rebind
    assert UPLOAD.encode() in attach.calls[0].request.content
    assert not direct.called and not multipart.called
    with open_brain(tmp_path, "p1") as store:
        assert read_index_id(store) == NEW_INDEX
        mapping = read_video_mapping(store, "vid0")
    assert mapping is not None and mapping.ready_in(NEW_INDEX)


@respx.mock  # every unmocked request (an upload, say) fails the test
def test_index_that_stops_answering_mid_run_is_rebound_on_the_next_slice(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A fingerprint-matched index that refuses the attach is re-checked, never 'bad key'."""
    _seed_uploaded_into_old_index(tmp_path, fingerprint=key_fingerprint(TL_KEY))
    old_attach = respx.post(_tl_url(f"/indexes/{OLD_INDEX}/indexed-assets")).respond(
        403, json=NOT_READABLE
    )
    check = respx.get(_tl_url(f"/indexes/{OLD_INDEX}")).respond(403, json=NOT_READABLE)
    create, attach = _mock_new_account_attach()

    body = _index_job(_real_client(tmp_path, monkeypatch))

    assert body["done"] is True, body
    assert body["reason"] is None  # never invalid_api_key
    assert old_attach.call_count == 1 and check.call_count == 1 and create.call_count == 1
    assert attach.call_count == 1


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


def _seed_tl_describe(root: Path, shots: list[ShotRecord]) -> None:
    """An indexed asset with a tier-0 shot list: what describe reads and writes."""
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
        by_hash: dict[str, list[ShotRecord]] = {}
        for shot in shots:
            by_hash.setdefault(shot.content_hash, []).append(shot)
        for content_hash, rows in by_hash.items():
            # Geometry-only tier-0 rows ("not measured yet"): enough of a shot list for
            # tier 2, with no decode.
            store.upsert_shots("vid", content_hash, "measured", rows)


def _ledger_shot(index: int, t0: float, t1: float, content_hash: str = "sha-vid") -> ShotRecord:
    return ShotRecord(
        asset_id="vid",
        content_hash=content_hash,
        shot_index=index,
        t0=t0,
        t1=t1,
        keyframe_t=(t0 + t1) / 2.0,
    )


_TWO_CHAPTERS = [
    TLChapter(start=0.0, end=1.5, title="Intro", summary="setup"),
    TLChapter(start=1.5, end=3.0, title="Reveal", summary="payoff"),
]


def test_describe_writes_the_chapters_into_the_shot_ledger(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A paid describe is remembered: the next run reads it off the ledger (VU6.3).

    THE DEFECT. Pegasus answered `describe_footage` in 25-38 s per asset and the answer
    reached one turn and no ledger row, so every later run's clip rows still read
    `described: null` and the agent asked — and paid — again.
    """
    _seed_tl_describe(tmp_path, [_ledger_shot(0, 0.0, 1.5), _ledger_shot(1, 1.5, 3.0)])
    client = _client(tmp_path, monkeypatch, _FakeTL(chapters=_TWO_CHAPTERS))
    body = client.post("/brain/visual/describe", json={"projectId": "p1", "assetId": "vid"}).json()
    assert body["available"] is True and len(body["packets"]) == 2

    # Read back through the route the run itself reads, not the store.
    ledger = client.get("/brain/shots", params={"projectId": "p1", "assetIds": "vid"}).json()
    assert ledger["available"] is True
    described = [shot["described"] for shot in ledger["shots"]]
    assert [d["summary"] for d in described] == ["Intro — setup", "Reveal — payoff"]
    assert {d["model"] for d in described} == {TL_DESCRIBED_MODEL}
    assert ledger["coverage"]["described"] == 2
    # The digest is rebuilt too (duration from the probe), so its coverage agrees.
    assert ledger["digests"][0]["coverage"]["described"] == 2
    assert ledger["digests"][0]["durationS"] == 3.0
    with open_brain(tmp_path, "p1") as store:
        # And the summaries are searchable, keyed by shot like every tier-2 producer's.
        captions = store.list_visual_captions("vid")
        assert [(c.scene_index, c.text) for c in captions] == [
            (0, "Intro — setup"),
            (1, "Reveal — payoff"),
        ]


def test_describe_never_overwrites_a_real_tier2_description(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_tl_describe(tmp_path, [_ledger_shot(0, 0.0, 1.5), _ledger_shot(1, 1.5, 3.0)])
    real = described_from_summary("A host speaks to camera.", model="local-pack")
    with open_brain(tmp_path, "p1") as store:
        store.upsert_shots(
            "vid",
            "sha-vid",
            "described",
            [_ledger_shot(0, 0.0, 1.5).model_copy(update={"described": real})],
        )
    client = _client(tmp_path, monkeypatch, _FakeTL(chapters=_TWO_CHAPTERS))
    client.post("/brain/visual/describe", json={"projectId": "p1", "assetId": "vid"})
    with open_brain(tmp_path, "p1") as store:
        shots = store.list_shots(["vid"])
    assert [(s.described.model, s.described.summary) for s in shots if s.described] == [
        ("local-pack", "A host speaks to camera."),
        (TL_DESCRIBED_MODEL, "Reveal — payoff"),
    ]


def test_a_failed_ledger_write_does_not_fail_the_describe(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The packets are already paid for and in hand; a locked brain costs the ledger its
    # copy, not the editor their answer.
    _seed_tl_describe(tmp_path, [_ledger_shot(0, 0.0, 3.0)])

    def locked(*_args: Any, **_kwargs: Any) -> int:
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(BrainStore, "upsert_shots", locked)
    client = _client(tmp_path, monkeypatch, _FakeTL(chapters=_TWO_CHAPTERS))
    body = client.post("/brain/visual/describe", json={"projectId": "p1", "assetId": "vid"}).json()
    assert body["available"] is True and len(body["packets"]) == 2


def test_describe_leaves_shots_of_other_bytes_alone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The chapter map describes the bytes TwelveLabs indexed ("sha-vid"). Shots measured
    # from different bytes are different footage, and must not borrow its words.
    _seed_tl_describe(tmp_path, [_ledger_shot(0, 0.0, 3.0, content_hash="sha-reencoded")])
    client = _client(tmp_path, monkeypatch, _FakeTL(chapters=_TWO_CHAPTERS))
    body = client.post("/brain/visual/describe", json={"projectId": "p1", "assetId": "vid"}).json()
    assert len(body["packets"]) == 2  # the describe answer itself is unaffected
    with open_brain(tmp_path, "p1") as store:
        assert store.list_shots(["vid"])[0].described is None


def test_describe_overlap_is_only_the_words_under_a_short_placement(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """THE DEFECT: a stock clip on screen for 1.1 s got the whole 50 s narration.

    The host talks fast and never pauses the 0.6 s the utterance segmenter needs, so the
    whole monologue is one utterance — and the old overlap returned every utterance
    touching the placement. It must be the words spoken while the clip is on screen.
    """
    _seed_tl_describe(tmp_path, [])
    project = _project_doc()
    project["timeline"]["tracks"][0]["clips"][0].update(
        {"start": 20.0, "end": 21.1, "sourceStart": 0.5, "sourceEnd": 1.6}
    )
    project["transcript"] = [
        {"word": f"w{i}", "start": i * 0.3, "end": i * 0.3 + 0.22} for i in range(166)
    ]
    fake = _FakeTL(chapters=[TLChapter(start=0.0, end=3.0, title="Skyline")])
    client = _client(tmp_path, monkeypatch, fake)
    body = client.post(
        "/brain/visual/describe", json={"projectId": "p1", "assetId": "vid", "project": project}
    ).json()
    assert body["packets"][0]["transcriptOverlap"] == "w66 w67 w68 w69 w70"


def test_describe_reports_not_indexed_without_mapping(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_asset(tmp_path, tmp_path)
    client = _client(tmp_path, monkeypatch, _FakeTL())
    body = client.post("/brain/visual/describe", json={"projectId": "p1", "assetId": "vid"}).json()
    assert body["available"] is True and body["reason"] == "not_indexed"
    assert body["packets"] == []


def test_describe_reads_a_still_from_the_path_that_indexed_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A photo indexed on-device is described from there, even with a TwelveLabs key set.

    THE DEFECT. Indexing already routes per asset: a still cannot be attached to a
    Marengo index (TwelveLabs answers 404 `resource_not_exists`), so
    `_asset_is_still_image` sends stills to the on-device embedder and their evidence
    lands in `visual_spans`/`visual_captions`. Reading did not mirror that — any project
    with a TwelveLabs key sent EVERY describe to `_tl_describe`, which only knows
    `tl:video` mappings. So an asset indexed perfectly well, on the path the indexer
    deliberately chose for it, answered `not_indexed` with zero packets.

    Measured on a real machine before the fix: `project_champadevi_hike` held **60
    indexed spans** and described as `not_indexed`. So did every other photo project —
    the ones where the on-device path is the only path that can work.
    """
    (tmp_path / "photo.jpg").write_bytes(b"\xff\xd8fake")
    with open_brain(tmp_path, "p1") as store:
        store.upsert_asset("pic", path="photo.jpg", content_sha256="sha-pic")
        store.upsert_visual_spans(
            [
                VisualSpanRow(
                    asset_id="pic",
                    model=MODEL_ID,
                    sampler_version=SAMPLER_VERSION,
                    t0=0.0,
                    t1=0.0,
                    scene_index=0,
                    keyframe_t=0.0,
                    phash=0,
                    frame_count=1,
                    content_hash="sha-pic",
                )
            ]
        )
        store.upsert_visual_captions(
            [
                VisualCaptionRow(
                    asset_id="pic",
                    scene_index=0,
                    t0=0.0,
                    t1=0.0,
                    text="A man stands in a dry, grassy field.",
                    model="caption-model",
                    content_hash="sha-pic",
                )
            ]
        )
    # A TwelveLabs key IS configured and resolves — that is the whole point.
    client = _client(tmp_path, monkeypatch, _FakeTL())
    body = client.post("/brain/visual/describe", json={"projectId": "p1", "assetId": "pic"}).json()
    assert body["available"] is True
    assert body["reason"] is None
    assert body["backend"] != "twelvelabs"
    assert len(body["packets"]) == 1
    assert "grassy field" in body["packets"][0]["caption"]


# --- footage-map: cache is authoritative (no re-billing; survives reopen) --------


class _CountingTL(_FakeTL):
    """A fake that counts every Pegasus call, to prove the cache prevents re-billing."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.pegasus_calls = 0

    def summarize_chapters(self, asset_ref: str, **_kw: Any) -> list[TLChapter]:
        self.pegasus_calls += 1
        return super().summarize_chapters(asset_ref, **_kw)

    def summarize_highlights(self, asset_ref: str, **_kw: Any) -> list[TLHighlight]:
        self.pegasus_calls += 1
        return super().summarize_highlights(asset_ref, **_kw)

    def summarize_gist(self, asset_ref: str, **_kw: Any) -> TLGist:
        self.pegasus_calls += 1
        return super().summarize_gist(asset_ref, **_kw)


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
