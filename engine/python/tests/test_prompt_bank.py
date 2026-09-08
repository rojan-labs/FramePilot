"""The zero-shot prompt bank, and its two contracts with the rest of the system.

The bank is versioned data, not a string literal, so what has to hold is:

1. **Its labels are exactly the ledger's closed vocabularies.** A phrase for a label
   ``LabelledFacts`` cannot store would be a fact nothing can read; a ledger value with no
   phrase would be a label the model can never produce.
2. **The pack's mirror does not drift.** ``workers/visual-embed`` carries a copy because a
   Capability Pack has no import path into the engine (ADR 0114). A copy that drifted
   would label footage against sentences the engine did not choose, and the version number
   would say nothing had changed.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest

from framepilot_engine.analysis import prompt_bank
from framepilot_engine.analysis.prompt_bank import (
    PROMPT_BANK_VERSION,
    PROMPT_GROUPS,
    all_prompts,
    bank_digest,
    best_label,
    group_named,
    softmax,
)
from framepilot_engine.brain.ledger_models import (
    TIER1_VERSION,
    ScreenContent,
    ShotSize,
    SubjectKind,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
MIRROR = (
    REPO_ROOT / "workers" / "visual-embed" / "src" / "framepilot_visual_embed" / "prompt_bank.py"
)


def _mirror() -> ModuleType:
    """Import the pack's copy directly from disk, without installing the worker."""
    spec = importlib.util.spec_from_file_location("visual_embed_prompt_bank", MIRROR)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # Registered before execution because `@dataclass(slots=True)` rebuilds the class and
    # looks its module up in `sys.modules`; an unregistered module fails on import.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class TestLedgerVocabularyParity:
    def test_shot_size_labels_are_the_ledger_ladder(self) -> None:
        assert group_named("shotSize").labels == tuple(size.value for size in ShotSize)

    def test_subject_kind_labels_are_the_ledger_enum(self) -> None:
        assert set(group_named("subjectKind").labels) == {kind.value for kind in SubjectKind}

    def test_screen_content_labels_are_the_ledger_enum(self) -> None:
        assert set(group_named("screenContent").labels) == {
            content.value for content in ScreenContent
        }

    def test_setting_is_the_one_open_ended_group_and_is_still_closed(self) -> None:
        # `LabelledFacts.setting` is a free `Confident`, so the ledger cannot police it.
        # The bank is therefore the only closed list there is, and it must stay one.
        settings = group_named("setting").labels
        assert len(settings) == len(set(settings)) == 20

    def test_tier1_version_is_the_bank_version(self) -> None:
        # Bumping the bank re-queues labelling and nothing else; if these ever came apart,
        # a re-phrased prompt would leave stale labels in place with a version that
        # claimed they were current.
        assert TIER1_VERSION == PROMPT_BANK_VERSION


class TestPackMirror:
    def test_the_mirror_exists_where_the_worker_expects_it(self) -> None:
        assert MIRROR.is_file()

    def test_the_mirror_agrees_on_version_and_digest(self) -> None:
        mirror = _mirror()
        assert mirror.PROMPT_BANK_VERSION == PROMPT_BANK_VERSION
        assert mirror.bank_digest() == bank_digest()

    def test_the_mirror_agrees_phrase_for_phrase(self) -> None:
        mirror = _mirror()
        assert mirror.all_prompts() == all_prompts()
        assert [(g.name, g.labels, g.descriptors) for g in mirror.PROMPT_GROUPS] == [
            (g.name, g.labels, g.descriptors) for g in PROMPT_GROUPS
        ]

    def test_the_mirror_is_byte_identical_below_its_docstring(self) -> None:
        marker = "from __future__ import annotations"
        engine_source = Path(prompt_bank.__file__).read_text(encoding="utf-8")
        mirror_source = MIRROR.read_text(encoding="utf-8")
        assert (
            mirror_source[mirror_source.index(marker) :]
            == engine_source[engine_source.index(marker) :]
        )


class TestBankArithmetic:
    def test_every_phrase_is_phrased_as_a_photograph(self) -> None:
        assert all(prompt.startswith("a photo of ") for prompt in all_prompts())

    def test_the_flat_order_is_group_order_then_label_order(self) -> None:
        expected = [prompt for group in PROMPT_GROUPS for prompt in group.prompts]
        assert list(all_prompts()) == expected
        assert len(set(all_prompts())) == len(all_prompts())

    def test_softmax_survives_the_logit_scale_a_contrastive_model_uses(self) -> None:
        # Cosines divided by 0.01 reach ~100; exp(100) overflows without the shift.
        probabilities = softmax([0.9, 0.1, -0.4], temperature=0.01)
        assert sum(probabilities) == pytest.approx(1.0)
        assert probabilities[0] > probabilities[1] > probabilities[2]

    def test_best_label_is_deterministic_on_a_tie(self) -> None:
        labels = group_named("subjectKind").labels
        assert best_label("subjectKind", [0.0] * len(labels))[0] == labels[0]

    def test_best_label_refuses_scores_that_are_not_the_group(self) -> None:
        with pytest.raises(ValueError, match="labels but"):
            best_label("setting", [1.0, 2.0])
