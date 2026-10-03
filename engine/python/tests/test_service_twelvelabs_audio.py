"""Audio-only media must reach TwelveLabs under a picture, or it is never indexed.

Regression cover for the reported defect: transcribing a voiceover (``.m4a``) with
the TwelveLabs provider always failed with ``TwelveLabs API error (HTTP 404)
(resource_not_exists)``. Verified against the live API: ``POST /assets`` accepts an
audio file and reports it ``ready``, but ``POST /indexes/{id}/indexed-assets``
refuses every audio container (MP3, WAV, M4A — even on an audio-only Marengo index),
while the same sound muxed under a black picture indexes and transcribes. The route
now uploads audio-only media through that carrier; footage is uploaded untouched.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

import framepilot_engine.service as service_module
from framepilot_engine.brain.store import open_brain
from framepilot_engine.brain.twelvelabs import TaskStatus, TwelveLabsClientResolution
from framepilot_engine.config import Settings
from framepilot_engine.media.ffmpeg import FFmpegError
from framepilot_engine.media.probe import MediaInfo, StreamInfo
from framepilot_engine.service import create_app


class _RecordingTL:
    """Records what was uploaded: the file name, and whether it existed at upload time."""

    key_fingerprint = "fp-current"

    def __init__(self) -> None:
        self.uploads: list[Path] = []

    def index_accessible(self, index_id: str) -> bool:
        return True

    def find_index(self, name: str) -> str | None:
        return None

    def create_index(self, name: str) -> str:
        return "idx-1"

    def create_index_task(self, index_id: str, media_path: Path) -> str:
        assert media_path.is_file(), "the uploaded file must exist while it uploads"
        self.uploads.append(media_path)
        return f"task-{media_path.name}"

    def get_task(self, task_id: str) -> TaskStatus:
        return TaskStatus(task_id, "ready", f"video-{task_id}")


class _RecordingWrap:
    """Stands in for the ffmpeg carrier encode; ``fail`` makes it raise like ffmpeg."""

    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.calls: list[tuple[Path, Path, float | None]] = []

    def __call__(self, source: Path, output: Path, *, timeout: float | None = None) -> Path:
        self.calls.append((source, output, timeout))
        if self.fail:
            raise FFmpegError("'ffmpeg' exited 1: Invalid data found when processing input")
        output.write_bytes(b"carrier")
        return output


def _probe(streams: list[StreamInfo], *, duration: float = 415.0) -> dict[str, Any]:
    return MediaInfo(
        path="/x", duration_seconds=duration, format_name="mov,mp4,m4a", streams=streams
    ).model_dump(mode="json")


_AUDIO = StreamInfo(index=0, codec_type="audio", sample_rate=48000, channels=2)
#: Embedded cover art as ffprobe reports it: a picture "stream" at the 90 kHz timebase.
_COVER_ART = StreamInfo(index=1, codec_type="video", width=300, height=300, fps=90000.0)
_FOOTAGE = StreamInfo(index=1, codec_type="video", width=1920, height=1080, fps=29.97)


def _client(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    assets: list[tuple[str, str, dict[str, Any]]],
    tl: _RecordingTL,
    wrap: _RecordingWrap,
) -> TestClient:
    for _asset_id, name, _probe_json in assets:
        (tmp_path / name).write_bytes(b"\x00\x00fake\x00\x00")
    with open_brain(tmp_path, "p1") as store:
        for asset_id, name, probe in assets:
            store.upsert_asset(asset_id, path=name, content_sha256=f"sha-{asset_id}", probe=probe)
    monkeypatch.setattr(
        service_module,
        "resolve_twelvelabs",
        lambda key=None: TwelveLabsClientResolution(client=tl),  # type: ignore[arg-type]
    )
    monkeypatch.setattr(service_module, "wrap_audio_in_video", wrap)
    return TestClient(create_app(Settings(projects_root=tmp_path, twelvelabs_api_key="tl-key")))


def _index(client: TestClient, asset_id: str) -> Any:
    """Index one asset by id, as the desktop does before a TwelveLabs transcription.

    Explicit, because the default worklist is visual assets only: background indexing
    never uploads (and bills for) a voiceover nobody asked to transcribe.
    """
    body: dict[str, Any] = {"projectId": "p1", "assetIds": [asset_id], "tiers": []}
    return client.post("/brain/visual/index", json=body).json()


def test_audio_only_asset_is_uploaded_under_a_black_picture(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    tl, wrap = _RecordingTL(), _RecordingWrap()
    client = _client(tmp_path, monkeypatch, [("vo", "voiceover.m4a", _probe([_AUDIO]))], tl, wrap)

    last = _index(client, "vo")

    assert last["done"] is True, last
    assert [item["ok"] for item in last["items"]] == [True]
    assert [call[0].name for call in wrap.calls] == ["voiceover.m4a"]
    assert [path.name for path in tl.uploads] == ["voiceover.mp4"]
    carrier = tl.uploads[0]
    # Written to a temp dir and removed after upload — never into the user's footage.
    assert tmp_path not in carrier.parents
    assert not carrier.exists()
    # A 415 s voiceover gets more than the 60 s media timeout to encode its carrier.
    assert wrap.calls[0][2] is not None and wrap.calls[0][2] > 60


def test_audio_with_cover_art_counts_as_audio_only(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    tl, wrap = _RecordingTL(), _RecordingWrap()
    client = _client(
        tmp_path, monkeypatch, [("song", "song.mp3", _probe([_AUDIO, _COVER_ART]))], tl, wrap
    )

    assert _index(client, "song")["done"] is True
    assert [path.name for path in tl.uploads] == ["song.mp4"]


def test_footage_is_uploaded_untouched(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    tl, wrap = _RecordingTL(), _RecordingWrap()
    client = _client(
        tmp_path, monkeypatch, [("cam", "clip.mp4", _probe([_FOOTAGE, _AUDIO]))], tl, wrap
    )

    assert _index(client, "cam")["done"] is True
    assert wrap.calls == []
    assert tl.uploads == [tmp_path / "clip.mp4"]


def test_a_carrier_that_cannot_be_encoded_fails_the_asset_with_a_reason(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    tl, wrap = _RecordingTL(), _RecordingWrap(fail=True)
    client = _client(tmp_path, monkeypatch, [("vo", "voiceover.m4a", _probe([_AUDIO]))], tl, wrap)

    last = _index(client, "vo")

    assert tl.uploads == []
    (item,) = last["items"]
    assert item["ok"] is False
    assert "Could not prepare voiceover.m4a for TwelveLabs" in item["reason"]
