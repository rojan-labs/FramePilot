"""Exports are BT.709 limited range and say so in the stream (#154).

libswscale's default RGB -> YUV matrix is BT.601 and an untagged file leaves the player to guess,
so an export used to read red as Y/U/V 81/90/240 where a BT.709 player expects 63/102/240. These
pin the encode itself: a PNG source reaches the encoder as exact RGB (no YUV decode in between),
so the planes signalstats reads are the encoder's arithmetic alone, and must be BT.709's.
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from framepilot_engine.media.ffmpeg import find_ffmpeg, find_ffprobe
from framepilot_engine.render.encoders import BT709_OUTPUT_ARGS, choose_encoder
from framepilot_engine.render.pipeline import RenderState, export_video
from framepilot_engine.timeline.models import Project

WIDTH, HEIGHT = 320, 240
#: Horizontal bands, one known colour each; 80 rows keeps every 4:2:0 chroma row inside a band.
BANDS: tuple[tuple[int, int, int], ...] = ((255, 0, 0), (0, 0, 255), (128, 128, 128))
BAND_ROWS = HEIGHT // len(BANDS)
#: Codes. The encode of an exact RGB input is exact up to rounding; BT.601 misses red's luma
#: by 18 codes and blue's V by 8, so this cannot pass on the old matrix.
PLANE_TOLERANCE = 1.0
#: 8-bit levels after MoviePy's decode (the bundled ffmpeg's C tables round red to 253).
RGB_TOLERANCE = 4.0

BT709_KR, BT709_KB = 0.2126, 0.0722


def _bt709_limited(rgb: tuple[int, int, int]) -> tuple[float, float, float]:
    """The Y/U/V codes BT.709 limited range writes for 8-bit ``rgb``."""
    red, green, blue = (channel / 255.0 for channel in rgb)
    luma = BT709_KR * red + (1 - BT709_KR - BT709_KB) * green + BT709_KB * blue
    cb = (blue - luma) / (2 * (1 - BT709_KB))
    cr = (red - luma) / (2 * (1 - BT709_KR))
    return 16 + 219 * luma, 128 + 224 * cb, 128 + 224 * cr


def _project() -> Project:
    return Project.model_validate(
        {
            "id": "colour154",
            "name": "colour154",
            "fps": 30,
            "resolution": {"width": WIDTH, "height": HEIGHT},
            "assets": [
                {
                    "id": "bands",
                    "path": "bands.png",
                    "kind": "image",
                    "media": {"width": WIDTH, "height": HEIGHT},
                }
            ],
            "timeline": {
                "tracks": [
                    {
                        "id": "v",
                        "type": "video",
                        "clips": [
                            {
                                "id": "c",
                                "assetId": "bands",
                                "trackId": "v",
                                "start": 0.0,
                                "end": 1.0,
                                "sourceStart": 0.0,
                                "sourceEnd": 1.0,
                            }
                        ],
                    }
                ]
            },
        }
    )


def _plane_means(path: Path, band: int) -> tuple[float, float, float]:
    """signalstats' Y/U/V means over the interior of ``band`` in the first frame (raw codes)."""
    margin = 16
    top = band * BAND_ROWS + margin
    crop = f"crop={WIDTH - 2 * margin}:{BAND_ROWS - 2 * margin}:{margin}:{top}"
    completed = subprocess.run(
        [
            find_ffmpeg(),
            "-hide_banner",
            "-i",
            str(path),
            "-frames:v",
            "1",
            "-vf",
            f"{crop},signalstats,metadata=mode=print",
            "-f",
            "null",
            "-",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    values = dict(re.findall(r"lavfi\.signalstats\.(YAVG|UAVG|VAVG)=([0-9.]+)", completed.stderr))
    return float(values["YAVG"]), float(values["UAVG"]), float(values["VAVG"])


@pytest.fixture(scope="module")
def exported(tmp_path_factory: pytest.TempPathFactory) -> Path:
    root = tmp_path_factory.mktemp("colour154")
    pixels = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
    for index, colour in enumerate(BANDS):
        pixels[index * BAND_ROWS : (index + 1) * BAND_ROWS] = colour
    Image.fromarray(pixels, "RGB").save(root / "bands.png")
    job = export_video(_project(), base_dir=root, output_path="out/bands.mp4")
    assert job.state is RenderState.COMPLETED, (job.error, job.error_detail)
    assert job.output_path is not None
    return Path(job.output_path)


def test_every_encoder_converts_and_tags_bt709() -> None:
    names = {"libx264", "h264_videotoolbox", "libx265", "hevc_videotoolbox"}
    for codec in ("h264", "hevc"):
        for hardware in (True, False):
            choice = choose_encoder(codec, available=names, allow_hardware=hardware)
            assert list(BT709_OUTPUT_ARGS) == choice.ffmpeg_params[: len(BT709_OUTPUT_ARGS)]


@pytest.mark.usefixtures("require_ffprobe")
def test_the_export_is_tagged_bt709_limited(exported: Path) -> None:
    probe = subprocess.run(
        [
            find_ffprobe(),
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=pix_fmt,color_range,color_space,color_primaries,color_transfer",
            "-of",
            "json",
            str(exported),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    stream = json.loads(probe.stdout)["streams"][0]
    assert stream == {
        "pix_fmt": "yuv420p",
        "color_range": "tv",
        "color_space": "bt709",
        "color_transfer": "bt709",
        "color_primaries": "bt709",
    }


@pytest.mark.usefixtures("require_ffprobe")
@pytest.mark.parametrize("band", range(len(BANDS)))
def test_known_colours_are_written_through_the_bt709_matrix(exported: Path, band: int) -> None:
    measured = _plane_means(exported, band)
    expected = _bt709_limited(BANDS[band])
    assert all(abs(m - e) <= PLANE_TOLERANCE for m, e in zip(measured, expected, strict=True)), (
        BANDS[band],
        measured,
        expected,
    )


@pytest.mark.usefixtures("require_ffprobe")
def test_known_colours_round_trip_through_a_tag_honouring_decode(exported: Path) -> None:
    from moviepy import VideoFileClip

    with VideoFileClip(str(exported)) as clip:
        frame = np.asarray(clip.get_frame(0.5), dtype=np.float64)
    for index, colour in enumerate(BANDS):
        middle = frame[index * BAND_ROWS + BAND_ROWS // 2, WIDTH // 2]
        assert np.abs(middle - np.asarray(colour)).max() <= RGB_TOLERANCE, (colour, middle)
