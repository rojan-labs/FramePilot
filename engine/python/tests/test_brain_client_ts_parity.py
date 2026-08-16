"""Cross-language brain analysis wire-shape parity (plan B1.4).

``GET /brain/analysis`` serializes the Pydantic ``AnalysisResultRow`` /
``BrainAnalysisResponse`` models (by camelCase alias — FastAPI's default);
the TS side re-validates that payload with the Zod schemas in
``packages/ai-sdk/src/brain-client.ts`` before warming the semantic index.
A field renamed/added on one side and not the other is a silent warm-data
loss (Zod ``safeParse`` fails → the reader honestly degrades to "no brain"),
so the two schemas MUST declare the same key set.

Mirrors the source-reading pattern of ``test_tool_registry_ts_parity.py``:
parse the TS source directly (no build step), so this test can never drift
from the file it checks.
"""

from __future__ import annotations

import re
from pathlib import Path

from pydantic import BaseModel

from framepilot_engine.brain.models import AnalysisResultRow, SessionContext
from framepilot_engine.service import BrainAnalysisResponse, VisualStatusResponse

# tests → python → engine → repo root.
_REPO_ROOT = Path(__file__).resolve().parents[3]
_AI_SDK_SRC = _REPO_ROOT / "packages" / "ai-sdk" / "src"
_TS_BRAIN_CLIENT = _AI_SDK_SRC / "brain-client.ts"
# The visual-index status schema lives here and is REUSED by brain-client.ts (MI6.2);
# it must mirror the engine's VisualStatusResponse just like the brain-client schemas.
_TS_VISUAL_INDEX_CLIENT = _AI_SDK_SRC / "visual-index-client.ts"

# One Zod object field inside an already-extracted `z.object({...})` body:
# `  assetId: z.string(),` / `  results: z.array(...)` / `  lastJob: visualJobStatusSchema`.
# The value is a Zod expression (`z.`) OR a reference to another schema, so we anchor on
# `name:` followed by a word char (skips `/**`/`*` JSDoc lines, whose first non-space is
# not a word char). Non-schema object literals elsewhere in the file are already excluded
# by the per-schema `re.search` that extracts the body this runs against.
_ZOD_FIELD_RE = re.compile(r"^\s*(\w+):\s*\w", re.MULTILINE)


def _ts_schema_keys(schema_name: str, source_path: Path = _TS_BRAIN_CLIENT) -> set[str]:
    """Field keys of one exported `z.object({...})` schema, parsed from source."""
    source = source_path.read_text(encoding="utf-8")
    match = re.search(
        rf"export const {schema_name} = z\.object\(\{{(.*?)\n\}}\);",
        source,
        re.DOTALL,
    )
    assert match is not None, f"Schema {schema_name!r} not found in {source_path}"
    return set(_ZOD_FIELD_RE.findall(match.group(1)))


def _wire_keys(model: type[BaseModel]) -> set[str]:
    """The camelCase keys the model serializes to (alias when declared)."""
    return {field.alias or name for name, field in model.model_fields.items()}


def test_ts_source_is_readable() -> None:
    assert _TS_BRAIN_CLIENT.is_file(), f"Missing {_TS_BRAIN_CLIENT}"


def test_analysis_result_row_parity() -> None:
    ts_keys = _ts_schema_keys("analysisResultRowSchema")
    py_keys = _wire_keys(AnalysisResultRow)
    assert ts_keys == py_keys, (
        f"AnalysisResultRow wire-shape drift — TS-only: {sorted(ts_keys - py_keys)}, "
        f"Python-only: {sorted(py_keys - ts_keys)}"
    )


def test_brain_analysis_response_parity() -> None:
    ts_keys = _ts_schema_keys("brainAnalysisResponseSchema")
    py_keys = _wire_keys(BrainAnalysisResponse)
    assert ts_keys == py_keys, (
        f"BrainAnalysisResponse wire-shape drift — TS-only: {sorted(ts_keys - py_keys)}, "
        f"Python-only: {sorted(py_keys - ts_keys)}"
    )


def test_visual_status_response_parity() -> None:
    """``GET /brain/visual/status`` (plan MI4.3/MI6.2).

    The Zod ``visualStatusResponseSchema`` (declared in visual-index-client.ts,
    reused by brain-client.ts's status reader) re-validates the engine's
    ``VisualStatusResponse`` payload; a field added on one side and not the other
    silently drops the status line the orchestrator relies on to know when it can
    see. The two schemas MUST declare the same key set.
    """
    ts_keys = _ts_schema_keys("visualStatusResponseSchema", _TS_VISUAL_INDEX_CLIENT)
    py_keys = _wire_keys(VisualStatusResponse)
    assert ts_keys == py_keys, (
        f"VisualStatusResponse wire-shape drift — TS-only: {sorted(ts_keys - py_keys)}, "
        f"Python-only: {sorted(py_keys - ts_keys)}"
    )


def test_session_context_parity() -> None:
    """``POST /brain/session-context`` (plan B6.3).

    ``status`` is Python-only by design: the TS digest never reads the embedded
    brain health report, so the Zod schema deliberately does not declare it
    (Zod ignores unknown keys — an undeclared field is dropped, not a parse
    failure). Every field the TS side DOES declare must exist in Python.
    """
    ts_keys = _ts_schema_keys("sessionContextResponseSchema")
    py_keys = _wire_keys(SessionContext)
    assert ts_keys <= py_keys, (
        f"SessionContext wire-shape drift — declared in TS but missing from "
        f"Python: {sorted(ts_keys - py_keys)}"
    )
    assert py_keys - ts_keys == {"status"}, (
        f"Unexpected Python-only session-context fields: {sorted(py_keys - ts_keys - {'status'})}"
    )
