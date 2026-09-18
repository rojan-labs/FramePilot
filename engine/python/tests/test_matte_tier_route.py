"""PX5.9: ``POST /mattes/monitor-tier`` makes a committed artifact's tier, and nothing else.

The route's contract (ADR 0181, the BR4.12 limits of the other ``/mattes/*`` routes):

* written into ``.framepilot-derived/matte-tiers/<key>/`` through a staged folder that is
  verified, then renamed; a repeat is ``current`` and rewrites nothing;
* refused (409) unless the masters' digests are the mask's pins, before and after the pixels;
* one request at a time (503), one deadline sized from the frame count (504);
* only through real folders: a symlinked folder or master anywhere on the way is refused (400),
  and a link is never followed to write or delete;
* bounded inputs (422), and no path in any answer;
* the fuzzed-media corpus ends in typed refusals within a time bound.
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient

import framepilot_engine.service as service_module
from framepilot_engine.config import Settings
from framepilot_engine.render import matte_tier_job
from framepilot_engine.render.matte_tier import (
    ALPHA_FILE,
    PLANES_FILE,
    TIER_FILE,
    MatteTierChanged,
)
from framepilot_engine.render.mattes import FOREGROUND_FILE, MATTE_FILE, MATTES_DIR
from framepilot_engine.service import create_app, matte_tier_deadline
from tests.fixtures.fuzz_media.generate import media_corpus
from tests.matte_fixtures import encode_ffv1, sha256, write_artifact

TIERS = ".framepilot-derived/matte-tiers"
#: Per-case bound for the fuzzed corpus, seconds.
CASE_SECONDS = 30.0


def _disc(width: int, height: int, shift: int) -> np.ndarray:
    y, x = np.mgrid[0:height, 0:width]
    distance = np.hypot(x - width * 0.45 - shift, y - height * 0.5)
    rounded: np.ndarray = np.round(
        np.clip((min(width, height) * 0.3 - distance) / 4.0, 0.0, 1.0) * 255
    ).astype(np.uint8)
    return rounded


def _project(root: Path) -> tuple[Path, dict[str, Any], Path]:
    """A project folder holding one committed artifact and the picture's 16x9 proxy."""
    project = root / "demo"
    rng = np.random.default_rng(3)
    artifact = write_artifact(
        project,
        pts=[0, 1, 2],
        mattes=[_disc(64, 36, shift) for shift in range(3)],
        foregrounds=[rng.integers(0, 256, size=(36, 64, 3), dtype=np.uint8) for _ in range(3)],
    )
    proxy = project / "proxies" / "clip.mkv"
    proxy.parent.mkdir(parents=True)
    encode_ffv1(proxy, [np.zeros((9, 16), dtype=np.uint8)] * 3, "gray", "gray")
    return project, artifact, proxy


def _body(project: Path, artifact: dict[str, Any], proxy: Path, **extra: Any) -> dict[str, Any]:
    return {
        "project_dir": str(project),
        "artifact": {
            "key": artifact["key"],
            "files": [{"name": f["name"], "sha256": f["sha256"]} for f in artifact["files"]],
            "width": artifact["width"],
            "height": artifact["height"],
        },
        "proxy_path": str(proxy),
        **extra,
    }


@pytest.fixture
def setup(tmp_path: Path) -> tuple[TestClient, Path, dict[str, Any], Path]:
    project, artifact, proxy = _project(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    return client, project, artifact, proxy


def test_writes_the_tier_atomically_then_reports_it_current(
    setup: tuple[TestClient, Path, dict[str, Any], Path],
) -> None:
    client, project, artifact, proxy = setup
    response = client.post("/mattes/monitor-tier", json=_body(project, artifact, proxy))
    assert response.status_code == 200, response.text
    assert response.json() == {
        "status": "written",
        "width": 16,
        "height": 9,
        "frame_count": 3,
        "alpha": True,
    }
    tier = project / TIERS / artifact["key"]
    assert sorted(p.name for p in tier.iterdir()) == [ALPHA_FILE, PLANES_FILE, TIER_FILE]
    manifest = json.loads((tier / TIER_FILE).read_text(encoding="utf-8"))
    pinned = {f["name"]: f["sha256"] for f in artifact["files"]}
    assert manifest["source"]["files"] == {
        name: pinned[name] for name in (MATTE_FILE, FOREGROUND_FILE, "frames.json")
    }
    # The staging folder is empty: nothing half-written is left beside the tiers.
    assert list((project / TIERS / ".staging").iterdir()) == []
    stamp = (tier / PLANES_FILE).stat().st_mtime_ns
    again = client.post("/mattes/monitor-tier", json=_body(project, artifact, proxy))
    assert again.status_code == 200 and again.json()["status"] == "current"
    assert (tier / PLANES_FILE).stat().st_mtime_ns == stamp


def test_a_rotated_picture_turns_the_tier(
    setup: tuple[TestClient, Path, dict[str, Any], Path],
) -> None:
    client, project, artifact, proxy = setup
    response = client.post(
        "/mattes/monitor-tier", json=_body(project, artifact, proxy, rotation=90)
    )
    assert response.status_code == 200, response.text
    assert (response.json()["width"], response.json()["height"]) == (9, 16)


def test_refuses_masters_that_are_not_the_pins(
    setup: tuple[TestClient, Path, dict[str, Any], Path],
) -> None:
    client, project, artifact, proxy = setup
    foreground = project / MATTES_DIR / artifact["key"] / FOREGROUND_FILE
    foreground.write_bytes(foreground.read_bytes() + b"\0")
    response = client.post("/mattes/monitor-tier", json=_body(project, artifact, proxy))
    assert response.status_code == 409
    assert not (project / TIERS / artifact["key"]).exists()


def test_a_master_changed_during_the_pixels_leaves_the_old_tier(
    setup: tuple[TestClient, Path, dict[str, Any], Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, project, artifact, proxy = setup
    first = client.post("/mattes/monitor-tier", json=_body(project, artifact, proxy))
    assert first.status_code == 200
    tier = project / TIERS / artifact["key"]
    before = (tier / TIER_FILE).read_bytes()
    real = matte_tier_job.verified_source  # type: ignore[attr-defined]
    calls = {"n": 0}

    def changed_after(directory: Path, pins: Any) -> Any:
        calls["n"] += 1
        if calls["n"] == 2:
            raise MatteTierChanged("matte.mkv changed since the mask pinned it.")
        return real(directory, pins)

    monkeypatch.setattr(matte_tier_job, "verified_source", changed_after)
    # A different size forces a new write, so the second digest check is reached.
    small = proxy.parent / "small.mkv"
    encode_ffv1(small, [np.zeros((6, 8), dtype=np.uint8)] * 3, "gray", "gray")
    response = client.post("/mattes/monitor-tier", json=_body(project, artifact, small))
    assert response.status_code == 409
    assert (tier / TIER_FILE).read_bytes() == before
    assert list((project / TIERS / ".staging").iterdir()) == []


def test_one_at_a_time_and_a_deadline_sized_by_frames(
    setup: tuple[TestClient, Path, dict[str, Any], Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, project, artifact, proxy = setup
    entered, release = threading.Event(), threading.Event()
    real = service_module.make_monitor_tier  # type: ignore[attr-defined]

    def slow(*args: Any, **kwargs: Any) -> Any:
        entered.set()
        release.wait(10)
        return real(*args, **kwargs)

    monkeypatch.setattr(service_module, "make_monitor_tier", slow)
    first: dict[str, Any] = {}
    thread = threading.Thread(
        target=lambda: first.update(
            response=client.post("/mattes/monitor-tier", json=_body(project, artifact, proxy))
        )
    )
    thread.start()
    assert entered.wait(10)
    busy = client.post("/mattes/monitor-tier", json=_body(project, artifact, proxy))
    release.set()
    thread.join(20)
    assert busy.status_code == 503
    assert first["response"].status_code == 200

    # The budget grows with the frame count and is capped.
    assert matte_tier_deadline(5400) == pytest.approx(600 + 0.5 * 5400)
    assert matte_tier_deadline(10**7) == 6 * 60 * 60
    monkeypatch.setattr(service_module, "make_monitor_tier", real)
    monkeypatch.setattr(service_module, "matte_tier_deadline", lambda _frames: 0.0)
    (project / TIERS / artifact["key"] / TIER_FILE).unlink()
    timed_out = client.post("/mattes/monitor-tier", json=_body(project, artifact, proxy))
    assert timed_out.status_code == 504
    assert list((project / TIERS / ".staging").iterdir()) == []


@pytest.mark.parametrize(
    "linked",
    [".framepilot-derived/mattes", "masters", ".framepilot-derived/matte-tiers", "tier"],
)
def test_never_reads_or_writes_through_a_link(tmp_path: Path, linked: str) -> None:
    project, artifact, proxy = _project(tmp_path)
    key = artifact["key"]
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    if linked == ".framepilot-derived/mattes":
        real_dir = project / MATTES_DIR
        real_dir.rename(elsewhere / "mattes")
        real_dir.symlink_to(elsewhere / "mattes")
    elif linked == "masters":
        matte = project / MATTES_DIR / key / MATTE_FILE
        matte.rename(elsewhere / MATTE_FILE)
        matte.symlink_to(elsewhere / MATTE_FILE)
    elif linked == ".framepilot-derived/matte-tiers":
        (project / TIERS).symlink_to(elsewhere)
    else:
        (project / TIERS).mkdir(parents=True)
        (project / TIERS / key).symlink_to(elsewhere)
    response = client.post("/mattes/monitor-tier", json=_body(project, artifact, proxy))
    assert response.status_code == 400, response.text
    assert response.json()["detail"] == "The matte folder is not a plain folder."
    # Nothing was written or removed through the link.
    assert sorted(p.name for p in elsewhere.iterdir()) in (
        [],
        ["mattes"],
        [MATTE_FILE],
    )


def test_bounded_inputs_and_no_paths(setup: tuple[TestClient, Path, dict[str, Any], Path]) -> None:
    client, project, artifact, proxy = setup
    root = str(project.parent)
    bad: list[dict[str, Any]] = []
    changes: list[dict[str, Any]] = [
        {"width": 0},
        {"height": 99999},
        {"key": "../" + "a" * 61},
        {"files": []},
        {"files": [{"name": "x.mkv", "sha256": "0" * 64}]},
    ]
    for change in changes:
        body = _body(project, artifact, proxy)
        body["artifact"] = {**body["artifact"], **change}
        bad.append(body)
    bad.append(_body(project, artifact, proxy, rotation=45))
    bad.append({**_body(project, artifact, proxy), "extra": 1})
    for body in bad:
        response = client.post("/mattes/monitor-tier", json=body)
        assert response.status_code == 422, body
    outside = client.post("/mattes/monitor-tier", json=_body(Path("/etc"), artifact, proxy))
    assert outside.status_code == 400
    assert outside.json()["detail"] == "The file is outside the projects folder."
    missing = client.post(
        "/mattes/monitor-tier",
        json=_body(project, {**artifact, "key": "b" * 64}, proxy),
    )
    assert missing.status_code == 404
    for response in (outside, missing):
        assert root not in response.text and "/etc" not in response.text


def test_the_fuzzed_corpus_ends_typed_bounded_and_without_paths(tmp_path: Path) -> None:
    (tmp_path / "corpus").mkdir()
    corpus = media_corpus(tmp_path / "corpus")
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    for name, media in corpus.items():
        project, artifact, proxy = _project(tmp_path / name)
        directory = project / MATTES_DIR / artifact["key"]
        # The corpus file stands in for a master, pinned by its own digest, so the digest check
        # passes and the hardened decode is what meets it. And for the picture, too.
        for master in (MATTE_FILE, FOREGROUND_FILE):
            (directory / master).write_bytes(media.read_bytes())
        artifact["files"] = [
            {**entry, "sha256": sha256(directory / entry["name"])} for entry in artifact["files"]
        ]
        fuzzed_proxy = proxy.parent / f"fuzzed{media.suffix}"
        fuzzed_proxy.write_bytes(media.read_bytes())
        for picture in (proxy, fuzzed_proxy):
            started = time.monotonic()
            response = client.post("/mattes/monitor-tier", json=_body(project, artifact, picture))
            assert response.status_code in {200, 400, 404, 409, 422, 504}, (name, response.text)
            assert str(tmp_path) not in response.text, name
            assert time.monotonic() - started < CASE_SECONDS, name
        assert not list((project / TIERS / ".staging").glob("*")), name
