"""Transition catalog — the Python mirror (plan/ADVANCED-TRANSITION-SYSTEM.md).

Loads ``transition_catalog.json``, the committed artifact generated from the
canonical TypeScript catalog (``packages/timeline-schema/src/transition-catalog.ts``
and ``transition-params.ts`` via ``pnpm schema:generate``). The engine NEVER
defines a transition of its own: it interprets the same pure data the web editor
does, and ``tests/test_transition_catalog.py`` guards drift against the TS-side
artifact.

The same shape as :mod:`framepilot_engine.render.effect_catalog`, and for the same
reasons — read that module's docstring first. What differs is what an entry means:

* an effect catalog entry names a **look**; a transition catalog entry names a
  **treatment of a cut**, so it carries a default duration, a direction and an
  alignment as well as params;
* the ``id`` of a transition entry is stored verbatim in the project file (as the
  ``kind`` param of the ``transition`` effect), which is why the seven ids that
  predate the catalog are entries in it rather than being migrated away.

The render passes dispatch ONLY on ``renderKind``, never on an entry id.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from functools import cache
from importlib import resources
from typing import Any

__all__ = [
    "CatalogTransition",
    "TransitionCatalog",
    "TransitionParam",
    "apply_path",
    "clamp_params",
    "default_params",
    "directions_for_kind",
    "get_transition",
    "known_kinds",
    "load_catalog",
    "params_for_kind",
    "resolve_params",
]


@dataclass(frozen=True)
class TransitionParam:
    """One tunable parameter of a transition render kind."""

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
class CatalogTransition:
    """One browsable catalog entry (pure data)."""

    id: str
    label: str
    category: str
    render_kind: str
    params: dict[str, float]
    direction: str
    intensity: float | None
    softness: float | None
    easing: str | None
    default_duration: float
    description: str
    tags: tuple[str, ...]
    is_cut: bool


@dataclass(frozen=True)
class TransitionCatalog:
    """The loaded catalog: param vocabulary, directions, paths and entries."""

    params: dict[str, tuple[TransitionParam, ...]]
    directions: dict[str, tuple[str, ...]]
    apply_path: dict[str, str]
    transitions: dict[str, CatalogTransition]
    categories: tuple[str, ...]


def _param(raw: dict[str, Any]) -> TransitionParam:
    choices = raw.get("choices")
    return TransitionParam(
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


def _transition(raw: dict[str, Any]) -> CatalogTransition:
    return CatalogTransition(
        id=raw["id"],
        label=raw["label"],
        category=raw["category"],
        render_kind=raw["renderKind"],
        params={k: float(v) for k, v in (raw.get("params") or {}).items()},
        direction=raw.get("direction", ""),
        intensity=(None if raw.get("intensity") is None else float(raw["intensity"])),
        softness=(None if raw.get("softness") is None else float(raw["softness"])),
        easing=raw.get("easing"),
        default_duration=float(raw["defaultDuration"]),
        description=raw["description"],
        tags=tuple(raw.get("tags") or ()),
        is_cut=bool(raw.get("isCut", False)),
    )


@cache
def load_catalog() -> TransitionCatalog:
    """Load and cache the committed catalog artifact."""
    source = resources.files("framepilot_engine.render").joinpath("transition_catalog.json")
    raw = json.loads(source.read_text(encoding="utf-8"))
    return TransitionCatalog(
        params={kind: tuple(_param(p) for p in params) for kind, params in raw["params"].items()},
        directions={kind: tuple(values) for kind, values in raw["directions"].items()},
        apply_path=dict(raw["applyPath"]),
        transitions={entry["id"]: _transition(entry) for entry in raw["transitions"]},
        categories=tuple(category["id"] for category in raw["categories"]),
    )


def known_kinds() -> frozenset[str]:
    """Every render kind the catalog declares params for."""
    return frozenset(load_catalog().params)


def params_for_kind(kind: str) -> tuple[TransitionParam, ...]:
    """Declared parameters of ``kind``, or empty for one this build does not know.

    Empty rather than raising, for the same reason the effect catalog does it: an
    unknown kind means the project came from a newer FramePilot, and the right
    outcome for a render someone is waiting on is a skipped transition and a
    warning, not an aborted export.
    """
    return load_catalog().params.get(kind, ())


def directions_for_kind(kind: str) -> tuple[str, ...]:
    """The directions ``kind`` can express, in menu order."""
    return load_catalog().directions.get(kind, ())


def apply_path(kind: str) -> str:
    """How the compiler applies ``kind``: ``geometry``, ``mask`` or ``frame``."""
    return load_catalog().apply_path.get(kind, "frame")


def default_params(kind: str) -> dict[str, float]:
    """The full default parameter bag for ``kind``."""
    return {p.name: p.default for p in params_for_kind(kind)}


def clamp_params(kind: str, params: dict[str, Any] | None) -> dict[str, float]:
    """Merge ``params`` over the kind defaults, clamped, dropping unknown names.

    Mirrors the TS ``clampTransitionParams``. Every pass calls this before reading
    a value, so a pass can divide by a param without guarding it.
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


def get_transition(transition_id: str) -> CatalogTransition | None:
    """Catalog entry by stored ``kind``, or ``None`` when this build has no such id."""
    return load_catalog().transitions.get(transition_id)


def resolve_params(transition_id: str) -> dict[str, float]:
    """The complete param bag a freshly-applied catalog entry would carry."""
    entry = get_transition(transition_id)
    if entry is None:
        return {}
    return {**default_params(entry.render_kind), **entry.params}
