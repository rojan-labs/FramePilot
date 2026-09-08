"""The bank's own arithmetic. The engine holds the cross-repository drift test."""

from __future__ import annotations

import pytest

from framepilot_visual_embed.prompt_bank import (
    PROMPT_BANK_VERSION,
    PROMPT_GROUPS,
    all_prompts,
    bank_digest,
    best_label,
    group_named,
    prompt_index,
    softmax,
)


def test_every_phrase_is_a_photograph() -> None:
    assert all(prompt.startswith("a photo of ") for prompt in all_prompts())


def test_the_bank_has_four_groups_and_a_stable_total_order() -> None:
    assert [group.name for group in PROMPT_GROUPS] == [
        "shotSize",
        "subjectKind",
        "setting",
        "screenContent",
    ]
    assert len(all_prompts()) == sum(len(group.labels) for group in PROMPT_GROUPS)
    assert len(set(all_prompts())) == len(all_prompts())


def test_prompt_index_points_into_the_flat_order() -> None:
    for group in PROMPT_GROUPS:
        for label in group.labels:
            index = prompt_index(group.name, label)
            assert all_prompts()[index] == group.prompts[group.labels.index(label)]


def test_prompt_index_refuses_an_unknown_group_or_label() -> None:
    with pytest.raises(KeyError):
        prompt_index("vibe", "x")
    with pytest.raises(ValueError):
        prompt_index("shotSize", "XCU")


def test_the_digest_covers_the_version_and_every_phrase() -> None:
    # A version number only invalidates what somebody remembered to bump; this is the
    # value the engine's drift test compares.
    assert len(bank_digest()) == 64
    assert PROMPT_BANK_VERSION >= 1


def test_softmax_is_stable_under_large_logits() -> None:
    probabilities = softmax([1000.0, 999.0, 0.0])
    assert sum(probabilities) == pytest.approx(1.0)
    assert probabilities[0] > probabilities[1] > probabilities[2]


def test_softmax_refuses_a_non_positive_temperature() -> None:
    with pytest.raises(ValueError, match="temperature"):
        softmax([1.0], temperature=0.0)


def test_best_label_breaks_ties_on_label_order() -> None:
    group = group_named("screenContent")
    value, probability = best_label("screenContent", [0.0] * len(group.labels))
    assert value == group.labels[0]
    assert probability == pytest.approx(1.0 / len(group.labels))


def test_best_label_refuses_a_score_count_that_is_not_the_group() -> None:
    with pytest.raises(ValueError, match="labels but"):
        best_label("shotSize", [0.0, 1.0])
