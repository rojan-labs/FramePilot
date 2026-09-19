"""The Python mirror refuses exactly what worker-protocol.ts refuses, and emits what it accepts."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from conftest import DELETE, SHA, line, matte_request, mutate, segment_frame_request

from framepilot_smart_mask.protocol import (
    ARTIFACT_FILE_NAMES,
    MAX_LINE_BYTES,
    REVIEW_REASONS,
    ArtifactFile,
    CancelMessage,
    MatteArtifact,
    MatteOutcome,
    MatteRequest,
    MatteSummary,
    ProtocolError,
    ReviewRange,
    SegmentFrameRequest,
    encode_line,
    matte_result_message,
    parse_input_line,
    progress_message,
    segment_frame_result_message,
)

TS_PROTOCOL = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "capability-packs"
    / "src"
    / "worker-protocol.ts"
)


def refused(message: dict[str, object]) -> ProtocolError:
    with pytest.raises(ProtocolError) as caught:
        parse_input_line(line(message))
    return caught.value


def test_parses_a_box_prompt_matte_request() -> None:
    request = parse_input_line(line(matte_request()))
    assert isinstance(request, MatteRequest)
    assert request.media.frame_count == 48
    assert request.prompts[0].kind == "box"
    assert request.output.max_bytes == 10_000_000_000
    assert request.inputs is None and request.previous_artifact is None


def test_parses_points_brush_lock_and_previous_artifact() -> None:
    message = matte_request(
        prompts=[
            {"kind": "points", "pts": 0, "points": [{"x": 0.5, "y": 0.5, "label": "include"}]},
            {"kind": "brush", "pts": 512, "file": "corrections/512.png"},
            {"kind": "lock", "pts": -24, "file": "locked/-24.png"},
        ],
        inputs={
            "handleId": "in-1",
            "absolutePath": "/project/.framepilot-derived/mattes/.staging/job-1/inputs",
            "files": ["corrections/512.png", "locked/-24.png", "previous/matte.mkv"],
        },
        previousArtifact=SHA,
    )
    request = parse_input_line(line(message))
    assert isinstance(request, MatteRequest)
    assert [prompt.kind for prompt in request.prompts] == ["points", "brush", "lock"]
    assert request.prompts[2].pts == -24
    assert request.previous_artifact == SHA


@pytest.mark.parametrize(
    ("path", "value", "fragment"),
    [
        (["parameters", "extra"], 1, "unexpected keys"),
        (["parameters", "previewHeight"], 179, ">= 180"),
        (["parameters", "previewHeight"], 1081, "<= 1080"),
        (["parameters", "prompts"], [], "between 1 and 512"),
        (
            ["parameters", "output", "allowedFiles"],
            ["matte.mkv", "report.json"],
            "matte.mkv and frames.json",
        ),
        (
            ["parameters", "output", "allowedFiles"],
            ["matte.mkv", "frames.json", "frames.json"],
            "distinct",
        ),
        (
            ["parameters", "output", "allowedFiles"],
            ["matte.mkv", "frames.json", "evil.sh"],
            "may not create",
        ),
        (["parameters", "output", "absolutePath"], "relative/dir", "absolute"),
        (["parameters", "output", "absolutePath"], "/a/../b", "traversal"),
        (["parameters", "output", "maxBytes"], 0, ">= 1"),
        (["parameters", "prompts", 0, "box", "width"], 0.9, "inside the frame"),
        (["parameters", "prompts", 0, "pts"], 0.5, "integer"),
        (["parameters", "prompts", 0, "kind"], "lasso", "kind"),
        (["media", "fps"], 0, "fps"),
        (["media", "lastFrameExclusive"], 0, ">= 1"),
        (["media", "firstFrame"], 60, "frame range"),
        (["protocolVersion"], 2, "protocol version"),
        (["capability"], "subject.detect", "not provided by Smart Mask"),
        (["projectRevision"], True, "integer"),
        (["media"], DELETE, "missing"),
    ],
)
def test_refuses_malformed_matte_requests(
    path: list[str | int], value: object, fragment: str
) -> None:
    error = refused(mutate(matte_request(), path, value))
    assert error.code == "invalid_request"
    assert fragment in error.detail


def test_brush_file_must_name_its_own_pts_and_be_declared() -> None:
    inputs = {"handleId": "in-1", "absolutePath": "/in", "files": ["corrections/12.png"]}
    wrong_pts = matte_request(
        prompts=[
            {"kind": "box", "pts": 0, "box": {"x": 0, "y": 0, "width": 1, "height": 1}},
            {"kind": "brush", "pts": 13, "file": "corrections/12.png"},
        ],
        inputs=inputs,
    )
    assert "its pts" in refused(wrong_pts).detail
    undeclared = matte_request(
        prompts=[
            {"kind": "box", "pts": 0, "box": {"x": 0, "y": 0, "width": 1, "height": 1}},
            {"kind": "brush", "pts": 12, "file": "corrections/12.png"},
        ],
    )
    assert "listed in the inputs handle" in refused(undeclared).detail
    orphan = matte_request(
        inputs={"handleId": "in-1", "absolutePath": "/in", "files": ["locked/5.png"]}
    )
    assert "only files a prompt references" in refused(orphan).detail
    previous_without_key = matte_request(
        inputs={"handleId": "in-1", "absolutePath": "/in", "files": ["previous/matte.mkv"]}
    )
    assert "need previousArtifact" in refused(previous_without_key).detail


def test_corrections_alone_need_a_previous_artifact() -> None:
    message = matte_request(
        prompts=[{"kind": "lock", "pts": 0, "file": "locked/0.png"}],
        inputs={"handleId": "in-1", "absolutePath": "/in", "files": ["locked/0.png"]},
    )
    assert "unless it refines a previous artifact" in refused(message).detail
    accepted = mutate(message, ["parameters", "previousArtifact"], SHA)
    assert isinstance(parse_input_line(line(accepted)), MatteRequest)


def test_content_fingerprint_is_optional_and_must_be_sha256_hex() -> None:
    request = parse_input_line(line(matte_request()))
    assert isinstance(request, MatteRequest) and request.content_fingerprint is None
    with_content = parse_input_line(
        line(mutate(matte_request(), ["parameters", "contentFingerprint"], SHA))
    )
    assert isinstance(with_content, MatteRequest) and with_content.content_fingerprint == SHA
    bad = mutate(matte_request(), ["parameters", "contentFingerprint"], "not-a-digest")
    assert "contentFingerprint" in refused(bad).detail


def test_segment_frame_requests() -> None:
    request = parse_input_line(line(segment_frame_request()))
    assert isinstance(request, SegmentFrameRequest)
    assert request.points[0].label == "include"
    empty = mutate(segment_frame_request(), ["parameters", "points"], DELETE)
    hover = parse_input_line(
        line(mutate(empty, ["parameters", "hoverPoint"], {"x": 0.1, "y": 0.9}))
    )
    assert isinstance(hover, SegmentFrameRequest) and hover.hover_point is not None
    assert "points, a box, or a hover point" in refused(empty).detail


def test_cancel_and_garbage_lines() -> None:
    assert parse_input_line(
        '{"type":"cancel","protocolVersion":1,"requestId":"req-1"}'
    ) == CancelMessage("req-1")
    with pytest.raises(ProtocolError, match="not valid JSON"):
        parse_input_line("{")
    with pytest.raises(ProtocolError, match="1 MiB"):
        parse_input_line(" " * (MAX_LINE_BYTES + 1))


def outcome(**overrides: object) -> MatteOutcome:
    artifact = MatteArtifact(
        files=(ArtifactFile("matte.mkv", 10, SHA), ArtifactFile("frames.json", 20, SHA)),
        width=1920,
        height=1080,
        frame_count=48,
        first_pts=0,
        last_pts=47 * 512,
        time_base=(1, 12800),
    )
    values: dict[str, object] = {
        "artifact": artifact,
        "execution_provider": "cpu",
        "summary": MatteSummary(
            verified_frames=40, flagged_frames=8, locked_frames=0, self_correction_rounds=2
        ),
        "needs_review": (ReviewRange(512, 1024, "estimates_disagree"),),
    }
    values.update(overrides)
    return MatteOutcome(**values)  # type: ignore[arg-type]


def test_matte_result_encodes_the_host_shape() -> None:
    message = matte_result_message(
        request_id="req-1",
        project_revision=7,
        outcome=outcome(),
        backend="onnxruntime",
        model_digests={"b": SHA, "a": SHA},
    )
    assert message["artifact"]["timeBase"] == [1, 12800]
    assert message["summary"] == {
        "verifiedFrames": 40,
        "flaggedFrames": 8,
        "lockedFrames": 0,
        "selfCorrectionRounds": 2,
    }
    assert list(message["modelDigests"]) == ["a", "b"]
    assert message["needsReview"] == [
        {"startPts": 512, "endPts": 1024, "reason": "estimates_disagree"}
    ]
    assert encode_line(message).endswith("\n")


@pytest.mark.parametrize(
    ("overrides", "fragment"),
    [
        ({"summary": MatteSummary(40, 9, 0, 0)}, "exceed the frame count"),
        ({"summary": MatteSummary(0, 0, 0, 17)}, "rounds"),
        ({"execution_provider": "cuda"}, "provider"),
    ],
)
def test_matte_result_refuses_what_the_host_would(
    overrides: dict[str, object], fragment: str
) -> None:
    with pytest.raises(ProtocolError, match=fragment):
        matte_result_message(
            request_id="r",
            project_revision=0,
            outcome=outcome(**overrides),
            backend="b",
            model_digests={},
        )


def test_matte_result_requires_declared_and_required_files() -> None:
    from dataclasses import replace

    missing = replace(
        outcome().artifact,
        files=(ArtifactFile("matte.mkv", 1, SHA), ArtifactFile("report.json", 1, SHA)),
    )
    with pytest.raises(ProtocolError, match=r"matte\.mkv and frames\.json"):
        matte_result_message(
            request_id="r",
            project_revision=0,
            outcome=outcome(artifact=missing),
            backend="b",
            model_digests={},
        )


def test_progress_round_only_for_self_correct() -> None:
    assert progress_message("r", "self_correct", 1, 3, round_number=2)["round"] == 2
    assert progress_message("r", "segment", 9, 3)["completed"] == 3
    assert progress_message("r", "decode", 0, 0)["total"] == 1
    with pytest.raises(ProtocolError):
        progress_message("r", "segment", 1, 3, round_number=1)


def test_segment_frame_result_bounds() -> None:
    message = segment_frame_result_message(
        request_id="s",
        project_revision=1,
        pts=10,
        width=640,
        height=360,
        mask_png_base64="iVBORw0KGgo=",
        score=1.5,
        backend="b",
        model_digests={},
    )
    assert message["score"] == 1.0
    with pytest.raises(ProtocolError):
        segment_frame_result_message(
            request_id="s",
            project_revision=1,
            pts=10,
            width=640,
            height=1081,
            mask_png_base64="iVBORw0KGgo=",
            score=1,
            backend="b",
            model_digests={},
        )


def _ts_enum(source: str, anchor: str) -> list[str]:
    start = source.index(anchor)
    body = source[start : source.index("]", start)]
    return re.findall(r"'([a-z_.]+(?:\.[a-z]+)?)'", body)


@pytest.mark.skipif(
    not TS_PROTOCOL.is_file(), reason="TypeScript protocol not present in this checkout"
)
def test_enums_match_the_typescript_protocol() -> None:
    source = TS_PROTOCOL.read_text(encoding="utf-8")
    assert tuple(_ts_enum(source, "MatteArtifactFileNameSchema = z.enum([")) == ARTIFACT_FILE_NAMES
    assert tuple(_ts_enum(source, "MatteReviewReasonSchema = z.enum([")) == REVIEW_REASONS
    phases_block = source[source.index("CapabilityPackWorkerProgressSchema") :]
    ts_phases = set(_ts_enum(phases_block, "phase: z.enum(["))
    from typing import get_args

    from framepilot_smart_mask.protocol import ProgressPhase

    assert set(get_args(ProgressPhase)) <= ts_phases
    assert json.dumps(sorted(ts_phases))
