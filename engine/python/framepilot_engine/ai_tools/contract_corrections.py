"""Targeted corrections layered on top of the AI tool contract installer.

Keep these tiny: the base registry owns the structural shapes, while
``contract_overrides`` adds strict runtime semantics. This module exists for cases
where a semantic rule must be added without replacing an already-correct nested model.
"""

from __future__ import annotations

from pydantic import ConfigDict, model_validator

from framepilot_engine.ai_tools.registry import TOOL_REGISTRY, ManageAssetsArgs


class StrictManageAssetsArgs(ManageAssetsArgs):
    """Preserve the typed folder/assignment schema and reject an empty plan."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    @model_validator(mode="after")
    def plan_requires_content(self) -> StrictManageAssetsArgs:
        if self.strategy == "plan" and not (self.folders or self.assignments):
            raise ValueError("strategy='plan' requires at least one folder or assignment")
        return self


def install_contract_corrections() -> None:
    """Install parity-preserving semantic corrections onto the shared registry."""
    spec = TOOL_REGISTRY["manage_assets"]
    spec.input_model = StrictManageAssetsArgs
    spec.input_schema = StrictManageAssetsArgs.model_json_schema(by_alias=True)
