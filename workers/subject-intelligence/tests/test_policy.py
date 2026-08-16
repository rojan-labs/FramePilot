"""Policy: what the pack is willing to claim, and what it refuses to."""

from __future__ import annotations

import pytest
from conftest import (
    FRAME_HEIGHT,
    FRAME_WIDTH,
    ScriptedBackend,
    ScriptedSource,
    detect_request,
    segment_request,
    solid_mask,
)

from framepilot_subject_intelligence.backend import RawDetection, RawMask
from framepilot_subject_intelligence.policy import (
    MIN_DETECTION_CONFIDENCE,
    SubjectNotFoundError,
    build_mask_sample,
    resolve_prompt_region,
    run_detection,
    run_segmentation,
    select_detections,
)
from framepilot_subject_intelligence.protocol import NormalizedPoint, ProtocolError

NEVER_CANCELLED = lambda: False  # noqa: E731


def face(x: float, y: float, size: float = 100.0, confidence: float = 0.9) -> RawDetection:
    return RawDetection(label="face", box=(x, y, size, size), confidence=confidence)


def test_a_low_confidence_guess_is_not_reported_as_a_subject() -> None:
    kept = select_detections(
        [face(10, 10, confidence=0.95), face(200, 200, confidence=MIN_DETECTION_CONFIDENCE - 0.01)],
        frame=0,
        width=FRAME_WIDTH,
        height=FRAME_HEIGHT,
        labels=("face",),
        max_detections=20,
    )

    assert len(kept) == 1
    assert kept[0].confidence == pytest.approx(0.95)


def test_finding_nothing_returns_nothing() -> None:
    # The dangerous alternative is a fallback box in the middle of frame, which
    # would look like a detection and be a fabrication.
    assert select_detections(
        [], frame=0, width=FRAME_WIDTH, height=FRAME_HEIGHT, labels=("face",), max_detections=20
    ) == []


def test_only_requested_labels_come_back() -> None:
    raw = [
        face(10, 10),
        RawDetection(label="person", box=(0, 0, 500, 900), confidence=0.9),
        RawDetection(label="object", box=(30, 30, 60, 60), confidence=0.9),
    ]

    kept = select_detections(
        raw,
        frame=0,
        width=FRAME_WIDTH,
        height=FRAME_HEIGHT,
        labels=("face", "person"),
        max_detections=20,
    )

    assert sorted(item.label for item in kept) == ["face", "person"]


def test_the_strongest_detections_survive_the_cap() -> None:
    raw = [face(index * 10, 0, confidence=0.5 + index / 100) for index in range(10)]

    kept = select_detections(
        raw, frame=0, width=FRAME_WIDTH, height=FRAME_HEIGHT, labels=("face",), max_detections=3
    )

    assert [round(item.confidence, 2) for item in kept] == [0.59, 0.58, 0.57]


def test_a_box_hanging_off_the_edge_is_clipped_not_dropped() -> None:
    # A face at the edge of frame is a real face; the protocol just requires the
    # box to stay inside the picture.
    kept = select_detections(
        [face(FRAME_WIDTH - 40, FRAME_HEIGHT - 40, size=200)],
        frame=0,
        width=FRAME_WIDTH,
        height=FRAME_HEIGHT,
        labels=("face",),
        max_detections=20,
    )

    assert len(kept) == 1
    box = kept[0].box
    assert box.x + box.width <= 1.0
    assert box.y + box.height <= 1.0
    assert box.width > 0.0


def test_a_box_entirely_outside_the_frame_is_not_a_detection() -> None:
    kept = select_detections(
        [face(FRAME_WIDTH + 50, 10)],
        frame=0,
        width=FRAME_WIDTH,
        height=FRAME_HEIGHT,
        labels=("face",),
        max_detections=20,
    )

    assert kept == []


def test_detection_runs_every_frame_in_the_range(backend: ScriptedBackend) -> None:
    backend.frames = 3
    backend.faces = [[face(10, 10)], [], [face(20, 20)]]
    source = backend.open_frames("/approved/media.mp4", 0, 3)

    frames = list(
        run_detection(detect_request(), source, backend, should_cancel=NEVER_CANCELLED)
    )

    assert [len(group) for group in frames] == [1, 0, 1]
    assert [item.frame for group in frames for item in group] == [0, 2]


def test_detection_stops_when_the_host_cancels(backend: ScriptedBackend) -> None:
    backend.frames = 100
    source = backend.open_frames("/approved/media.mp4", 0, 100)

    with pytest.raises(ProtocolError) as error:
        list(run_detection(detect_request(), source, backend, should_cancel=lambda: True))

    assert error.value.code == "cancelled"


def test_a_point_prompt_resolves_to_a_real_detected_person(backend: ScriptedBackend) -> None:
    crowd = RawDetection(label="person", box=(0, 0, 1900, 1000), confidence=0.9)
    subject = RawDetection(label="person", box=(800, 400, 300, 600), confidence=0.9)
    backend.objects = [[crowd, subject]]

    region = resolve_prompt_region(
        segment_request(region=None, point=NormalizedPoint(x=0.5, y=0.5)),
        "frame",
        backend,
        FRAME_WIDTH,
        FRAME_HEIGHT,
    )

    # The smallest person containing the point — clicking a face in a crowd means
    # that person, not the group behind them.
    assert region == subject.box


def test_a_point_prompt_with_nobody_there_is_an_honest_loss(backend: ScriptedBackend) -> None:
    backend.objects = [[RawDetection(label="person", box=(0, 0, 100, 100), confidence=0.9)]]

    with pytest.raises(SubjectNotFoundError):
        resolve_prompt_region(
            segment_request(region=None, point=NormalizedPoint(x=0.9, y=0.9)),
            "frame",
            backend,
            FRAME_WIDTH,
            FRAME_HEIGHT,
        )


def test_a_low_confidence_person_cannot_anchor_a_point_prompt(backend: ScriptedBackend) -> None:
    backend.objects = [
        [
            RawDetection(
                label="person", box=(0, 0, 1900, 1000), confidence=MIN_DETECTION_CONFIDENCE - 0.01
            )
        ]
    ]

    with pytest.raises(SubjectNotFoundError):
        resolve_prompt_region(
            segment_request(region=None, point=NormalizedPoint(x=0.5, y=0.5)),
            "frame",
            backend,
            FRAME_WIDTH,
            FRAME_HEIGHT,
        )


def test_an_empty_mask_is_reported_as_no_subject() -> None:
    with pytest.raises(SubjectNotFoundError):
        build_mask_sample(0, 4, 4, [0] * 16, 0.9)


def test_a_few_stray_pixels_are_not_a_subject() -> None:
    # One lit pixel in 400 is noise. Returning it as a matte would hand the editor
    # a "mask" that mattes nothing.
    values = [0] * 400
    values[42] = 1

    with pytest.raises(SubjectNotFoundError):
        build_mask_sample(0, 20, 20, values, 0.9)


def test_a_real_mask_round_trips_through_its_run_lengths() -> None:
    from framepilot_subject_intelligence.geometry import decode_run_lengths

    mask = solid_mask(width=4, height=4)

    sample = build_mask_sample(3, mask.width, mask.height, list(mask.values), mask.confidence)

    assert sample.frame == 3
    assert decode_run_lengths(sample.counts, 16) == tuple(mask.values)


def test_a_mask_that_starts_foreground_still_decodes() -> None:
    from framepilot_subject_intelligence.geometry import decode_run_lengths

    values = [1] * 8 + [0] * 8

    sample = build_mask_sample(0, 4, 4, values, 0.8)

    # The leading zero run is what keeps this from decoding inverted.
    assert sample.counts[0] == 0
    assert decode_run_lengths(sample.counts, 16) == tuple(values)


def test_segmentation_uses_the_region_the_caller_gave(backend: ScriptedBackend) -> None:
    backend.frames = 1
    backend.masks = [solid_mask()]
    source = backend.open_frames("/approved/media.mp4", 0, 1)

    masks = list(
        run_segmentation(segment_request(), source, backend, should_cancel=NEVER_CANCELLED)
    )

    assert len(masks) == 1
    assert backend.segment_regions == [
        (0.25 * FRAME_WIDTH, 0.25 * FRAME_HEIGHT, 0.5 * FRAME_WIDTH, 0.5 * FRAME_HEIGHT)
    ]


def test_segmentation_confidence_is_the_measurement_not_a_constant(
    backend: ScriptedBackend,
) -> None:
    backend.frames = 1
    backend.masks = [solid_mask(confidence=0.61)]
    source = backend.open_frames("/approved/media.mp4", 0, 1)

    masks = list(
        run_segmentation(segment_request(), source, backend, should_cancel=NEVER_CANCELLED)
    )

    assert masks[0].confidence == pytest.approx(0.61)


def test_segmentation_stops_when_the_host_cancels(backend: ScriptedBackend) -> None:
    backend.frames = 100
    source = backend.open_frames("/approved/media.mp4", 0, 100)

    with pytest.raises(ProtocolError) as error:
        list(run_segmentation(segment_request(), source, backend, should_cancel=lambda: True))

    assert error.value.code == "cancelled"


def test_an_out_of_range_confidence_is_clamped_to_the_wire_contract() -> None:
    sample = build_mask_sample(0, 2, 2, [1, 1, 1, 1], 1.4)

    assert sample.confidence == 1.0


def test_a_source_that_ends_early_simply_ends(backend: ScriptedBackend) -> None:
    # Short media is not an error: the host asked for a range, the file had less.
    source = ScriptedSource(frames=1)

    frames = list(
        run_detection(detect_request(), source, backend, should_cancel=NEVER_CANCELLED)
    )

    assert len(frames) == 1


def test_masks_carry_the_backend_reported_dimensions(backend: ScriptedBackend) -> None:
    backend.frames = 1
    backend.masks = [RawMask(width=6, height=2, values=[1] * 12, confidence=0.7)]
    source = backend.open_frames("/approved/media.mp4", 0, 1)

    masks = list(
        run_segmentation(segment_request(), source, backend, should_cancel=NEVER_CANCELLED)
    )

    assert (masks[0].width, masks[0].height) == (6, 2)
