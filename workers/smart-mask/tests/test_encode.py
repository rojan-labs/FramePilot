"""BR3.9: FFV1 masters are lossless, previews have one packet per frame, segments join exactly."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

np = pytest.importorskip("numpy")

from framepilot_smart_mask.encode import (  # noqa: E402
    concat_segments,
    decode_gray_frames,
    encode_argv,
    encode_stream,
    packet_count,
    preview_size,
)
from framepilot_smart_mask.protocol import ProtocolError  # noqa: E402

FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")
needs_ffmpeg = pytest.mark.skipif(FFMPEG is None or FFPROBE is None, reason="ffmpeg not installed")


def test_preview_size_is_even_and_never_upscaled() -> None:
    assert preview_size(1920, 1080, 360) == (640, 360)
    assert preview_size(853, 480, 1080) == (852, 480)
    assert preview_size(64, 36, 180) == (64, 36)
    assert preview_size(1080, 1920, 361) == (202, 360)


def test_encode_argv_formats() -> None:
    matte = encode_argv("ffmpeg", "m.mkv", "matte", 64, 36, 360)
    assert matte[matte.index("-c:v") + 1] == "ffv1" and matte[-3:] == ["-f", "matroska", "m.mkv"]
    assert "gray" in matte
    foreground = encode_argv("ffmpeg", "f.mkv", "foreground", 64, 36, 360)
    assert foreground[foreground.index("-pix_fmt", foreground.index("-c:v")) + 1] == "bgr0"
    preview = encode_argv("ffmpeg", "p.webm", "preview", 1920, 1080, 360)
    assert "scale=640:360:flags=area" in preview and "libvpx-vp9" in preview
    with pytest.raises(ProtocolError):
        encode_argv("ffmpeg", "x", "gif", 1, 1, 1)


def mattes(count: int, height: int = 36, width: int = 64) -> list[np.ndarray]:
    rng = np.random.default_rng(3)
    return [rng.integers(0, 256, (height, width), dtype=np.uint8) for _ in range(count)]


@needs_ffmpeg
def test_ffv1_matte_and_foreground_round_trip_bit_exact(tmp_path: Path) -> None:
    frames = mattes(7)
    matte = tmp_path / "matte.mkv"
    assert (
        encode_stream(FFMPEG, str(matte), "matte", 64, 36, (f.tobytes() for f in frames), 360) == 7
    )
    assert packet_count(FFPROBE, str(matte)) == 7
    decoded = list(decode_gray_frames(FFMPEG, str(matte), 64, 36))
    assert len(decoded) == 7 and all(
        np.array_equal(a, b) for a, b in zip(decoded, frames, strict=True)
    )
    rgb = [np.stack([f, f[::-1], 255 - f], axis=-1) for f in frames]
    foreground = tmp_path / "foreground.mkv"
    encode_stream(FFMPEG, str(foreground), "foreground", 64, 36, (f.tobytes() for f in rgb), 360)
    import subprocess

    raw = subprocess.run(
        [FFMPEG, "-v", "error", "-i", str(foreground), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True,
        check=True,
    ).stdout
    assert np.array_equal(np.frombuffer(raw, np.uint8).reshape(7, 36, 64, 3), np.stack(rgb))
    probe = subprocess.run(
        [
            FFPROBE,
            "-v",
            "error",
            "-show_entries",
            "stream=pix_fmt",
            "-of",
            "csv=p=0",
            str(foreground),
        ],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert probe == "bgr0"


@needs_ffmpeg
def test_previews_have_one_packet_per_frame(tmp_path: Path) -> None:
    frames = mattes(25, 72, 128)
    preview = tmp_path / "preview.webm"
    encode_stream(FFMPEG, str(preview), "preview", 128, 72, (f.tobytes() for f in frames), 180)
    assert packet_count(FFPROBE, str(preview)) == 25


@needs_ffmpeg
def test_segments_concatenate_exactly(tmp_path: Path) -> None:
    frames = mattes(10)
    segments = []
    for index, chunk in enumerate((frames[:4], frames[4:9], frames[9:])):
        path = tmp_path / f"segment-{index}.mkv"
        encode_stream(FFMPEG, str(path), "matte", 64, 36, (f.tobytes() for f in chunk), 360)
        segments.append(str(path))
    joined = tmp_path / "matte.mkv"
    concat_segments(FFMPEG, str(joined), segments, tmp_path)
    assert packet_count(FFPROBE, str(joined)) == 10
    decoded = list(decode_gray_frames(FFMPEG, str(joined), 64, 36))
    assert all(np.array_equal(a, b) for a, b in zip(decoded, frames, strict=True))
    previews = []
    for index, chunk in enumerate((frames[:5], frames[5:])):
        path = tmp_path / f"preview-{index}.webm"
        encode_stream(FFMPEG, str(path), "preview", 64, 36, (f.tobytes() for f in chunk), 180)
        previews.append(str(path))
    joined_preview = tmp_path / "preview.webm"
    concat_segments(FFMPEG, str(joined_preview), previews, tmp_path)
    assert packet_count(FFPROBE, str(joined_preview)) == 10
    assert sorted(p.name for p in tmp_path.iterdir() if p.suffix == ".txt") == []


@needs_ffmpeg
def test_unwritable_destination_is_output_unwritable(tmp_path: Path) -> None:
    locked = tmp_path / "locked"
    locked.mkdir()
    locked.chmod(0o500)
    try:
        with pytest.raises(ProtocolError) as caught:
            encode_stream(
                FFMPEG, str(locked / "matte.mkv"), "matte", 64, 36, iter([bytes(64 * 36)]), 360
            )
        assert caught.value.code == "output_unwritable"
    finally:
        locked.chmod(0o700)
