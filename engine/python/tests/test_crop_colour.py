"""The colour of a detection crop, measured (AM2.7): CIELAB, the region, the decode, the route."""

from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np
import numpy.typing as npt
import pytest
from fastapi.testclient import TestClient

from framepilot_engine.config import Settings
from framepilot_engine.masking import crop_colour
from framepilot_engine.masking.crop_colour import (
    MAX_CROPS,
    CropBox,
    CropColourError,
    centre_weights,
    decode_frame,
    dominant_tone,
    measure_crop,
    measure_crops,
    srgb_to_lab,
)
from framepilot_engine.media.ffmpeg import find_ffmpeg
from framepilot_engine.service import create_app

WIDTH, HEIGHT, FPS = 96, 64, 10


def _pixel(rgb: tuple[int, int, int]) -> npt.NDArray[np.uint8]:
    return np.array([[rgb]], dtype=np.uint8)


def _lab(rgb: tuple[int, int, int]) -> tuple[float, float, float]:
    lightness, a, b = srgb_to_lab(_pixel(rgb))
    return float(lightness[0, 0]), float(a[0, 0]), float(b[0, 0])


def _scene(body: tuple[int, int, int], background: tuple[int, int, int]) -> npt.NDArray[np.uint8]:
    """A flat ``body`` rectangle in the middle half of a ``background`` frame."""
    frame = np.empty((HEIGHT, WIDTH, 3), dtype=np.uint8)
    frame[:] = background
    frame[HEIGHT // 4 : 3 * HEIGHT // 4, WIDTH // 4 : 3 * WIDTH // 4] = body
    return frame


def _encode(
    path: Path, frames: list[npt.NDArray[np.uint8]], matrix: str, colour_range: str
) -> None:
    """Lossless FFV1 4:4:4 in ``matrix``/``colour_range``, tagged: the decode must read the tags."""
    tags = {"bt709": ("bt709", "bt709", "bt709"), "bt601": ("smpte170m", "smpte170m", "smpte170m")}
    colorspace, primaries, transfer = tags[matrix]
    process = subprocess.run(
        [
            find_ffmpeg(),
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-s",
            f"{WIDTH}x{HEIGHT}",
            "-r",
            str(FPS),
            "-i",
            "-",
            "-vf",
            f"scale=out_color_matrix={matrix}:out_range={colour_range},format=yuv444p",
            "-c:v",
            "ffv1",
            "-colorspace",
            colorspace,
            "-color_primaries",
            primaries,
            "-color_trc",
            transfer,
            "-color_range",
            colour_range,
            str(path),
        ],
        input=b"".join(frame.tobytes() for frame in frames),
        capture_output=True,
        check=False,
    )
    assert process.returncode == 0, process.stderr.decode()


# --- CIELAB -------------------------------------------------------------------------------


def test_srgb_to_lab_matches_the_reference_values() -> None:
    white, black, red = _lab((255, 255, 255)), _lab((0, 0, 0)), _lab((255, 0, 0))
    assert white == pytest.approx((100.0, 0.0, 0.0), abs=0.01)
    assert black == pytest.approx((0.0, 0.0, 0.0), abs=0.01)
    # CIE reference for sRGB red (D65): L* 53.24, a* 80.09, b* 67.20.
    assert red == pytest.approx((53.24, 80.09, 67.20), abs=0.05)
    # Middle grey #777777 sits at L* 50 with no chroma.
    lightness, a, b = _lab((119, 119, 119))
    assert lightness == pytest.approx(50.0, abs=0.1)
    assert abs(a) < 0.01 and abs(b) < 0.01


# --- The region -----------------------------------------------------------------------------


def test_centre_weights_ignore_the_corners_and_peak_in_the_middle() -> None:
    weights = centre_weights(40, 60)
    assert weights[0, 0] == 0 and weights[0, -1] == 0 and weights[-1, 0] == 0
    assert weights[20, 30] == pytest.approx(weights.max())
    assert weights.max() == pytest.approx(1.0, abs=0.01)


def test_a_white_object_on_green_is_measured_white_not_green() -> None:
    frame = _scene((240, 240, 238), (40, 150, 55))
    colour = measure_crop(frame, CropBox(0.0, 0.2, 0.2, 0.6, 0.6))
    assert colour is not None
    assert colour.neutral_share > 0.9
    assert colour.neutral_lightness == pytest.approx(_lab((240, 240, 238))[0], abs=0.5)


def test_a_chromatic_object_has_no_neutral_share() -> None:
    frame = _scene((35, 75, 200), (238, 238, 235))
    colour = measure_crop(frame, CropBox(0.0, 0.25, 0.25, 0.5, 0.5))
    assert colour is not None
    assert colour.neutral_share == 0.0
    assert colour.neutral_lightness is None
    assert colour.chroma > 50


def test_the_dominant_tone_ignores_glass_and_tyres() -> None:
    body = np.full(400, 92.0)
    glass = np.full(250, 70.0)
    tyres = np.full(200, 8.0)
    lightness = np.concatenate([body, glass, tyres])
    # A plain median is dragged into the glass; the densest tone is the body's.
    assert float(np.median(lightness)) == pytest.approx(70.0)
    assert dominant_tone(lightness, np.ones_like(lightness)) == pytest.approx(92.0)


def test_a_box_too_small_or_off_the_picture_is_not_measured() -> None:
    frame = _scene((240, 240, 238), (40, 150, 55))
    assert measure_crop(frame, CropBox(0.0, 0.5, 0.5, 0.01, 0.01)) is None
    assert measure_crop(frame, CropBox(0.0, 1.0, 1.0, 0.2, 0.2)) is None


# --- The decode -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("matrix", "colour_range"),
    [("bt709", "tv"), ("bt709", "pc"), ("bt601", "tv"), ("bt601", "pc")],
)
def test_the_decode_applies_the_tagged_matrix_and_range(
    tmp_path: Path, matrix: str, colour_range: str
) -> None:
    """A saturated patch comes back as the RGB that went in under every matrix and range: the
    decode reads the file's tags, as the export's does. A decoder that assumed BT.601 limited
    would land the BT.709 patch ~10 levels off."""
    patch = (200, 40, 90)
    path = tmp_path / f"{matrix}-{colour_range}.mkv"
    _encode(path, [_scene(patch, (128, 128, 128))], matrix, colour_range)
    frame = decode_frame(path, 0.0, FPS)
    assert frame.shape == (HEIGHT, WIDTH, 3)
    centre = frame[HEIGHT // 2, WIDTH // 2].astype(int)
    assert np.abs(centre - np.array(patch)).max() <= 3


def test_each_box_is_measured_on_its_own_frame(tmp_path: Path) -> None:
    path = tmp_path / "levels.mkv"
    levels = [(30, 30, 30), (128, 128, 128), (235, 235, 235)]
    _encode(path, [_scene(level, (40, 150, 55)) for level in levels], "bt709", "tv")
    box = (0.3, 0.3, 0.4, 0.4)
    measured = measure_crops(
        path, FPS, [CropBox(index / FPS, *box) for index in (2, 0, 1, 2)], deadline=None
    )
    lightness = [colour.neutral_lightness for colour in measured if colour is not None]
    expected = [_lab(levels[index])[0] for index in (2, 0, 1, 2)]
    assert lightness == pytest.approx(expected, abs=1.0)


def test_measure_crops_refuses_bad_requests(tmp_path: Path) -> None:
    path = tmp_path / "one.mkv"
    _encode(path, [_scene((128, 128, 128), (0, 0, 0))], "bt709", "tv")
    box = CropBox(0.0, 0.1, 0.1, 0.5, 0.5)
    with pytest.raises(ValueError, match="At most"):
        measure_crops(path, FPS, [box] * (MAX_CROPS + 1))
    with pytest.raises(ValueError, match="frame rate"):
        measure_crops(path, 0.0, [box])
    garbage = tmp_path / "not-video.mp4"
    garbage.write_bytes(b"not a video")
    with pytest.raises(CropColourError):
        measure_crops(garbage, FPS, [box])


def test_a_malformed_picture_is_refused() -> None:
    with pytest.raises(CropColourError, match="8-bit RGB"):
        crop_colour._parse_ppm(b"P5\n2 2\n255\n" + bytes(4))
    with pytest.raises(CropColourError, match="truncated"):
        crop_colour._parse_ppm(b"P6\n2 2\n255\n" + bytes(5))
    with pytest.raises(CropColourError, match="header"):
        crop_colour._parse_ppm(b"P6\n2")


# --- The route ----------------------------------------------------------------------------------


def _client(root: Path | None) -> TestClient:
    return TestClient(create_app(Settings(projects_root=root)))


def test_the_route_measures_crops_inside_the_projects_root(tmp_path: Path) -> None:
    media = tmp_path / "project" / "media" / "shot.mkv"
    media.parent.mkdir(parents=True)
    _encode(media, [_scene((238, 238, 235), (40, 150, 55))], "bt709", "tv")
    response = _client(tmp_path).post(
        "/masking/crop-colour",
        json={
            "input_path": str(media),
            "fps": FPS,
            "crops": [
                {"time_seconds": 0, "x": 0.2, "y": 0.2, "width": 0.6, "height": 0.6},
                {"time_seconds": 0, "x": 0.5, "y": 0.5, "width": 0.01, "height": 0.01},
            ],
        },
    )
    assert response.status_code == 200
    first, second = response.json()["crops"]
    assert first["neutral_share"] > 0.9
    assert first["neutral_lightness"] == pytest.approx(_lab((238, 238, 235))[0], abs=1.0)
    assert second is None


def test_the_route_refuses_escapes_missing_files_and_bad_bodies(tmp_path: Path) -> None:
    root = tmp_path / "projects"
    root.mkdir()
    outside = tmp_path / "elsewhere.mkv"
    _encode(outside, [_scene((128, 128, 128), (0, 0, 0))], "bt709", "tv")
    crop = {"time_seconds": 0, "x": 0.1, "y": 0.1, "width": 0.5, "height": 0.5}
    client = _client(root)
    escaped = client.post(
        "/masking/crop-colour", json={"input_path": str(outside), "fps": FPS, "crops": [crop]}
    )
    assert escaped.status_code == 400
    assert str(outside) not in escaped.text
    missing = client.post(
        "/masking/crop-colour",
        json={"input_path": str(root / "gone.mkv"), "fps": FPS, "crops": [crop]},
    )
    assert missing.status_code == 404
    garbage = root / "garbage.mp4"
    garbage.write_bytes(b"not a video")
    refused = client.post(
        "/masking/crop-colour", json={"input_path": str(garbage), "fps": FPS, "crops": [crop]}
    )
    assert refused.status_code == 422
    assert str(garbage) not in refused.text
    for body in (
        {"input_path": str(garbage), "fps": FPS, "crops": []},
        {"input_path": str(garbage), "fps": FPS, "crops": [crop] * (MAX_CROPS + 1)},
        {"input_path": str(garbage), "fps": 0, "crops": [crop]},
        {"input_path": str(garbage), "fps": FPS, "crops": [{**crop, "x": 1.5}]},
        {"input_path": str(garbage), "fps": FPS, "crops": [crop], "extra": 1},
    ):
        assert client.post("/masking/crop-colour", json=body).status_code == 422


def test_the_route_refuses_without_a_projects_root(tmp_path: Path) -> None:
    media = tmp_path / "shot.mkv"
    _encode(media, [_scene((128, 128, 128), (0, 0, 0))], "bt709", "tv")
    response = _client(None).post(
        "/masking/crop-colour",
        json={
            "input_path": str(media),
            "fps": FPS,
            "crops": [{"time_seconds": 0, "x": 0.1, "y": 0.1, "width": 0.5, "height": 0.5}],
        },
    )
    assert response.status_code == 503


def test_the_route_answers_busy_while_one_measurement_runs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import threading

    import framepilot_engine.service as service

    media = tmp_path / "shot.mkv"
    _encode(media, [_scene((128, 128, 128), (0, 0, 0))], "bt709", "tv")
    entered = threading.Event()
    release = threading.Event()

    def slow(*_args: object, **_kwargs: object) -> list[None]:
        entered.set()
        release.wait(5)
        return [None]

    monkeypatch.setattr(service, "measure_crops", slow)
    client = _client(tmp_path)
    body = {
        "input_path": str(media),
        "fps": FPS,
        "crops": [{"time_seconds": 0, "x": 0.1, "y": 0.1, "width": 0.5, "height": 0.5}],
    }
    results: list[int] = []
    worker = threading.Thread(
        target=lambda: results.append(client.post("/masking/crop-colour", json=body).status_code)
    )
    worker.start()
    assert entered.wait(5)
    assert client.post("/masking/crop-colour", json=body).status_code == 503
    release.set()
    worker.join(5)
    assert results == [200]
