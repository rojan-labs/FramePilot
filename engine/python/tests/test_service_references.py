"""``POST /references/analyze`` (plan/system-mission P3.3)."""

from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

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
