"""Effect catalog — the Python mirror (schema v13, ADR 0088).

Loads ``effect_catalog.json``, the committed artifact generated from the
canonical TypeScript catalog (``packages/timeline-schema/src/effect-catalog.ts``
and ``effect-params.ts`` via ``pnpm schema:generate``). The engine NEVER defines
an effect of its own: it interprets the same pure data as the web editor, and
``tests/test_effect_catalog.py`` guards drift against the TS-side artifact.

Two things live here:

* the **param vocabulary** — the declared range of every parameter of every
  render kind. The render passes clamp against these, using the SAME numbers the
  Inspector sliders and the AI tool layer publish, so a value that looks legal in
  the UI cannot produce a black frame in a render.
* the **catalog** — browsable entries mapping a name onto a render kind plus
  param overrides.

The render passes dispatch ONLY on ``EffectLayer.kind``, never on a catalog
entry id. That is the extensibility contract: adding a catalog entry is a
data-only change, adding a *kind* is a deliberate two-sided implementation
(numpy pass here, GLSL pass in the web preview, plus a parity test).
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from functools import cache
from importlib import resources
from typing import Any

__all__ = [
    "CatalogEffect",
    "EffectParam",
    "clamp_edge_style_params",
    "clamp_params",
    "default_params",
    "edge_style_kinds",
    "edge_style_params_issue",
    "get_effect",
    "known_kinds",
    "load_catalog",
    "params_for_kind",
    "resolve_params",
]


@dataclass(frozen=True)
class EffectParam:
    """One tunable parameter of a render kind."""

    name: str
    label: str
    min: float
    max: float
    step: float
    default: float
    choices: tuple[str, ...] | None
    unit: str | None
    hint: str | None

    def clamp(self, value: float) -> float:
        """Constrain ``value`` to this parameter's declared range."""
        return min(self.max, max(self.min, value))


@dataclass(frozen=True)
class CatalogEffect:
    """One browsable catalog entry (pure data)."""

    id: str
    label: str
    category: str
    kind: str
    params: dict[str, float]
    default_duration: float
    description: str
    tags: tuple[str, ...]


@dataclass(frozen=True)
class EffectCatalog:
    """The loaded catalog: param vocabulary + entries, both keyed for lookup."""

    params: dict[str, tuple[EffectParam, ...]]
    effects: dict[str, CatalogEffect]
    categories: tuple[str, ...]
    #: MK9.2: cut-out edge style kinds (bottom-to-top stacking order) and their params.
    edge_kinds: tuple[str, ...] = ()
    edge_params: dict[str, tuple[EffectParam, ...]] = field(default_factory=dict)


def _param(raw: dict[str, Any]) -> EffectParam:
    choices = raw.get("choices")
    return EffectParam(
        name=raw["name"],
        label=raw["label"],
        min=float(raw["min"]),
        max=float(raw["max"]),
        step=float(raw["step"]),
        default=float(raw["default"]),
        choices=tuple(choices) if choices else None,
        unit=raw.get("unit"),
        hint=raw.get("hint"),
    )


def _effect(raw: dict[str, Any]) -> CatalogEffect:
    return CatalogEffect(
        id=raw["id"],
        label=raw["label"],
        category=raw["category"],
        kind=raw["kind"],
        params={k: float(v) for k, v in (raw.get("params") or {}).items()},
        default_duration=float(raw["defaultDuration"]),
        description=raw["description"],
        tags=tuple(raw.get("tags") or ()),
    )


@cache
def load_catalog() -> EffectCatalog:
    """Load and cache the committed catalog artifact."""
    source = resources.files("framepilot_engine.render").joinpath("effect_catalog.json")
    raw = json.loads(source.read_text(encoding="utf-8"))
    edge = raw.get("edgeStyles") or {}
    return EffectCatalog(
        params={kind: tuple(_param(p) for p in params) for kind, params in raw["params"].items()},
        effects={entry["id"]: _effect(entry) for entry in raw["effects"]},
        categories=tuple(category["id"] for category in raw["categories"]),
        edge_kinds=tuple(edge.get("kinds") or ()),
        edge_params={
            kind: tuple(_param(p) for p in params)
            for kind, params in (edge.get("params") or {}).items()
        },
    )


def known_kinds() -> frozenset[str]:
    """Every render kind the catalog declares params for."""
    return frozenset(load_catalog().params)


def params_for_kind(kind: str) -> tuple[EffectParam, ...]:
    """Declared parameters of ``kind``, or empty for an unknown kind.

    Empty rather than raising: an unknown kind means the project was written by a
    newer FramePilot than this engine, and the compiler's job is to skip that
    layer with a warning, not to abort a render the user is waiting on.
    """
    return load_catalog().params.get(kind, ())


def default_params(kind: str) -> dict[str, float]:
    """The full default parameter bag for ``kind``."""
    return {p.name: p.default for p in params_for_kind(kind)}


def clamp_params(kind: str, params: dict[str, float] | None) -> dict[str, float]:
    """Merge ``params`` over the kind defaults, clamped, dropping unknown names.

    Mirrors the TS ``clampParamsForKind``. Every render pass calls this before
    reading a value, so a shader/numpy pass can trust its inputs absolutely — an
    out-of-range param produces a dialled-back look, never a divide-by-zero or a
    black frame.
    """
    out = default_params(kind)
    if not params:
        return out
    for descriptor in params_for_kind(kind):
        raw = params.get(descriptor.name)
        if raw is None:
            continue
        try:
            value = float(raw)
        except (TypeError, ValueError):
            continue
        # NaN fails every comparison, so it would slip straight past a clamp.
        if math.isnan(value):
            continue
        out[descriptor.name] = descriptor.clamp(value)
    return out


def get_effect(effect_id: str) -> CatalogEffect | None:
    """Catalog entry by id, for attribution/logging only — never for dispatch."""
    return load_catalog().effects.get(effect_id)


def resolve_params(effect_id: str) -> dict[str, float]:
    """The complete param bag a freshly-applied catalog entry would carry."""
    entry = get_effect(effect_id)
    if entry is None:
        return {}
    return {**default_params(entry.kind), **entry.params}


# ---------------------------------------------------------------------------
# Cut-out edge styles (MK9.2)
# ---------------------------------------------------------------------------


def edge_style_kinds() -> tuple[str, ...]:
    """The edge style kinds, in the order they stack from the bottom up."""
    return load_catalog().edge_kinds


def clamp_edge_style_params(kind: str, params: dict[str, Any] | None) -> dict[str, float]:
    """Merge ``params`` over an edge style kind's defaults, clamped (``clampEdgeStyleParams``)."""
    descriptors = load_catalog().edge_params.get(kind, ())
    out = {descriptor.name: descriptor.default for descriptor in descriptors}
    for descriptor in descriptors:
        raw = (params or {}).get(descriptor.name)
        if isinstance(raw, bool) or not isinstance(raw, int | float) or math.isnan(raw):
            continue
        out[descriptor.name] = descriptor.clamp(float(raw))
    return out


def edge_style_params_issue(params: Any) -> str | None:
    """Why stored edge style params are invalid, or ``None`` (TS ``edgeStyleParamsIssue``)."""
    kinds = load_catalog().edge_kinds
    if not isinstance(params, dict) or params.get("kind") not in kinds:
        return (
            "An edge style needs a kind (stroke, glow or shadow) and numeric settings. "
            "Pick the style again."
        )
    declared = {d.name: d for d in load_catalog().edge_params.get(str(params["kind"]), ())}
    for name, value in params.items():
        if name == "kind":
            continue
        numeric = isinstance(value, int | float) and not isinstance(value, bool)
        if not numeric or not math.isfinite(value):
            return (
                "An edge style needs a kind (stroke, glow or shadow) and numeric settings. "
                "Pick the style again."
            )
        descriptor = declared.get(name)
        if descriptor is None:
            return f'An edge style has a setting "{name}" its kind does not use. Remove it.'
        if value < descriptor.min or value > descriptor.max:
            return (
                f"An edge style's {descriptor.label.lower()} is outside its range. "
                "Set it within the slider's range."
            )
    return None
