"""Tier-0 shot statistics: the parser and the fold, without ffmpeg (ADR 0175, VU1.1).

Both halves are pure by construction, so everything here runs on captured log text and
plain data. The one test that needs a real decode lives in
``test_shot_stats_accuracy.py`` and is marked, because it reads fixture media.

The log samples below are REAL ffmpeg 8.1 output, trimmed. Writing them by hand would
test the parser against an idea of ffmpeg rather than against ffmpeg.
"""

from __future__ import annotations

import pytest

from framepilot_engine.analysis.shot_stats import (
    BLUR_FULL,
    SHOT_SPLIT_SECONDS,
    STATS_FPS,
    FrameSample,
    MotionSample,
    Tier0Samples,
    fold_shots,
    measure_asset,
    motion_class_for,
    parse_tier0_logs,
    shot_boundaries,
    still_argv,
    tier0_argv,
)

# Two statistics frames and two motion frames, interleaved exactly as the two chains do.
REAL_LOGS = """
[metadata@st @ 0x82100a7c0] frame:0    pts:0       pts_time:0
[metadata@st @ 0x82100a7c0] lavfi.signalstats.YMIN=6
[metadata@st @ 0x82100a7c0] lavfi.signalstats.YLOW=17
[metadata@st @ 0x82100a7c0] lavfi.signalstats.YAVG=76.0338
[metadata@st @ 0x82100a7c0] lavfi.signalstats.YHIGH=170
[metadata@st @ 0x82100a7c0] lavfi.signalstats.UAVG=163.078
[metadata@st @ 0x82100a7c0] lavfi.signalstats.VAVG=84.5482
[metadata@st @ 0x82100a7c0] lavfi.signalstats.SATAVG=59.6734
[metadata@st @ 0x82100a7c0] lavfi.blur=4.268779
[metadata@scd @ 0x82100a7c1] frame:0    pts:0       pts_time:0
[metadata@scd @ 0x82100a7c1] lavfi.scd.mafd=0.000
[metadata@scd @ 0x82100a7c1] lavfi.scd.score=0.000
[metadata@scd @ 0x82100a7c1] lavfi.siti.si=90.98
[metadata@scd @ 0x82100a7c1] lavfi.siti.ti=0.00
[metadata@scd @ 0x82100a7c1] frame:15   pts:7680    pts_time:0.5
[metadata@scd @ 0x82100a7c1] lavfi.scd.mafd=20.488
[metadata@scd @ 0x82100a7c1] lavfi.scd.score=20.488
[metadata@scd @ 0x82100a7c1] lavfi.scd.time=0.5
[metadata@scd @ 0x82100a7c1] lavfi.siti.si=88.10
[metadata@scd @ 0x82100a7c1] lavfi.siti.ti=41.20
[metadata@st @ 0x82100a7c0] frame:1    pts:1       pts_time:0.5
[metadata@st @ 0x82100a7c0] lavfi.signalstats.YLOW=24
[metadata@st @ 0x82100a7c0] lavfi.signalstats.YAVG=104.679
[metadata@st @ 0x82100a7c0] lavfi.signalstats.YHIGH=190
[metadata@st @ 0x82100a7c0] lavfi.signalstats.UAVG=128.0
[metadata@st @ 0x82100a7c0] lavfi.signalstats.VAVG=128.0
[metadata@st @ 0x82100a7c0] lavfi.signalstats.SATAVG=10.0
[metadata@st @ 0x82100a7c0] lavfi.blur=8.0
"""

BLACK_LOGS = """
[metadata@scd @ 0x845018d80] frame:0    pts:0       pts_time:0
[metadata@scd @ 0x845018d80] lavfi.black_start=0
[metadata@scd @ 0x845018d80] lavfi.freezedetect.freeze_start=0
[metadata@scd @ 0x845018d80] lavfi.siti.si=0.00
[metadata@scd @ 0x845018d80] lavfi.siti.ti=0.00
[metadata@scd @ 0x845018d80] frame:30   pts:15360   pts_time:1.5
[metadata@scd @ 0x845018d80] lavfi.black_end=1.5
[metadata@scd @ 0x845018d80] lavfi.freezedetect.freeze_end=1.5
[metadata@scd @ 0x845018d80] lavfi.siti.si=0.00
[metadata@scd @ 0x845018d80] lavfi.siti.ti=0.00
"""


class TestParse:
    def test_reads_both_chains_from_one_stream(self) -> None:
        samples = parse_tier0_logs(REAL_LOGS)
        assert len(samples.frames) == 2
        assert len(samples.motion) == 2
        assert [c.t for c in samples.cuts] == [0.5]

    def test_a_cut_carries_the_score_that_triggered_it(self) -> None:
        assert parse_tier0_logs(REAL_LOGS).cuts[0].score == pytest.approx(20.488)

    def test_reads_the_percentiles_signalstats_actually_reports(self) -> None:
        first = parse_tier0_logs(REAL_LOGS).frames[0]
        assert first.y_low == 17
        assert first.y_high == 170
        assert first.y_avg == pytest.approx(76.0338)

    def test_black_and_freeze_spans_pair_start_with_end(self) -> None:
        samples = parse_tier0_logs(BLACK_LOGS)
        assert samples.black_spans == [(0.0, 1.5)]
        assert samples.freeze_spans == [(0.0, 1.5)]

    def test_a_span_still_open_at_eof_runs_to_the_last_frame(self) -> None:
        """A file that fades to black and stops is the common case, not an edge case."""
        logs = BLACK_LOGS.split("lavfi.black_end")[0]
        samples = parse_tier0_logs(logs + "lavfi.siti.ti=0.0\n")
        assert samples.black_spans and samples.black_spans[0][0] == 0.0

    def test_ignores_lines_from_other_filters(self) -> None:
        noise = "[Parsed_blurdetect_7 @ 0x0] blur mean: 4.06\nframe= 64 fps=0.0 q=-0.0\n"
        assert parse_tier0_logs(noise).frames == []

    def test_a_truncated_line_is_skipped_not_raised(self) -> None:
        """A ledger is an optimization: half a log must still produce half a ledger."""
        truncated = REAL_LOGS[: REAL_LOGS.index("lavfi.blur=8.0") + 8]
        assert len(parse_tier0_logs(truncated).frames) >= 1

    def test_a_non_numeric_value_is_skipped(self) -> None:
        logs = (
            "[metadata@st @ 0x0] frame:0 pts:0 pts_time:0\n"
            "[metadata@st @ 0x0] lavfi.signalstats.YAVG=nan-ish\n"
        )
        assert parse_tier0_logs(logs).frames == []


class TestShotBoundaries:
    def test_no_cuts_is_one_shot_covering_the_asset(self) -> None:
        assert shot_boundaries([], 12.0, split_seconds=100.0) == [(0.0, 12.0, False)]

    def test_cuts_become_contiguous_spans(self) -> None:
        spans = shot_boundaries([4.0, 8.0], 12.0, split_seconds=100.0)
        assert spans == [(0.0, 4.0, False), (4.0, 8.0, False), (8.0, 12.0, False)]

    def test_drops_a_cut_closer_than_one_sample_interval(self) -> None:
        """A shot shorter than one sample has nothing measurable in it."""
        gap = 1.0 / STATS_FPS
        spans = shot_boundaries([4.0, 4.0 + gap / 2], 12.0, split_seconds=100.0)
        assert [s[0] for s in spans] == [0.0, 4.0]

    def test_drops_cuts_outside_the_asset(self) -> None:
        assert shot_boundaries([-1.0, 0.0, 99.0], 12.0, split_seconds=100.0) == [(0.0, 12.0, False)]

    def test_a_long_take_is_split_and_the_splits_are_marked(self) -> None:
        spans = shot_boundaries([], 75.0, split_seconds=30.0)
        assert [(round(a), round(b)) for a, b, _ in spans] == [(0, 30), (30, 60), (60, 75)]
        # The first really does start at a cut; the rest are duration splits and must never
        # be read as edit points by a transition policy.
        assert [s[2] for s in spans] == [False, True, True]

    def test_default_split_is_the_documented_budget(self) -> None:
        spans = shot_boundaries([], SHOT_SPLIT_SECONDS * 2 + 1)
        assert len(spans) == 3


def _samples(**over: object) -> Tier0Samples:
    frames = [
        FrameSample(t=0.0, y_avg=51.0, y_low=25.5, y_high=76.5, u_avg=128, v_avg=128, sat_avg=0),
        FrameSample(t=0.5, y_avg=51.0, y_low=25.5, y_high=76.5, u_avg=128, v_avg=128, sat_avg=0),
    ]
    return Tier0Samples(frames=frames, motion=[MotionSample(t=0.0, si=10, ti=1.0)], **over)  # type: ignore[arg-type]


class TestFold:
    def test_normalises_luma_to_zero_one(self) -> None:
        shot = fold_shots(_samples(), 1.0)[0]
        assert shot.luma_mean == pytest.approx(0.2)
        assert shot.luma_p10 == pytest.approx(0.1)
        assert shot.luma_p90 == pytest.approx(0.3)
        assert shot.contrast_idx == pytest.approx(0.2)

    def test_a_neutral_frame_reads_warmth_zero(self) -> None:
        """`ref/mood.png` is grayscale and reads UAVG = VAVG = 128, so the scale needs no
        offset. If this ever fails, warmth has acquired a bias and every match will drift."""
        assert fold_shots(_samples(), 1.0)[0].warmth == pytest.approx(0.0)

    def test_warmth_does_not_saturate_on_a_strongly_graded_shot(self) -> None:
        """The real `vertical-30s.mp4` reading: UAVG 162, VAVG 86. A saturated scale cannot
        tell two cool shots apart, which is exactly what a colour match needs to do."""
        frames = [
            FrameSample(t=0.0, y_avg=76, y_low=17, y_high=170, u_avg=162, v_avg=86, sat_avg=59)
        ]
        shot = fold_shots(Tier0Samples(frames=frames), 1.0)[0]
        assert -1.0 < shot.warmth < -0.4

    def test_drops_the_first_motion_sample_of_a_shot(self) -> None:
        """TI on the first frame measures the CUT, not the shot. Without this every shot
        after a hard cut reads `fast`."""
        motion = [MotionSample(t=0.0, si=10, ti=90.0), MotionSample(t=0.1, si=10, ti=1.0)]
        shot = fold_shots(Tier0Samples(frames=_samples().frames, motion=motion), 1.0)[0]
        assert shot.motion_class == "static"

    def test_keeps_the_only_motion_sample_when_that_is_all_there_is(self) -> None:
        shot = fold_shots(_samples(), 1.0)[0]
        assert shot.ti == pytest.approx(1.0)

    def test_sharpness_inverts_blur(self) -> None:
        frames = [
            FrameSample(
                t=0,
                y_avg=50,
                y_low=10,
                y_high=90,
                u_avg=128,
                v_avg=128,
                sat_avg=0,
                blur=BLUR_FULL / 2,
            )
        ]
        assert fold_shots(Tier0Samples(frames=frames), 1.0)[0].sharpness == pytest.approx(0.5)

    def test_sharpness_never_goes_negative_on_an_extremely_blurred_frame(self) -> None:
        frames = [
            FrameSample(
                t=0,
                y_avg=50,
                y_low=10,
                y_high=90,
                u_avg=128,
                v_avg=128,
                sat_avg=0,
                blur=BLUR_FULL * 3,
            )
        ]
        assert fold_shots(Tier0Samples(frames=frames), 1.0)[0].sharpness == 0.0

    def test_black_is_judged_at_the_shot_midpoint(self) -> None:
        """Touching the tail of a fade-out is not a black shot — flagging it would make
        "drop the black clips" delete real footage."""
        samples = Tier0Samples(frames=_samples().frames, black_spans=[(0.0, 0.05)])
        assert fold_shots(samples, 2.0)[0].black is False
        covered = Tier0Samples(frames=_samples().frames, black_spans=[(0.0, 2.0)])
        assert fold_shots(covered, 2.0)[0].black is True

    def test_a_still_is_one_static_shot(self) -> None:
        shots = fold_shots(_samples(), 4.0, is_image=True)
        assert len(shots) == 1
        assert shots[0].motion_class == "static"
        assert shots[0].ti == 0.0

    def test_no_frames_yields_no_shots_rather_than_a_fabricated_one(self) -> None:
        assert fold_shots(Tier0Samples(), 10.0) == []

    def test_a_shot_with_no_frame_inside_still_gets_a_row(self) -> None:
        """Shot indices must line up with the asset's real structure: a missing row would
        silently renumber every shot after it."""
        samples = Tier0Samples(
            frames=[
                FrameSample(t=0.0, y_avg=51, y_low=25, y_high=76, u_avg=128, v_avg=128, sat_avg=0)
            ],
            cuts=[],
        )
        shots = fold_shots(samples, 90.0)
        assert [s.shot_index for s in shots] == [0, 1, 2]

    def test_the_keyframe_sits_inside_its_shot(self) -> None:
        for shot in fold_shots(_samples(), 90.0):
            assert shot.t0 <= shot.keyframe_t < shot.t1

    def test_cut_score_is_attached_to_the_shot_that_starts_there(self) -> None:
        samples = parse_tier0_logs(REAL_LOGS)
        shots = fold_shots(samples, 4.0)
        assert shots[0].cut_score == 0.0
        assert shots[1].cut_score == pytest.approx(20.488)


class TestMotionClass:
    @pytest.mark.parametrize(
        ("ti", "expected"),
        [
            (0.0, "static"),
            (2.9, "static"),
            (3.0, "slow"),
            (7.9, "slow"),
            (8.0, "handheld"),
            (14.9, "handheld"),
            (15.0, "fast"),
            (90.0, "fast"),
        ],
    )
    def test_thresholds(self, ti: float, expected: str) -> None:
        assert motion_class_for(ti) == expected


class TestCommand:
    def test_one_input_two_mapped_outputs_means_one_decode(self) -> None:
        argv = tier0_argv("ffmpeg", __import__("pathlib").Path("/tmp/a.mp4"))
        assert argv.count("-i") == 1
        assert argv.count("-map") == 2

    def test_both_metadata_filters_are_named(self) -> None:
        """The whole parse depends on telling the chains apart in one stderr stream."""
        graph = tier0_argv("ffmpeg", __import__("pathlib").Path("/tmp/a.mp4"))[
            tier0_argv("ffmpeg", __import__("pathlib").Path("/tmp/a.mp4")).index("-filter_complex")
            + 1
        ]
        assert "metadata@scd=mode=print" in graph
        assert "metadata@st=mode=print" in graph

    def test_motion_and_scene_run_at_native_rate(self) -> None:
        """At 2 fps every frame looks like a cut and every clip looks fast."""
        argv = tier0_argv("ffmpeg", __import__("pathlib").Path("/tmp/a.mp4"))
        graph = argv[argv.index("-filter_complex") + 1]
        # `;[a]` and not `[a]`: the split's own output labels are `[a][b]` earlier in the
        # graph, so anchoring on the bare label lands on the declaration, not the chain.
        scd_chain = graph.split(";[a]")[1].split("[s]")[0]
        assert "siti" in scd_chain
        assert "fps=" not in scd_chain

    def test_measure_asset_uses_the_injected_runner(self) -> None:
        seen: list[list[str]] = []

        def runner(argv: object) -> str:
            seen.append(list(argv))  # type: ignore[arg-type]
            return REAL_LOGS

        shots = measure_asset(__import__("pathlib").Path("/tmp/a.mp4"), duration=4.0, runner=runner)
        assert len(seen) == 1
        assert len(shots) == 2


class TestStills:
    """A photo took the video path and measured nothing at all.

    `measure_asset(is_image=True)` built the split graph, whose second `-f null` output
    never receives a frame from a single-image input, so ffmpeg exited 234 having produced
    no statistics. Every still in every project was silently unmeasured — found only when
    the fixture labels were generated and all 60 photos came back empty.
    """

    def test_a_still_uses_one_chain_and_one_output(self) -> None:
        argv = still_argv("ffmpeg", __import__("pathlib").Path("/tmp/p.jpg"))
        assert argv.count("-f") == 1
        assert "-filter_complex" not in argv
        assert "split" not in " ".join(argv)

    def test_a_still_asks_for_exactly_one_frame(self) -> None:
        argv = still_argv("ffmpeg", __import__("pathlib").Path("/tmp/p.jpg"))
        assert argv[argv.index("-frames:v") + 1] == "1"

    def test_a_still_does_not_run_the_motion_filters(self) -> None:
        """`scdet` and `siti` compare a frame with the one before it. A still has none."""
        graph = still_argv("ffmpeg", __import__("pathlib").Path("/tmp/p.jpg"))[
            still_argv("ffmpeg", __import__("pathlib").Path("/tmp/p.jpg")).index("-vf") + 1
        ]
        assert "scdet" not in graph
        assert "siti" not in graph
        assert "signalstats" in graph and "blurdetect" in graph

    def test_measure_asset_routes_a_still_to_the_still_command(self) -> None:
        seen: list[list[str]] = []

        def runner(argv: object) -> str:
            seen.append(list(argv))  # type: ignore[arg-type]
            return (
                "[metadata@st @ 0x0] frame:0 pts:0 pts_time:0\n"
                "[metadata@st @ 0x0] lavfi.signalstats.YAVG=76.0\n"
                "[metadata@st @ 0x0] lavfi.signalstats.YLOW=17\n"
                "[metadata@st @ 0x0] lavfi.signalstats.YHIGH=170\n"
                "[metadata@st @ 0x0] lavfi.signalstats.UAVG=128\n"
                "[metadata@st @ 0x0] lavfi.signalstats.VAVG=128\n"
                "[metadata@st @ 0x0] lavfi.signalstats.SATAVG=10\n"
                "[metadata@st @ 0x0] lavfi.blur=4.0\n"
            )

        shots = measure_asset(
            __import__("pathlib").Path("/tmp/p.jpg"), duration=0.04, is_image=True, runner=runner
        )
        assert "-filter_complex" not in seen[0]
        assert len(shots) == 1
        assert shots[0].motion_class == "static"

    def test_a_still_gets_a_real_span_not_the_container_duration(self) -> None:
        """A JPEG often reports a nominal 0.04s. A zero-length shot divides by zero in
        every downstream projection, so the span is floored at one sample interval."""

        def runner(argv: object) -> str:
            return (
                "[metadata@st @ 0x0] frame:0 pts:0 pts_time:0\n"
                "[metadata@st @ 0x0] lavfi.signalstats.YAVG=76.0\n"
                "[metadata@st @ 0x0] lavfi.signalstats.YLOW=17\n"
                "[metadata@st @ 0x0] lavfi.signalstats.YHIGH=170\n"
            )

        shots = measure_asset(
            __import__("pathlib").Path("/tmp/p.jpg"), duration=0.04, is_image=True, runner=runner
        )
        assert shots[0].t1 - shots[0].t0 >= 1.0 / STATS_FPS
