"""The local tier-2 arm: decoding a pack's answer into the ledger's own shape.

What matters here is not that the arm works — that needs weights and a llama.cpp binary,
neither of which this repository has fetched — but that it is **honest about what it
received**. Every short, mismatched or foreign answer must become an error rather than a
row in the ledger, because a partial tier-2 write is indistinguishable from real coverage
once it is stored, and a description is the one tier that can be wrong in an interesting
way.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, cast

import pytest

from framepilot_engine.brain.ledger_models import TIER2_VERSION, CameraMovement, ShotSize
from framepilot_engine.brain.local_visual_describe import (
    MAX_SHOTS_PER_REQUEST,
    LocalVisualDescribeClient,
)
from framepilot_engine.brain.pack_worker import PackHandle, PackWorkerError


@pytest.fixture
def entrypoint(tmp_path: Path) -> Path:
    path = tmp_path / "framepilot-visual-describe"
    path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    return path


@pytest.fixture
def handle(entrypoint: Path) -> PackHandle:
    return PackHandle(
        pack_id="framepilot.visual-describe",
        version="1.0.0",
        release_digest="a" * 64,
        entrypoint=str(entrypoint),
        capabilities=("visual.describe",),
    )


class Scripted:
    """A launcher that replays one canned stdout per request."""

    def __init__(self, *messages: dict[str, Any]) -> None:
        self._messages = list(messages)
        self.requests: list[dict[str, Any]] = []
        self.returncode: int | None = 0

    def __call__(self, _handle: PackHandle) -> Scripted:
        return self

    def kill(self) -> None:  # pragma: no cover - only a timeout path uses this
        pass

    def communicate(
        self, input: str | None = None, timeout: float | None = None
    ) -> tuple[str, str]:
        self.requests.append(json.loads(input or "{}"))
        message = self._messages.pop(0)
        return json.dumps({**message, "requestId": self.requests[-1]["requestId"]}) + "\n", ""


def describe_reply(shots: list[dict[str, Any]], **overrides: Any) -> dict[str, Any]:
    message: dict[str, Any] = {
        "type": "result",
        "protocolVersion": 1,
        "projectRevision": 0,
        "capability": "visual.describe",
        "backend": "llama.cpp/smolvlm2-2.2b",
        "modelDigests": {},
        "tier2Version": TIER2_VERSION,
        "model": "framepilot/smolvlm2-2.2b-instruct-q4-k-m",
        "shots": shots,
    }
    message.update(overrides)
    return message


def shot(index: int, **overrides: Any) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "shotIndex": index,
        "summary": f"Shot {index}: a man speaks at a desk.",
        "subject": "man",
        "action": "speaking",
        "setting": "office",
        "camera": {"shotSize": "MS", "angle": "eye-level", "movement": "static"},
        "mood": "neutral",
        "onScreenText": ["SHIP IT"],
        "quality": ["well-lit"],
        "confidence": "high",
    }
    entry.update(overrides)
    return entry


def run(handle: PackHandle, launcher: Scripted, spans: list[tuple[int, float, float]]) -> Any:
    return LocalVisualDescribeClient(handle, launch=launcher).describe_shots(
        asset_id="vid",
        media_path="/media/clip.mp4",
        shots=spans,
        duration_seconds=30.0,
        fps=30.0,
    )


class TestRequestShape:
    def test_the_request_carries_spans_and_the_tier_version(self, handle: PackHandle) -> None:
        launcher = Scripted(describe_reply([shot(0), shot(1)]))
        run(handle, launcher, [(0, 0.0, 4.0), (1, 4.0, 9.0)])
        parameters = launcher.requests[0]["parameters"]
        assert parameters["tier2Version"] == TIER2_VERSION
        # Spans, not keyframes: the pack chooses which frames of the shot to read.
        assert parameters["shots"] == [
            {"shotIndex": 0, "t0": 0.0, "t1": 4.0},
            {"shotIndex": 1, "t0": 4.0, "t1": 9.0},
        ]
        assert launcher.requests[0]["capability"] == "visual.describe"
        assert launcher.requests[0]["media"]["absolutePath"] == "/media/clip.mp4"

    def test_a_long_asset_is_chunked_to_the_worker_bound(self, handle: PackHandle) -> None:
        spans = [(i, float(i), i + 1.0) for i in range(MAX_SHOTS_PER_REQUEST + 3)]
        launcher = Scripted(
            describe_reply([shot(i) for i in range(MAX_SHOTS_PER_REQUEST)]),
            describe_reply([shot(i) for i in range(MAX_SHOTS_PER_REQUEST, len(spans))]),
        )
        described = run(handle, launcher, spans)
        assert len(launcher.requests) == 2
        assert [item.shot_index for item in described] == list(range(len(spans)))

    def test_an_empty_shot_list_costs_no_process(self, handle: PackHandle) -> None:
        launcher = Scripted()
        assert run(handle, launcher, []) == []
        assert launcher.requests == []

    def test_an_asset_without_a_usable_handle_is_refused(self, handle: PackHandle) -> None:
        client = LocalVisualDescribeClient(handle, launch=Scripted())
        with pytest.raises(PackWorkerError, match="no usable duration"):
            client.describe_shots(
                asset_id="vid",
                media_path="/media/clip.mp4",
                shots=[(0, 0.0, 1.0)],
                duration_seconds=0.0,
                fps=30.0,
            )


class TestDecoding:
    def test_an_answer_becomes_ledger_facts(self, handle: PackHandle) -> None:
        described = run(handle, Scripted(describe_reply([shot(0)])), [(0, 0.0, 4.0)])
        facts = described[0].facts
        assert facts.tier2_version == TIER2_VERSION
        assert facts.model == "framepilot/smolvlm2-2.2b-instruct-q4-k-m"
        assert facts.camera.shot_size is ShotSize.MS
        assert facts.camera.movement is CameraMovement.STATIC
        assert facts.on_screen_text == ["SHIP IT"]
        assert facts.p == 0.9

    def test_the_producing_model_is_taken_from_the_pack_not_assumed(
        self, handle: PackHandle
    ) -> None:
        # A pack that fell back to its low-memory weights must be able to say so; a row
        # always names the model that produced it.
        launcher = Scripted(
            describe_reply([shot(0)], model="framepilot/smolvlm2-500m-instruct-q8-0")
        )
        client = LocalVisualDescribeClient(handle, launch=launcher)
        described = client.describe_shots(
            asset_id="vid",
            media_path="/m.mp4",
            shots=[(0, 0.0, 4.0)],
            duration_seconds=30.0,
            fps=30.0,
        )
        assert described[0].facts.model == "framepilot/smolvlm2-500m-instruct-q8-0"
        assert client.model_id == "framepilot/smolvlm2-500m-instruct-q8-0"

    def test_results_come_back_in_shot_index_order(self, handle: PackHandle) -> None:
        launcher = Scripted(describe_reply([shot(4), shot(1)]))
        described = run(handle, launcher, [(1, 1.0, 2.0), (4, 4.0, 5.0)])
        assert [item.shot_index for item in described] == [1, 4]


class TestRefusals:
    @pytest.mark.parametrize(
        ("reply", "message"),
        [
            (describe_reply([shot(0)], tier2Version=99), "not v"),
            (describe_reply([shot(0)], model=""), "named no producing model"),
            (describe_reply([]), "carried no shots"),
            (describe_reply([cast("dict[str, Any]", "not an object")]), "not an object"),
            (describe_reply([shot(7)]), "unrequested shot"),
            (describe_reply([shot(0, summary="")]), "non-empty summary"),
        ],
    )
    def test_a_malformed_answer_is_a_protocol_failure(
        self, handle: PackHandle, reply: dict[str, Any], message: str
    ) -> None:
        with pytest.raises(PackWorkerError, match=message):
            run(handle, Scripted(reply), [(0, 0.0, 4.0)])

    def test_a_short_answer_is_accepted_and_the_missing_shot_is_simply_absent(
        self, handle: PackHandle
    ) -> None:
        # This used to demand every requested shot come back, on the reasoning that "a
        # short answer would be written as coverage for shots nobody looked at". Backwards:
        # a shot the pack does not return gets NO `described` row, and no row is not
        # coverage. What the rule actually did was throw away the whole batch — up to 16
        # shots — because one frame was featureless enough that the model declined it.
        launcher = Scripted(describe_reply([shot(0)]))
        described = run(handle, launcher, [(0, 0.0, 4.0), (1, 4.0, 9.0)])
        assert [d.shot_index for d in described] == [0]

    def test_one_declined_shot_costs_only_itself_across_a_full_batch(
        self, handle: PackHandle
    ) -> None:
        # The damage the old rule did, at the size it actually did it. A batch is
        # MAX_SHOTS_PER_REQUEST = 16, and refusing a short answer meant a single
        # featureless frame — a fade to black, a lens cap, a leader — threw away the
        # fifteen describable shots beside it, on every pass.
        spans = [(index, index * 2.0, index * 2.0 + 2.0) for index in range(16)]
        answered = [shot(index) for index in range(16) if index != 7]
        described = run(handle, Scripted(describe_reply(answered)), spans)
        assert [d.shot_index for d in described] == [i for i in range(16) if i != 7]

    def test_an_answer_naming_a_shot_nobody_asked_for_is_still_refused(
        self, handle: PackHandle
    ) -> None:
        # The half of that rule that was right, and is kept: a subset is honest, a stranger
        # is a pack that is not speaking the contract.
        launcher = Scripted(describe_reply([shot(7)]))
        with pytest.raises(PackWorkerError, match="unrequested shot"):
            run(handle, launcher, [(0, 0.0, 4.0), (1, 4.0, 9.0)])

    def test_a_capability_the_handle_does_not_claim_is_refused(self, entrypoint: Path) -> None:
        handle = PackHandle(
            pack_id="framepilot.visual-describe",
            version="1.0.0",
            release_digest="a" * 64,
            entrypoint=str(entrypoint),
            capabilities=("visual.embed",),
        )
        with pytest.raises(PackWorkerError, match="does not provide"):
            run(handle, Scripted(describe_reply([shot(0)])), [(0, 0.0, 4.0)])
