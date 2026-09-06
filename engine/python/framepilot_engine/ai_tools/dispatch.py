"""Tool dispatch (PRD §8.3, §18.2, plan Phase 4).

WHY: this is the single entry point the orchestrator calls to invoke a tool. It
enforces the registry, availability and schema boundaries before a handler can run,
and it normalizes handler-level semantic failures into typed tool errors so callers
never have to distinguish an input mistake from an arbitrary Python exception.

Some registry entries intentionally execute in the TypeScript host because their
canonical implementation depends on editor-core or host-owned state. Those tools are
listed explicitly below and return ``delegated_to_host=True``. This keeps registry
availability honest without pretending an absent Python handler succeeded locally.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, ValidationError

from framepilot_engine.ai_tools import handlers
from framepilot_engine.ai_tools.handlers import ToolContext
from framepilot_engine.ai_tools.registry import TOOL_REGISTRY, ToolKind, ToolSpec

_log = logging.getLogger(__name__)


class ToolError(Exception):
    """Base class for all dispatch failures."""


class UnknownToolError(ToolError):
    """Raised when a tool name is not in the registry."""

    def __init__(self, name: str) -> None:
        super().__init__(f"Unknown tool: {name!r}")
        self.name = name


class ToolUnavailableError(ToolError):
    """Raised when a registered tool's engine capability does not exist yet."""

    def __init__(self, name: str) -> None:
        super().__init__(
            f"Tool {name!r} is registered but not available "
            "(its engine capability does not exist yet)."
        )
        self.name = name


class ToolHandlerMissingError(ToolError):
    """Raised when registry metadata claims an in-process tool that cannot execute."""

    def __init__(self, name: str) -> None:
        super().__init__(
            f"Tool {name!r} is marked available but has no in-process handler or explicit "
            "host delegation. The tool registry and Python dispatcher are out of sync."
        )
        self.name = name


class ToolInputError(ToolError):
    """Raised when raw arguments fail the tool's structural schema validation."""

    def __init__(self, name: str, error: ValidationError) -> None:
        super().__init__(f"Invalid arguments for tool {name!r}: {error}")
        self.name = name
        self.validation_error = error


class ToolSemanticError(ToolError):
    """Raised when schema-valid arguments are impossible against current project state."""

    def __init__(self, name: str, message: str) -> None:
        super().__init__(f"Tool {name!r} rejected the requested operation: {message}")
        self.name = name
        self.detail = message
        self.recoverable = True


@dataclass(frozen=True)
class ToolResult:
    """Outcome of a successful dispatch or an explicit host hand-off."""

    name: str
    kind: ToolKind
    operations: list[dict[str, Any]] | None = None
    data: Any = None
    delegated_to_host: bool = False


_HANDLERS: dict[str, Callable[[Any, ToolContext], Any]] = {
    "get_project_state": handlers.get_project_state,
    "get_timeline": handlers.get_timeline,
    "get_timeline_summary": handlers.get_timeline_summary,
    "get_clips": handlers.get_clips,
    "get_clip": handlers.get_clip,
    "get_transcript": handlers.get_transcript,
    "get_selected_range": handlers.get_selected_range,
    "recall_evidence": handlers.recall_evidence,
    "load_skill": handlers.load_skill,
    "list_assets": handlers.list_assets,
    "discover_caption_styles": handlers.discover_caption_styles,
    "trim_clip": handlers.trim_clip,
    "split_clip": handlers.split_clip,
    "delete_range": handlers.delete_range,
    "ripple_delete": handlers.ripple_delete,
    "delete_clip": handlers.delete_clip,
    "delete_clips": handlers.delete_clips,
    "move_clip": handlers.move_clip,
    "reorder_clips": handlers.reorder_clips,
    "set_clip_speed_ramp": handlers.set_clip_speed_ramp,
    "add_track": handlers.add_track,
    "remove_track": handlers.remove_track,
    "move_track": handlers.move_track,
    "add_clip": handlers.add_clip,
    "add_clips": handlers.add_clips,
    "add_text_layer": handlers.add_text_layer,
    "add_caption_layer": handlers.add_caption_layer,
    "add_keyframes": handlers.add_keyframes,
    "remove_keyframes": handlers.remove_keyframes,
    "punch_in": handlers.punch_in,
    "apply_color_grade": handlers.apply_color_grade,
    "adjust_audio": handlers.adjust_audio,
    "add_transition": handlers.add_transition,
    "add_mask": handlers.add_mask,
    "track_object": handlers.track_object,
    "set_track_flags": handlers.set_track_flags,
    "set_track_caption_style": handlers.set_track_caption_style,
    "auto_emphasize_captions": handlers.auto_emphasize_captions,
    "set_caption_style": handlers.set_caption_style,
    "set_clip_speed": handlers.set_clip_speed,
    "set_clip_crop": handlers.set_clip_crop,
    "set_clip_blend_mode": handlers.set_clip_blend_mode,
    "add_asset": handlers.add_asset,
    "manage_assets": handlers.manage_assets,
    "add_marker": handlers.add_marker,
    "remove_marker": handlers.remove_marker,
    "remember_preference": handlers.remember_preference,
}

# These entries deliberately use the TypeScript host/editor-core implementation. They
# remain in the Python registry so schema discovery/parity is one-to-one, but Python must
# return an explicit hand-off instead of falling through to a missing-handler KeyError.
_HOST_DELEGATED_TOOLS = frozenset(
    {
        "get_timeline_map",
        "map_time",
        "get_mapped_transcript",
        "list_edit_boundaries",
        "verify_captions",
        "verify_transitions",
        "discover_effects",
        "discover_transitions",
        "read_edit_signals",
        "apply_effect",
        "move_effect",
        "resize_effect",
        "adjust_effect",
        "set_effect_enabled",
        "remove_effect",
    }
)


def missing_in_process_handlers() -> tuple[str, ...]:
    """Return advertised read/mutate tools lacking local execution or host delegation."""
    return tuple(
        sorted(
            name
            for name, spec in TOOL_REGISTRY.items()
            if spec.available
            and spec.kind in ("read", "mutate")
            and name not in _HANDLERS
            and name not in _HOST_DELEGATED_TOOLS
        )
    )


def _validate_args(spec: ToolSpec, raw_args: dict[str, Any]) -> BaseModel:
    try:
        return spec.input_model.model_validate(raw_args)
    except ValidationError as exc:
        raise ToolInputError(spec.name, exc) from exc


def _run_handler(
    name: str,
    handler: Callable[[Any, ToolContext], Any],
    validated: BaseModel,
    ctx: ToolContext,
) -> Any:
    """Execute pure handler logic and normalize expected semantic refusals."""
    try:
        return handler(validated, ctx)
    except ValueError as exc:
        _log.warning("ACT ✗ tool %r rejected semantic input: %s", name, exc)
        raise ToolSemanticError(name, str(exc)) from exc


def run_tool(name: str, raw_args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    """Validate and dispatch one registered tool."""
    _log.info("ACT → dispatching tool %r", name)
    spec = TOOL_REGISTRY.get(name)
    if spec is None:
        _log.warning("ACT ✗ tool %r is not registered", name)
        raise UnknownToolError(name)
    if not spec.available:
        _log.warning("ACT ✗ tool %r is registered but unavailable", name)
        raise ToolUnavailableError(name)

    try:
        validated = _validate_args(spec, raw_args)
    except ToolInputError:
        _log.warning("ACT ✗ tool %r rejected invalid arguments", name)
        raise

    if spec.kind in ("action", "analysis") or name in _HOST_DELEGATED_TOOLS:
        _log.info("ACT ← tool %r (kind=%s) delegated to host", name, spec.kind)
        return ToolResult(name=name, kind=spec.kind, delegated_to_host=True)

    handler = _HANDLERS.get(name)
    if handler is None:
        _log.error("ACT ✗ tool %r is available but has no execution route", name)
        raise ToolHandlerMissingError(name)

    result = _run_handler(name, handler, validated, ctx)
    if spec.mutating:
        _log.info("ACT ← tool %r (kind=%s) → %d operation(s)", name, spec.kind, len(result))
        return ToolResult(name=name, kind=spec.kind, operations=result)
    _log.info("ACT ← tool %r (kind=%s) → data", name, spec.kind)
    return ToolResult(name=name, kind=spec.kind, data=result)
