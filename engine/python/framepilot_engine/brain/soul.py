"""Cross-project memory — the "soul" (plan B6.2).

WHY: the project brain learns one project. Some things a user teaches are not
about *this* footage at all — "I always cut on the beat", "never put captions
over faces". Those belong to the person and should follow them into the next
project, which is exactly what davinci's cross-project Soul does.

Layout (outside any project, on the user's machine)::

    ~/.framepilot/soul/
        working_style.md              ← how this user likes to edit
        learned_from_corrections.md   ← promoted from repeated corrections
        perspective.md                ← taste/point-of-view notes
        corrections_index.json        ← bookkeeping for the promotion heuristic

**Slow-changing on purpose.** Only two things write here:

1. An explicit "remember this across projects" (:func:`append_soul_note`).
2. **Promotion**: the same correction seen in ``PROMOTION_MIN_PROJECTS``
   different projects (:func:`note_correction`). One project disliking
   something is a project preference and stays in that project's
   ``corrections.md``; the *same* note in two projects is a pattern about the
   person. This is why the index tracks distinct project ids rather than a
   count — ten corrections in one project still say nothing cross-project.

This **complements** ``user-memory.ts`` (typed preferences, localStorage in the
browser) rather than replacing it: this is the narrative tier, on disk, written
only by the sidecar — so it exists on desktop and honestly does not in a
browser-only build, like every other sidecar-derived capability.

Files here are capped and truncated oldest-first, reusing the project tiers'
hygiene (plan B6.4).
"""

from __future__ import annotations

import json
import logging
import re
from enum import StrEnum
from pathlib import Path

from framepilot_engine.brain.memory import (
    MAX_TIER_BYTES,
    atomic_write_text,
    fit_entries,
    parse_entries,
    render_markdown_file,
    render_section,
)

_log = logging.getLogger(__name__)

SOUL_DIRNAME = ".framepilot"
SOUL_SUBDIR = "soul"
CORRECTIONS_INDEX_FILENAME = "corrections_index.json"

# How many DISTINCT projects must show the same correction before it is promoted
# to the soul. Two is the smallest number that can distinguish "this project" from
# "this person" — the whole point of the heuristic.
PROMOTION_MIN_PROJECTS = 2

# Soul docs are read into a session-start prompt, so the digest is bounded well
# below the per-file cap; the newest notes are the ones that survive.
DEFAULT_DIGEST_MAX_CHARS = 2000

_WHITESPACE_RE = re.compile(r"\s+")
_NON_WORD_RE = re.compile(r"[^\w\s]")


class SoulDoc(StrEnum):
    """The cross-project documents (plan B6.2)."""

    WORKING_STYLE = "working_style"
    LEARNED_FROM_CORRECTIONS = "learned_from_corrections"
    PERSPECTIVE = "perspective"


_DOC_HEADERS: dict[SoulDoc, tuple[str, str]] = {
    SoulDoc.WORKING_STYLE: (
        "Working style",
        "How this editor likes to work, across every project. Newest last.",
    ),
    SoulDoc.LEARNED_FROM_CORRECTIONS: (
        "Learned from corrections",
        "Patterns promoted after the same correction appeared in several projects. "
        "Each entry names the project that confirmed it.",
    ),
    SoulDoc.PERSPECTIVE: (
        "Perspective",
        "Taste and point-of-view notes that outlive any single project. Newest last.",
    ),
}


def soul_root(home: Path | None = None) -> Path:
    """The soul directory, ``~/.framepilot/soul`` (``home`` injectable for tests)."""
    base = home if home is not None else Path.home()
    return base / SOUL_DIRNAME / SOUL_SUBDIR


def soul_doc_path(root: Path, doc: SoulDoc) -> Path:
    """The markdown file backing one soul document."""
    return root / f"{doc.value}.md"


def corrections_index_path(root: Path) -> Path:
    """The promotion bookkeeping file's path."""
    return root / CORRECTIONS_INDEX_FILENAME


def normalize_correction(text: str) -> str:
    """Fold a correction to a comparison key for the promotion heuristic.

    Case, punctuation, and whitespace differences must not hide that a user is
    saying the same thing twice ("Don't cut on the beat!" vs "dont cut on the
    beat"). Deliberately crude: this is a promotion *heuristic*, and a missed
    match only costs a promotion, while a false match would put words in the
    user's mouth across projects.
    """
    folded = _NON_WORD_RE.sub("", text.casefold())
    return _WHITESPACE_RE.sub(" ", folded).strip()


def read_corrections_index(root: Path) -> dict[str, list[str]]:
    """Load the correction → project ids index, or ``{}`` when absent/corrupt.

    Unreadable bookkeeping degrades to "no history": the worst case is a missed
    promotion, never a crash on a session-start path.
    """
    path = corrections_index_path(root)
    if not path.is_file():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        _log.warning("Soul corrections index unreadable; starting fresh → %s", path)
        return {}
    if not isinstance(raw, dict):
        return {}
    return {
        key: [p for p in value if isinstance(p, str)]
        for key, value in raw.items()
        if isinstance(key, str) and isinstance(value, list)
    }


def write_corrections_index(root: Path, index: dict[str, list[str]]) -> Path:
    """Persist the promotion index (atomic, canonical key order)."""
    return atomic_write_text(
        corrections_index_path(root),
        json.dumps(index, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
    )


def record_sighting(
    index: dict[str, list[str]],
    correction: str,
    project_id: str,
    *,
    min_projects: int = PROMOTION_MIN_PROJECTS,
) -> tuple[dict[str, list[str]], bool]:
    """Record that ``correction`` was seen in ``project_id``; report promotion.

    Pure: returns a NEW index rather than mutating. Promotion fires only on the
    transition across ``min_projects`` distinct projects, so a third and fourth
    project repeating the same correction never re-append the same soul note.

    :returns: ``(new_index, promoted)``.
    """
    key = normalize_correction(correction)
    if not key:
        return dict(index), False
    before = index.get(key, [])
    if project_id in before:
        return dict(index), False  # same project repeating itself proves nothing
    after = sorted([*before, project_id])
    promoted = len(before) < min_projects <= len(after)
    return {**index, key: after}, promoted


def append_soul_note(
    root: Path,
    doc: SoulDoc,
    *,
    title: str,
    ts: str,
    body: str = "",
    project_id: str | None = None,
    max_bytes: int = MAX_TIER_BYTES,
) -> Path:
    """Append one note to a soul document, capped oldest-first (plan B6.2/B6.4).

    The explicit "remember this across projects" path. Same read-parse-fit-
    rewrite discipline as the project tiers; ``project_id`` traces the note back
    to where it was learned.
    """
    target = soul_doc_path(root, doc)
    existing = target.read_text(encoding="utf-8") if target.exists() else ""
    section = render_section(ts=ts, title=title, body=body, trace=project_id, trace_label="project")
    title_text, blurb = _DOC_HEADERS[doc]
    header_bytes = len(render_markdown_file(title_text, blurb, [], truncated=True).encode("utf-8"))
    kept, truncated = fit_entries(
        [*parse_entries(existing), section], max(0, max_bytes - header_bytes)
    )
    atomic_write_text(target, render_markdown_file(title_text, blurb, kept, truncated=truncated))
    _log.info("ACT soul append: doc=%s entries=%d truncated=%s", doc.value, len(kept), truncated)
    return target


def note_correction(root: Path, correction: str, project_id: str, *, ts: str) -> bool:
    """Record a correction sighting; promote it to the soul on the Nth project.

    The repeated-correction path (plan B6.2). Called for every correction, but
    only writes ``learned_from_corrections.md`` when the same note has now been
    seen in :data:`PROMOTION_MIN_PROJECTS` different projects.

    :returns: Whether this sighting promoted the correction.
    """
    index, promoted = record_sighting(read_corrections_index(root), correction, project_id)
    write_corrections_index(root, index)
    if promoted:
        append_soul_note(
            root,
            SoulDoc.LEARNED_FROM_CORRECTIONS,
            title=correction.strip().splitlines()[0][:120],
            ts=ts,
            body=(
                f"Seen in {PROMOTION_MIN_PROJECTS} different projects — treating this as "
                "a standing preference, not a one-off."
            ),
            project_id=project_id,
        )
        _log.info("ACT soul promote: correction confirmed across projects (project=%s)", project_id)
    return promoted


def read_soul_doc(root: Path, doc: SoulDoc) -> str:
    """Read one soul document's text, or ``''`` when it does not exist yet."""
    target = soul_doc_path(root, doc)
    return target.read_text(encoding="utf-8") if target.exists() else ""


def soul_digest(root: Path, *, max_chars: int = DEFAULT_DIGEST_MAX_CHARS) -> str:
    """Assemble a bounded cross-project digest for session context (plan B6.3).

    Concatenates whatever documents exist, in enum order, and bounds the result
    by dropping from the FRONT — the newest notes are at the end of each file
    and are what a model most needs. Returns ``''`` when the user has no soul
    yet (a first-run user is not a broken one).
    """
    parts = [text for doc in SoulDoc if (text := read_soul_doc(root, doc).strip())]
    if not parts:
        return ""
    digest = "\n\n".join(parts)
    if len(digest) <= max_chars:
        return digest
    return "…\n" + digest[-max_chars:]
