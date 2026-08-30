"""``POST /references/analyze`` (plan/system-mission P3.3)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from framepilot_engine import service as service_module
from framepilot_engine.config import Settings
from framepilot_engine.service import create_app


def _logo(directory: Path) -> Path:
    path = directory / "media" / "p" / "logo.png"
    path.parent.mkdir(parents=True)
    img = Image.new("RGBA", (200, 80), (0, 0, 0, 0))
    for x in range(20, 180):
        for y in range(20, 60):
            img.putpixel((x, y), (200, 40, 40, 255))
    img.save(path)
    return path


def test_analyzes_an_image_once_and_serves_the_cache_after(tmp_path: Path) -> None:
    logo = _logo(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    first = client.post("/references/analyze", json={"input_path": str(logo)})
    assert first.status_code == 200, first.text
    body = first.json()
    assert body["kind"] == "image" and body["cached"] is False
    assert body["image"]["width"] == 200 and body["image"]["hasAlpha"] is True
    assert len(body["contentHash"]) == 64
    cache = logo.with_name("logo.png.reference.json")
    assert cache.is_file() and json.loads(cache.read_text())["contentHash"] == body["contentHash"]

    second = client.post("/references/analyze", json={"input_path": str(logo)})
    assert second.status_code == 200 and second.json()["cached"] is True

    refreshed = client.post("/references/analyze", json={"input_path": str(logo), "refresh": True})
    assert refreshed.json()["cached"] is False


def test_refuses_paths_outside_the_sandbox_and_missing_files(tmp_path: Path) -> None:
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    outside = client.post("/references/analyze", json={"input_path": "/etc/hosts"})
    assert outside.status_code in {400, 403, 422}
    missing = client.post("/references/analyze", json={"input_path": str(tmp_path / "nope.png")})
    assert missing.status_code == 404


def test_the_second_attach_does_no_analysis_work_at_all(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """P3.3's done-when: attaching the same file twice ANALYZES once.

    ``cached: true`` on the second answer is not that claim — a flag can be right while
    the work is done twice, and the whole point of the content-hash cache is that the
    second attach costs nothing. So this counts calls into the analyzer itself: the
    second request must not reach it, and ``refresh`` (the sidebar's Re-analyze) must.
    """
    logo = _logo(tmp_path)
    calls: list[Path] = []
    real = service_module.analyze_reference_image

    def counting(path: Path, **kwargs: object) -> object:
        calls.append(path)
        return real(path, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(service_module, "analyze_reference_image", counting)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))

    first = client.post("/references/analyze", json={"input_path": str(logo)})
    assert first.status_code == 200 and first.json()["cached"] is False
    assert len(calls) == 1

    second = client.post("/references/analyze", json={"input_path": str(logo)})
    assert second.json()["cached"] is True
    assert len(calls) == 1, "the cached answer re-ran the analysis"
    # The cached payload is the same measurement, not a stub of one.
    assert second.json()["image"] == first.json()["image"]

    client.post("/references/analyze", json={"input_path": str(logo), "refresh": True})
    assert len(calls) == 2


def test_a_changed_file_at_the_same_path_is_measured_again(tmp_path: Path) -> None:
    """The cache is keyed by CONTENT, not by path.

    An editor who re-exports their reference over the same filename must get the new
    measurement; a cache that keyed on the path would hand back the old one forever.
    """
    logo = _logo(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    first = client.post("/references/analyze", json={"input_path": str(logo)}).json()

    Image.new("RGBA", (64, 64), (10, 200, 10, 255)).save(logo)
    second = client.post("/references/analyze", json={"input_path": str(logo)}).json()

    assert second["cached"] is False
    assert second["contentHash"] != first["contentHash"]
    assert second["image"]["width"] == 64
