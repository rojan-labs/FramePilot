"""Caption template catalog — the Python mirror (schema v10, ADR 0069).

Loads ``caption_templates.json``, the committed artifact generated from the
canonical TypeScript catalog (``packages/timeline-schema/src/caption-templates.ts``
via ``pnpm schema:generate``). The engine NEVER defines template looks of its
own: it interprets the same pure data as the web editor, and
``tests/test_caption_templates.py`` guards byte-level drift against the
TS-side artifact.

Resolution precedence mirrors the TS ``resolveCaptionStyle`` exactly: the
template fills every field the clip's explicit style leaves unset; explicit
fields always win, with FIELD-LEVEL (not deep) merge — an explicit nested
object (``highlight``/``background``/…) replaces the template's wholesale.
Change both implementations together.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import cache
from importlib import resources

from framepilot_engine.timeline.models import CaptionStyle

__all__ = [
    "CaptionTemplate",
    "default_template_id",
    "get_caption_template",
    "layer_caption_style",
    "load_catalog",
    "resolve_caption_style",
]


@dataclass(frozen=True)
class CaptionTemplate:
    """One catalog entry: a named, complete caption look (pure data)."""

    id: str
    label: str
    category: str
    suggested_words_per_line: int
    style: CaptionStyle


def _read_catalog_json() -> dict[str, object]:
    """Read the packaged ``caption_templates.json`` artifact."""
    payload = (
        resources.files("framepilot_engine.render")
        .joinpath("caption_templates.json")
        .read_text(encoding="utf-8")
    )
    data = json.loads(payload)
    if not isinstance(data, dict):  # pragma: no cover - corrupt artifact
        raise ValueError("caption_templates.json: expected a top-level object")
    return data


@cache
def load_catalog() -> dict[str, CaptionTemplate]:
    """Parse the packaged catalog once, keyed by template id."""
    data = _read_catalog_json()
    templates = data.get("templates")
    if not isinstance(templates, list):  # pragma: no cover - corrupt artifact
        raise ValueError("caption_templates.json: expected a 'templates' array")
    catalog: dict[str, CaptionTemplate] = {}
    for entry in templates:
        template = CaptionTemplate(
            id=entry["id"],
            label=entry["label"],
            category=entry["category"],
            suggested_words_per_line=entry["suggestedWordsPerLine"],
            style=CaptionStyle.model_validate(entry["style"]),
        )
        catalog[template.id] = template
    return catalog


@cache
def default_template_id() -> str:
    """The catalog's default template id (TS ``DEFAULT_CAPTION_TEMPLATE_ID``)."""
    value = _read_catalog_json().get("defaultTemplateId")
    if not isinstance(value, str):  # pragma: no cover - corrupt artifact
        raise ValueError("caption_templates.json: expected a 'defaultTemplateId' string")
    return value


def get_caption_template(template_id: str) -> CaptionTemplate | None:
    """Look up a catalog entry by id (``None`` for unknown ids)."""
    return load_catalog().get(template_id)


def layer_caption_style(
    track_default: CaptionStyle | None, clip_override: CaptionStyle | None
) -> CaptionStyle | None:
    """Layer a clip's style over its track's default (schema v11, ADR 0071).

    Field-level merge with the clip winning — including ``template_id``, so one
    cue may adopt a different template while every cue that specifies nothing
    follows the track. Mirrors the TS ``layerCaptionStyle``.
    """
    if track_default is None:
        return clip_override
    if clip_override is None:
        return track_default
    merged = track_default.model_dump(exclude_none=True, by_alias=True)
    merged.update(clip_override.model_dump(exclude_none=True, by_alias=True))
    return CaptionStyle.model_validate(merged)


def resolve_caption_style(
    style: CaptionStyle | None, track_default: CaptionStyle | None = None
) -> CaptionStyle:
    """Fold the template named by ``style.template_id`` under the explicit fields.

    Mirrors the TS ``resolveCaptionStyle`` precedence, highest first: **clip
    override → track default → template catalog**. Template values fill unset
    fields, explicit fields win (field-level merge). The result never carries a
    ``template_id`` (resolution is not re-entrant).

    ``track_default`` is optional so every pre-v11 call site behaves exactly as
    it did.
    """
    layered = layer_caption_style(track_default, style)
    if layered is None:
        return CaptionStyle()
    explicit = layered.model_dump(exclude_none=True, by_alias=True)
    explicit.pop("templateId", None)
    template = (
        get_caption_template(layered.template_id) if layered.template_id is not None else None
    )
    if template is None:
        return CaptionStyle.model_validate(explicit)
    merged = template.style.model_dump(exclude_none=True, by_alias=True)
    merged.update(explicit)
    return CaptionStyle.model_validate(merged)
