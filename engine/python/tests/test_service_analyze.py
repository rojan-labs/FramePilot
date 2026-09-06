"""Tests for the unified depth-tiered ``POST /analyze`` route (plan B1.2).

Every analyzer is monkeypatched at the service module seam (the same pattern
as the single-route tests in ``test_service.py``), so the tier expansion,
compatibility gating, honest-unavailable mapping, and per-kind failure
isolation are all exercised without ffmpeg/whisper binaries.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

import framepilot_engine.service as service_module
from framepilot_engine.analysis.beats import Beat, BeatAnalysis
from framepilot_engine.analysis.black import BlackRange
from framepilot_engine.analysis.freeze import FrozenRange
from framepilot_engine.analysis.loudness import LoudnessAnalysis
from framepilot_engine.analysis.scenes import SceneCut
from framepilot_engine.analysis.silence import SilentRange
from framepilot_engine.analysis.tiers import (
    DEPTH_KINDS,
    AnalysisDepth,
    AnalysisKind,
    analysis_params_hash,
    kinds_for,
)
from framepilot_engine.audio.asr import AsrModelMissingError
from framepilot_engine.config import Settings
from framepilot_engine.media.ffmpeg import NoAudioStreamError
from framepilot_engine.media.probe import MediaInfo, StreamInfo
from framepilot_engine.service import create_app
from framepilot_engine.timeline.models import Project, ProjectFile, TranscriptWord

# --- Fixtures -----------------------------------------------------------------


def _write_analysis_project(directory: Path) -> Path:
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


def _media_info(*, has_video: bool = True, has_audio: bool = True) -> MediaInfo:
    streams: list[StreamInfo] = []
    if has_video:
        streams.append(StreamInfo(index=0, codec_type="video", width=1920, height=1080, fps=30.0))
    if has_audio:
        streams.append(StreamInfo(index=1, codec_type="audio", sample_rate=48000, channels=2))
    return MediaInfo(
        path="/clip.mp4", duration_seconds=10.0, format_name="mov,mp4", streams=streams
    )


def _patch_all_analyzers(monkeypatch: pytest.MonkeyPatch, **overrides: Any) -> None:
    """Install happy-path fakes for every analyzer the route dispatches to."""
    fakes: dict[str, Any] = {
        "inspect_media": lambda path, *, timeout=None: _media_info(),
        # The unified silence analyzer measures at the probe floor and filters after
        # (see `summarize_silence`), so the fake must accept `min_silence_seconds`.
        # The silence analyzer now measures at the probe floor and filters after (see
        # `summarize_silence`), so the fake takes whatever thresholds it is called with.
        "detect_silence": lambda path, **kwargs: [SilentRange(start=1.0, end=2.0, duration=1.0)],
        "detect_scenes": lambda path, *, timeout=None: [SceneCut(time=3.0)],
        "measure_loudness": lambda path, *, timeout=None: LoudnessAnalysis(
            integrated_lufs=-16.0, loudness_range_lu=4.0, true_peak_dbfs=-1.2
        ),
        "detect_black": lambda path, *, timeout=None: [
            BlackRange(start=0.0, end=0.6, duration=0.6)
        ],
        "detect_beats": lambda path, *, timeout=None: BeatAnalysis(
            beats=[Beat(time=0.5, strength=1.0)], bpm=120.0
        ),
        "detect_freezes": lambda path, *, total_duration=None, timeout=None: [
            FrozenRange(start=4.0, end=6.5, duration=2.5)
        ],
        "transcribe": lambda path, *, timeout=None: [
            TranscriptWord(word="hello", start=0.1, end=0.4)
        ],
    }
    fakes.update(overrides)
    for name, fake in fakes.items():
        monkeypatch.setattr(service_module, name, fake)


def _post_analyze(client: TestClient, project_path: Path, **body: Any) -> Any:
    payload = {"project_path": str(project_path), **body}
    return client.post("/analyze", json=payload)


def _statuses(body: dict[str, Any]) -> dict[str, str]:
    return {entry["kind"]: entry["status"] for entry in body["results"]}


# --- Tier vocabulary (pure) -----------------------------------------------------


def test_depth_tiers_are_supersets() -> None:
    quick = set(DEPTH_KINDS[AnalysisDepth.QUICK])
    standard = set(DEPTH_KINDS[AnalysisDepth.STANDARD])
    deep = set(DEPTH_KINDS[AnalysisDepth.DEEP])
    assert quick < standard < deep
    assert deep == set(AnalysisKind)


def test_kinds_for_explicit_list_wins_and_dedupes() -> None:
    kinds = kinds_for(
        AnalysisDepth.QUICK,
        [AnalysisKind.BEATS, AnalysisKind.SCENES, AnalysisKind.BEATS],
    )
    assert kinds == (AnalysisKind.BEATS, AnalysisKind.SCENES)


def test_kinds_for_falls_back_to_depth() -> None:
    assert kinds_for(AnalysisDepth.QUICK, None) == (AnalysisKind.PROBE, AnalysisKind.SILENCE)
    assert kinds_for(AnalysisDepth.QUICK, []) == (AnalysisKind.PROBE, AnalysisKind.SILENCE)


def test_analysis_params_hash_is_stable_and_input_sensitive() -> None:
    base = analysis_params_hash(AnalysisKind.SILENCE, {"noiseFloorDb": -30.0}, content_sha256="a")
    assert base == analysis_params_hash(
        AnalysisKind.SILENCE, {"noiseFloorDb": -30.0}, content_sha256="a"
    )
    # Different params, kind, or source content each produce a different key.
    assert base != analysis_params_hash(
        AnalysisKind.SILENCE, {"noiseFloorDb": -40.0}, content_sha256="a"
    )
    assert base != analysis_params_hash(
        AnalysisKind.BLACK, {"noiseFloorDb": -30.0}, content_sha256="a"
    )
    assert base != analysis_params_hash(
        AnalysisKind.SILENCE, {"noiseFloorDb": -30.0}, content_sha256="b"
    )


# --- Route: tiers ------------------------------------------------------------------


def test_analyze_quick_runs_probe_and_silence(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_all_analyzers(monkeypatch)
    project_path = _write_analysis_project(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))

    resp = _post_analyze(client, project_path, depth="quick")
    assert resp.status_code == 200
    body = resp.json()
    assert body["assetId"] == "vid"
    assert body["depth"] == "quick"
    assert [e["kind"] for e in body["results"]] == ["probe", "silence"]
    assert _statuses(body) == {"probe": "ok", "silence": "ok"}
    silence = body["results"][1]
    # The entry carries the measurement, not just the filtered ranges: an empty
    # `ranges` must never be readable as "this recording has no dead air".
    assert silence["result"] == {
        "ranges": [{"start": 1.0, "end": 2.0, "duration": 1.0}],
        "measuredCount": 1,
        "longestSeconds": 1.0,
        "belowThresholdSeconds": 0.0,
        "probeFloorSeconds": 0.1,
        # The level and gap that defined "silent" — carried since run 137d8fd0.
        "noiseFloorDb": -30.0,
        "minSilenceSeconds": 0.5,
    }


def test_analyze_standard_adds_scenes_loudness_black(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_all_analyzers(monkeypatch)
    project_path = _write_analysis_project(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))

    resp = _post_analyze(client, project_path)  # standard is the default
    assert resp.status_code == 200
    body = resp.json()
    assert [e["kind"] for e in body["results"]] == [
        "probe",
        "silence",
        "scenes",
        "loudness",
        "black",
    ]
    assert set(_statuses(body).values()) == {"ok"}
    loudness = next(e for e in body["results"] if e["kind"] == "loudness")
    assert loudness["result"] == {
        "integratedLufs": -16.0,
        "loudnessRangeLu": 4.0,
        "truePeakDbfs": -1.2,
    }


def test_analyze_deep_runs_everything(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_all_analyzers(monkeypatch)
    project_path = _write_analysis_project(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))

    resp = _post_analyze(client, project_path, depth="deep")
    assert resp.status_code == 200
    body = resp.json()
    statuses = _statuses(body)
    assert set(statuses) == {k.value for k in AnalysisKind}
    assert set(statuses.values()) == {"ok"}
    beats = next(e for e in body["results"] if e["kind"] == "beats")
    assert beats["result"]["bpm"] == 120.0
    transcription = next(e for e in body["results"] if e["kind"] == "transcription")
    assert transcription["result"]["words"][0]["word"] == "hello"
    freeze = next(e for e in body["results"] if e["kind"] == "freeze")
    assert freeze["result"] == {"ranges": [{"start": 4.0, "end": 6.5, "duration": 2.5}]}


def test_analyze_explicit_kinds_override_depth(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_all_analyzers(monkeypatch)
    project_path = _write_analysis_project(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))

    resp = _post_analyze(client, project_path, depth="quick", kinds=["loudness", "black"])
    assert resp.status_code == 200
    assert [e["kind"] for e in resp.json()["results"]] == ["loudness", "black"]


# --- Route: compatibility gating -----------------------------------------------------


def test_analyze_audio_only_asset_skips_video_kinds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_all_analyzers(
        monkeypatch,
        inspect_media=lambda path, *, timeout=None: _media_info(has_video=False),
    )
    project_path = _write_analysis_project(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))

    resp = _post_analyze(client, project_path, asset_id="mus", depth="deep")
    assert resp.status_code == 200
    statuses = _statuses(resp.json())
    assert statuses["scenes"] == "skipped"
    assert statuses["black"] == "skipped"
    assert statuses["freeze"] == "skipped"
    assert statuses["silence"] == "ok"
    assert statuses["loudness"] == "ok"


def test_analyze_silent_video_skips_audio_kinds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_all_analyzers(
        monkeypatch,
        inspect_media=lambda path, *, timeout=None: _media_info(has_audio=False),
    )
    project_path = _write_analysis_project(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))

    resp = _post_analyze(client, project_path, depth="deep")
    assert resp.status_code == 200
    statuses = _statuses(resp.json())
    for kind in ("silence", "loudness", "beats", "transcription"):
        assert statuses[kind] == "skipped"
    for kind in ("probe", "scenes", "black", "freeze"):
        assert statuses[kind] == "ok"


# --- Route: honest unavailability + failure isolation ---------------------------------


def test_analyze_missing_asr_model_is_unavailable_not_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def _no_model(path: Path, *, timeout: float | None = None) -> list[TranscriptWord]:
        raise AsrModelMissingError("base.en", Path("/models/ggml-base.en.bin"))

    _patch_all_analyzers(monkeypatch, transcribe=_no_model)
    project_path = _write_analysis_project(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))

    resp = _post_analyze(client, project_path, kinds=["transcription", "silence"])
    assert resp.status_code == 200
    entries = {e["kind"]: e for e in resp.json()["results"]}
    assert entries["transcription"]["status"] == "unavailable"
    assert "asr/setup" in entries["transcription"]["reason"].lower()
    assert entries["silence"]["status"] == "ok"  # the pass is not aborted


def test_analyze_loudness_none_is_unavailable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_all_analyzers(monkeypatch, measure_loudness=lambda path, *, timeout=None: None)
    project_path = _write_analysis_project(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))

    resp = _post_analyze(client, project_path, kinds=["loudness"])
    entry = resp.json()["results"][0]
    assert entry["status"] == "unavailable"
    assert entry["result"] is None


def test_analyze_beats_on_silent_media_is_unavailable_not_failed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Silent footage gave the beat analyzer no input; it did not break.

    The distinction is load-bearing downstream: a caller treats `unavailable` as a fact
    to work around and `failed` as a fault to stop on, so misreporting this ended agent
    runs over an ordinary video-only asset.
    """

    def _silent(path: Path, *, timeout: float | None = None) -> object:
        raise NoAudioStreamError(f"{path.name} has no audio track, so there are no beats.")

    _patch_all_analyzers(monkeypatch, detect_beats=_silent)
    project_path = _write_analysis_project(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))

    resp = _post_analyze(client, project_path, kinds=["beats", "silence"])
    assert resp.status_code == 200
    entries = {e["kind"]: e for e in resp.json()["results"]}
    assert entries["beats"]["status"] == "unavailable"
    assert "has no audio track" in entries["beats"]["reason"]
    assert entries["silence"]["status"] == "ok"  # the pass is not aborted


def test_analyze_one_failing_kind_does_not_abort_pass(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from framepilot_engine.media.ffmpeg import FFmpegError

    def _boom(path: Path, *, timeout: float | None = None) -> list[SceneCut]:
        raise FFmpegError("scene filter exploded")

    _patch_all_analyzers(monkeypatch, detect_scenes=_boom)
    project_path = _write_analysis_project(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))

    resp = _post_analyze(client, project_path)  # standard
    assert resp.status_code == 200
    entries = {e["kind"]: e for e in resp.json()["results"]}
    assert entries["scenes"]["status"] == "failed"
    assert "exploded" in entries["scenes"]["reason"]
    assert entries["silence"]["status"] == "ok"
    assert entries["black"]["status"] == "ok"


# --- Route: error mapping ---------------------------------------------------------------


def test_analyze_unknown_asset_404(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_all_analyzers(monkeypatch)
    project_path = _write_analysis_project(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    resp = _post_analyze(client, project_path, asset_id="ghost")
    assert resp.status_code == 404
    # The error lists the real, analysable asset ids so a caller that passed a
    # hallucinated id can self-correct instead of dead-ending on a bare 404.
    detail = resp.json()["detail"]
    assert "ghost" in detail
    assert "vid" in detail  # the project's real video asset id


def test_analyze_unreadable_media_404(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def _missing(path: Path, *, timeout: float | None = None) -> MediaInfo:
        raise FileNotFoundError(f"{path} does not exist")

    _patch_all_analyzers(monkeypatch, inspect_media=_missing)
    project_path = _write_analysis_project(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    resp = _post_analyze(client, project_path)
    assert resp.status_code == 404


def test_analyze_probe_ffmpeg_error_422(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from framepilot_engine.media.ffmpeg import FFmpegError

    def _corrupt(path: Path, *, timeout: float | None = None) -> MediaInfo:
        raise FFmpegError("corrupt container")

    _patch_all_analyzers(monkeypatch, inspect_media=_corrupt)
    project_path = _write_analysis_project(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    resp = _post_analyze(client, project_path)
    assert resp.status_code == 422


def test_analyze_rejects_both_project_sources(tmp_path: Path) -> None:
    client = TestClient(create_app())
    resp = client.post("/analyze", json={})
    assert resp.status_code == 422


# --- Brain persistence + read-through cache (plan B1.3) --------------------------------


def _sandboxed_setup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, **overrides: Any
) -> tuple[TestClient, Path, dict[str, int]]:
    """A sandboxed app + on-disk project/media + call counters per analyzer."""
    from framepilot_engine.config import Settings

    calls = {"silence": 0, "probe": 0}

    def _counted_inspect(path: Path, *, timeout: float | None = None) -> MediaInfo:
        calls["probe"] += 1
        return _media_info()

    def _counted_silence(
        path: Path,
        *,
        min_silence_seconds: float | None = None,
        total_duration: float | None = None,
        timeout: float | None = None,
    ) -> list[SilentRange]:
        calls["silence"] += 1
        return [SilentRange(start=1.0, end=2.0, duration=1.0)]

    _patch_all_analyzers(
        monkeypatch,
        inspect_media=_counted_inspect,
        detect_silence=_counted_silence,
        **overrides,
    )
    project_path = _write_analysis_project(tmp_path)
    (tmp_path / "clip.mp4").write_bytes(b"fake mp4 bytes v1")
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    return client, project_path, calls


def test_analyze_persists_results_and_serves_cache_hits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, project_path, calls = _sandboxed_setup(tmp_path, monkeypatch)

    first = _post_analyze(client, project_path, depth="quick", projectId="pa")
    assert first.status_code == 200
    assert all(e["cached"] is False for e in first.json()["results"])
    assert calls["silence"] == 1

    # Sidecar export stays in lockstep with the DB (B0.3).
    sidecar = tmp_path / ".framepilot-derived" / "pa" / "sidecars" / "vid" / "analysis.json"
    assert sidecar.exists()

    # The media-bin digest regenerates after the pass (B1.5).
    summary = tmp_path / ".framepilot-derived" / "pa" / "memory" / "bin_summary.md"
    assert summary.exists()
    assert "## vid" in summary.read_text(encoding="utf-8")
    assert "1 silent range" in summary.read_text(encoding="utf-8")

    second = _post_analyze(client, project_path, depth="quick", projectId="pa")
    assert second.status_code == 200
    assert all(e["cached"] is True for e in second.json()["results"])
    assert all(e["status"] == "ok" for e in second.json()["results"])
    assert calls["silence"] == 1  # cache hit — ffmpeg (the fake) not re-run
    # The silence payload survives the round-trip through the brain byte-true.
    assert second.json()["results"][1]["result"] == {
        "ranges": [{"start": 1.0, "end": 2.0, "duration": 1.0}],
        "measuredCount": 1,
        "longestSeconds": 1.0,
        "belowThresholdSeconds": 0.0,
        "probeFloorSeconds": 0.1,
        # The level and gap that defined "silent" — carried since run 137d8fd0.
        "noiseFloorDb": -30.0,
        "minSilenceSeconds": 0.5,
    }


def test_analyze_cache_invalidates_when_source_bytes_change(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, project_path, calls = _sandboxed_setup(tmp_path, monkeypatch)

    assert _post_analyze(client, project_path, depth="quick", projectId="pa").status_code == 200
    (tmp_path / "clip.mp4").write_bytes(b"fake mp4 bytes v2 (re-exported)")
    resp = _post_analyze(client, project_path, depth="quick", projectId="pa")
    assert resp.status_code == 200
    assert all(e["cached"] is False for e in resp.json()["results"])
    assert calls["silence"] == 2  # content hash changed → honest recompute


def test_analyze_non_ok_entries_are_not_persisted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, project_path, _ = _sandboxed_setup(
        tmp_path, monkeypatch, measure_loudness=lambda path, *, timeout=None: None
    )

    resp = _post_analyze(client, project_path, kinds=["loudness"], projectId="pa")
    assert resp.json()["results"][0]["status"] == "unavailable"
    listing = client.get("/brain/analysis", params={"projectId": "pa"})
    assert listing.status_code == 200
    assert listing.json()["available"] is True
    assert listing.json()["results"] == []


def test_analyze_without_project_id_does_not_touch_brain(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, project_path, _ = _sandboxed_setup(tmp_path, monkeypatch)
    resp = _post_analyze(client, project_path, depth="quick")
    assert resp.status_code == 200
    assert not (tmp_path / ".framepilot-derived" / "pa").exists()


def test_brain_analysis_route_lists_and_filters_rows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, project_path, _ = _sandboxed_setup(tmp_path, monkeypatch)
    _post_analyze(client, project_path, depth="quick", projectId="pa")

    listing = client.get("/brain/analysis", params={"projectId": "pa"})
    assert listing.status_code == 200
    body = listing.json()
    assert body["available"] is True
    kinds = {row["kind"] for row in body["results"]}
    assert kinds == {"probe", "silence"}
    assert all(row["assetId"] == "vid" for row in body["results"])
    assert all(row["source"] == "machine" for row in body["results"])
    assert body["results"][0]["tool"].endswith("@v1")

    only_silence = client.get("/brain/analysis", params={"projectId": "pa", "kind": "silence"})
    assert [r["kind"] for r in only_silence.json()["results"]] == ["silence"]


def test_brain_analysis_route_honest_unavailable_without_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("FRAMEPILOT_PROJECTS_ROOT", raising=False)
    client = TestClient(create_app())  # no projects_root configured
    resp = client.get("/brain/analysis", params={"projectId": "pa"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["available"] is False
    assert "FRAMEPILOT_PROJECTS_ROOT" in body["reason"]
    assert body["results"] == []


def test_brain_analysis_route_rejects_traversal_project_id(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, _, _ = _sandboxed_setup(tmp_path, monkeypatch)
    resp = client.get("/brain/analysis", params={"projectId": "../../etc"})
    assert resp.status_code == 200
    assert resp.json()["available"] is False
