"""Fuzzed media against the matte routes and readers (BR4.12).

Typed refusals, bounded cost, no paths.

Each case must end in a typed outcome (``FrameHashError``/``ValueError`` in-process, a 4xx/5xx with
a path-free message over HTTP, or a ``None`` hash) within a time bound, with the decoders it
started staying under a memory bound. Nothing may raise an untyped exception or hang.
"""

from __future__ import annotations

import contextlib
import resource
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from framepilot_engine.config import Settings
from framepilot_engine.media.untrusted import DECODE_THREADS, MAX_PIXELS
from framepilot_engine.render import mattes
from framepilot_engine.render.frame_hashes import (
    FrameHashError,
    frame_hashes_by_index,
    frame_hashes_by_pts,
)
from framepilot_engine.render.mattes import (
    MATTE_FILE,
    MatteFrameMissing,
    _packet_seconds,
    _Track,
    probe_stream,
    read_frames_file,
)
from framepilot_engine.service import create_app
from tests.fixtures.fuzz_media.generate import (
    MAX_CORPUS_FILE_BYTES,
    _video,
    frames_corpus,
    media_corpus,
)

#: Per-case wall-clock bound, seconds.
CASE_SECONDS = 20.0
#: Peak RSS any decoder child may reach while the corpus runs.
CHILD_RSS_BOUND_BYTES = 1024 * 1024 * 1024


def _child_peak_rss_bytes() -> int:
    peak = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    # macOS reports bytes, Linux kilobytes.
    return peak if sys.platform == "darwin" else peak * 1024


@pytest.fixture(scope="module")
def corpus(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, dict[str, Path]]:
    root = tmp_path_factory.mktemp("fuzz_media")
    return root, media_corpus(root)


def test_corpus_files_are_small(corpus: tuple[Path, dict[str, Path]]) -> None:
    _, files = corpus
    for name, path in files.items():
        assert path.stat().st_size <= MAX_CORPUS_FILE_BYTES, name


def test_every_case_ends_typed_bounded_and_without_following_references(
    corpus: tuple[Path, dict[str, Path]],
) -> None:
    _, files = corpus
    for name, path in files.items():
        started = time.monotonic()
        try:
            hashes = frame_hashes_by_pts(path, [0, 1, 33], deadline=time.monotonic() + CASE_SECONDS)
        except (FrameHashError, ValueError) as exc:
            assert str(path.parent) not in str(exc), name
            hashes = None
        if name in {"hls_renamed", "ffconcat_renamed", "external_reference", "huge_dimensions"}:
            # A playlist or oversized picture must never decode into frames.
            assert hashes is None or all(value is None for value in hashes), name
        with contextlib.suppress(FrameHashError, ValueError):
            frame_hashes_by_index(path, [0, 5], deadline=time.monotonic() + CASE_SECONDS)
        assert time.monotonic() - started < 2 * CASE_SECONDS + 5, name
    assert _child_peak_rss_bytes() < CHILD_RSS_BOUND_BYTES


def test_routes_refuse_the_corpus_without_paths(corpus: tuple[Path, dict[str, Path]]) -> None:
    root, files = corpus
    client = TestClient(create_app(Settings(projects_root=root)))
    for name, path in files.items():
        for response in (
            client.post("/mattes/frame-hashes", json={"input_path": str(path), "pts": [0, 33]}),
            client.post(
                "/mattes/locked-frames",
                json={"matte_path": str(path), "expected": [{"index": 0, "sha256": "a" * 64}]},
            ),
            # AM2.7: the colour re-ranker decodes the same untrusted media.
            client.post(
                "/masking/crop-colour",
                json={
                    "input_path": str(path),
                    "fps": 30,
                    "crops": [{"time_seconds": 0, "x": 0, "y": 0, "width": 1, "height": 1}],
                },
            ),
        ):
            assert response.status_code in {200, 400, 404, 422, 503, 504}, name
            assert str(root) not in response.text, name
            if response.status_code == 200 and "crops" in response.json():
                # A playlist or a file pointing elsewhere must never decode into a picture.
                assert name not in {"hls_renamed", "ffconcat_renamed", "external_reference"}, name
            if (
                response.status_code == 200
                and "hashes" in response.json()
                and name in {"hls_renamed", "ffconcat_renamed", "external_reference"}
            ):
                assert all(value is None for value in response.json()["hashes"]), name


def test_hostile_frames_json_is_a_value_error(tmp_path: Path) -> None:
    for name, path in frames_corpus(tmp_path).items():
        started = time.monotonic()
        with pytest.raises(ValueError):
            read_frames_file(path)
        assert time.monotonic() - started < 5, name


#: Cases whose bytes are not a Matroska matte: the export's matte decoder must never make frames
#: of them (a playlist or concat file named ``matte.mkv`` would otherwise open its target).
NEVER_DECODES = {
    "truncated_mp4",
    "huge_dimensions",
    "zero_frames",
    "hls_renamed",
    "ffconcat_renamed",
    "external_reference",
}


def _as_matte(root: Path, name: str, source: Path) -> Path:
    """The corpus file where the export reads a matte from: ``<artifact>/matte.mkv``."""
    directory = root / "as-matte" / name
    directory.mkdir(parents=True, exist_ok=True)
    return Path(shutil.copyfile(source, directory / MATTE_FILE))


def test_the_export_matte_decoder_ends_typed_bounded_and_without_following_references(
    corpus: tuple[Path, dict[str, Path]],
) -> None:
    """BR4.16: ``mattes.probe_stream``, the packet index and the rawvideo cursor against every
    corpus case, each placed as ``matte.mkv``."""
    root, files = corpus
    for name, source in files.items():
        path = _as_matte(root, name, source)
        started = time.monotonic()
        with contextlib.suppress(ValueError, subprocess.SubprocessError):
            probe_stream(path)
        with contextlib.suppress(MatteFrameMissing):
            _packet_seconds(path)
        track = _Track(path, "gray", 64, 36, 1, 1)
        try:
            decoded: bool = track.read(0).size > 0
            track.read(3)
        except MatteFrameMissing as exc:
            assert str(path.parent) not in str(exc), name
            decoded = False
        finally:
            track.close()
        if name in NEVER_DECODES:
            assert not decoded, name
        assert time.monotonic() - started < CASE_SECONDS, name
    assert _child_peak_rss_bytes() < CHILD_RSS_BOUND_BYTES


def test_every_export_matte_probe_and_decode_is_hardened(
    corpus: tuple[Path, dict[str, Path]], monkeypatch: pytest.MonkeyPatch
) -> None:
    root, files = corpus
    path = _as_matte(root, "hardened", files["corrupt_ffv1"])
    seen: list[list[str]] = []
    real_popen = subprocess.Popen

    # Popen only: subprocess.run starts its process through it, so every launch is seen once.
    def spy_popen(argv: list[str], **kwargs: object) -> subprocess.Popen[bytes]:
        seen.append(list(argv))
        return real_popen(argv, **kwargs)  # type: ignore[call-overload,no-any-return]

    monkeypatch.setattr(subprocess, "Popen", spy_popen)
    with contextlib.suppress(ValueError):
        mattes.probe_stream(path)
    with contextlib.suppress(MatteFrameMissing):
        mattes._packet_seconds(path)
    track = _Track(path, "gray", 64, 36, 1, 1)
    with contextlib.suppress(MatteFrameMissing):
        track.read(0)
    track.close()
    # The three calls that open the matte (resolver probes of the binaries themselves aside).
    opened = [argv for argv in seen if str(path) in argv]
    assert len(opened) == 3
    for argv in opened:
        joined = " ".join(argv)
        assert "-protocol_whitelist file" in joined
        assert "-format_whitelist" in joined
        assert f"-max_pixels {MAX_PIXELS}" in joined
        assert f"-threads {DECODE_THREADS}" in joined
        forced = [i for i in range(len(argv) - 1) if argv[i] == "-f" and argv[i + 1] == "matroska"]
        assert forced and forced[0] < argv.index("-i")


def test_a_concat_file_named_matte_mkv_cannot_open_a_sibling(tmp_path: Path) -> None:
    """The case the corpus's absolute-path playlists miss: ffmpeg's concat demuxer follows a
    RELATIVE name by default, so before BR4.16 this ``matte.mkv`` decoded ``elsewhere.mkv``."""
    real = tmp_path / "real"
    real.mkdir()
    _video(real / "elsewhere.mkv", "-pix_fmt", "gray")
    (real / MATTE_FILE).write_text("ffconcat version 1.0\nfile 'elsewhere.mkv'\n", encoding="utf-8")
    track = _Track(real / MATTE_FILE, "gray", 64, 36, 1, 1)
    try:
        with pytest.raises(MatteFrameMissing):
            track.read(0)
    finally:
        track.close()
    with pytest.raises(ValueError):
        probe_stream(real / MATTE_FILE)
