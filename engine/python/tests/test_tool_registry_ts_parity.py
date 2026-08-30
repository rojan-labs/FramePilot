"""Cross-language AI tool registry parity (plan Phase 4, PRD §8.3).

The TS tool registry (``packages/ai-sdk/src/tool-registry.ts``) is the single
source of truth for which tools the AI may call. The Python mirror
(:mod:`framepilot_engine.ai_tools.registry`) MUST expose the exact same tool
*name* set: Python's dispatcher validates args with Pydantic
``ConfigDict(extra="forbid")``, so any tool name it does not recognize is
rejected outright — a tool present on one side and missing on the other is a
silent capability gap (TS calls it, Python 4xxs) or a silent security hole
(Python accepts a name TS never declared).

Mirrors the cross-language guard already established for the project schema
(``test_schema_parity.py``): read the TS source directly (no build step
required) rather than requiring a committed JSON fixture, so this test can
never itself drift from the TS file it is checking.
"""

from __future__ import annotations

import re
from pathlib import Path

from framepilot_engine.ai_tools.registry import TOOL_REGISTRY

# tests → python → engine → repo root.
_REPO_ROOT = Path(__file__).resolve().parents[3]
_AI_SDK_SRC = _REPO_ROOT / "packages" / "ai-sdk" / "src"
_TS_TOOL_REGISTRY = _AI_SDK_SRC / "tool-registry.ts"
#: Domain-owned tool modules composed into the same public manifest (P1.2).
#:
#: A tool's *file* is an organisational choice; which names exist is the contract
#: this test guards. Reading only the registry file would have quietly narrowed
#: that contract every time a family moved out of it — the moved tools would stop
#: being compared rather than start failing.
_TS_DOMAIN_TOOLS = _AI_SDK_SRC / "domain-tools"


def _ts_sources() -> list[str]:
    """Every TS source that declares a registered tool, one entry per file.

    Deliberately NOT concatenated. `_SPEC_BODY_RE` reads a spec's body as
    everything up to the next `name:` declaration, so joining the files lets the
    last spec in one file absorb the first flag in the next — which is exactly
    what happened: `remove_marker` inherited `hostUiOnly: true` from `askTool` in
    `tool-factories.ts` and vanished from the compared set. A file boundary is a
    hard boundary for that scan.
    """
    sources = [_TS_TOOL_REGISTRY.read_text(encoding="utf-8")]
    sources.extend(
        path.read_text(encoding="utf-8")
        for path in sorted(_TS_DOMAIN_TOOLS.glob("*.ts"))
        if not path.name.endswith(".test.ts")
    )
    return sources


# Matches a tool spec's `name: 'snake_case_name'` declaration. Tool names are
# always lower-snake-case (PRD §8.3), which lets this regex skip unrelated
# `name: '...'` object-literal fields elsewhere in the file (e.g. the by-kind
# media-bin folder labels `name: 'Video'` / `'Audio'` / `'Images'`, which are
# capitalized and therefore never match).
_TOOL_NAME_RE = re.compile(r"name:\s*'([a-z][a-z_]*)'")

# An `askTool(...)` puts a question to the human driving the run. The engine cannot serve
# one and is never asked to: the tool is `hostUiOnly`, the orchestrator resolves it
# in-process against the driving UI, and it never reaches the sidecar dispatcher (see
# `ToolKind`'s `ask` and ADR 0059). Mirroring it here would mean a Python spec the
# dispatcher could never honour — the inverse of the gap this test exists to close.
#
# Keyed off the FACTORY rather than a hand-listed name, so the exclusion cannot rot: a new
# ask tool is covered automatically, and moving one back to any other factory puts it
# straight back under the parity rule.
_ASK_TOOL_RE = re.compile(r"askTool\(\s*\{\s*name:\s*'([a-z][a-z_]*)'")

# The same reasoning reaches beyond ask tools. Any spec that declares `hostUiOnly: true`
# inline (e.g. `measure_color`, which needs the live clip selection and returns run-scoped
# evidence handles) is resolved against the driving UI and never reaches this dispatcher.
# Matched by walking each spec's body up to the next `name:` declaration, so the flag is read
# where it is actually written rather than inferred from which factory built the spec.
_SPEC_BODY_RE = re.compile(
    r"name:\s*'([a-z][a-z_]*)'(?P<body>.*?)(?=name:\s*'[a-z][a-z_]*'|\Z)", re.DOTALL
)


def _ts_host_ui_only_names() -> set[str]:
    """TS tools resolved by the host UI, never by the engine."""
    names: set[str] = set()
    for source in _ts_sources():
        names.update(_ASK_TOOL_RE.findall(source))
        for match in _SPEC_BODY_RE.finditer(source):
            if "hostUiOnly: true" in match.group("body"):
                names.add(match.group(1))
    return names


def _ts_tool_names() -> set[str]:
    """Tool names the engine is expected to mirror, parsed straight from TS source."""
    declared = {name for source in _ts_sources() for name in _TOOL_NAME_RE.findall(source)}
    return declared - _ts_host_ui_only_names()


def test_host_ui_only_tools_are_detected_and_excluded() -> None:
    """Guard the exclusion is real and narrow (it would silently widen otherwise)."""
    host_ui_only = _ts_host_ui_only_names()
    # Now that the parser reads the domain modules too, the professional family is
    # covered here rather than only by the generated fixture — the exclusion is
    # complete instead of "inline declarations only".
    assert host_ui_only == {
        "ask_user",
        "measure_color",
        # Where a caption cue breaks is a linguistic decision and `segmentCaptions`
        # is deliberately its single authority (ADR 0071). Mirroring it here would
        # mean a second segmenter disagreeing with the first word by word — so this
        # one is resolved outside the sidecar. MCP still serves it (it needs no UI
        # state); see UI_INDEPENDENT_HOST_TOOLS in packages/mcp-server.
        "caption_the_edit",
        # Main-process only: the provider network and the project media directory
        # live in Electron main, and there is no sidecar route to fall back to
        # (ADR 0139). Desktop Agent mode still offers them.
        "search_music",
        "add_music",
        "remove_silences",
        "search_stock",
        "add_stock",
        "professional_audio",
        "professional_color",
        "professional_edit",
        "professional_motion",
        "professional_tracking_mask",
    }
    assert "trim_clip" not in host_ui_only


def test_ts_source_is_readable() -> None:
    assert _TS_TOOL_REGISTRY.is_file(), f"Missing {_TS_TOOL_REGISTRY}"


def test_ts_tool_names_extracted_sanely() -> None:
    # Guard the regex itself is meaningful (would silently pass an empty set
    # otherwise) and hasn't picked up the by-kind folder-label false positives.
    names = _ts_tool_names()
    assert len(names) > 30
    assert "Video" not in names and "Audio" not in names and "Images" not in names
    assert "trim_clip" in names  # sanity: a known-good tool name is present


def test_python_registry_matches_ts_tool_names() -> None:
    """The two registries must declare the exact same tool-name set.

    Fails loudly (with the actual diff) the moment either side adds, removes,
    or renames a tool without mirroring the change — the gap this test exists
    to close (six tools were previously TS-only: set_caption_style,
    set_clip_speed, set_clip_crop, set_clip_blend_mode, add_marker,
    remove_marker).
    """
    ts_names = _ts_tool_names()
    python_names = set(TOOL_REGISTRY)
    only_in_ts = ts_names - python_names
    only_in_python = python_names - ts_names
    assert not only_in_ts, f"Tools registered in TS but missing from Python: {sorted(only_in_ts)}"
    assert not only_in_python, (
        f"Tools registered in Python but missing from TS: {sorted(only_in_python)}"
    )


def test_every_tool_description_is_the_generated_ts_text() -> None:
    """The model must read one description per tool on every surface (plan/system-mission
    P2.3). Python's registry takes its text from the generated mirror; a literal that
    survives here means a tool TS does not define, which is the only allowed exception."""
    from framepilot_engine.ai_tools.registry import TOOL_REGISTRY
    from framepilot_engine.ai_tools.tool_descriptions_generated import TOOL_DESCRIPTIONS

    shared = [name for name in TOOL_REGISTRY if name in TOOL_DESCRIPTIONS]
    assert len(shared) >= 70
    for name in shared:
        assert TOOL_REGISTRY[name].description == TOOL_DESCRIPTIONS[name], name
    # Every Python tool has a TS text: a name here would be a tool the desktop cannot see.
    only_python = sorted(name for name in TOOL_REGISTRY if name not in TOOL_DESCRIPTIONS)
    assert only_python == [], only_python
