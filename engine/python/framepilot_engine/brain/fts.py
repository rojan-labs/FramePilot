"""Full-text-search ingest helpers for the Project Brain (plan B2.1).

WHY: "find where I said X" must be an index lookup, not a linear scan of the
whole inline ``transcript[]``. This module owns the two pure, deterministic
transformations between the canonical project document and the FTS5 tables in
``brain.sqlite``:

- **Utterance segmentation** — the transcript's flat word list is grouped into
  contiguous utterances using the exact ``DIALOGUE_GAP_SECONDS`` rule the TS
  ``SemanticTimelineIndex`` uses (``semantic-index.ts#deriveDialogue``), so a
  search hit corresponds one-to-one with a dialogue segment the proposers
  already reason about.
- **Match-expression sanitizing** — raw user/model queries are re-tokenized
  into quoted FTS5 terms, so query syntax (``"``, ``*``, ``NEAR``, column
  filters) can never be injected into the MATCH grammar (plan B7.2).

The FTS tables are *indexes over canonical data* (invariant 1): they are
dropped and rebuilt from the project document on every ingest, never treated
as truth.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol

from framepilot_engine.brain.models import TranscriptUtterance

__all__ = [
    "DIALOGUE_GAP_SECONDS",
    "SupportsMarker",
    "SupportsWord",
    "fts_match_expression",
    "segment_utterances",
]

#: Max gap (seconds) between one word ending and the next beginning that still
#: counts as the same utterance. MUST mirror ``DIALOGUE_GAP_SECONDS`` in
#: ``packages/ai-sdk/src/kernel/semantic-index/semantic-index.ts`` — search
#: hits and dialogue segments are the same segmentation of the same transcript.
DIALOGUE_GAP_SECONDS = 0.6


class SupportsWord(Protocol):
    """Anything shaped like a transcript word (``timeline.models.TranscriptWord``)."""

    @property
    def word(self) -> str: ...
    @property
    def start(self) -> float: ...
    @property
    def end(self) -> float: ...


class SupportsMarker(Protocol):
    """Anything shaped like a timeline marker (``timeline.models.Marker``).

    A Protocol (not an import of the timeline model) so the brain package
    never depends on the timeline package — the service layer is the only
    place the two meet.
    """

    @property
    def id(self) -> str: ...
    @property
    def time(self) -> float: ...
    @property
    def label(self) -> str | None: ...


def segment_utterances(words: Sequence[SupportsWord]) -> list[TranscriptUtterance]:
    """Group a time-ordered word list into contiguous utterances.

    Mirrors ``semantic-index.ts#deriveDialogue`` exactly: a gap larger than
    :data:`DIALOGUE_GAP_SECONDS` between adjacent words starts a new utterance;
    an utterance's ``end`` only ever grows (an overlapping shorter word never
    shrinks it). Pure and deterministic.
    """
    utterances: list[TranscriptUtterance] = []
    current: tuple[float, float, list[str]] | None = None  # (start, end, words)
    for w in words:
        if current is not None and w.start - current[1] > DIALOGUE_GAP_SECONDS:
            utterances.append(
                TranscriptUtterance(start=current[0], end=current[1], text=" ".join(current[2]))
            )
            current = None
        if current is None:
            current = (w.start, w.end, [w.word])
        else:
            current[2].append(w.word)
            if w.end > current[1]:
                current = (current[0], w.end, current[2])
    if current is not None:
        utterances.append(
            TranscriptUtterance(start=current[0], end=current[1], text=" ".join(current[2]))
        )
    return utterances


def fts_match_expression(query: str) -> str:
    """Reduce an untrusted query to a safe FTS5 MATCH expression.

    Every alphanumeric token is double-quoted (FTS5 string syntax: a quoted
    token is always a term, never an operator/column filter) and the tokens are
    joined with implicit AND — "all words, any order". Quote characters cannot
    escape because non-alphanumeric characters are treated as separators and
    dropped. An empty result means "nothing searchable" and callers MUST skip
    the MATCH entirely rather than send an empty expression (FTS5 errors on it).
    """
    tokens: list[str] = []
    current: list[str] = []
    for ch in query:
        if ch.isalnum():
            current.append(ch)
        elif current:
            tokens.append("".join(current))
            current = []
    if current:
        tokens.append("".join(current))
    return " ".join(f'"{token}"' for token in tokens)
