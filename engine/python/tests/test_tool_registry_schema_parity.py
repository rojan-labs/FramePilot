"""Cross-language AI tool schema parity.

The committed fixture is generated from the canonical TS registry. Python must match
its tool kind, availability, mutation flag, and normalized argument schema with no
known-drift/xfail allowlist. Renderer-backed semantic rules that are stricter than the
raw registry are covered separately in ``test_tool_contract_overrides.py``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from framepilot_engine.ai_tools import TOOL_REGISTRY

_FIXTURE = Path(__file__).resolve().parent / "fixtures" / "ts_tool_registry.json"
_GENERATOR = "pnpm --filter @framepilot/ai-sdk generate:tool-parity"
_NORMALIZATION_VERSION = 2
_BOUNDS = ("minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum")
_MAX_SAFE_INTEGER = 9007199254740991


def _load_fixture() -> dict[str, Any]:
    if not _FIXTURE.is_file():
        pytest.fail(f"Missing {_FIXTURE}. Regenerate with: {_GENERATOR}")
    loaded: dict[str, Any] = json.loads(_FIXTURE.read_text(encoding="utf-8"))
    return loaded


def _resolve_ref(node: dict[str, Any], defs: dict[str, Any]) -> dict[str, Any]:
    ref = node.get("$ref")
    if not isinstance(ref, str):
        return node
    name = ref.removeprefix("#/$defs/")
    target = defs.get(name)
    if target is None:
        raise AssertionError(f"unresolvable $ref: {ref}")
    return {**target, **{key: value for key, value in node.items() if key != "$ref"}}


def _type_list(node: dict[str, Any]) -> list[str]:
    declared = node.get("type")
    if isinstance(declared, str):
        return [] if declared == "null" else [declared]
    if isinstance(declared, list):
        return sorted({str(value) for value in declared} - {"null"})
    return []


def _is_null_arm(node: Any) -> bool:
    if not isinstance(node, dict):
        return False
    declared = node.get("type")
    if declared == "null":
        return True
    return isinstance(declared, list) and set(declared) == {"null"}


def _has_default(properties: Any, name: str, defs: dict[str, Any]) -> bool:
    """True when a property supplies its own value if the caller omits it.

    Zod lists a `.default(x)` field in `required` even though `parse({})` succeeds and
    fills the default in; Pydantic leaves a defaulted field out of `required`. Comparing
    the raw lists would either force Python to reject calls TS accepts, or hide real
    drift. `required` therefore means "the caller must supply this" on both sides.
    """
    if not isinstance(properties, dict):
        return False
    prop = properties.get(name)
    if not isinstance(prop, dict):
        return False
    return "default" in _resolve_ref(prop, defs)


def _normalize(node: Any, defs: dict[str, Any]) -> Any:
    if not isinstance(node, dict):
        return node
    schema = _resolve_ref(node, defs)
    union = schema.get("anyOf") or schema.get("oneOf")
    if isinstance(union, list):
        arms = [member for member in union if not _is_null_arm(member)]
        members = [_normalize(member, defs) for member in arms]
        if len(members) == 1:
            return members[0]
        type_only = all(
            isinstance(member, dict) and list(member.keys()) == ["type"] for member in members
        )
        if type_only:
            union_types: set[str] = set()
            for member in members:
                union_types.update(member["type"])
            return {"type": sorted(union_types)}
        return {"anyOf": sorted(members, key=lambda member: json.dumps(member, sort_keys=True))}

    out: dict[str, Any] = {}
    types = _type_list(schema)
    if types:
        out["type"] = types
    enum = schema.get("enum")
    if isinstance(enum, list):
        out["enum"] = sorted(enum, key=str)
    # Only a closed object (`additionalProperties: false`) is a real restriction, and
    # both generators spell that the same way. Zod spells an open record's value schema
    # as `{}` while Pydantic spells it `true`; those are identical in JSON Schema, so
    # comparing them would flag generator idiom as drift. A Pydantic model that forgot
    # `extra="forbid"` omits the keyword entirely and still mismatches TS's `false`.
    additional = schema.get("additionalProperties")
    if additional is False:
        out["additionalProperties"] = False
    properties = schema.get("properties")
    required = schema.get("required")
    if isinstance(required, list):
        # Omit an empty list: Pydantic drops `required` entirely when nothing is
        # mandatory, while Zod can still emit `[]` once defaulted fields are filtered.
        mandatory = sorted(name for name in required if not _has_default(properties, name, defs))
        if mandatory:
            out["required"] = mandatory
    if isinstance(properties, dict):
        out["properties"] = {
            key: _normalize(properties[key], defs) for key in sorted(properties)
        }
    items = schema.get("items")
    if isinstance(items, dict):
        out["items"] = _normalize(items, defs)
    for bound in _BOUNDS:
        value = schema.get(bound)
        if (
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and abs(value) != _MAX_SAFE_INTEGER
        ):
            out[bound] = float(value)
    return out


def _normalize_floats(node: Any) -> Any:
    if isinstance(node, dict):
        return {
            key: (
                float(value)
                if key in _BOUNDS and isinstance(value, (int, float))
                else _normalize_floats(value)
            )
            for key, value in node.items()
        }
    if isinstance(node, list):
        return [_normalize_floats(value) for value in node]
    return node


def _python_normalized(name: str) -> Any:
    schema = TOOL_REGISTRY[name].input_schema
    defs = schema.get("$defs", {}) if isinstance(schema, dict) else {}
    return _normalize(schema, defs)


def _expected_tools() -> dict[str, Any]:
    fixture = _load_fixture()
    return {
        name: spec for name, spec in fixture["tools"].items() if not spec["hostUiOnly"]
    }


def test_fixture_is_present_and_versioned() -> None:
    fixture = _load_fixture()
    assert fixture["normalizationVersion"] == _NORMALIZATION_VERSION
    assert fixture["toolCount"] > 30
    assert "trim_clip" in fixture["tools"]


def test_fixture_covers_the_same_tool_names_as_python() -> None:
    expected = set(_expected_tools())
    actual = set(TOOL_REGISTRY)
    missing_in_python = sorted(expected - actual)
    missing_in_ts = sorted(actual - expected)
    assert not missing_in_python, f"Tools in TS but missing from Python: {missing_in_python}"
    assert not missing_in_ts, f"Tools in Python but missing from TS: {missing_in_ts}"


@pytest.mark.parametrize("tool_name", sorted(_expected_tools()))
def test_python_tool_metadata_matches_ts(tool_name: str) -> None:
    expected = _expected_tools()[tool_name]
    tool = TOOL_REGISTRY[tool_name]
    assert tool.kind == expected["kind"], (
        f"{tool_name}: kind drift — TS {expected['kind']!r}, Python {tool.kind!r}"
    )
    assert tool.available == expected["available"], (
        f"{tool_name}: availability drift — TS {expected['available']}, Python {tool.available}"
    )
    assert tool.mutating == expected["mutates"], (
        f"{tool_name}: mutation drift — TS {expected['mutates']}, Python {tool.mutating}"
    )


@pytest.mark.parametrize("tool_name", sorted(_expected_tools()))
def test_python_tool_schema_matches_ts_without_drift_allowlist(tool_name: str) -> None:
    expected = _normalize_floats(_expected_tools()[tool_name]["schema"])
    actual = _python_normalized(tool_name)
    assert actual == expected, (
        f"{tool_name}: argument-schema drift between TS and Python.\n"
        f"  TS     : {json.dumps(expected, sort_keys=True)}\n"
        f"  Python : {json.dumps(actual, sort_keys=True)}\n"
        "No known-drift allowlist exists. Mirror the contract in ai_tools/contract_overrides.py "
        f"or regenerate the TS fixture after an intentional TS registry change: {_GENERATOR}"
    )
