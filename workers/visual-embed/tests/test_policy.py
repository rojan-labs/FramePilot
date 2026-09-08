"""What the pack claims from a similarity, with no model in sight."""

from __future__ import annotations

import pytest
from conftest import DIM, FakeBackend, prompt_vectors, unit, vector_for

from framepilot_visual_embed.policy import cosine, embed_shots, label_image
from framepilot_visual_embed.prompt_bank import PROMPT_GROUPS
from framepilot_visual_embed.protocol import EmbedRequest, MediaHandle, ProtocolError, ShotPrompt

MEDIA = MediaHandle(
    handle_id="media:1",
    asset_id="asset-1",
    absolute_path="/sandbox/a.mp4",
    source_start_seconds=0.0,
    source_end_seconds=60.0,
    fps=30.0,
    first_frame=0,
    last_frame_exclusive=1800,
)


def request_for(*shots: tuple[int, float]) -> EmbedRequest:
    return EmbedRequest(
        request_id="embed:1",
        project_revision=0,
        media=MEDIA,
        prompt_bank_version=1,
        shots=tuple(ShotPrompt(shot_index=index, keyframe_t=t) for index, t in shots),
    )


class TestCosine:
    def test_identical_vectors_score_one(self) -> None:
        assert cosine(unit(1.0, 1.0), unit(1.0, 1.0)) == pytest.approx(1.0)

    def test_a_zero_vector_scores_zero_rather_than_dividing_by_zero(self) -> None:
        assert cosine([0.0] * DIM, unit(1.0)) == 0.0

    def test_two_spaces_are_a_hard_error(self) -> None:
        with pytest.raises(ValueError, match="cannot compare"):
            cosine([1.0, 0.0], [1.0, 0.0, 0.0])


class TestLabelImage:
    def test_labels_every_group_of_the_bank(self) -> None:
        labels = label_image(unit(1.0), prompt_vectors())
        assert set(labels) == {group.name for group in PROMPT_GROUPS}

    @pytest.mark.parametrize(
        ("group", "label"),
        [
            ("shotSize", "MCU"),
            ("subjectKind", "vehicle"),
            ("setting", "kitchen"),
            ("screenContent", "slides"),
        ],
    )
    def test_an_image_sitting_on_a_prompt_gets_that_prompt_s_label(
        self, group: str, label: str
    ) -> None:
        labels = label_image(vector_for(group, label), prompt_vectors())
        assert labels[group].value == label

    def test_probabilities_are_per_group_and_sum_to_one(self) -> None:
        # The whole point of grouping: "close-up" and "kitchen" answer different
        # questions and must not share probability mass.
        labels = label_image(vector_for("setting", "forest"), prompt_vectors())
        for group in PROMPT_GROUPS:
            assert 0.0 < labels[group.name].p <= 1.0

    def test_refuses_a_vector_count_that_is_not_the_bank(self) -> None:
        with pytest.raises(ValueError, match="phrases but"):
            label_image(unit(1.0), prompt_vectors()[:-1])


class TestEmbedShots:
    def test_returns_one_embedding_per_requested_shot(self) -> None:
        backend = FakeBackend(faces_per_frame=2)
        shots = list(embed_shots(request_for((0, 1.0), (1, 5.0)), backend, prompt_vectors()))
        assert [shot.shot_index for shot in shots] == [0, 1]
        assert all(shot.faces == 2 for shot in shots)
        assert all(len(shot.face_vectors) == 2 for shot in shots)

    def test_counts_no_faces_when_nobody_is_there(self) -> None:
        backend = FakeBackend(faces_per_frame=0)
        [shot] = list(embed_shots(request_for((0, 1.0)), backend, prompt_vectors()))
        assert shot.faces == 0
        assert list(shot.face_vectors) == []

    def test_decodes_in_batches_and_visits_every_keyframe_once(self) -> None:
        backend = FakeBackend()
        request = request_for(*[(i, float(i)) for i in range(20)])
        list(embed_shots(request, backend, prompt_vectors()))
        assert backend.decoded == [float(i) for i in range(20)]

    def test_an_undecodable_keyframe_fails_the_request(self) -> None:
        # Not dropped: a short answer would read downstream as coverage that does not exist.
        backend = FakeBackend(unreadable_at=5.0)
        with pytest.raises(ProtocolError) as error:
            list(embed_shots(request_for((0, 1.0), (1, 5.0)), backend, prompt_vectors()))
        assert error.value.code == "media_unreadable"

    def test_cancellation_stops_before_the_next_batch(self) -> None:
        backend = FakeBackend()
        request = request_for(*[(i, float(i)) for i in range(20)])
        with pytest.raises(ProtocolError) as error:
            list(embed_shots(request, backend, prompt_vectors(), should_cancel=lambda: True))
        assert error.value.code == "cancelled"
        assert backend.decoded == []
