"""Fuzzed media against the matte routes and readers (BR4.12).

Typed refusals, bounded cost, no paths.

Each case must end in a typed outcome (``FrameHashError``/``ValueError`` in-process, a 4xx/5xx with
a path-free message over HTTP, or a ``None`` hash) within a time bound, with the decoders it
started staying under a memory bound. Nothing may raise an untyped exception or hang.
"""

from __future__ import annotations

import contextlib
import resource
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from framepilot_engine.config import Settings
from framepilot_engine.render.frame_hashes import (
    FrameHashError,
    frame_hashes_by_index,
    frame_hashes_by_pts,
)
from framepilot_engine.render.mattes import read_frames_file
from framepilot_engine.service import create_app
from tests.fixtures.fuzz_media.generate import (
    MAX_CORPUS_FILE_BYTES,
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
        ):
            assert response.status_code in {200, 400, 404, 422, 503, 504}, name
            assert str(root) not in response.text, name
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
