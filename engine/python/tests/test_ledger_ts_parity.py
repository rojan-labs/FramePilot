"""Cross-language shot-ledger wire-shape parity (ADR 0175, plan/visual-understanding VU0.4).

The engine WRITES the ledger and the AI SDK READS it, so the two schema declarations are
one contract kept in two languages by hand — exactly the arrangement
``test_brain_client_ts_parity.py`` guards for the brain rows. A field added or renamed on
one side only is a silent loss: ``parseLedgerSnapshot`` degrades to ``null`` and the agent
goes back to being blind, which is the one failure this whole plan exists to prevent.

Same source-reading technique: parse the TS file directly, so the test cannot drift from
the file it checks and needs no build step.
"""

from __future__ import annotations

import re
from pathlib import Path

from pydantic import BaseModel

from framepilot_engine.brain.ledger_models import (
    SHOT_SIZE_LADDER,
    TIER0_VERSION,
    TIER1_VERSION,
    TIER2_VERSION,
    AssetDigest,
    CameraFacts,
    CameraMovement,
    ChromaStats,
    Confident,
    DescribedFacts,
    EntityRef,
    LabelledFacts,
    LedgerSnapshot,
    LumaStats,
    MeasuredFacts,
    MotionClass,
    MotionStats,
    ScreenContent,
    ShotRecord,
    ShotSize,
    SubjectKind,
    TierCoverage,
)

# tests → python → engine → repo root.
_REPO_ROOT = Path(__file__).resolve().parents[3]
_TS_LEDGER = _REPO_ROOT / "packages" / "ai-sdk" / "src" / "ledger.ts"

_ZOD_FIELD_RE = re.compile(r"^\s*(\w+):\s*\w", re.MULTILINE)


def _ts_schema_keys(schema_name: str) -> set[str]:
    """Field keys of one exported `z.object({...})` schema, parsed from source."""
    source = _TS_LEDGER.read_text(encoding="utf-8")
    # Terminator is the first `});`, not `\n});`: a small schema that fits on one line
    # (`Confident`) has no newline before its close, and anchoring on one silently ran the
    # match on into the NEXT schema's body — which is how this helper first "passed" while
    # comparing the wrong object.
    match = re.search(
        rf"export const {schema_name} = z\.object\(\{{(.*?)\}}\);",
        source,
        re.DOTALL,
    )
    assert match is not None, f"Schema {schema_name!r} not found in {_TS_LEDGER}"
    return set(_ZOD_FIELD_RE.findall(match.group(1)))


def _ts_const_array(name: str) -> list[str]:
    """Members of an exported `as const` string-literal array."""
    source = _TS_LEDGER.read_text(encoding="utf-8")
    match = re.search(rf"export const {name} = \[(.*?)\] as const;", source, re.DOTALL)
    assert match is not None, f"Const array {name!r} not found in {_TS_LEDGER}"
    return re.findall(r"'([^']+)'", match.group(1))


def _wire_keys(model: type[BaseModel]) -> set[str]:
    """The camelCase keys the model serializes to (alias when declared)."""
    return {field.alias or name for name, field in model.model_fields.items()}


def test_ts_source_is_readable() -> None:
    assert _TS_LEDGER.is_file(), f"Missing {_TS_LEDGER}"


def test_measured_facts_parity() -> None:
    ts_keys = _ts_schema_keys("MeasuredFactsSchema")
    py_keys = _wire_keys(MeasuredFacts)
    assert ts_keys == py_keys, (
        f"MeasuredFacts drift — TS-only: {sorted(ts_keys - py_keys)}, "
        f"Python-only: {sorted(py_keys - ts_keys)}"
    )


def test_labelled_facts_parity() -> None:
    ts_keys = _ts_schema_keys("LabelledFactsSchema")
    py_keys = _wire_keys(LabelledFacts)
    assert ts_keys == py_keys, (
        f"LabelledFacts drift — TS-only: {sorted(ts_keys - py_keys)}, "
        f"Python-only: {sorted(py_keys - ts_keys)}"
    )


def test_described_facts_parity() -> None:
    ts_keys = _ts_schema_keys("DescribedFactsSchema")
    py_keys = _wire_keys(DescribedFacts)
    assert ts_keys == py_keys, (
        f"DescribedFacts drift — TS-only: {sorted(ts_keys - py_keys)}, "
        f"Python-only: {sorted(py_keys - ts_keys)}"
    )


def test_shot_record_parity() -> None:
    ts_keys = _ts_schema_keys("ShotRecordSchema")
    py_keys = _wire_keys(ShotRecord)
    assert ts_keys == py_keys, (
        f"ShotRecord drift — TS-only: {sorted(ts_keys - py_keys)}, "
        f"Python-only: {sorted(py_keys - ts_keys)}"
    )


def test_asset_digest_parity() -> None:
    ts_keys = _ts_schema_keys("AssetDigestSchema")
    py_keys = _wire_keys(AssetDigest)
    assert ts_keys == py_keys, (
        f"AssetDigest drift — TS-only: {sorted(ts_keys - py_keys)}, "
        f"Python-only: {sorted(py_keys - ts_keys)}"
    )


def test_small_object_parity() -> None:
    """The leaf shapes, checked together — each is small enough that a table is clearer."""
    for schema_name, model in (
        ("LumaStatsSchema", LumaStats),
        ("ChromaStatsSchema", ChromaStats),
        ("MotionStatsSchema", MotionStats),
        ("ConfidentSchema", Confident),
        ("EntityRefSchema", EntityRef),
        ("CameraFactsSchema", CameraFacts),
        ("TierCoverageSchema", TierCoverage),
        ("LedgerSnapshotSchema", LedgerSnapshot),
    ):
        ts_keys = _ts_schema_keys(schema_name)
        py_keys = _wire_keys(model)
        assert ts_keys == py_keys, (
            f"{model.__name__} drift — TS-only: {sorted(ts_keys - py_keys)}, "
            f"Python-only: {sorted(py_keys - ts_keys)}"
        )


def test_motion_stats_class_key_is_not_the_python_field_name() -> None:
    """`class` is a Python keyword, so the field is `motion_class` with an alias.

    Pinned because the obvious "fix" — renaming the field on one side — would break the
    wire silently: Zod would drop an unknown key and every motion word would vanish.
    """
    assert "class" in _wire_keys(MotionStats)
    assert "motion_class" not in _wire_keys(MotionStats)


def test_enum_vocabularies_match() -> None:
    for ts_name, py_enum in (
        ("MOTION_CLASSES", MotionClass),
        ("SUBJECT_KINDS", SubjectKind),
        ("SCREEN_CONTENTS", ScreenContent),
        ("CAMERA_MOVEMENTS", CameraMovement),
    ):
        ts_values = set(_ts_const_array(ts_name))
        py_values = {member.value for member in py_enum}
        assert ts_values == py_values, (
            f"{ts_name} drift — TS-only: {sorted(ts_values - py_values)}, "
            f"Python-only: {sorted(py_values - ts_values)}"
        )


def test_shot_size_ladder_order_matches() -> None:
    """ORDER is the contract here, not just membership.

    A cut-pair delta counts steps on this ladder and a transition policy reads the sign, so
    a ladder reversed on one side would silently invert "wider" and "tighter".
    """
    assert _ts_const_array("SHOT_SIZE_LADDER") == [s.value for s in SHOT_SIZE_LADDER]
    assert [s.value for s in SHOT_SIZE_LADDER] == [s.value for s in ShotSize]


def test_tier_versions_match() -> None:
    source = _TS_LEDGER.read_text(encoding="utf-8")
    for name, value in (
        ("TIER0_VERSION", TIER0_VERSION),
        ("TIER1_VERSION", TIER1_VERSION),
        ("TIER2_VERSION", TIER2_VERSION),
    ):
        match = re.search(rf"export const {name} = (\d+) as const;", source)
        assert match is not None, f"{name} not found in {_TS_LEDGER}"
        assert int(match.group(1)) == value, (
            f"{name} drift — TS {match.group(1)}, Python {value}. A tier version decides "
            "which column is re-queued; a mismatch re-runs the wrong work or none at all."
        )
