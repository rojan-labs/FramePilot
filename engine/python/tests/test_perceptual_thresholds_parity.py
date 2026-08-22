"""Cross-language parity for the perceptual gate thresholds.

The agent-side temporal review and the export validator judge the same two concerns (audio
peak, black frames) on two different signals, so they legitimately hold different numbers.
They must not hold them *independently*: in a captured run the review failed an audio window
at +0.089 dBFS while the exporter's ceiling sat at +1.0, and nothing in either file explained
the difference or would have caught one being retuned alone.

``packages/ai-sdk/src/perceptual-thresholds.ts`` is the source of truth. This test reads it
directly (the source-reading pattern of ``test_brain_client_ts_parity.py`` — no build step, so
it cannot drift from the file it checks) and compares every value against the Python mirror.
"""

from __future__ import annotations

import re
from pathlib import Path

from framepilot_engine.validation.perceptual_thresholds import (
    EXPORT_MAX_AUDIO_DBFS,
    EXPORT_MAX_BLACK_RATIO,
    REVIEW_BLACK_FRAME_RATIO,
    REVIEW_MAX_AUDIO_DBFS,
)
from framepilot_engine.validation.render_validation import ExpectedRender

# tests → python → engine → repo root.
_REPO_ROOT = Path(__file__).resolve().parents[3]
_TS_THRESHOLDS = _REPO_ROOT / "packages" / "ai-sdk" / "src" / "perceptual-thresholds.ts"

# `value: FULL_SCALE_DBFS - 0.1,` / `value: FULL_SCALE_DBFS + 1,` / `value: 0.98,`
_VALUE_RE = re.compile(
    r"^\s*(?P<key>\w+):\s*\{\s*$"  # the entry name, opening its object
    r"(?P<body>[^}]*?)"  # up to its closing brace
    r"^\s*\},",
    re.MULTILINE | re.DOTALL,
)
_FULL_SCALE_RE = re.compile(r"const FULL_SCALE_DBFS = (-?\d+(?:\.\d+)?);")
_ENTRY_VALUE_RE = re.compile(
    r"value:\s*(?:FULL_SCALE_DBFS\s*(?P<op>[-+])\s*(?P<delta>\d+(?:\.\d+)?)|(?P<literal>-?\d+(?:\.\d+)?))"
)


def _ts_values() -> dict[str, float]:
    """Every `value:` in the TS table, keyed by its entry name, arithmetic resolved."""
    source = _TS_THRESHOLDS.read_text(encoding="utf-8")
    full_scale_match = _FULL_SCALE_RE.search(source)
    assert full_scale_match is not None, "FULL_SCALE_DBFS is no longer declared"
    full_scale = float(full_scale_match.group(1))

    values: dict[str, float] = {}
    for entry in _VALUE_RE.finditer(source):
        value_match = _ENTRY_VALUE_RE.search(entry.group("body"))
        if value_match is None:
            continue
        if value_match.group("literal") is not None:
            values[entry.group("key")] = float(value_match.group("literal"))
            continue
        delta = float(value_match.group("delta"))
        values[entry.group("key")] = (
            full_scale + delta if value_match.group("op") == "+" else full_scale - delta
        )
    return values


def _ts_boundary_jump_db() -> float:
    source = _TS_THRESHOLDS.read_text(encoding="utf-8")
    match = re.search(r"MAX_AUDIO_BOUNDARY_JUMP_DB = (\d+(?:\.\d+)?)", source)
    assert match is not None, "MAX_AUDIO_BOUNDARY_JUMP_DB is no longer declared"
    return float(match.group(1))


def test_ts_table_declares_every_threshold_this_module_mirrors() -> None:
    """A renamed or removed TS entry must break here rather than drift silently."""
    values = _ts_values()
    assert {"review", "export", "reviewFrameRatio", "exportDurationRatio"} <= set(values)


def test_python_mirrors_the_ts_audio_peak_ceilings() -> None:
    values = _ts_values()
    assert values["review"] == REVIEW_MAX_AUDIO_DBFS
    assert values["export"] == EXPORT_MAX_AUDIO_DBFS


def test_python_mirrors_the_ts_black_frame_ceilings() -> None:
    values = _ts_values()
    assert values["reviewFrameRatio"] == REVIEW_BLACK_FRAME_RATIO
    assert values["exportDurationRatio"] == EXPORT_MAX_BLACK_RATIO


def test_export_validation_defaults_come_from_the_shared_table() -> None:
    """The validator's own defaults are the table's, not a second copy of the numbers."""
    expected = ExpectedRender()
    assert expected.max_audio_dbfs == EXPORT_MAX_AUDIO_DBFS
    assert expected.max_black_ratio == EXPORT_MAX_BLACK_RATIO


def test_the_review_ceiling_is_stricter_than_the_export_ceiling() -> None:
    """The ordering is the whole point: catch it pre-encode, refuse it post-encode."""
    assert REVIEW_MAX_AUDIO_DBFS < EXPORT_MAX_AUDIO_DBFS
    assert REVIEW_BLACK_FRAME_RATIO > EXPORT_MAX_BLACK_RATIO
    assert _ts_boundary_jump_db() == 12.0
