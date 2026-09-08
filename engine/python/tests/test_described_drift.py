"""The Visual Describe pack's mirror of the structured contract must not drift.

``workers/visual-describe`` carries a copy of the schema, the prompt, the closed
vocabularies and the keyframe rule because a Capability Pack has no import path into the
engine (ADR 0114). A copy that drifted would describe footage against a schema the engine
did not choose, and ``TIER2_VERSION`` would say nothing had changed — the exact failure the
prompt-bank mirror test exists to prevent for tier 1.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path
from types import ModuleType

import pytest

from framepilot_engine.brain import described as engine_described
from framepilot_engine.brain.ledger_models import TIER2_VERSION

REPO_ROOT = Path(__file__).resolve().parents[3]
WORKER_SRC = REPO_ROOT / "workers" / "visual-describe" / "src"


def _pack(module: str) -> ModuleType:
    """Import one pack module from the worker's source tree, without installing it.

    The worker is a separate artifact project with its own `pyproject.toml`, so it is not
    on the engine's import path. Putting its `src/` there for the duration of this module
    is the cheapest way to compare the two copies as the PYTHON they are, rather than as
    text — which is what catches a mirror that was edited in a way the eye would miss.
    """
    if str(WORKER_SRC) not in sys.path:
        sys.path.insert(0, str(WORKER_SRC))
    return importlib.import_module(f"framepilot_visual_describe.{module}")


@pytest.fixture(scope="module")
def mirror() -> ModuleType:
    return _pack("schema")


class TestSchemaParity:
    def test_the_json_schema_is_byte_identical(self, mirror: ModuleType) -> None:
        assert mirror.DESCRIBED_JSON_SCHEMA == engine_described.DESCRIBED_JSON_SCHEMA

    def test_the_instruction_is_identical(self, mirror: ModuleType) -> None:
        # The prompt IS the meaning of every stored field: two producers asked different
        # questions produce answers that cannot be compared, however identical the shape.
        assert mirror.DESCRIBE_INSTRUCTION == engine_described.DESCRIBE_INSTRUCTION

    def test_the_schema_name_is_identical(self, mirror: ModuleType) -> None:
        assert mirror.DESCRIBED_SCHEMA_NAME == engine_described.DESCRIBED_SCHEMA_NAME

    def test_the_closed_vocabularies_are_identical(self, mirror: ModuleType) -> None:
        assert mirror.QUALITY_VOCABULARY == engine_described.QUALITY_VOCABULARY
        assert mirror.CAMERA_ANGLES == engine_described.CAMERA_ANGLES
        assert mirror.UNKNOWN == engine_described.UNKNOWN
        assert tuple(mirror.CONFIDENCE_LEVELS) == tuple(engine_described.CONFIDENCE_BUCKETS)

    def test_the_bounds_are_identical(self, mirror: ModuleType) -> None:
        for name in (
            "MAX_SUMMARY_CHARS",
            "MAX_FIELD_CHARS",
            "MAX_ON_SCREEN_TEXT_ITEMS",
            "MAX_ON_SCREEN_TEXT_CHARS",
            "MAX_QUALITY_ITEMS",
        ):
            assert getattr(mirror, name) == getattr(engine_described, name), name

    def test_the_pack_ships_the_ledger_tier_version(self, mirror: ModuleType) -> None:
        # A request naming another version is refused by the worker, so these coming apart
        # would make every description request fail rather than silently mismatch.
        assert mirror.TIER2_VERSION == TIER2_VERSION


class TestKeyframeParity:
    """Both arms must read the SAME pictures, or "hosted and local agree" is untestable."""

    @pytest.fixture(scope="class")
    @classmethod
    def policy(cls) -> ModuleType:
        return _pack("policy")

    @pytest.mark.parametrize(
        ("t0", "t1"),
        [(0.0, 10.0), (4.0, 4.2), (0.0, 0.5), (1.0, 1.6), (12.5, 13.25), (0.0, 3.0)],
    )
    def test_the_pack_and_the_engine_choose_the_same_frames(
        self, policy: ModuleType, t0: float, t1: float
    ) -> None:
        span = policy.ShotSpan(shot_index=0, t0=t0, t1=t1)
        assert policy.keyframe_times(span) == pytest.approx(engine_described.keyframe_times(t0, t1))

    def test_the_span_thresholds_are_identical(self, policy: ModuleType) -> None:
        assert policy.MIN_MULTI_FRAME_SPAN == engine_described.MIN_MULTI_FRAME_SPAN
