"""Reference-media analysis (plan/system-mission P3.3) against generated media."""

from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from framepilot_engine.analysis.reference import (
    analysis_to_dict,
    analyze_reference_image,
    analyze_reference_video,
    color_stats_from_rgb,
    shot_statistics,
)
from framepilot_engine.media.ffmpeg import find_ffmpeg


def test_color_stats_are_deterministic_and_bounded() -> None:
    warm = np.array([[220, 120, 40]] * 50, dtype=np.uint8)
    cool = np.array([[40, 90, 220]] * 50, dtype=np.uint8)
    assert color_stats_from_rgb(warm).temperature > 0.5
    assert color_stats_from_rgb(cool).temperature < -0.5
    grey = np.array([[128, 128, 128]] * 10, dtype=np.uint8)
    stats = color_stats_from_rgb(grey)
    assert stats.saturation == 0.0 and stats.contrast == 0.0
    assert color_stats_from_rgb(np.zeros((0, 3), dtype=np.uint8)).brightness == 0.0


def test_shot_statistics_from_cuts() -> None:
    stats = shot_statistics([1.0, 2.0, 4.0, 4.5, 8.0], 10.0)
    assert stats["shotCount"] == 6
    assert stats["medianShotS"] == pytest.approx(1.5)
    assert stats["cutsPerMinute"] == pytest.approx(30.0)
    one_take = shot_statistics([], 21.6)
    assert one_take["shotCount"] == 1 and one_take["medianShotS"] == pytest.approx(21.6)


@pytest.fixture
def cut_video(tmp_path: Path) -> Path:
    """Four one-second solid-colour shots, with a 1 kHz tone: cuts at 1, 2, 3 s."""
    ffmpeg = find_ffmpeg()
    parts = []
    for i, color in enumerate(["red", "blue", "green", "yellow"]):
        part = tmp_path / f"p{i}.mp4"
        subprocess.run(
            [
                ffmpeg,
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                f"color=c={color}:s=160x90:r=25:d=1",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=1000:duration=1",
                "-shortest",
                "-pix_fmt",
                "yuv420p",
                str(part),
            ],
            check=True,
        )
        parts.append(part)
    listing = tmp_path / "list.txt"
    listing.write_text("".join(f"file '{p}'\n" for p in parts))
    out = tmp_path / "cuts.mp4"
    subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(listing),
            "-c",
            "copy",
            str(out),
        ],
        check=True,
    )
    return out


def test_analyze_reference_video_measures_shots_and_colour(cut_video: Path) -> None:
    analysis = analyze_reference_video(cut_video, timeout=60.0)
    assert analysis.duration_s == pytest.approx(4.0, abs=0.2)
    assert analysis.width == 160 and analysis.height == 90
    assert analysis.shot_count >= 3
    assert analysis.color is not None and 0.0 <= analysis.color.saturation <= 1.0
    payload = analysis_to_dict(analysis)
    assert "durationS" in payload and "shotCount" in payload
    assert "speechShare" in payload  # a tone is not silence


def test_analyze_reference_image_reports_size_alpha_palette(tmp_path: Path) -> None:
    logo = tmp_path / "logo.png"
    img = Image.new("RGBA", (300, 120), (0, 0, 0, 0))
    for x in range(40, 260):
        for y in range(30, 90):
            img.putpixel((x, y), (230, 90, 20, 255))
    img.save(logo)
    analysis = analyze_reference_image(logo)
    assert (analysis.width, analysis.height) == (300, 120)
    assert analysis.has_alpha is True
    assert analysis.dominant_colors and analysis.dominant_colors[0].startswith("#")
    assert analysis.color is not None and analysis.color.temperature > 0.3
    photo = tmp_path / "photo.jpg"
    Image.new("RGB", (640, 480), (30, 60, 200)).save(photo)
    cool = analyze_reference_image(photo)
    assert cool.has_alpha is False and cool.color is not None and cool.color.temperature < -0.3
