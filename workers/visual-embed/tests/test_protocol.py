"""The worker's half of the frozen JSON-line contract."""

from __future__ import annotations

import json

import pytest

from framepilot_visual_embed.protocol import (
    MAX_SHOTS,
    MAX_TEXTS,
    ConfidentLabel,
    EmbedRequest,
    ProtocolError,
    ShotEmbedding,
    TextRequest,
    embed_result_message,
    encode_line,
    failure_message,
    pack_fp16,
    parse_input_line,
    text_result_message,
    unpack_fp16,
)

MEDIA = {
    "handleId": "media:clip-1",
    "assetId": "asset-1",
    "absolutePath": "/sandbox/project/media/shot.mp4",
    "sourceStartSeconds": 0.0,
    "sourceEndSeconds": 60.0,
    "fps": 30.0,
    "firstFrame": 0,
    "lastFrameExclusive": 1800,
}


def embed_line(**overrides: object) -> str:
    payload: dict[str, object] = {
        "type": "request",
        "protocolVersion": 1,
        "requestId": "embed:asset-1:0",
        "projectRevision": 3,
        "capability": "visual.embed",
        "media": MEDIA,
        "parameters": {
            "promptBankVersion": 1,
            "shots": [{"shotIndex": 1, "keyframeT": 12.0}, {"shotIndex": 0, "keyframeT": 2.0}],
        },
    }
    payload.update(overrides)
    return json.dumps(payload)


class TestEmbedRequests:
    def test_parses_and_sorts_shots_by_source_time(self) -> None:
        request = parse_input_line(embed_line())
        assert isinstance(request, EmbedRequest)
        assert [shot.shot_index for shot in request.shots] == [0, 1]
        assert request.prompt_bank_version == 1

    def test_refuses_a_keyframe_outside_the_approved_handle(self) -> None:
        with pytest.raises(ProtocolError) as error:
            parse_input_line(
                embed_line(
                    parameters={
                        "promptBankVersion": 1,
                        "shots": [{"shotIndex": 0, "keyframeT": 61.0}],
                    }
                )
            )
        assert "outside the approved media range" in error.value.detail
        assert error.value.code == "invalid_request"

    def test_refuses_repeated_shot_indices(self) -> None:
        with pytest.raises(ProtocolError, match="distinct"):
            parse_input_line(
                embed_line(
                    parameters={
                        "promptBankVersion": 1,
                        "shots": [
                            {"shotIndex": 4, "keyframeT": 1.0},
                            {"shotIndex": 4, "keyframeT": 2.0},
                        ],
                    }
                )
            )

    def test_refuses_a_batch_past_the_shot_bound(self) -> None:
        shots = [{"shotIndex": i, "keyframeT": float(i)} for i in range(MAX_SHOTS + 1)]
        with pytest.raises(ProtocolError, match="between 1 and"):
            parse_input_line(embed_line(parameters={"promptBankVersion": 1, "shots": shots}))

    def test_refuses_another_pack_capability(self) -> None:
        with pytest.raises(ProtocolError, match="not provided by Visual Embed"):
            parse_input_line(embed_line(capability="subject.detect"))

    def test_refuses_another_protocol_version(self) -> None:
        with pytest.raises(ProtocolError, match="unsupported protocol version"):
            parse_input_line(embed_line(protocolVersion=2))


class TestTextRequests:
    def test_carries_no_media_handle(self) -> None:
        request = parse_input_line(
            json.dumps(
                {
                    "type": "request",
                    "protocolVersion": 1,
                    "requestId": "query:1",
                    "projectRevision": 0,
                    "capability": "visual.text",
                    "parameters": {"texts": ["wide shots of the street"]},
                }
            )
        )
        assert isinstance(request, TextRequest)
        assert request.texts == ("wide shots of the street",)

    def test_refuses_a_media_handle_it_has_no_use_for(self) -> None:
        with pytest.raises(ProtocolError, match="unexpected keys: media"):
            parse_input_line(
                json.dumps(
                    {
                        "type": "request",
                        "protocolVersion": 1,
                        "requestId": "query:1",
                        "projectRevision": 0,
                        "capability": "visual.text",
                        "media": MEDIA,
                        "parameters": {"texts": ["x"]},
                    }
                )
            )

    def test_bounds_the_text_batch(self) -> None:
        with pytest.raises(ProtocolError, match="between 1 and"):
            parse_input_line(
                json.dumps(
                    {
                        "type": "request",
                        "protocolVersion": 1,
                        "requestId": "query:1",
                        "projectRevision": 0,
                        "capability": "visual.text",
                        "parameters": {"texts": ["x"] * (MAX_TEXTS + 1)},
                    }
                )
            )


class TestPackedVectors:
    def test_round_trips_within_half_precision(self) -> None:
        original = [0.5, -0.25, 0.125, 0.0]
        assert unpack_fp16(pack_fp16(original)) == pytest.approx(original, abs=1e-3)

    def test_refuses_a_non_finite_component(self) -> None:
        with pytest.raises(ProtocolError, match="non-finite"):
            pack_fp16([0.5, float("nan")])

    def test_refuses_payload_that_is_not_base64(self) -> None:
        with pytest.raises(ProtocolError, match="base64"):
            unpack_fp16("not base64!")


class TestResults:
    def _shot(self, **overrides: object) -> ShotEmbedding:
        defaults: dict[str, object] = {
            "shot_index": 0,
            "vector": [0.5, 0.5],
            "labels": {"shotSize": ConfidentLabel(value="MS", p=0.8)},
            "faces": 1,
            "face_vectors": [[1.0, 0.0]],
        }
        defaults.update(overrides)
        return ShotEmbedding(**defaults)  # type: ignore[arg-type]

    def _message(self, **overrides: object) -> dict[str, object]:
        arguments: dict[str, object] = {
            "request_id": "embed:1",
            "project_revision": 3,
            "prompt_bank_version": 1,
            "dim": 2,
            "face_dim": 2,
            "shots": [self._shot()],
            "backend": "fake",
            "model_digests": {"m.onnx": "a" * 64},
        }
        arguments.update(overrides)
        return embed_result_message(**arguments)  # type: ignore[arg-type]

    def test_encodes_a_labelled_shot(self) -> None:
        message = self._message()
        assert message["capability"] == "visual.embed"
        assert message["shots"][0]["labels"] == {"shotSize": {"value": "MS", "p": 0.8}}
        assert unpack_fp16(message["shots"][0]["vector"]) == pytest.approx([0.5, 0.5], abs=1e-3)

    def test_refuses_an_empty_shot_list(self) -> None:
        # Unlike detection, "nothing" is not an answer here: the host named the shots.
        with pytest.raises(ProtocolError, match="at least one shot"):
            self._message(shots=[])

    def test_refuses_a_vector_that_disagrees_with_dim(self) -> None:
        with pytest.raises(ProtocolError, match="not 2"):
            self._message(shots=[self._shot(vector=[0.1, 0.2, 0.3])])

    def test_refuses_face_vectors_that_do_not_match_the_count(self) -> None:
        with pytest.raises(ProtocolError, match="one vector per counted face"):
            self._message(shots=[self._shot(faces=2)])

    def test_refuses_a_label_group_the_ledger_cannot_store(self) -> None:
        with pytest.raises(ProtocolError, match="not a ledger label group"):
            self._message(shots=[self._shot(labels={"vibe": ConfidentLabel(value="x", p=0.5)})])

    def test_orders_shots_by_index_regardless_of_input_order(self) -> None:
        message = self._message(
            dim=2,
            shots=[self._shot(shot_index=5), self._shot(shot_index=2)],
        )
        assert [shot["shotIndex"] for shot in message["shots"]] == [2, 5]

    def test_text_result_carries_one_vector_per_query(self) -> None:
        message = text_result_message(
            request_id="query:1",
            project_revision=0,
            dim=2,
            vectors=[[1.0, 0.0], [0.0, 1.0]],
            backend="fake",
            model_digests={},
        )
        assert len(message["vectors"]) == 2

    def test_encoded_lines_are_canonical_and_newline_terminated(self) -> None:
        line = encode_line(failure_message("embed:1", "cancelled", "stopped", False))
        assert line.endswith("\n")
        assert json.loads(line)["code"] == "cancelled"
