"""Tests for the chunked batch analysis route ``POST /analyze/batch`` (plan B5.2).

Analyzers are monkeypatched at the service seam (same pattern as
``test_service_analyze.py``) so pacing, cursor persistence, per-asset failure
isolation, and honest-unavailable degradation run without ffmpeg/whisper.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

import framepilot_engine.service as service_module
from framepilot_engine.analysis.silence import SilentRange
from framepilot_engine.config import Settings
from framepilot_engine.media.probe import MediaInfo, StreamInfo
from framepilot_engine.service import create_app
from framepilot_engine.timeline.models import Project, ProjectFile

# --- Fixtures -----------------------------------------------------------------


def _media_info() -> MediaInfo:
    return MediaInfo(
        path="/clip.mp4",
        duration_seconds=10.0,
        format_name="mov,mp4",
        streams=[
            StreamInfo(index=0, codec_type="video", width=1920, height=1080, fps=30.0),
            StreamInfo(index=1, codec_type="audio", sample_rate=48000, channels=2),
        ],
    )


def _write_project(directory: Path) -> Path:
    project = Project.model_validate(
        {
            "id": "pb",
            "name": "B",
            "assets": [
                {"id": "vid", "path": "clip.mp4", "kind": "video"},
                {"id": "mus", "path": "song.mp3", "kind": "audio"},
            ],
            "timeline": {"tracks": []},
        }
    )
    dest = directory / "batch.project.fp.json"
    ProjectFile.save(project, dest)
    return dest


def _sandboxed_client(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, **overrides: Any
) -> tuple[TestClient, Path]:
    fakes: dict[str, Any] = {
        "inspect_media": lambda path, *, timeout=None: _media_info(),
        "detect_silence": lambda path, *, total_duration=None, timeout=None: [
            SilentRange(start=1.0, end=2.0, duration=1.0)
        ],
    }
    fakes.update(overrides)
    for name, fake in fakes.items():
        monkeypatch.setattr(service_module, name, fake)
    project_path = _write_project(tmp_path)
    (tmp_path / "clip.mp4").write_bytes(b"fake mp4 bytes")
    (tmp_path / "song.mp3").write_bytes(b"fake mp3 bytes")
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    return client, project_path


def _post_batch(client: TestClient, project_path: Path, **body: Any) -> Any:
    return client.post("/analyze/batch", json={"project_path": str(project_path), **body})


# --- Honest-unavailable ---------------------------------------------------------


def test_batch_unavailable_without_projects_root(tmp_path: Path) -> None:
    project_path = _write_project(tmp_path)
    client = TestClient(create_app(Settings()))
    body = client.post(
        "/analyze/batch", json={"project_path": str(project_path), "projectId": "pb"}
    ).json()
    assert body["available"] is False and "sandbox root" in body["reason"]


# --- Pacing ---------------------------------------------------------------------


def test_batch_paces_worklist_across_calls(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, project_path = _sandboxed_client(tmp_path, monkeypatch)

    first = _post_batch(client, project_path, projectId="pb", depth="quick", maxAssets=1).json()
    assert first["available"] is True
    assert first["cursor"] == 1 and first["total"] == 2 and first["done"] is False
    assert [i["assetId"] for i in first["items"]] == ["vid"]
    assert all(i["ok"] for i in first["items"])
    job_id = first["jobId"]

    second = _post_batch(
        client, project_path, projectId="pb", jobId=job_id, maxAssets=1
    ).json()
    assert second["cursor"] == 2 and second["done"] is True
    assert [i["assetId"] for i in second["items"]] == ["mus"]

    # Both assets' quick-pass results are now persisted in the brain.
    analysis = client.get("/brain/analysis", params={"projectId": "pb"}).json()
    assert {r["assetId"] for r in analysis["results"]} == {"vid", "mus"}
    # And the journal shows the job done at full progress.
    jobs = client.get("/brain/jobs", params={"projectId": "pb"}).json()
    assert [(j["id"], j["state"], j["progress"]) for j in jobs["jobs"]] == [
        (job_id, "done", 1.0)
    ]


def test_batch_repoll_after_done_is_idempotent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, project_path = _sandboxed_client(tmp_path, monkeypatch)
    first = _post_batch(client, project_path, projectId="pb", depth="quick", maxAssets=25).json()
    assert first["done"] is True and first["cursor"] == 2
    again = _post_batch(
        client, project_path, projectId="pb", jobId=first["jobId"]
    ).json()
    assert again["done"] is True and again["cursor"] == 2 and again["items"] == []


def test_batch_explicit_asset_ids_fix_the_worklist(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, project_path = _sandboxed_client(tmp_path, monkeypatch)
    body = _post_batch(
        client, project_path, projectId="pb", assetIds=["mus"], depth="quick"
    ).json()
    assert body["total"] == 1 and body["done"] is True
    assert [i["assetId"] for i in body["items"]] == ["mus"]


def test_batch_empty_worklist_is_done_immediately(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A project with no analysable assets: nothing to pace, done at cursor 0.
    project = Project.model_validate(
        {"id": "pe", "name": "E", "assets": [], "timeline": {"tracks": []}}
    )
    dest = tmp_path / "empty.project.fp.json"
    ProjectFile.save(project, dest)
    for name, fake in {"inspect_media": lambda path, *, timeout=None: _media_info()}.items():
        monkeypatch.setattr(service_module, name, fake)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    body = client.post(
        "/analyze/batch", json={"project_path": str(dest), "projectId": "pe"}
    ).json()
    assert body["total"] == 0 and body["done"] is True and body["items"] == []


# --- Failure isolation ----------------------------------------------------------


def test_batch_missing_asset_is_reported_not_fatal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from framepilot_engine.media.ffmpeg import FFmpegError

    def _inspect_reject_song(path: Path, *, timeout: float | None = None) -> MediaInfo:
        if path.name == "song.mp3":
            raise FFmpegError("cannot decode song.mp3")
        return _media_info()

    client, project_path = _sandboxed_client(
        tmp_path, monkeypatch, inspect_media=_inspect_reject_song
    )
    body = _post_batch(client, project_path, projectId="pb", depth="quick", maxAssets=25).json()
    assert body["done"] is True and body["cursor"] == 2
    by_asset = {i["assetId"]: i for i in body["items"]}
    assert by_asset["vid"]["ok"] is True
    assert by_asset["mus"]["ok"] is False and "song.mp3" in by_asset["mus"]["reason"]


# --- Job-id guarding ------------------------------------------------------------


def test_batch_continuation_of_non_batch_job_is_409(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from framepilot_engine.brain.store import open_brain

    client, project_path = _sandboxed_client(tmp_path, monkeypatch)
    with open_brain(tmp_path, "pb") as store:
        store.create_job("render-1", kind="render", payload={})
    resp = _post_batch(client, project_path, projectId="pb", jobId="render-1")
    assert resp.status_code == 409
    assert "not an analyze-batch job" in resp.json()["detail"]


def test_batch_client_supplied_job_id_is_reused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, project_path = _sandboxed_client(tmp_path, monkeypatch)
    first = _post_batch(
        client, project_path, projectId="pb", jobId="mybatch", depth="quick", maxAssets=1
    ).json()
    assert first["jobId"] == "mybatch" and first["done"] is False
    second = _post_batch(
        client, project_path, projectId="pb", jobId="mybatch", maxAssets=1
    ).json()
    assert second["jobId"] == "mybatch" and second["done"] is True
