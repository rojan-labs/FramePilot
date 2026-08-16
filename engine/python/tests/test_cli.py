"""Tests for the CLI parser and subcommand wiring (plan 2.4)."""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest

from framepilot_engine.audio.asr import ModelDownload, StreamDownloader
from framepilot_engine.cli import build_parser, main
from framepilot_engine.timeline.models import Project, ProjectFile


def _fake_download(payload: bytes) -> StreamDownloader:
    """Stand in for the network: serve ``payload`` as a two-chunk streamed body."""

    @contextmanager
    def opener(_url: str) -> Iterator[ModelDownload]:
        half = len(payload) // 2
        yield ModelDownload(total_bytes=len(payload), chunks=iter([payload[:half], payload[half:]]))

    return opener


def test_parser_builds_with_all_subcommands() -> None:
    parser = build_parser()
    subparsers_action = next(
        action for action in parser._actions if hasattr(action, "choices") and action.choices
    )
    assert subparsers_action.choices is not None
    commands = set(subparsers_action.choices)
    assert {
        "render",
        "validate-render",
        "inspect-media",
        "setup-asr",
        "asr-status",
        "serve",
    } <= commands


def test_render_parses_burn_captions_flag() -> None:
    parser = build_parser()
    default = parser.parse_args(["render", "p.fp.json"])
    enabled = parser.parse_args(["render", "p.fp.json", "--burn-captions"])
    assert default.burn_captions is False
    assert enabled.burn_captions is True


def test_help_exits_zero() -> None:
    with pytest.raises(SystemExit) as exc:
        main(["--help"])
    assert exc.value.code == 0


def test_no_command_prints_help_and_returns_zero(capsys: pytest.CaptureFixture[str]) -> None:
    assert main([]) == 0
    out = capsys.readouterr().out
    assert "usage" in out.lower()


# --- inspect-media -----------------------------------------------------------


@pytest.mark.usefixtures("require_ffprobe")
def test_inspect_media_prints_json(
    media_factory: Callable[..., Path], capsys: pytest.CaptureFixture[str]
) -> None:
    path = media_factory("cli_probe.mp4", seconds=1.0)
    assert main(["inspect-media", str(path)]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["streams"]


def test_inspect_media_missing_file_returns_one(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["inspect-media", "/no/such/file.mp4"]) == 1
    assert "error" in capsys.readouterr().out.lower()


# --- setup-asr / asr-status ---------------------------------------------------


def test_asr_status_prints_json(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(tmp_path))
    monkeypatch.delenv("FRAMEPILOT_WHISPER_CLI", raising=False)
    monkeypatch.setattr("shutil.which", lambda _name: None)
    assert main(["asr-status"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["binaryAvailable"] is False
    assert payload["model"] == "large-v3-turbo-q5_0"
    assert payload["modelPresent"] is False


def test_setup_asr_downloads_and_verifies(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(tmp_path))
    payload = b"fake-model-bytes"
    import hashlib

    monkeypatch.setenv(
        "FRAMEPILOT_ASR_LARGE_V3_TURBO_Q5_0_SHA256", hashlib.sha256(payload).hexdigest()
    )
    monkeypatch.setattr("framepilot_engine.audio.asr._default_downloader", _fake_download(payload))

    assert main(["setup-asr"]) == 0

    captured = capsys.readouterr()
    out = json.loads(captured.out)
    assert out["model"] == "large-v3-turbo-q5_0"
    assert (tmp_path / "ggml-large-v3-turbo-q5_0.bin").read_bytes() == payload
    # Real progress goes to stderr, so stdout stays pipeable JSON.
    assert "downloading:" in captured.err


def test_setup_asr_progress_line_reports_a_percentage_when_the_size_is_known(
    capsys: pytest.CaptureFixture[str],
) -> None:
    from framepilot_engine.cli import _print_download_progress

    _print_download_progress(1 << 20, 4 << 20)
    assert "1.0 MiB of 4.0 MiB (25%)" in capsys.readouterr().err


def test_setup_asr_progress_line_omits_the_percentage_when_the_size_is_unknown(
    capsys: pytest.CaptureFixture[str],
) -> None:
    from framepilot_engine.cli import _print_download_progress

    _print_download_progress(1 << 20, None)

    err = capsys.readouterr().err
    assert "1.0 MiB" in err
    assert "%" not in err


def test_setup_asr_reports_checksum_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("FRAMEPILOT_ASR_MODEL_DIR", str(tmp_path))
    monkeypatch.setenv("FRAMEPILOT_ASR_BASE_EN_SHA256", "0" * 64)
    monkeypatch.setattr(
        "framepilot_engine.audio.asr._default_downloader", _fake_download(b"wrong-bytes")
    )

    assert main(["setup-asr"]) == 1
    assert "error" in capsys.readouterr().out.lower()
    assert list(tmp_path.iterdir()) == []


def test_serve_command_invokes_service(monkeypatch: pytest.MonkeyPatch) -> None:
    # Don't actually start uvicorn; just assert the subcommand calls serve().
    called: dict[str, Any] = {}

    def fake_serve(*, host: str | None, port: int | None) -> None:
        called["host"] = host
        called["port"] = port

    monkeypatch.setattr("framepilot_engine.service.serve", fake_serve)
    assert main(["serve", "--host", "0.0.0.0", "--port", "9000"]) == 0
    assert called == {"host": "0.0.0.0", "port": 9000}


# --- render ------------------------------------------------------------------


def _write_project(
    directory: Path, assets: list[dict[str, Any]], tracks: list[dict[str, Any]]
) -> Path:
    project = Project.model_validate(
        {"id": "p1", "name": "T", "fps": 30, "assets": assets, "timeline": {"tracks": tracks}}
    )
    dest = directory / "demo.project.fp.json"
    ProjectFile.save(project, dest)
    return dest


def test_render_missing_project_returns_one(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["render", "/no/such/project.fp.json"]) == 1
    assert "error" in capsys.readouterr().out.lower()


@pytest.mark.usefixtures("require_ffprobe")
def test_render_completes_and_prints_job(
    tmp_project_dir: Path, media_factory: Callable[..., Path], capsys: pytest.CaptureFixture[str]
) -> None:
    src = media_factory("clip.mp4", seconds=1.0, with_audio=False)
    (tmp_project_dir / "clip.mp4").write_bytes(src.read_bytes())
    project_path = _write_project(
        tmp_project_dir,
        assets=[{"id": "a1", "path": "clip.mp4", "kind": "video"}],
        tracks=[
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
        ],
    )
    assert main(["render", str(project_path), "--preview"]) == 0
    job = json.loads(capsys.readouterr().out)
    assert job["state"] == "completed"
    assert Path(job["output_path"]).is_file()


# --- validate-render ---------------------------------------------------------


@pytest.mark.usefixtures("require_ffprobe")
def test_validate_render_passes(
    media_factory: Callable[..., Path], capsys: pytest.CaptureFixture[str]
) -> None:
    path = media_factory("cli_validate.mp4", seconds=1.0, with_audio=False)
    code = main(["validate-render", str(path), "--no-audio", "--duration", "1.0"])
    report = json.loads(capsys.readouterr().out)
    assert code == 0
    assert report["ok"]


@pytest.mark.usefixtures("require_ffprobe")
def test_validate_render_fails_returns_one(
    media_factory: Callable[..., Path], capsys: pytest.CaptureFixture[str]
) -> None:
    path = media_factory("cli_black.mp4", seconds=1.0, color="black", with_audio=False)
    code = main(["validate-render", str(path), "--no-audio"])
    report = json.loads(capsys.readouterr().out)
    assert code == 1
    assert not report["ok"]
