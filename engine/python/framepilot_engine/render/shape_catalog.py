"""The shape catalogue and shape-param validation (schema v25, plan/elements EL4a, ADR 0190).

Loads ``shape_catalog.json``, the committed artifact generated from
``packages/timeline-schema/src/shape-catalog.ts``, and validates a shape clip's params with the
same rules and the same sentences as the TypeScript ``shapeParamsProblem``. Both runtimes read
``tests/fixtures/shape-params.json``, so neither can drift from the other.

The messages name the fix and never the offending magnitude: the agent's repeated-failure guard
keys on the text, and a message that varied with the input would read as progress.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from functools import cache
from importlib import resources
from typing import Any, Final, Literal, TypeGuard

ShapeFrame = Literal["box", "segment"]

SHAPE_EFFECT_TYPE: Final = "shape"
SHAPE_STROKE_STYLES: Final = ("solid", "dashed", "dotted")
SHAPE_CAPS: Final = ("none", "arrow", "dot", "bar")
SHAPE_COLOR_PATTERN: Final = re.compile(r"^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$")

_BOX_KEYS: Final = ("x", "y", "width", "height")
_SEGMENT_KEYS: Final = ("x1", "y1", "x2", "y2")
#: The standard keys in the TS schema's declaration order: the first failing one is reported.
_STANDARD_KEYS: Final = (
    "shape",
    *_BOX_KEYS,
    *_SEGMENT_KEYS,
    "fill",
    "stroke",
    "strokeWidth",
    "strokeStyle",
    "startCap",
    "endCap",
    "label",
    "labelColor",
)
#: The longest badge label, in characters (code points; TS counts the same way).
SHAPE_LABEL_MAX: Final = 8
_LIMITS: Final[dict[str, tuple[float, float]]] = {
    "x": (0, 100),
    "y": (0, 100),
    "width": (0.1, 400),
    "height": (0.1, 400),
    "x1": (-50, 150),
    "y1": (-50, 150),
    "x2": (-50, 150),
    "y2": (-50, 150),
    "strokeWidth": (0.05, 10),
}
_OPTIONAL: Final = frozenset(
    {*_BOX_KEYS, *_SEGMENT_KEYS, "fill", "stroke", "startCap", "endCap", "label", "labelColor"}
)
_PICK_ONE: Final = "Pick one with search_elements (kind: shape) or from the Shapes tab."
#: Icons are shapes whose id is this prefix and a Lucide icon name (plan/elements EL5.5).
ICON_PREFIX: Final = "icon/"


@dataclass(frozen=True)
class ShapeKnob:
    name: str
    label: str
    min: float
    max: float
    default: float


@dataclass(frozen=True)
class ShapeDescriptor:
    id: str
    name: str
    frame: ShapeFrame
    generator: str
    knobs: tuple[ShapeKnob, ...]
    #: Fixed generator settings (polygon sides, a path, the fill rule, ...); see the catalogue.
    geometry: Mapping[str, Any] = field(default_factory=dict)
    #: Badges draw a ``label`` inside the shape (plan/elements EL5.4).
    labelled: bool = False

    def knob(self, name: str) -> ShapeKnob | None:
        return next((knob for knob in self.knobs if knob.name == name), None)


@cache
def load_shape_catalog() -> dict[str, ShapeDescriptor]:
    """Parse the packaged catalogue once, keyed by shape id."""
    payload = (
        resources.files("framepilot_engine.render")
        .joinpath("shape_catalog.json")
        .read_text(encoding="utf-8")
    )
    data = json.loads(payload)
    shapes = data.get("shapes") if isinstance(data, dict) else None
    if not isinstance(shapes, list):  # pragma: no cover - corrupt artifact
        raise ValueError("shape_catalog.json: expected a 'shapes' array")
    catalog: dict[str, ShapeDescriptor] = {}
    for entry in shapes:
        knobs = tuple(
            ShapeKnob(
                name=knob["name"],
                label=knob["label"],
                min=float(knob["min"]),
                max=float(knob["max"]),
                default=float(knob["default"]),
            )
            for knob in entry["knobs"]
        )
        catalog[entry["id"]] = ShapeDescriptor(
            id=entry["id"],
            name=entry["name"],
            frame=entry["frame"],
            generator=entry["generator"],
            knobs=knobs,
            geometry=_resolved_geometry(entry.get("geometry") or {}),
            labelled=bool(entry.get("labelled", False)),
        )
    return catalog


def _resolved_geometry(geometry: Mapping[str, Any]) -> dict[str, Any]:
    """A catalogue shape's geometry with a Lucide ``icon`` reference swapped for its outline."""
    icon = geometry.get("icon")
    if not isinstance(icon, str):
        return dict(geometry)
    source = load_shape_icons().get(ICON_PREFIX + icon)
    if source is None:  # pragma: no cover - guarded by test_shape_icons.py
        raise ValueError(
            f"shape_catalog.json draws the icon '{icon}', which shape_icons.json lacks. "
            "Run scripts/elements/build_icons.mjs and schema:generate."
        )
    return {**source.geometry, **geometry}


@cache
def load_shape_icons() -> dict[str, ShapeDescriptor]:
    """The Lucide icons as path shapes, keyed ``icon/<name>`` (``shape_icons.json``)."""
    payload = (
        resources.files("framepilot_engine.render")
        .joinpath("shape_icons.json")
        .read_text(encoding="utf-8")
    )
    icons = json.loads(payload)["icons"]
    return {
        icon["id"]: ShapeDescriptor(
            id=icon["id"],
            name=icon["name"],
            frame="box",
            generator="path",
            knobs=(),
            geometry={"path": icon["path"], "fillRule": "nonzero", "roundCaps": True},
        )
        for icon in icons
    }


def shape_descriptor(shape_id: str) -> ShapeDescriptor | None:
    """The catalogue entry for ``shape_id`` (a shape or an ``icon/`` shape), or ``None``."""
    if shape_id.startswith(ICON_PREFIX):
        return load_shape_icons().get(shape_id)
    return load_shape_catalog().get(shape_id)


def shape_keys_for(descriptor: ShapeDescriptor) -> tuple[str, ...]:
    """Every key a shape of this descriptor accepts, standard frame keys first."""
    frame = _BOX_KEYS if descriptor.frame == "box" else _SEGMENT_KEYS
    caps = ("startCap", "endCap") if descriptor.frame == "segment" else ()
    label = ("label", "labelColor") if descriptor.labelled else ()
    return (
        "shape",
        *frame,
        "fill",
        "stroke",
        "strokeWidth",
        "strokeStyle",
        *caps,
        *label,
        *(knob.name for knob in descriptor.knobs),
    )


def _present(params: Mapping[str, Any], key: str) -> bool:
    """Whether ``key`` carries a value. ``None`` reads as absent for every key.

    ``set_effect_params`` clears a key with ``None`` here and keeps a ``null`` in TypeScript, so the
    runtimes agree on a shape only if neither tells ``None`` and "absent" apart.
    """
    return params.get(key) is not None


def _is_number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value)


def is_shape_label(value: Any) -> TypeGuard[str]:
    """Whether ``value`` can be a badge label: 1-8 characters on one line, not all spaces."""
    return (
        isinstance(value, str)
        and 1 <= len(value) <= SHAPE_LABEL_MAX
        and value.strip() != ""
        and "\n" not in value
        and "\r" not in value
    )


def _standard_key_ok(key: str, value: Any) -> bool:
    if key == "shape":
        return isinstance(value, str) and value != ""
    if key == "label":
        return is_shape_label(value)
    if key in ("fill", "stroke", "labelColor"):
        return value is None or (isinstance(value, str) and bool(SHAPE_COLOR_PATTERN.match(value)))
    if key == "strokeStyle":
        return value in SHAPE_STROKE_STYLES
    if key in ("startCap", "endCap"):
        return value in SHAPE_CAPS
    low, high = _LIMITS[key]
    return _is_number(value) and low <= value <= high


def _standard_key_hint(key: str) -> str:
    if key in ("x", "y"):
        return "A box centre is a percent of the frame, 0 to 100."
    if key in ("width", "height"):
        return "A box size is a percent of the frame height, 0.1 to 400."
    if key in _SEGMENT_KEYS:
        return "An end is a percent of the frame, -50 to 150."
    if key in ("fill", "stroke", "labelColor"):
        return "A colour is #rrggbb or #rrggbbaa, or null for none."
    if key == "label":
        return "A label is 1 to 8 characters on one line."
    if key == "strokeWidth":
        return "A stroke width is a percent of the frame height, 0.05 to 10."
    if key == "strokeStyle":
        return "It is solid, dashed or dotted."
    if key in ("startCap", "endCap"):
        return "A cap is none, arrow, dot or bar."
    return "Knobs are numbers."


def _format_bound(value: float) -> str:
    """A bound as JavaScript's ``String(number)`` writes it (``50``, not ``50.0``)."""
    return str(int(value)) if value == int(value) else repr(value)


def shape_params_problem(params: Mapping[str, Any]) -> str | None:
    """Why ``params`` cannot be a shape, as one sentence with its remedy, or ``None``.

    The TS twin is ``shapeParamsProblem``; the checks run in the same order so the first
    problem found is the same sentence in both runtimes.
    """
    shape_id = params.get("shape")
    if not isinstance(shape_id, str) or shape_id == "":
        return f"A shape needs a shape id. {_PICK_ONE}"
    descriptor = shape_descriptor(shape_id)
    if descriptor is None:
        return f"There is no shape called '{shape_id}'. {_PICK_ONE}"
    knob_names = {knob.name for knob in descriptor.knobs}
    for key in params:
        if not _present(params, key) or key in _STANDARD_KEYS or key in knob_names:
            continue
        allowed = ", ".join(shape_keys_for(descriptor))
        return f"Shape parameter '{key}' is not one this shape has. Its parameters are: {allowed}."
    wrong_frame = _SEGMENT_KEYS if descriptor.frame == "box" else _BOX_KEYS
    if any(_present(params, key) for key in wrong_frame):
        if descriptor.frame == "box":
            return f"'{shape_id}' is placed by a box (x, y, width, height), not by two ends."
        return f"'{shape_id}' is placed by its two ends (x1, y1, x2, y2), not a box."
    frame_keys = _BOX_KEYS if descriptor.frame == "box" else _SEGMENT_KEYS
    if any(not _present(params, key) for key in frame_keys):
        if descriptor.frame == "box":
            return f"'{shape_id}' needs its box: x, y, width and height."
        return f"'{shape_id}' needs both ends: x1, y1, x2 and y2."
    if descriptor.frame == "box" and (_present(params, "startCap") or _present(params, "endCap")):
        return f"'{shape_id}' has no ends to cap; startCap and endCap are for lines and arrows."
    if not descriptor.labelled and (_present(params, "label") or _present(params, "labelColor")):
        return (
            f"'{shape_id}' has no label; label and labelColor are for numbered badges and "
            "burst labels."
        )
    for knob in descriptor.knobs:
        if not _present(params, knob.name):
            continue
        value = params[knob.name]
        if not _is_number(value) or value < knob.min or value > knob.max:
            return (
                f"{knob.name} must be between {_format_bound(knob.min)} "
                f"and {_format_bound(knob.max)}."
            )
    for key in _STANDARD_KEYS:
        if key in _OPTIONAL and not _present(params, key):
            continue
        if not _standard_key_ok(key, params.get(key)):
            return (
                f"Shape parameter '{key}' is out of range or the wrong type. "
                f"{_standard_key_hint(key)}"
            )
    if descriptor.frame == "segment" and params.get("stroke") is None:
        return (
            f"'{shape_id}' is drawn by its stroke — with the stroke off it draws nothing. "
            "Set a stroke colour."
        )
    if params.get("fill") is None and params.get("stroke") is None:
        return "A shape needs a fill or a stroke — with both off it draws nothing."
    return None


def knob_value(descriptor: ShapeDescriptor, params: Mapping[str, Any], name: str) -> float:
    """A knob's value on a shape: the param when set, else the descriptor's default."""
    knob = descriptor.knob(name)
    if knob is None:
        raise KeyError(f"Shape '{descriptor.id}' has no knob '{name}'.")
    value = params.get(name)
    if isinstance(value, int | float) and _is_number(value):
        return float(value)
    return knob.default


@cache
def _raw_catalog() -> list[dict[str, Any]]:
    payload = (
        resources.files("framepilot_engine.render")
        .joinpath("shape_catalog.json")
        .read_text(encoding="utf-8")
    )
    shapes = json.loads(payload)["shapes"]
    return list(shapes)


def catalogue_entry(shape_id: str) -> dict[str, Any] | None:
    """The catalogue's raw entry for ``shape_id`` (name, category, tags, defaults), or ``None``."""
    return next((shape for shape in _raw_catalog() if shape["id"] == shape_id), None)


def shape_preset_ids() -> tuple[str, ...]:
    """Every preset id, in catalogue order."""
    return tuple(preset["id"] for shape in _raw_catalog() for preset in shape["presets"])


def featured_shape_preset_ids() -> tuple[str, ...]:
    """The presets the Shapes tab opens on: the screen-recording staples, in order."""
    payload = (
        resources.files("framepilot_engine.render")
        .joinpath("shape_catalog.json")
        .read_text(encoding="utf-8")
    )
    return tuple(json.loads(payload)["featured"])


def resolve_shape_preset_id(preset_id: str) -> str | None:
    """The preset ``preset_id`` names: itself, an icon, or a shape's first style (TS twin)."""
    if preset_id.startswith(ICON_PREFIX):
        return preset_id if preset_id in load_shape_icons() else None
    for shape in _raw_catalog():
        if shape["id"] == preset_id:
            return str(shape["presets"][0]["id"])
        if any(preset["id"] == preset_id for preset in shape["presets"]):
            return preset_id
    return None


#: The style an icon is inserted with: its outline in white, as Lucide draws it (TS
#: ``ICON_PRESET_STYLE``).
_ICON_STYLE: Final = {"fill": None, "stroke": "#FFFFFF", "strokeWidth": 1, "strokeStyle": "solid"}
#: Where an icon lands when first placed, percent of the frame height (TS ``SQUARE``).
_ICON_SIZE: Final = 24


def preset_shape_params(
    preset_id: str, at: tuple[float, float] = (50.0, 50.0)
) -> dict[str, Any] | None:
    """The complete params a preset is inserted with, centred on ``at`` (percent of each axis).

    The twin of TypeScript's ``presetShapeParams``: knobs take the preset's value, else the
    descriptor's default, so a fresh shape states every number the engine draws it with. An icon's
    id (``icon/<name>``) is its own preset: its outline in white.
    """
    if preset_id.startswith(ICON_PREFIX):
        if preset_id not in load_shape_icons():
            return None
        x, y = at
        return {
            "shape": preset_id,
            "x": x,
            "y": y,
            "width": _ICON_SIZE,
            "height": _ICON_SIZE,
            **_ICON_STYLE,
        }
    for shape in _raw_catalog():
        for preset in shape["presets"]:
            if preset["id"] != preset_id:
                continue
            knobs = {
                knob["name"]: (preset.get("knobs") or {}).get(knob["name"], knob["default"])
                for knob in shape["knobs"]
            }
            style = {
                "fill": preset["fill"],
                "stroke": preset["stroke"],
                "strokeWidth": preset["strokeWidth"],
                "strokeStyle": preset["strokeStyle"],
            }
            defaults = shape["defaults"]
            x, y = at
            if shape["frame"] == "box":
                label = {key: preset[key] for key in ("label", "labelColor") if key in preset}
                return {
                    "shape": shape["id"],
                    "x": x,
                    "y": y,
                    "width": defaults["width"],
                    "height": defaults["height"],
                    **style,
                    **label,
                    **knobs,
                }
            return {
                "shape": shape["id"],
                "x1": x + defaults["x1"],
                "y1": y + defaults["y1"],
                "x2": x + defaults["x2"],
                "y2": y + defaults["y2"],
                **style,
                "startCap": preset.get("startCap", "none"),
                "endCap": preset.get("endCap", "none"),
                **knobs,
            }
    return None


# --- search (plan/elements EL5.6) ------------------------------------------------------------

#: Icons rank after every catalogue shape: added to an icon's score (TS ``ICON_RANK_OFFSET``).
_ICON_RANK_OFFSET: Final = 5
_WORD_SPLIT: Final = re.compile(r"[^a-z0-9]+")


@dataclass(frozen=True)
class ShapeSearchHit:
    """One placeable style: a catalogue preset, or an icon (its id is its own preset)."""

    shape_id: str
    preset_id: str
    preset_name: str
    shape_name: str
    category: str
    tags: tuple[str, ...]


def _words(text: str) -> list[str]:
    return [word for word in _WORD_SPLIT.split(text.lower()) if word]


@cache
def _catalogue_hits() -> tuple[ShapeSearchHit, ...]:
    """Every catalogue preset in the Shapes tab's order: the featured staples, then the rest."""
    rows = [
        ShapeSearchHit(
            shape_id=shape["id"],
            preset_id=preset["id"],
            preset_name=preset["name"],
            shape_name=shape["name"],
            category=shape["category"],
            tags=tuple(shape["tags"]),
        )
        for shape in _raw_catalog()
        for preset in shape["presets"]
    ]
    by_id = {row.preset_id: row for row in rows}
    featured = featured_shape_preset_ids()
    return (
        *(by_id[preset_id] for preset_id in featured),
        *(row for row in rows if row.preset_id not in featured),
    )


@cache
def _icon_hits() -> tuple[ShapeSearchHit, ...]:
    return tuple(
        ShapeSearchHit(
            shape_id=icon.id,
            preset_id=icon.id,
            preset_name=icon.name,
            shape_name=icon.name,
            category="symbols",
            tags=("icon",),
        )
        for icon in load_shape_icons().values()
    )


def _search_score(hit: ShapeSearchHit, terms: list[str]) -> int | None:
    """The TS ``score`` twin: 0 whole name .. 4 tag or category, worst term; icons after."""
    names = [hit.preset_name.lower(), hit.shape_name.lower()]
    name_words = [word for name in names for word in _words(name)]
    other_words = [word for tag in hit.tags for word in _words(tag)] + _words(hit.category)
    worst = 0
    for term in terms:
        if any(name == term for name in names):
            best = 0
        elif any(name.startswith(term) for name in names):
            best = 1
        elif any(word.startswith(term) for word in name_words):
            best = 2
        elif any(term in name for name in names):
            best = 3
        elif any(term in word for word in other_words):
            best = 4
        else:
            return None
        worst = max(worst, best)
    return worst + _ICON_RANK_OFFSET if hit.shape_id.startswith(ICON_PREFIX) else worst


def search_shapes(
    query: str, scope: str | None = None, limit: int | None = None
) -> tuple[list[ShapeSearchHit], int]:
    """The shapes and icons ``query`` finds, best first, and how many matched in all.

    The twin of TypeScript's ``searchShapes`` (``tests/fixtures/shape-search.json`` pins both):
    ``scope`` is a category, ``"icons"``, or ``None`` for everything; icons join an unscoped list
    only for a search.
    """
    terms = _words(query)
    if scope == "icons":
        catalogue: tuple[ShapeSearchHit, ...] = ()
    elif scope is None:
        catalogue = _catalogue_hits()
    else:
        catalogue = tuple(hit for hit in _catalogue_hits() if hit.category == scope)
    with_icons = scope == "icons" or (scope is None and len(terms) > 0)
    pool = [*catalogue, *(_icon_hits() if with_icons else ())]
    if not terms:
        return (pool if limit is None else pool[:limit]), len(pool)
    scored = [
        (rank, index, hit)
        for index, hit in enumerate(pool)
        if (rank := _search_score(hit, terms)) is not None
    ]
    scored.sort(key=lambda row: (row[0], row[1]))
    hits = [hit for _, _, hit in scored]
    return (hits if limit is None else hits[:limit]), len(hits)
