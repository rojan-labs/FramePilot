"""AI tool layer (PRD §8.3, plan Phase 4).

The AI may only edit the project through the registered, schema-validated tools
in :mod:`framepilot_engine.ai_tools.registry`. Mutating tools return *patches*
(operation dicts), never raw mutations; :func:`run_tool` is the single guarded
entry point (unknown/unavailable/invalid-args are rejected before any handler
runs).
"""

from __future__ import annotations

from framepilot_engine.ai_tools.contract_corrections import install_contract_corrections
from framepilot_engine.ai_tools.contract_overrides import install_python_tool_contracts
from framepilot_engine.ai_tools.dispatch import (
    ToolError,
    ToolHandlerMissingError,
    ToolInputError,
    ToolResult,
    ToolSemanticError,
    ToolUnavailableError,
    UnknownToolError,
    run_tool,
)
from framepilot_engine.ai_tools.handlers import Selection, ToolContext
from framepilot_engine.ai_tools.registry import TOOL_REGISTRY, ToolSpec, get_tool

# The base registry remains readable and hand-maintainable; these post-build installs
# tighten agent input without changing backward-compatible project-file models.
install_python_tool_contracts()
install_contract_corrections()

__all__ = [
    "TOOL_REGISTRY",
    "Selection",
    "ToolContext",
    "ToolError",
    "ToolHandlerMissingError",
    "ToolInputError",
    "ToolResult",
    "ToolSemanticError",
    "ToolSpec",
    "ToolUnavailableError",
    "UnknownToolError",
    "get_tool",
    "run_tool",
]