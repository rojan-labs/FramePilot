"""BR3.2: frame identity, display space and engine colour, plus the LGPL-only tool gate."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from framepilot_smart_mask.backend import MediaUnreadableError, ToolUnavailableError, VideoInfo
from framepilot_smart_mask.media import (
    assess_ffmpeg_build,
    decode_argv,
    frames_document,
    parse_probe,
    seek_seconds,
    verify_tools,
)

LGPL_VERSION = (
    "ffmpeg version 7.1\nconfiguration: --enable-shared --disable-programs --enable-libvpx\n"
)
LGPL_LICENCE = (
    "ffmpeg is free software; ... GNU Lesser General Public License ... version 2.1 of the License"
)
GPL_VERSION = "ffmpeg version 8.1\nconfiguration: --enable-gpl --enable-libx264 --enable-libvpx\n"
GPL_LICENCE = "ffmpeg is free software; ... GNU General Public License as published ... version 3"


def info(**overrides: object) -> VideoInfo:
    values: dict[str, object] = {
        "width": 1920,
        "height": 1080,
        "sample_aspect": (1, 1),
        "rotation": 0,
        "time_base": (1, 12800),
        "pts": tuple(range(0, 12 * 533, 533)),
        "start_time": 0.0,
    }
    values.update(overrides)
    return VideoInfo(**values)  # type: ignore[arg-type]


def test_ffmpeg_build_gate() -> None:
    assert assess_ffmpeg_build(LGPL_VERSION, LGPL_LICENCE).approved
    assert assess_ffmpeg_build(LGPL_VERSION, LGPL_LICENCE).licence == "LGPL-2.1-or-later"
    verdict = assess_ffmpeg_build(GPL_VERSION, GPL_LICENCE)
    assert not verdict.approved
    assert "configured with --enable-gpl" in verdict.reasons
    assert "configured with --enable-libx264" in verdict.reasons
    assert not assess_ffmpeg_build("ffmpeg version x\n", LGPL_LICENCE).approved


def test_parse_probe_follows_engine_frame_identity() -> None:
    stream = json.dumps(
        {
            "streams": [
                {
                    "width": 1440,
                    "height": 1080,
                    "sample_aspect_ratio": "4:3",
                    "time_base": "1/90000",
                    "side_data_list": [{"rotation": -90}],
                }
            ],
            "format": {"start_time": "1.500000"},
        }
    ).encode()
    packets = json.dumps(
        {
            "packets": [
                {"pts": 3003, "flags": "K__"},
                {"pts": -3003, "flags": "KD_"},
                {"pts": 9009, "flags": "___"},
                {"pts": 6006, "flags": "___"},
                {"pts": "N/A", "flags": "___"},
                {"pts": 0, "flags": "K__"},
            ]
        }
    ).encode()
    parsed = parse_probe(stream, packets)
    assert parsed.pts == (0, 3003, 6006, 9009)
    assert parsed.rotation == 90
    assert parsed.sample_aspect == (4, 3)
    # 1440 x 4/3 = 1920 wide stored; a quarter turn makes it 1080 x 1920 on screen.
    assert parsed.display_size == (1080, 1920)
    with pytest.raises(MediaUnreadableError):
        parse_probe(b'{"streams": []}', packets)
    with pytest.raises(MediaUnreadableError, match="repeats"):
        parse_probe(
            stream,
            json.dumps({"packets": [{"pts": 1, "flags": ""}, {"pts": 1, "flags": ""}]}).encode(),
        )


def test_display_size_rounds_half_up() -> None:
    assert info(width=720, height=480, sample_aspect=(32, 27)).display_size == (853, 480)
    assert info(width=5, height=4, sample_aspect=(3, 2)).display_size == (8, 4)  # 7.5 -> 8


def test_frames_document_and_seek() -> None:
    clip = info(start_time=0.1, pts=(1280, 1813, 2346, 2879))
    document = frames_document(clip, 1, 2)
    assert document == {
        "version": 1,
        "timeBase": [1, 12800],
        "originPts": 1280,
        "firstFrame": 1,
        "pts": [1813, 2346],
    }
    assert seek_seconds(clip, 0) is None
    assert seek_seconds(clip, 2) == pytest.approx((1813 + 2346) / 2 / 12800 - 0.1)
    with pytest.raises(MediaUnreadableError):
        frames_document(clip, 3, 2)


def test_decode_argv_scales_only_anamorphic_sources() -> None:
    square = decode_argv("ffmpeg", "/m.mov", info(), 0, 10)
    assert "-vf" not in square and "-ss" not in square
    assert square[square.index("-fps_mode") + 1] == "passthrough"
    assert square[-4:] == ["rawvideo", "-pix_fmt", "rgb24", "-"]
    rotated = decode_argv("ffmpeg", "/m.mov", info(rotation=270), 3, 10)
    assert "-vf" not in rotated and "-ss" in rotated
    anamorphic = decode_argv("ffmpeg", "/m.mov", info(width=1440, sample_aspect=(4, 3)), 0, 10)
    assert anamorphic[anamorphic.index("-vf") + 1] == "scale=1920:1080"
    assert anamorphic[anamorphic.index("-sws_flags") + 1] == "bicubic"


def test_unapproved_tool_needs_an_explicit_dev_override(tmp_path: Path) -> None:
    fake = tmp_path / "ffmpeg"
    fake.write_text(
        f"#!/bin/sh\nif [ \"$2\" = \"-L\" ]; then printf '%s' '{GPL_LICENCE}'; else printf '%s' '{GPL_VERSION}'; fi\n"
    )
    fake.chmod(0o755)
    env = {"FRAMEPILOT_SMART_MASK_FFMPEG": str(fake), "FRAMEPILOT_SMART_MASK_FFPROBE": str(fake)}
    with pytest.raises(ToolUnavailableError, match="not an approved LGPL-only build"):
        verify_tools(env)
    _, _, report = verify_tools({**env, "FRAMEPILOT_SMART_MASK_ALLOW_UNAPPROVED_FFMPEG": "1"})
    assert not report.approved and report.licence == "GPL"


# --- real ffmpeg, tiny generated clips, no weights ----------------------------------------

FFMPEG = shutil.which("ffmpeg")
needs_ffmpeg = pytest.mark.skipif(
    FFMPEG is None or shutil.which("ffprobe") is None, reason="ffmpeg not installed"
)


def _make(tmp_path: Path, name: str, *args: str) -> Path:
    out = tmp_path / name
    subprocess.run([FFMPEG or "ffmpeg", "-v", "error", "-y", *args, str(out)], check=True)
    return out


def _tools():  # type: ignore[no-untyped-def]
    from framepilot_smart_mask.media import FfmpegTools

    ffmpeg, ffprobe, report = verify_tools({"FRAMEPILOT_SMART_MASK_ALLOW_UNAPPROVED_FFMPEG": "1"})
    return FfmpegTools(ffmpeg, ffprobe, report)


@needs_ffmpeg
def test_seeked_decode_is_bit_identical_to_a_full_decode(tmp_path: Path) -> None:
    np = pytest.importorskip("numpy")
    clip = _make(
        tmp_path,
        "cfr.mkv",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=96x54:rate=24",
        "-frames:v",
        "16",
        "-c:v",
        "ffv1",
        "-pix_fmt",
        "yuv420p",
    )
    tools = _tools()
    probed = tools.probe(str(clip))
    assert len(probed.pts) == 16
    everything = np.stack(list(tools.frames(str(clip), probed, 0, 16)))
    window = np.stack(list(tools.frames(str(clip), probed, 5, 4)))
    assert np.array_equal(window, everything[5:9])
    # The engine's MoviePy command for a square-pixel source: no scale filter, rgb24.
    engine = subprocess.run(
        [FFMPEG, "-v", "error", "-i", str(clip), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True,
        check=True,
    ).stdout
    assert np.array_equal(np.frombuffer(engine, np.uint8).reshape(16, 54, 96, 3), everything)


@needs_ffmpeg
def test_variable_frame_rate_pts_and_seek(tmp_path: Path) -> None:
    np = pytest.importorskip("numpy")
    clip = _make(
        tmp_path,
        "vfr.mkv",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=64x36:rate=25",
        "-frames:v",
        "12",
        "-vf",
        "settb=1/1000,setpts=N*40+if(gte(N\\,6)\\,17\\,0)",
        "-fps_mode",
        "passthrough",
        "-enc_time_base",
        "1/1000",
        "-c:v",
        "ffv1",
    )
    tools = _tools()
    probed = tools.probe(str(clip))
    listed = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "packet=pts",
            "-of",
            "csv=p=0",
            str(clip),
        ],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split()
    assert list(probed.pts) == sorted(int(value) for value in listed)
    steps = {b - a for a, b in zip(probed.pts, probed.pts[1:], strict=False)}
    assert len(steps) > 1, "the fixture must really be variable-rate"
    everything = np.stack(list(tools.frames(str(clip), probed, 0, 12)))
    assert np.array_equal(np.stack(list(tools.frames(str(clip), probed, 6, 3))), everything[6:9])
    document = frames_document(probed, 6, 3)
    assert document["pts"] == list(probed.pts[6:9])


@needs_ffmpeg
def test_anamorphic_and_rotated_sources_decode_in_display_space(tmp_path: Path) -> None:
    pytest.importorskip("numpy")
    anamorphic = _make(
        tmp_path,
        "sar.mkv",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=64x36:rate=24",
        "-frames:v",
        "3",
        "-vf",
        "setsar=2",
        "-c:v",
        "ffv1",
    )
    tools = _tools()
    probed = tools.probe(str(anamorphic))
    assert probed.display_size == (128, 36)
    assert next(iter(tools.frames(str(anamorphic), probed, 0, 1))).shape == (36, 128, 3)
    base = _make(
        tmp_path,
        "base.mp4",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=64x36:rate=24",
        "-frames:v",
        "3",
        "-c:v",
        "mpeg4",
        "-q:v",
        "2",
    )
    rotated = tmp_path / "rotated.mp4"
    subprocess.run(
        [
            FFMPEG,
            "-v",
            "error",
            "-y",
            "-display_rotation",
            "90",
            "-i",
            str(base),
            "-c",
            "copy",
            str(rotated),
        ],
        check=True,
    )
    probed = tools.probe(str(rotated))
    assert probed.rotation in (90, 270)
    assert probed.display_size == (36, 64)
    assert next(iter(tools.frames(str(rotated), probed, 0, 1))).shape == (64, 36, 3)
