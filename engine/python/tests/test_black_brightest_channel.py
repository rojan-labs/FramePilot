"""Black means dark in every channel, on a real BT.709 export (#154).

Exports are BT.709 limited range since #154, and BT.709 luma weights blue at 7%: a pure-blue
end card encodes at Y=32, under plain ``blackdetect``'s luma threshold, so render QC failed a
legitimate export with "ends on black". The detector now judges max(R, G, B). These render
short clips through the export's own colour arguments and pin the verdicts on the real binary:
saturated colours are not black, real black / near-black / a fade-to-black / thin white strokes
on black keep the verdict they always had.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from framepilot_engine.analysis.black import detect_black, parse_black_ranges
from framepilot_engine.render.encoders import BT709_OUTPUT_ARGS
from framepilot_engine.validation.render_validation import (
    CheckStatus,
    ExpectedRender,
    validate_render,
)

SIZE = "320x180"
FPS = 15
LIT_SECONDS = 1.0
TAIL_SECONDS = 1.0
CLIP_SECONDS = LIT_SECONDS + TAIL_SECONDS
#: A span counts as covering the tail when it starts within this of the cut (one frame of
#: encoder/decoder slack) and reaches the end within blackdetect's final-frame undercount.
TAIL_SLACK_SECONDS = 0.15
#: A fade darkens over this long, then holds black; the black verdict starts by its last frame.
FADE_SECONDS = 0.6
#: Two 2-px white strokes across half the frame: under 1% of the pixels, like credits text.
THIN_STROKES = (
    ",drawbox=x=80:y=80:w=160:h=2:c=white:t=fill,drawbox=x=80:y=100:w=160:h=2:c=white:t=fill"
)


def _lit_then(tail_source: str) -> str:
    """A lavfi graph: ``LIT_SECONDS`` of testsrc2, then ``TAIL_SECONDS`` of ``tail_source``."""
    lit = f"testsrc2=s={SIZE}:r={FPS}:d={LIT_SECONDS}"
    return f"{lit}[lit];{tail_source}[tail];[lit][tail]concat=n=2:v=1"


def _solid(colour: str, extra: str = "") -> str:
    return _lit_then(f"color=c={colour}:s={SIZE}:r={FPS}:d={TAIL_SECONDS}{extra}")


def _export(ffmpeg_bin: str, target: Path, graph: str) -> Path:
    """Encode ``graph`` with the export's BT.709 limited-range colour arguments."""
    subprocess.run(
        [
            ffmpeg_bin,
            *("-y", "-f", "lavfi", "-i", graph, "-c:v", "libx264"),
            *BT709_OUTPUT_ARGS,
            str(target),
        ],
        check=True,
        capture_output=True,
    )
    return target


def _tail_is_black(path: Path) -> bool:
    spans = detect_black(path, min_black_seconds=0.1)
    return any(
        span.start <= LIT_SECONDS + TAIL_SLACK_SECONDS
        and span.end >= CLIP_SECONDS - TAIL_SLACK_SECONDS
        for span in spans
    )


@pytest.mark.parametrize(
    ("graph", "black"),
    [
        pytest.param(_solid("black"), True, id="real_black"),
        pytest.param(_solid("0x141414"), True, id="near_black_20"),
        pytest.param(_solid("black", THIN_STROKES), True, id="thin_white_strokes_on_black"),
        pytest.param(_solid("0x0000FF"), False, id="pure_blue"),
        pytest.param(_solid("0xFF0000"), False, id="pure_red"),
        # Value 50%: dark to the eye, but a colour, not black. Luma put it at Y=24.
        pytest.param(_solid("0x000080"), False, id="navy_0_0_128"),
    ],
)
def test_tail_verdict_follows_the_brightest_channel(
    ffmpeg_bin: str, tmp_project_dir: Path, graph: str, black: bool
) -> None:
    clip = _export(ffmpeg_bin, tmp_project_dir / "tail.mp4", graph)
    assert _tail_is_black(clip) is black


def test_fade_to_black_still_ends_black(ffmpeg_bin: str, tmp_project_dir: Path) -> None:
    fade_start = CLIP_SECONDS - TAIL_SECONDS
    graph = (
        f"testsrc2=s={SIZE}:r={FPS}:d={CLIP_SECONDS},fade=t=out:st={fade_start}:d={FADE_SECONDS}"
    )
    clip = _export(ffmpeg_bin, tmp_project_dir / "fade.mp4", graph)
    spans = detect_black(clip, min_black_seconds=0.1)
    assert spans, "a fade-to-black must still end on a black span"
    assert fade_start < spans[-1].start <= fade_start + FADE_SECONDS
    assert spans[-1].end >= CLIP_SECONDS - TAIL_SLACK_SECONDS


def test_pure_blue_fixture_really_is_dark_in_luma(ffmpeg_bin: str, tmp_project_dir: Path) -> None:
    # Precondition for the regression above: under plain (luma) blackdetect this exact
    # export IS "black". If the export chain ever lifts blue's luma, this fails and the
    # pure-blue case above stops proving anything.
    clip = _export(ffmpeg_bin, tmp_project_dir / "blue_luma.mp4", _solid("0x0000FF"))
    luma_pass = subprocess.run(
        [
            ffmpeg_bin,
            *("-hide_banner", "-nostats", "-i", str(clip)),
            *("-vf", "blackdetect=d=0.1:pic_th=0.98:pix_th=0.10", "-an", "-f", "null", "-"),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    assert parse_black_ranges(luma_pass.stderr), "BT.709 pure blue should sit under luma 10%"


@pytest.mark.usefixtures("require_ffprobe")
@pytest.mark.parametrize(
    ("colour", "expected_tail"),
    [("0x0000FF", CheckStatus.PASS), ("black", CheckStatus.FAIL)],
)
def test_render_qc_passes_a_blue_end_card_and_fails_a_black_tail(
    ffmpeg_bin: str, tmp_project_dir: Path, colour: str, expected_tail: CheckStatus
) -> None:
    clip = _export(ffmpeg_bin, tmp_project_dir / f"end_{colour}.mp4", _solid(colour))
    report = validate_render(
        clip,
        ExpectedRender(
            duration_seconds=CLIP_SECONDS, duration_tolerance_seconds=0.2, expect_audio=False
        ),
    )
    statuses = {check.name: check.status for check in report.checks}
    assert statuses["black_tail"] == expected_tail
    # Half the clip is lit either way, so the whole-render ratio never trips.
    assert statuses["black_frames"] == CheckStatus.PASS
