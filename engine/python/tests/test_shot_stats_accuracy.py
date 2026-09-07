"""Does the 160 px analysis frame tell the truth? (ADR 0175, VU1.6)

Tier 0 downscales before it measures, and that downscale is what makes a ten-hour library
affordable. It is also the one place tier 0 could be quietly wrong everywhere at once, so
the claim is CHECKED rather than asserted: the same statistics are read from the same
frames at full resolution and at 160 px, and the two must agree.

This is the machine-checkable half of the labelled fixture set (VU0.2) — it needs no human
eye, because it compares a measurement against a better measurement of the same thing.

The media is not committed (``tests/fixtures/mission`` is fetched by hand), so every test
here skips when it is absent rather than failing. A skip in CI is honest; a green run that
silently measured nothing would not be.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

from framepilot_engine.analysis.shot_stats import measure_asset, parse_tier0_logs
from framepilot_engine.media.ffmpeg import find_ffmpeg

_REPO_ROOT = Path(__file__).resolve().parents[3]
_MISSION = _REPO_ROOT / "tests" / "fixtures" / "mission"

#: A locked-off interview, a fast-cut vertical, and a grayscale still — between them they
#: cover the three ways tier 0 can be wrong: motion, colour, and neutrality.
_TALK = _MISSION / "talk-1080p-98s.mp4"
_VERTICAL = _MISSION / "vertical-30s.mp4"
_NEUTRAL_STILL = _MISSION / "ref" / "mood.png"

_AVG_RE = re.compile(r"lavfi\.signalstats\.(?P<key>YAVG|UAVG|VAVG)=(?P<value>[\d.]+)")

requires_media = pytest.mark.skipif(
    not _TALK.is_file(), reason="mission fixture media not fetched (see fetch-fixtures.sh)"
)


def _signalstats(path: Path, *, seconds: float, scale: str | None) -> list[dict[str, float]]:
    """Read raw per-frame signalstats at 1 fps, with or without the analysis downscale."""
    chain = ["fps=1"]
    if scale is not None:
        chain.append(scale)
    chain += ["signalstats", "metadata=mode=print"]
    # A still has no duration of its own, so `-t` alone reads zero frames from it; `-loop 1`
    # is what turns a PNG into a stream the filters can sample.
    loop = ["-loop", "1"] if path.suffix.lower() in {".png", ".jpg", ".jpeg"} else []
    proc = subprocess.run(
        [
            find_ffmpeg(),
            "-hide_banner",
            "-nostats",
            *loop,
            "-t",
            str(seconds),
            "-i",
            str(path),
            "-an",
            "-vf",
            ",".join(chain),
            "-f",
            "null",
            "-",
        ],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    out: list[dict[str, float]] = []
    current: dict[str, float] = {}
    for line in proc.stderr.splitlines():
        if "frame:" in line and current:
            out.append(current)
            current = {}
        match = _AVG_RE.search(line)
        if match:
            current[match.group("key")] = float(match.group("value"))
    if current:
        out.append(current)
    return out


@requires_media
@pytest.mark.parametrize("media", [_TALK, _VERTICAL], ids=["talk", "vertical"])
def test_downscale_preserves_the_statistics(media: Path) -> None:
    """The whole cost argument rests on this: 160 px must measure what full res measures.

    Tolerance is one 8-bit level out of 255 — far tighter than any threshold tier 0 uses to
    decide "dim" or "warm", so a change that breaks the claim breaks this first.
    """
    full = _signalstats(media, seconds=6.0, scale=None)
    small = _signalstats(media, seconds=6.0, scale="scale=160:-2")
    assert len(full) == len(small) and full, "the two passes must sample the same frames"
    for index, (a, b) in enumerate(zip(full, small, strict=True)):
        for key in ("YAVG", "UAVG", "VAVG"):
            assert b[key] == pytest.approx(a[key], abs=1.0), (
                f"{media.name} frame {index} {key}: full-res {a[key]}, 160px {b[key]}"
            )


@requires_media
def test_a_grayscale_still_reads_exactly_neutral() -> None:
    """The zero point of the warmth scale, checked against an image that has no colour.

    If this drifts, every colour match drifts with it and nothing else in the suite notices.
    """
    stats = _signalstats(_NEUTRAL_STILL, seconds=1.0, scale="scale=160:-2")
    assert stats, "the still produced no frames"
    assert stats[0]["UAVG"] == pytest.approx(128.0, abs=0.5)
    assert stats[0]["VAVG"] == pytest.approx(128.0, abs=0.5)


@requires_media
def test_a_locked_off_interview_reads_static_and_neutral() -> None:
    """One real end-to-end pass, judged the way an editor would judge it.

    `talk-1080p-98s.mp4` is a single continuous static talking head. Tier 0 must say so:
    no scene cuts (only duration splits), static motion, and no colour cast.
    """
    shots = measure_asset(_TALK, duration=98.0)
    assert shots, "no shots measured"
    assert all(s.split_of or s.shot_index == 0 for s in shots), (
        "a continuous take must produce duration splits, not scene cuts"
    )
    assert all(s.motion_class in {"static", "slow"} for s in shots)
    assert all(abs(s.warmth) < 0.15 for s in shots), "a neutral interview must not read graded"
    assert all(0.15 < s.luma_mean < 0.85 for s in shots), "a normally exposed shot"


@requires_media
def test_a_fast_cut_vertical_reads_as_many_shots_with_movement() -> None:
    """The opposite case, so the thresholds cannot pass by calling everything static."""
    shots = measure_asset(_VERTICAL, duration=30.0)
    assert len(shots) > 10, "a fast-cut edit must produce many shots"
    assert any(s.motion_class in {"handheld", "fast"} for s in shots)
    # The clip opens strongly blue-graded (UAVG 162, VAVG 86 at full res) and settles to
    # neutral after about seven seconds. Both halves matter: the scale must register the
    # cast, and it must not smear it across the shots that do not have it — a warmth
    # reading that cannot separate these two sections cannot drive a colour match either.
    warmth = [s.warmth for s in shots]
    assert min(warmth) < -0.4, "the graded opening must read cool"
    assert max(warmth) > -0.2, "the neutral remainder must not read cool"
    # And nothing may pin: a saturated scale cannot tell two cool shots apart.
    assert all(-0.95 < w < 0.95 for w in warmth)


@requires_media
def test_one_pass_reads_both_chains_on_real_media() -> None:
    """The named-metadata trick is load-bearing; prove it against ffmpeg, not a fixture."""
    from framepilot_engine.analysis.shot_stats import tier0_argv

    proc = subprocess.run(
        [*tier0_argv(find_ffmpeg(), _VERTICAL)],
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    samples = parse_tier0_logs(proc.stderr)
    assert samples.frames, "the statistics chain produced nothing"
    assert samples.motion, "the motion chain produced nothing"
    assert samples.cuts, "a fast-cut clip must produce cuts"


@requires_media
def test_every_photo_fixture_measures() -> None:
    """All 60 photo fixtures failed tier 0 until stills got their own command.

    A whole-directory sweep rather than one sample: the failure was uniform, so a single
    photo passing would have hidden it exactly as well as none passing.
    """
    photos = sorted((_MISSION / "photos").glob("*.jpg"))
    if not photos:
        pytest.skip("photo fixtures not fetched")
    failed: list[str] = []
    for photo in photos:
        try:
            shots = measure_asset(photo, duration=0.04, is_image=True)
        except Exception as exc:
            failed.append(f"{photo.name}: {type(exc).__name__}")
            continue
        if len(shots) != 1:
            failed.append(f"{photo.name}: {len(shots)} shots, expected 1")
    assert not failed, f"{len(failed)}/{len(photos)} photo fixtures unmeasured: {failed[:5]}"
