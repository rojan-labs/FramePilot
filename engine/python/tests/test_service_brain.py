"""Service-level tests for the Project Brain routes and import wiring (plan B0.4/B0.5).

Media probing/waveform derivation is monkeypatched (same pattern as the
thumbnail tests in ``test_service.py``) so these run without ffmpeg and stay
deterministic; the brain writes under test are real SQLite + sidecar files.
"""

from __future__ import annotations

import json
import time
from collections.abc import Sequence
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import framepilot_engine.service as service_module
from framepilot_engine.brain.store import open_brain
from framepilot_engine.config import Settings
from framepilot_engine.media.probe import MediaInfo, StreamInfo
from framepilot_engine.service import create_app
from framepilot_engine.timeline.models import SCHEMA_VERSION


def _fake_probe(monkeypatch: pytest.MonkeyPatch, *, duration: float = 4.0) -> None:
    """Stand in for ffprobe/waveform so import runs without real media tools."""

    def _fake_inspect(path: Path, *, timeout: float | None = None) -> MediaInfo:
        return MediaInfo(
            path=str(path),
            duration_seconds=duration,
            format_name="mov,mp4,m4a,3gp,3g2,mj2",
            streams=[StreamInfo(index=0, codec_type="video", width=320, height=240, fps=30.0)],
        )

    def _no_waveform(path: Path, **_kwargs: object) -> None:
        raise FileNotFoundError("no audio in fake probe")

    monkeypatch.setattr(service_module, "inspect_media", _fake_inspect)
    monkeypatch.setattr(service_module, "extract_waveform", _no_waveform)


def _sandboxed_client(tmp_path: Path) -> tuple[TestClient, Path]:
    src = tmp_path / "clip.mp4"
    src.write_bytes(b"fake video bytes")
    return TestClient(create_app(Settings(projects_root=tmp_path))), src


# --- GET /brain/status ----------------------------------------------------------


def test_brain_status_unavailable_without_projects_root() -> None:
    client = TestClient(create_app(Settings()))
    resp = client.get("/brain/status", params={"projectId": "p1"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["available"] is False and body["exists"] is False
    assert "projects_root" in body["reason"]


def test_brain_status_missing_brain_reports_not_exists(tmp_path: Path) -> None:
    client, _src = _sandboxed_client(tmp_path)
    body = client.get("/brain/status", params={"projectId": "p1"}).json()
    assert body["available"] is False and body["exists"] is False
    assert "does not exist" in body["reason"]


def test_brain_status_traversal_project_id_is_unavailable(tmp_path: Path) -> None:
    client, _src = _sandboxed_client(tmp_path)
    body = client.get("/brain/status", params={"projectId": "../../etc"}).json()
    assert body["available"] is False
    assert "escapes sandbox" in body["reason"]


# --- /asset-media brain wiring (B0.4) ---------------------------------------------


def test_asset_media_records_probe_into_brain_and_sidecar(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _fake_probe(monkeypatch)
    client, src = _sandboxed_client(tmp_path)
    resp = client.post(
        "/asset-media",
        json={
            "input_path": str(src),
            "thumbnails": 0,
            "projectId": "p1",
            "assetId": "asset_1",
        },
    )
    assert resp.status_code == 200
    assert resp.json()["brainRecorded"] is True

    brain_dir = tmp_path / ".framepilot-derived" / "p1"
    assert (brain_dir / "brain.sqlite").exists()
    sidecar = json.loads(
        (brain_dir / "sidecars" / "asset_1" / "analysis.json").read_text(encoding="utf-8")
    )
    assert sidecar["asset"]["path"] == "clip.mp4"
    assert len(sidecar["asset"]["contentSha256"]) == 64
    assert sidecar["asset"]["probe"]["duration_seconds"] == 4.0

    status_body = client.get("/brain/status", params={"projectId": "p1"}).json()
    assert status_body["available"] is True
    assert status_body["counts"]["assets"] == 1
    assert status_body["schemaVersion"] >= 1


def test_asset_media_without_project_id_skips_brain(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _fake_probe(monkeypatch)
    client, src = _sandboxed_client(tmp_path)
    resp = client.post("/asset-media", json={"input_path": str(src), "thumbnails": 0})
    assert resp.status_code == 200
    assert resp.json()["brainRecorded"] is False
    assert not (tmp_path / ".framepilot-derived").exists()


def test_asset_media_brain_failure_degrades_never_blocks_import(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """B0.5: a traversal-escaping projectId fails the brain write with a warning,
    while the import result the renderer needs still succeeds."""
    _fake_probe(monkeypatch)
    client, src = _sandboxed_client(tmp_path)
    resp = client.post(
        "/asset-media",
        json={
            "input_path": str(src),
            "thumbnails": 0,
            "projectId": "../../evil",
            "assetId": "asset_1",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["brainRecorded"] is False
    assert body["kind"] == "video" and body["durationSeconds"] == 4.0


def test_asset_media_without_projects_root_skips_brain(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _fake_probe(monkeypatch)
    client = TestClient(create_app(Settings()))
    src = tmp_path / "clip.mp4"
    src.write_bytes(b"fake video bytes")
    resp = client.post(
        "/asset-media",
        json={"input_path": str(src), "thumbnails": 0, "projectId": "p1", "assetId": "a1"},
    )
    assert resp.status_code == 200
    assert resp.json()["brainRecorded"] is False


# --- POST /brain/rebuild -----------------------------------------------------------


def test_brain_rebuild_requires_projects_root() -> None:
    client = TestClient(create_app(Settings()))
    resp = client.post("/brain/rebuild", json={"projectId": "p1"})
    assert resp.status_code == 503
    assert "FRAMEPILOT_PROJECTS_ROOT" in resp.json()["detail"]


def test_brain_rebuild_rejects_traversal_project_id(tmp_path: Path) -> None:
    client, _src = _sandboxed_client(tmp_path)
    resp = client.post("/brain/rebuild", json={"projectId": "../../etc"})
    assert resp.status_code == 400


def test_brain_rebuild_reimports_sidecars(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_probe(monkeypatch)
    client, src = _sandboxed_client(tmp_path)
    imported = client.post(
        "/asset-media",
        json={"input_path": str(src), "thumbnails": 0, "projectId": "p1", "assetId": "asset_1"},
    )
    assert imported.json()["brainRecorded"] is True

    resp = client.post("/brain/rebuild", json={"projectId": "p1"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["imported"] == 1
    assert body["status"]["available"] is True
    assert body["status"]["counts"]["assets"] == 1


def test_brain_rebuild_on_empty_project_creates_fresh_brain(tmp_path: Path) -> None:
    client, _src = _sandboxed_client(tmp_path)
    resp = client.post("/brain/rebuild", json={"projectId": "fresh"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["imported"] == 0
    assert body["status"]["counts"]["assets"] == 0
    assert (tmp_path / ".framepilot-derived" / "fresh" / "brain.sqlite").exists()


# --- B0.5: existing flows unaffected with the derived dir deleted -------------------


def test_flows_survive_deleting_the_derived_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The brain is a derived cache: deleting .framepilot-derived loses time,
    never truth — imports and status keep working and re-derive on demand."""
    import shutil

    _fake_probe(monkeypatch)
    client, src = _sandboxed_client(tmp_path)
    client.post(
        "/asset-media",
        json={"input_path": str(src), "thumbnails": 0, "projectId": "p1", "assetId": "a1"},
    )
    shutil.rmtree(tmp_path / ".framepilot-derived")

    status_body = client.get("/brain/status", params={"projectId": "p1"}).json()
    assert status_body["available"] is False and status_body["exists"] is False

    again = client.post(
        "/asset-media",
        json={"input_path": str(src), "thumbnails": 0, "projectId": "p1", "assetId": "a1"},
    )
    assert again.status_code == 200 and again.json()["brainRecorded"] is True
    with open_brain(tmp_path, "p1") as store:
        assert [a.id for a in store.list_assets()] == ["a1"]


# --- POST /brain/index + /brain/search (B2.1/B2.2) ----------------------------------


def _project_doc() -> dict[str, object]:
    """A minimal inline project with a transcript, markers, and one asset."""
    return {
        "id": "p1",
        "name": "Search test",
        "assets": [{"id": "asset_1", "kind": "video", "path": "clip.mp4"}],
        "transcript": [
            {"word": "welcome", "start": 0.0, "end": 0.4},
            {"word": "everyone", "start": 0.5, "end": 0.9},
            {"word": "budget", "start": 5.0, "end": 5.4},
            {"word": "review", "start": 5.5, "end": 5.9},
        ],
        "markers": [{"id": "m1", "time": 12.0, "label": "hook candidate"}],
    }


def test_brain_index_unavailable_without_projects_root() -> None:
    client = TestClient(create_app(Settings()))
    resp = client.post("/brain/index", json={"projectId": "p1", "project": _project_doc()})
    assert resp.status_code == 200
    body = resp.json()
    assert body["available"] is False and "projects_root" in body["reason"]


def test_brain_index_requires_exactly_one_project_source(tmp_path: Path) -> None:
    client, _src = _sandboxed_client(tmp_path)
    resp = client.post("/brain/index", json={"projectId": "p1"})
    assert resp.status_code == 422


def test_brain_index_ingests_utterances_and_markers(tmp_path: Path) -> None:
    client, _src = _sandboxed_client(tmp_path)
    resp = client.post("/brain/index", json={"projectId": "p1", "project": _project_doc()})
    assert resp.status_code == 200
    body = resp.json()
    assert body["available"] is True
    # 0.5 - 0.4 = 0.1s gap joins; 5.0 - 0.9 = 4.1s gap splits → two utterances.
    assert body["utterances"] == 2
    assert body["markers"] == 1


def test_brain_index_from_saved_project_path(tmp_path: Path) -> None:
    client, _src = _sandboxed_client(tmp_path)
    project_path = tmp_path / "proj.fp.json"
    project_path.write_text(
        json.dumps({"schemaVersion": SCHEMA_VERSION, **_project_doc()}), encoding="utf-8"
    )
    resp = client.post("/brain/index", json={"projectId": "p1", "project_path": str(project_path)})
    assert resp.status_code == 200 and resp.json()["available"] is True


def test_brain_index_traversal_project_id_is_unavailable(tmp_path: Path) -> None:
    client, _src = _sandboxed_client(tmp_path)
    body = client.post(
        "/brain/index", json={"projectId": "../../etc", "project": _project_doc()}
    ).json()
    assert body["available"] is False and "escapes sandbox" in body["reason"]


def test_brain_search_finds_transcript_markers_and_assets(tmp_path: Path) -> None:
    client, _src = _sandboxed_client(tmp_path)
    client.post("/brain/index", json={"projectId": "p1", "project": _project_doc()})
    resp = client.post("/brain/search", json={"projectId": "p1", "query": "budget"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["available"] is True
    assert [h["type"] for h in body["hits"]] == ["transcript"]
    hit = body["hits"][0]
    assert hit["start"] == 5.0 and hit["end"] == 5.9
    assert "[budget]" in hit["snippet"]

    marker_hits = client.post("/brain/search", json={"projectId": "p1", "query": "hook"}).json()[
        "hits"
    ]
    assert [h["type"] for h in marker_hits] == ["marker"]
    assert marker_hits[0]["markerId"] == "m1" and marker_hits[0]["start"] == 12.0


def test_brain_search_with_inline_project_reindexes_first(tmp_path: Path) -> None:
    """The agent loop posts its live working copy: hits reflect IT, not a stale index."""
    client, _src = _sandboxed_client(tmp_path)
    client.post("/brain/index", json={"projectId": "p1", "project": _project_doc()})
    updated = _project_doc()
    updated["transcript"] = [{"word": "rewritten", "start": 1.0, "end": 1.5}]
    body = client.post(
        "/brain/search", json={"projectId": "p1", "query": "budget", "project": updated}
    ).json()
    assert body["hits"] == []
    body = client.post(
        "/brain/search", json={"projectId": "p1", "query": "rewritten", "project": updated}
    ).json()
    assert [h["start"] for h in body["hits"]] == [1.0]


def test_brain_search_asset_hits_rank_below_fts_hits(tmp_path: Path) -> None:
    client, _src = _sandboxed_client(tmp_path)
    doc = _project_doc()
    doc["transcript"] = [{"word": "clip", "start": 0.0, "end": 0.4}]
    client.post("/brain/index", json={"projectId": "p1", "project": doc})
    with open_brain(tmp_path, "p1") as store:
        store.upsert_asset("asset_1", path="clip.mp4")
    body = client.post("/brain/search", json={"projectId": "p1", "query": "clip"}).json()
    assert [h["type"] for h in body["hits"]] == ["transcript", "asset"]
    assert body["hits"][1]["assetId"] == "asset_1"


def test_brain_search_derives_project_id_from_the_document(tmp_path: Path) -> None:
    """The MCP path knows only the saved project path — the document's id is used."""
    client, _src = _sandboxed_client(tmp_path)
    project_path = tmp_path / "proj.fp.json"
    project_path.write_text(
        json.dumps({"schemaVersion": SCHEMA_VERSION, **_project_doc()}), encoding="utf-8"
    )
    body = client.post(
        "/brain/search", json={"query": "budget", "project_path": str(project_path)}
    ).json()
    assert body["available"] is True
    assert [h["type"] for h in body["hits"]] == ["transcript"]
    assert (tmp_path / ".framepilot-derived" / "p1" / "brain.sqlite").exists()


def test_brain_search_requires_project_id_or_source(tmp_path: Path) -> None:
    client, _src = _sandboxed_client(tmp_path)
    resp = client.post("/brain/search", json={"query": "x"})
    assert resp.status_code == 422
    assert "projectId is required" in resp.json()["detail"]


def test_brain_search_unavailable_without_projects_root() -> None:
    client = TestClient(create_app(Settings()))
    body = client.post("/brain/search", json={"projectId": "p1", "query": "x"}).json()
    assert body["available"] is False and "projects_root" in body["reason"]


def test_brain_search_rejects_two_project_sources(tmp_path: Path) -> None:
    client, _src = _sandboxed_client(tmp_path)
    resp = client.post(
        "/brain/search",
        json={
            "projectId": "p1",
            "query": "x",
            "project": _project_doc(),
            "project_path": "p.fp.json",
        },
    )
    assert resp.status_code == 422


def test_brain_search_traversal_project_id_is_unavailable(tmp_path: Path) -> None:
    client, _src = _sandboxed_client(tmp_path)
    body = client.post("/brain/search", json={"projectId": "../../etc", "query": "x"}).json()
    assert body["available"] is False and "escapes sandbox" in body["reason"]


# --- POST /brain/index embeddings ingest (B3.2) --------------------------------------


class _KeywordEmbedder:
    """Deterministic keyword-axis embedder injected in place of the ONNX gate."""

    model_id = "fake:test"
    dim = 2

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        return [[float("budget" in t.lower()), float("welcome" in t.lower())] for t in texts]


def _fake_embedder(monkeypatch: pytest.MonkeyPatch) -> None:
    from framepilot_engine.brain.embeddings import EmbedderResolution

    monkeypatch.setattr(
        service_module,
        "resolve_embedder",
        lambda _model_dir: EmbedderResolution(embedder=_KeywordEmbedder()),
    )


def test_brain_index_without_embedder_reports_honest_reason(tmp_path: Path) -> None:
    client, _src = _sandboxed_client(tmp_path)
    body = client.post("/brain/index", json={"projectId": "p1", "project": _project_doc()}).json()
    assert body["available"] is True
    assert body["embedded"] == 0
    assert "FRAMEPILOT_EMBEDDINGS_MODEL_DIR" in body["embeddingsReason"]


def test_brain_index_embeds_utterances_and_asset_digests(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _fake_embedder(monkeypatch)
    client, _src = _sandboxed_client(tmp_path)
    with open_brain(tmp_path, "p1") as store:
        store.upsert_asset("asset_1", path="clip.mp4")
    body = client.post("/brain/index", json={"projectId": "p1", "project": _project_doc()}).json()
    assert body["available"] is True
    assert body["embeddingsReason"] is None
    assert body["embedded"] == 3  # two utterances + one brain-known asset digest

    with open_brain(tmp_path, "p1") as store:
        rows = store.list_embeddings("fake:test")
    assert [(r.owner_type, r.owner_id) for r in rows] == [
        ("asset", "asset_1"),
        ("utterance", "utt:00000"),
        ("utterance", "utt:00001"),
    ]
    assert rows[0].payload == {"path": "clip.mp4"}


# --- POST /brain/similar (B3.3) -------------------------------------------------------


def test_brain_similar_without_embedder_degrades_to_keyword(tmp_path: Path) -> None:
    client, _src = _sandboxed_client(tmp_path)
    client.post("/brain/index", json={"projectId": "p1", "project": _project_doc()})
    body = client.post("/brain/similar", json={"projectId": "p1", "query": "budget"}).json()
    assert body["available"] is True
    assert body["mode"] == "keyword"
    assert "FRAMEPILOT_EMBEDDINGS_MODEL_DIR" in body["reason"]
    assert [h["type"] for h in body["hits"]] == ["transcript"]
    assert body["hits"][0]["start"] == 5.0


def test_brain_similar_blends_semantic_and_keyword_hits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _fake_embedder(monkeypatch)
    client, _src = _sandboxed_client(tmp_path)
    body = client.post(
        "/brain/similar", json={"projectId": "p1", "query": "budget", "project": _project_doc()}
    ).json()
    assert body["available"] is True and body["mode"] == "blended"
    assert body["reason"] is None
    # "the budget review" matches BOTH signals → outranks everything else.
    top = body["hits"][0]
    assert top["type"] == "transcript" and top["start"] == 5.0
    assert top["snippet"] == "budget review"  # semantic snippet, no FTS markers
    assert top["score"] == 1.0


def test_brain_similar_semantic_recall_without_keyword_overlap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The whole point of B3: a query with no shared words still finds the moment."""
    _fake_embedder(monkeypatch)
    client, _src = _sandboxed_client(tmp_path)
    body = client.post(
        "/brain/similar",
        # No word overlap with the transcript, but the fake embedder puts
        # "budget" and this query on the same axis via the shared keyword.
        json={"projectId": "p1", "query": "our budget", "project": _project_doc()},
    ).json()
    semantic_top = body["hits"][0]
    assert semantic_top["start"] == 5.0 and semantic_top["score"] > body["hits"][1]["score"]


def test_brain_similar_unavailable_without_projects_root() -> None:
    client = TestClient(create_app(Settings()))
    body = client.post("/brain/similar", json={"projectId": "p1", "query": "x"}).json()
    assert body["available"] is False and "projects_root" in body["reason"]


def test_brain_similar_requires_project_id_or_source(tmp_path: Path) -> None:
    client, _src = _sandboxed_client(tmp_path)
    resp = client.post("/brain/similar", json={"query": "x"})
    assert resp.status_code == 422
    assert "projectId is required" in resp.json()["detail"]


def test_brain_similar_traversal_project_id_is_unavailable(tmp_path: Path) -> None:
    client, _src = _sandboxed_client(tmp_path)
    body = client.post("/brain/similar", json={"projectId": "../../etc", "query": "x"}).json()
    assert body["available"] is False and "escapes sandbox" in body["reason"]


def test_brain_index_and_search_degrade_without_fts5(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from framepilot_engine.brain import migrations as brain_migrations

    monkeypatch.setattr(brain_migrations, "fts5_available", lambda _conn: False)
    client, _src = _sandboxed_client(tmp_path)
    index_body = client.post(
        "/brain/index", json={"projectId": "p1", "project": _project_doc()}
    ).json()
    assert index_body["available"] is False and "FTS5" in index_body["reason"]

    with open_brain(tmp_path, "p1") as store:
        store.upsert_asset("asset_1", path="clip.mp4")
    search_body = client.post("/brain/search", json={"projectId": "p1", "query": "clip"}).json()
    # Degraded, not broken: asset-name matches still return, with the reason.
    assert search_body["available"] is True
    assert "FTS5" in search_body["reason"]
    assert [h["type"] for h in search_body["hits"]] == ["asset"]


# --- GET /brain/jobs (plan B5.1) ------------------------------------------------


def test_brain_jobs_unavailable_without_projects_root() -> None:
    client = TestClient(create_app(Settings()))
    body = client.get("/brain/jobs", params={"projectId": "p1"}).json()
    assert body["available"] is False and "projects_root" in body["reason"]


def test_brain_jobs_missing_brain_is_unavailable(tmp_path: Path) -> None:
    client, _src = _sandboxed_client(tmp_path)
    body = client.get("/brain/jobs", params={"projectId": "p1"}).json()
    assert body["available"] is False and "does not exist" in body["reason"]


def test_brain_jobs_lists_journaled_jobs(tmp_path: Path) -> None:
    from framepilot_engine.brain.models import JobState

    with open_brain(tmp_path, "p1") as store:
        store.create_job("j1", kind="analyze-batch", payload={"cursor": 0})
        store.update_job("j1", state=JobState.DONE, progress=1.0)
        store.create_job("j2", kind="analyze-batch", payload={})
        store.update_job("j2", state=JobState.RUNNING, progress=0.5)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    body = client.get("/brain/jobs", params={"projectId": "p1"}).json()
    assert body["available"] is True
    # Sweep flags the still-running job interrupted; the done one is untouched.
    states = {j["id"]: j["state"] for j in body["jobs"]}
    assert states == {"j1": "done", "j2": "interrupted"}


def test_brain_jobs_state_filter(tmp_path: Path) -> None:
    from framepilot_engine.brain.models import JobState

    with open_brain(tmp_path, "p1") as store:
        store.create_job("done", kind="analyze-batch", payload={})
        store.update_job("done", state=JobState.DONE)
        store.create_job("queued", kind="analyze-batch", payload={})
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    # First touch sweeps the queued job to interrupted; filter for it.
    body = client.get("/brain/jobs", params={"projectId": "p1", "state": "interrupted"}).json()
    assert [j["id"] for j in body["jobs"]] == ["queued"]


def test_brain_jobs_unknown_state_is_422(tmp_path: Path) -> None:
    client, _src = _sandboxed_client(tmp_path)
    resp = client.get("/brain/jobs", params={"projectId": "p1", "state": "bogus"})
    assert resp.status_code == 422
    assert "Unknown job state" in resp.json()["detail"]


def test_brain_jobs_sweep_is_once_per_process(tmp_path: Path) -> None:
    """A job created after the first sweep in the same process is not flagged."""
    from framepilot_engine.brain.models import JobState

    with open_brain(tmp_path, "p1") as store:
        store.create_job("old", kind="analyze-batch", payload={})
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    first = client.get("/brain/jobs", params={"projectId": "p1"}).json()
    assert {j["id"]: j["state"] for j in first["jobs"]} == {"old": "interrupted"}
    # New queued job in the same process (same app instance): the sweep already ran.
    with open_brain(tmp_path, "p1") as store:
        store.create_job("fresh", kind="analyze-batch", payload={})
        store.update_job("fresh", state=JobState.QUEUED)
    second = client.get("/brain/jobs", params={"projectId": "p1"}).json()
    assert {j["id"]: j["state"] for j in second["jobs"]} == {
        "old": "interrupted",
        "fresh": "queued",
    }


def test_brain_jobs_sweep_check_then_add_is_atomic_under_concurrency(tmp_path: Path) -> None:
    """Regression: `sweep_interrupted_jobs_once`'s check-then-add on the shared
    swept-projects set had no lock, so two concurrent first-touch requests for
    the same project could both pass the membership check before either
    request's `.add()` ran — both then sweep and double-log, breaking the
    "idempotent per process" contract its docstring promises.

    The race window is two bytecode-adjacent lines with no I/O between them,
    so reproducing it needs an explicit widening rather than hoping real
    thread scheduling happens to land there — the same technique
    `test_composition_cache.py` uses for its own checkout/eviction race. This
    reaches into the route's closure (the set is process-local state, not
    part of the public surface) to slow exactly the membership check the fix
    now holds a lock around.
    """
    import threading

    from framepilot_engine.brain.store import BrainStore

    with open_brain(tmp_path, "p1") as store:
        store.create_job("old", kind="analyze-batch", payload={})
    app = create_app(Settings(projects_root=tmp_path))
    client = TestClient(app)

    route = next(r for r in app.routes if getattr(r, "path", None) == "/brain/jobs")
    endpoint = route.endpoint  # type: ignore[attr-defined]
    sweep = endpoint.__closure__[
        endpoint.__code__.co_freevars.index("sweep_interrupted_jobs_once")
    ].cell_contents
    swept_cell = sweep.__closure__[sweep.__code__.co_freevars.index("_swept_brain_jobs")]

    class _SlowLookupSet(set[str]):
        """Widens the check-then-add gap enough for a genuinely concurrent
        second caller to land inside it, deterministically rather than by
        scheduling luck."""

        def __contains__(self, item: object) -> bool:
            result = super().__contains__(item)
            time.sleep(0.05)
            return result

    swept_cell.cell_contents = _SlowLookupSet(swept_cell.cell_contents)

    sweep_calls = 0
    sweep_calls_lock = threading.Lock()
    real_mark_interrupted_jobs = BrainStore.mark_interrupted_jobs

    def _counted_mark_interrupted_jobs(self: BrainStore) -> int:
        nonlocal sweep_calls
        with sweep_calls_lock:
            sweep_calls += 1
        return real_mark_interrupted_jobs(self)

    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr(BrainStore, "mark_interrupted_jobs", _counted_mark_interrupted_jobs)

        threads = [
            threading.Thread(
                target=lambda: client.get("/brain/jobs", params={"projectId": "p1"})
            )
            for _ in range(2)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

    assert sweep_calls == 1


# --- POST /brain/memory (B6.1/B6.2) -------------------------------------------


def _memory_client(tmp_path: Path) -> tuple[TestClient, Path]:
    """A client whose soul root is redirected into tmp — never the real ~/."""
    soul = tmp_path / "soul"
    client = TestClient(create_app(Settings(projects_root=tmp_path / "projects", soul_root=soul)))
    return client, soul


def test_memory_append_writes_the_tier_file(tmp_path: Path) -> None:
    client, _soul = _memory_client(tmp_path)
    resp = client.post(
        "/brain/memory",
        json={
            "projectId": "p1",
            "tier": "decisions",
            "title": "Kept the cold open",
            "body": "User liked the abrupt start.",
            "patchId": "patch-1",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["available"] is True and body["promoted"] is False
    text = Path(body["path"]).read_text(encoding="utf-8")
    assert "Kept the cold open" in text
    assert "patch: patch-1" in text


def test_memory_append_requires_a_sandbox_root() -> None:
    client = TestClient(create_app(Settings()))
    resp = client.post(
        "/brain/memory", json={"projectId": "p1", "tier": "corrections", "title": "x"}
    )
    assert resp.status_code == 503
    assert "FRAMEPILOT_PROJECTS_ROOT" in resp.json()["detail"]


def test_memory_append_rejects_a_traversal_project_id(tmp_path: Path) -> None:
    client, _soul = _memory_client(tmp_path)
    resp = client.post(
        "/brain/memory", json={"projectId": "../../etc", "tier": "corrections", "title": "x"}
    )
    assert resp.status_code == 400
    assert "escapes sandbox" in resp.json()["detail"]


def test_memory_append_rejects_an_empty_title(tmp_path: Path) -> None:
    client, _soul = _memory_client(tmp_path)
    resp = client.post(
        "/brain/memory", json={"projectId": "p1", "tier": "corrections", "title": ""}
    )
    assert resp.status_code == 422


def test_correction_promotes_to_the_soul_on_a_second_project(tmp_path: Path) -> None:
    client, soul = _memory_client(tmp_path)
    correction = "No captions over faces"
    first = client.post(
        "/brain/memory", json={"projectId": "p1", "tier": "corrections", "title": correction}
    ).json()
    assert first["promoted"] is False
    assert not (soul / "learned_from_corrections.md").exists()

    second = client.post(
        "/brain/memory", json={"projectId": "p2", "tier": "corrections", "title": correction}
    ).json()
    assert second["promoted"] is True
    assert correction in (soul / "learned_from_corrections.md").read_text(encoding="utf-8")


def test_decisions_never_feed_the_correction_promotion(tmp_path: Path) -> None:
    client, soul = _memory_client(tmp_path)
    for project in ("p1", "p2"):
        body = client.post(
            "/brain/memory", json={"projectId": project, "tier": "decisions", "title": "same note"}
        ).json()
        assert body["promoted"] is False
    assert not (soul / "learned_from_corrections.md").exists()


def test_explicit_soul_doc_records_across_projects_immediately(tmp_path: Path) -> None:
    client, soul = _memory_client(tmp_path)
    body = client.post(
        "/brain/memory",
        json={
            "projectId": "p1",
            "tier": "decisions",
            "title": "Always cut on the beat",
            "soulDoc": "working_style",
        },
    ).json()
    assert body["soulPath"] == str(soul / "working_style.md")
    text = (soul / "working_style.md").read_text(encoding="utf-8")
    assert "Always cut on the beat" in text
    assert "project: p1" in text


def test_session_notes_land_in_a_dated_file(tmp_path: Path) -> None:
    client, _soul = _memory_client(tmp_path)
    body = client.post(
        "/brain/memory",
        json={"projectId": "p1", "tier": "session_notes", "title": "Removed 12 silences"},
    ).json()
    written = Path(body["path"])
    assert written.parent.name == "session_notes"
    assert written.name.endswith(".md") and len(written.stem) == len("2026-07-15")


# --- POST /brain/session-context (B6.3) ---------------------------------------


def test_session_context_unavailable_without_projects_root() -> None:
    client = TestClient(create_app(Settings()))
    body = client.post("/brain/session-context", json={"projectId": "p1"}).json()
    assert body["available"] is False
    assert "projects_root" in body["reason"]


def test_session_context_traversal_project_id_is_unavailable(tmp_path: Path) -> None:
    client, _soul = _memory_client(tmp_path)
    body = client.post("/brain/session-context", json={"projectId": "../../etc"}).json()
    assert body["available"] is False
    assert "escapes sandbox" in body["reason"]


def test_session_context_for_a_fresh_project_is_available_and_empty(tmp_path: Path) -> None:
    """A first run is not an error: available, empty sections, honest status."""
    client, _soul = _memory_client(tmp_path)
    body = client.post("/brain/session-context", json={"projectId": "p1"}).json()
    assert body["available"] is True
    assert body["status"]["exists"] is False
    assert body["binSummary"] == "" and body["sessionNote"] == ""
    assert body["corrections"] == "" and body["decisions"] == "" and body["soul"] == ""


def test_session_context_assembles_every_tier(tmp_path: Path) -> None:
    client, _soul = _memory_client(tmp_path)
    client.post(
        "/brain/memory",
        json={"projectId": "p1", "tier": "corrections", "title": "no captions over faces"},
    )
    client.post(
        "/brain/memory", json={"projectId": "p1", "tier": "decisions", "title": "kept cold open"}
    )
    client.post(
        "/brain/memory",
        json={"projectId": "p1", "tier": "session_notes", "title": "ran silence pass"},
    )
    client.post(
        "/brain/memory",
        json={
            "projectId": "p1",
            "tier": "decisions",
            "title": "beat-syncs montages",
            "soulDoc": "working_style",
        },
    )
    body = client.post("/brain/session-context", json={"projectId": "p1"}).json()
    assert body["available"] is True
    assert "no captions over faces" in body["corrections"]
    assert "kept cold open" in body["decisions"]
    assert "ran silence pass" in body["sessionNote"]
    assert "beat-syncs montages" in body["soul"]


def test_session_context_bounds_the_corrections_tail(tmp_path: Path) -> None:
    client, _soul = _memory_client(tmp_path)
    for i in range(12):
        client.post(
            "/brain/memory",
            json={"projectId": "p1", "tier": "corrections", "title": f"correction-{i:02d}"},
        )
    body = client.post("/brain/session-context", json={"projectId": "p1"}).json()
    assert body["corrections"].count("## ") == service_module.SESSION_CONTEXT_TAIL_ENTRIES
    assert "correction-11" in body["corrections"]  # newest kept
    assert "correction-00" not in body["corrections"]  # oldest bounded away


def test_session_context_includes_the_bin_summary_when_analysed(tmp_path: Path) -> None:
    from framepilot_engine.brain.memory import write_bin_summary

    client, _soul = _memory_client(tmp_path)
    projects = tmp_path / "projects"
    with open_brain(projects, "p1") as store:
        store.upsert_asset("a1", path="media/a.mp4", probe={"duration_seconds": 12.0})
        write_bin_summary(store, projects / ".framepilot-derived" / "p1")
    body = client.post("/brain/session-context", json={"projectId": "p1"}).json()
    assert "# Media bin summary" in body["binSummary"]
    assert "a1 (media/a.mp4)" in body["binSummary"]
