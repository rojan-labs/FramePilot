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


def _projects_and_outside(tmp_path: Path) -> tuple[Path, Path]:
    """A projects root and a sibling directory the engine must never write into."""
    projects = tmp_path / "projects"
    outside = tmp_path / "outside"
    projects.mkdir()
    outside.mkdir()
    return projects, outside


def test_a_symlinked_cache_file_is_never_written_through(tmp_path: Path) -> None:
    """The cache sits beside user media, in a folder the user (or a shared zip, or a git
    clone) controls. A ``<ref>.reference.json`` planted there as a symlink to a file
    outside the projects root must not turn the analysis into a write to that file:
    the sandbox proved the MEDIA path is inside the root, not whatever its sibling
    link points at."""
    projects, outside = _projects_and_outside(tmp_path)
    logo = _logo(projects)
    victim = outside / "victim.txt"
    victim.write_text("keep", encoding="utf-8")
    cache = logo.with_name("logo.png.reference.json")
    cache.symlink_to(victim)
    client = TestClient(create_app(Settings(projects_root=projects)))

    response = client.post("/references/analyze", json={"input_path": str(logo)})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["kind"] == "image" and body["cached"] is False
    assert body["image"]["width"] == 200
    assert victim.read_text(encoding="utf-8") == "keep"
    # The planted link is replaced by a real cache file, so the next attach is a hit.
    assert not cache.is_symlink()
    assert json.loads(cache.read_text(encoding="utf-8"))["contentHash"] == body["contentHash"]


def test_a_dangling_cache_symlink_does_not_create_its_target(tmp_path: Path) -> None:
    """A dangling link is worse than a live one: writing through it CREATES a file
    wherever it points, outside the projects root."""
    projects, outside = _projects_and_outside(tmp_path)
    logo = _logo(projects)
    target = outside / "created-by-the-engine.txt"
    logo.with_name("logo.png.reference.json").symlink_to(target)
    client = TestClient(create_app(Settings(projects_root=projects)))

    response = client.post("/references/analyze", json={"input_path": str(logo)})

    assert response.status_code == 200, response.text
    assert not target.exists()
    assert not target.is_symlink()


def test_a_symlinked_cache_file_is_never_read(tmp_path: Path) -> None:
    """The read side of the same link: a forged cache outside the root, carrying the
    reference's real content hash, must not be served as the measurement."""
    projects, outside = _projects_and_outside(tmp_path)
    logo = _logo(projects)
    client = TestClient(create_app(Settings(projects_root=projects)))
    real = client.post("/references/analyze", json={"input_path": str(logo)}).json()
    forged = outside / "forged.reference.json"
    forged.write_text(
        json.dumps({**real, "image": {**real["image"], "width": 9999}}), encoding="utf-8"
    )
    cache = logo.with_name("logo.png.reference.json")
    cache.unlink()
    cache.symlink_to(forged)

    response = client.post("/references/analyze", json={"input_path": str(logo)})

    assert response.status_code == 200, response.text
    assert response.json()["cached"] is False
    assert response.json()["image"]["width"] == 200


def test_a_cache_that_cannot_be_swapped_in_leaves_no_temp_file_behind(tmp_path: Path) -> None:
    """The cache is written to a sibling temp file and swapped into place. When the swap
    fails (here the cache name is taken by a directory) the answer still stands, and the
    half-finished temp file must not litter the user's media folder."""
    logo = _logo(tmp_path)
    logo.with_name("logo.png.reference.json").mkdir()
    client = TestClient(create_app(Settings(projects_root=tmp_path)))

    response = client.post("/references/analyze", json={"input_path": str(logo)})

    assert response.status_code == 200, response.text
    assert response.json()["cached"] is False
    assert sorted(entry.name for entry in logo.parent.iterdir()) == [
        "logo.png",
        "logo.png.reference.json",
    ]


def _decode(body: dict[str, object]) -> Image.Image:
    import base64
    import io

    return Image.open(io.BytesIO(base64.b64decode(str(body["base64"]))))


def test_still_keeps_a_logos_transparency_as_png(tmp_path: Path) -> None:
    """A logo on a transparent background must not reach the model flattened."""
    logo = _logo(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    response = client.post("/references/still", json={"input_path": str(logo)})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["media_type"] == "image/png"
    assert (body["width"], body["height"]) == (200, 80)
    decoded = _decode(body)
    assert decoded.mode == "RGBA"
    assert decoded.getpixel((0, 0)) == (0, 0, 0, 0)
    assert decoded.getpixel((100, 40)) == (200, 40, 40, 255)


def test_still_downscales_a_large_photo_to_jpeg_within_the_bound(tmp_path: Path) -> None:
    photo = tmp_path / "media" / "p" / "photo.jpg"
    photo.parent.mkdir(parents=True)
    Image.new("RGB", (4000, 2000), (10, 120, 200)).save(photo)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    body = client.post("/references/still", json={"input_path": str(photo)}).json()
    assert body["media_type"] == "image/jpeg"
    assert (body["width"], body["height"]) == (1024, 512)
    assert _decode(body).size == (1024, 512)

    capped = client.post(
        "/references/still", json={"input_path": str(photo), "max_dimension": 99999}
    ).json()
    assert max(capped["width"], capped["height"]) == 1280


def test_still_applies_exif_orientation(tmp_path: Path) -> None:
    """A phone photo stored sideways must be shown upright."""
    photo = tmp_path / "media" / "p" / "portrait.jpg"
    photo.parent.mkdir(parents=True)
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90° clockwise to display
    Image.new("RGB", (300, 100), (0, 0, 0)).save(photo, exif=exif)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    body = client.post("/references/still", json={"input_path": str(photo)}).json()
    assert (body["width"], body["height"]) == (100, 300)


def test_still_refuses_outside_the_sandbox_missing_files_and_non_images(tmp_path: Path) -> None:
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    outside = client.post("/references/still", json={"input_path": "/etc/hosts"})
    assert outside.status_code in {400, 403, 422}
    missing = client.post("/references/still", json={"input_path": str(tmp_path / "nope.png")})
    assert missing.status_code == 404
    clip = tmp_path / "media" / "p" / "clip.mp4"
    clip.parent.mkdir(parents=True)
    clip.write_bytes(b"not really a video")
    not_image = client.post("/references/still", json={"input_path": str(clip)})
    assert not_image.status_code == 422
    assert "not an image" in not_image.json()["detail"]
    corrupt = tmp_path / "media" / "p" / "broken.png"
    corrupt.write_bytes(b"\x89PNG not really")
    unreadable = client.post("/references/still", json={"input_path": str(corrupt)})
    assert unreadable.status_code == 422


def test_still_sends_an_opaque_rgba_screenshot_as_jpeg(tmp_path: Path) -> None:
    """An alpha CHANNEL is not transparency: a fully opaque RGBA screenshot is a photo."""
    shot = tmp_path / "media" / "p" / "screenshot.png"
    shot.parent.mkdir(parents=True)
    Image.new("RGBA", (300, 200), (30, 60, 90, 255)).save(shot)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    body = client.post("/references/still", json={"input_path": str(shot)}).json()
    assert body["media_type"] == "image/jpeg"
    assert _decode(body).mode == "RGB"
