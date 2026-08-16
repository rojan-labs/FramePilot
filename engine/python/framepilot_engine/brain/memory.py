"""Human/model-readable memory tiers derived from the brain (plan B1.5, B6.1, B6.4).

WHY: the agent loop (and the human peeking under the hood) should be able to
answer "what media do I have, and what have we learned?" from a few small
markdown files instead of querying SQLite — the davinci file-based-memory idea.
Everything here is **derived and rebuildable** (never canonical, like every
brain artifact) and written atomically.

Two kinds of memory live here:

- **Digest** (B1.5): ``bin_summary.md``, regenerated wholesale after each
  persisted analysis pass from the asset rows and their latest results. Missing
  analyses render as honest "not analyzed" lines, never fabricated numbers.
- **Narrative** (B6.1): append-only ``corrections.md`` / ``decisions.md`` /
  ``session_notes/<date>.md``. The typed ``memory-store.ts`` stays authoritative
  for *preferences*; these are the prose tier a model reads for the *why*.

Layout under ``<brain dir>/memory/``::

    bin_summary.md
    corrections.md
    decisions.md
    session_notes/2026-07-15.md

Narrative tiers are size-capped and truncated **oldest-first** (plan B6.4) so a
long-lived project can never grow an unbounded file — or an unbounded prompt.
"""

from __future__ import annotations

import logging
import os
import re
import tempfile
from pathlib import Path
from typing import Any

from framepilot_engine.brain.models import (
    AnalysisResultRow,
    AssetRow,
    MemoryEntry,
    MemoryTier,
)
from framepilot_engine.brain.store import BrainStore
from framepilot_engine.safety import resolve_within

_log = logging.getLogger(__name__)

MEMORY_DIRNAME = "memory"
BIN_SUMMARY_FILENAME = "bin_summary.md"
SESSION_NOTES_DIRNAME = "session_notes"

# Per-file cap for the narrative tiers (plan B6.4). Generous enough that a
# normal project never truncates, small enough that a runaway loop cannot fill a
# disk or blow a context window: oldest entries are dropped first.
MAX_TIER_BYTES = 64 * 1024

# How many characters of transcript to quote as the "first line" — enough to
# identify the take, small enough to keep the digest skimmable.
_TRANSCRIPT_SNIPPET_MAX_CHARS = 80

_NOT_ANALYZED = "not analyzed"


def bin_summary_path(brain_dir: Path) -> Path:
    """The bin summary file path inside a project's (already sandboxed) brain dir."""
    return brain_dir / MEMORY_DIRNAME / BIN_SUMMARY_FILENAME


def _latest_result(rows: list[AnalysisResultRow], kind: str) -> dict[str, Any] | None:
    """The newest persisted result of ``kind``, or ``None`` when never analyzed.

    ``list_analysis`` returns rows in deterministic key order; picking the max
    ``created_at`` (ties → the later row) keeps the digest deterministic while
    always reflecting the freshest pass.
    """
    latest: AnalysisResultRow | None = None
    for row in rows:
        if row.kind != kind:
            continue
        if latest is None or row.created_at >= latest.created_at:
            latest = row
    return latest.result if latest is not None else None


def _probe_duration_seconds(probe: dict[str, Any] | None) -> float | None:
    value = (probe or {}).get("duration_seconds")
    return value if isinstance(value, (int, float)) else None


def _duration_line(probe: dict[str, Any] | None) -> str:
    duration = _probe_duration_seconds(probe)
    return f"{duration:.1f}s" if duration is not None else "unknown"


def _resolution_line(probe: dict[str, Any] | None) -> str:
    streams = (probe or {}).get("streams")
    for stream in streams if isinstance(streams, list) else []:
        if not isinstance(stream, dict) or stream.get("codec_type") != "video":
            continue
        width, height = stream.get("width"), stream.get("height")
        if isinstance(width, int) and isinstance(height, int):
            return f"{width}x{height}"
    return "no video"


def _loudness_line(result: dict[str, Any] | None) -> str:
    if result is None:
        return _NOT_ANALYZED
    lufs = result.get("integratedLufs")
    return f"{lufs:.1f} LUFS" if isinstance(lufs, (int, float)) else _NOT_ANALYZED


def _scenes_line(result: dict[str, Any] | None) -> str:
    if result is None:
        return _NOT_ANALYZED
    cuts = result.get("cuts")
    count = len(cuts) if isinstance(cuts, list) else 0
    return f"{count} scene cut{'' if count == 1 else 's'}"


def _silence_line(result: dict[str, Any] | None, probe: dict[str, Any] | None) -> str:
    if result is None:
        return _NOT_ANALYZED
    ranges = result.get("ranges")
    rows = ranges if isinstance(ranges, list) else []
    count = len(rows)
    silent_seconds = sum(
        r["duration"]
        for r in rows
        if isinstance(r, dict) and isinstance(r.get("duration"), (int, float))
    )
    ranges_part = f"{count} silent range{'' if count == 1 else 's'}"
    duration = _probe_duration_seconds(probe)
    if duration is not None and duration > 0:
        return f"{silent_seconds / duration:.0%} silent ({ranges_part})"
    return ranges_part


def _transcript_line(result: dict[str, Any] | None) -> str:
    if result is None:
        return "not transcribed"
    words = result.get("words")
    tokens = [
        w["word"]
        for w in (words if isinstance(words, list) else [])
        if isinstance(w, dict) and isinstance(w.get("word"), str)
    ]
    if not tokens:
        return "no speech detected"
    snippet = " ".join(tokens)
    if len(snippet) > _TRANSCRIPT_SNIPPET_MAX_CHARS:
        snippet = snippet[:_TRANSCRIPT_SNIPPET_MAX_CHARS].rstrip() + "…"
    return f'"{snippet}"'


def asset_section(asset: AssetRow, rows: list[AnalysisResultRow]) -> str:
    """One asset's digest section — also the text embedded for similarity (B3.2)."""
    probe = asset.probe
    lines = [
        f"## {asset.id} ({asset.path})",
        "",
        f"- duration: {_duration_line(probe)}",
        f"- resolution: {_resolution_line(probe)}",
        f"- loudness: {_loudness_line(_latest_result(rows, 'loudness'))}",
        f"- scenes: {_scenes_line(_latest_result(rows, 'scenes'))}",
        f"- silence: {_silence_line(_latest_result(rows, 'silence'), probe)}",
        f"- transcript: {_transcript_line(_latest_result(rows, 'transcription'))}",
    ]
    return "\n".join(lines)


def render_bin_summary(store: BrainStore) -> str:
    """Render the media-bin digest markdown from the brain's current rows.

    Pure over the store's contents — same rows, same text — so regeneration
    is idempotent and the file diffs meaningfully across analysis passes.
    """
    assets = store.list_assets()
    header = [
        "# Media bin summary",
        "",
        "Derived from the project brain — regenerated after each analysis pass; do not edit.",
    ]
    if not assets:
        return "\n".join([*header, "", "No assets analyzed yet."]) + "\n"
    sections = [asset_section(asset, store.list_analysis(asset.id)) for asset in assets]
    return "\n\n".join(["\n".join(header), *sections]) + "\n"


def atomic_write_text(target: Path, text: str) -> Path:
    """Write ``text`` to ``target`` via temp file + rename, creating parents.

    Temp file in the same directory then atomic rename, so a crash mid-write
    never leaves a truncated file (same pattern as the sidecar exports). Shared
    by the digest, the narrative tiers, and the soul (:mod:`.soul`) — all are
    read by a model, and a half-written memory is worse than a missing one.
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=target.parent, prefix=f".{target.name}.")
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        tmp_path.replace(target)
    finally:
        if tmp_path.exists():  # rename failed or write raised
            tmp_path.unlink()
    return target


def write_bin_summary(store: BrainStore, brain_dir: Path) -> Path:
    """Regenerate ``memory/bin_summary.md`` from the brain (atomic write)."""
    target = atomic_write_text(bin_summary_path(brain_dir), render_bin_summary(store))
    _log.debug("Regenerated bin summary → %s", target)
    return target


# --- narrative tiers (plan B6.1) ----------------------------------------------

# Each tier's file header: what it is, and the discipline that keeps it honest.
_TIER_HEADERS: dict[MemoryTier, tuple[str, str]] = {
    MemoryTier.CORRECTIONS: (
        "Corrections",
        "Edits the user rejected, and why. Avoid repeating these. Newest last; "
        "each entry names the patch it refers to.",
    ),
    MemoryTier.DECISIONS: (
        "Decisions",
        "Editorial choices the user accepted. Newest last; each entry names the patch.",
    ),
    MemoryTier.SESSION_NOTES: (
        "Session notes",
        "What happened in each run on this date. Newest last.",
    ),
}

_TRUNCATION_NOTICE = "_Older entries were dropped to respect the size cap._"

# An entry begins at a markdown H2. Matched at line starts only, so an H2-looking
# line inside a fenced code block in a body would split an entry — bodies here are
# reasons and run summaries, not documents, and a mis-split only ever costs a
# truncation boundary, never correctness of what is written.
_ENTRY_SPLIT_RE = re.compile(r"^## ", re.MULTILINE)


def memory_dir(brain_dir: Path) -> Path:
    """The memory directory inside a project's (already sandboxed) brain dir."""
    return brain_dir / MEMORY_DIRNAME


def session_note_date(ts: str) -> str:
    """The ``YYYY-MM-DD`` date a timestamp's session note belongs to.

    Derived from the entry's own ISO-8601 timestamp rather than a wall clock, so
    the file a note lands in is a pure function of the note.
    """
    return ts[:10]


def tier_path(brain_dir: Path, tier: MemoryTier, *, ts: str | None = None) -> Path:
    """The markdown file backing ``tier``.

    Session notes are per-day (``session_notes/<date>.md``), so they need the
    entry's ``ts``; the other tiers are single append-only files.

    :raises ValueError: for a session-notes path with no timestamp to date it by.
    :raises PathTraversalError: if ``ts`` would date a note outside the brain dir.
    """
    base = memory_dir(brain_dir)
    if tier is not MemoryTier.SESSION_NOTES:
        return base / f"{tier.value}.md"
    if ts is None:
        raise ValueError("Session notes are per-day; a ts is required to resolve the file.")
    # `ts` reaches the filename via session_note_date(), so it is a path segment.
    # The routes generate it server-side today, but this module's public API takes
    # any string, and an absolute one (`/etc/cron.d/x`) would silently reset the
    # join and write attacker-chosen markdown outside the sandbox. Every other
    # brain tree has a resolve_within backstop; this is the one that lacked it.
    return resolve_within(base, str(Path(SESSION_NOTES_DIRNAME) / f"{session_note_date(ts)}.md"))


def render_section(
    *,
    ts: str,
    title: str,
    body: str = "",
    trace: str | None = None,
    trace_label: str = "patch",
) -> str:
    """Render one timestamped markdown section (trailing newline included).

    The shared entry format for every append-only markdown file in the memory
    system — the project tiers here and the cross-project soul
    (:mod:`.soul`) — so :func:`parse_entries` can split any of them.

    ``trace`` is the id this prose refers to (a patch for a correction, a
    project for a soul note): what keeps an entry falsifiable (plan B6.4). It is
    omitted rather than faked when absent.
    """
    lines = [f"## {ts} — {title}", ""]
    if trace is not None:
        lines += [f"{trace_label}: {trace}", ""]
    stripped = body.strip()
    if stripped:
        lines += [stripped, ""]
    return "\n".join(lines)


def render_entry(entry: MemoryEntry) -> str:
    """Render one project memory entry as a markdown section."""
    return render_section(ts=entry.ts, title=entry.title, body=entry.body, trace=entry.patch_id)


def parse_entries(text: str) -> list[str]:
    """Split a tier file into its entry sections, oldest first.

    The inverse of :func:`render_entry` over a whole file: anything before the
    first entry (the header, a truncation notice) is dropped, because the header
    is regenerated on every write rather than carried forward.
    """
    parts = _ENTRY_SPLIT_RE.split(text)
    return [f"## {part}".rstrip("\n") + "\n" for part in parts[1:]]


def render_markdown_file(title: str, blurb: str, entries: list[str], *, truncated: bool) -> str:
    """Render a whole append-only markdown file: header, notice, entries.

    The file is rewritten wholesale on each append rather than literally
    appended to, which is what lets the cap drop old entries — the *contract* is
    append-only (entries are never edited or reordered), not the I/O. Shared
    with the soul (:mod:`.soul`).
    """
    header = [f"# {title}", "", blurb, ""]
    if truncated:
        header += [_TRUNCATION_NOTICE, ""]
    return "\n".join(header) + "\n".join(entries)


def render_tier_file(tier: MemoryTier, entries: list[str], *, truncated: bool) -> str:
    """Render a whole project memory tier file."""
    title, blurb = _TIER_HEADERS[tier]
    return render_markdown_file(title, blurb, entries, truncated=truncated)


def fit_entries(entries: list[str], budget_bytes: int) -> tuple[list[str], bool]:
    """Drop oldest entries until the rest fit ``budget_bytes`` (plan B6.4).

    The NEWEST entry is always kept, even when it alone exceeds the budget: the
    thing the user just told us is the last thing we should forget, and an
    over-cap file is a visible, bounded overshoot rather than silent data loss.

    :returns: ``(kept_entries, truncated)`` — ``truncated`` reports whether
        anything was actually dropped, so the file can say so honestly.
    """
    if not entries:
        return [], False
    kept = list(entries)
    size = sum(len(e.encode("utf-8")) for e in kept)
    truncated = False
    while len(kept) > 1 and size > budget_bytes:
        size -= len(kept.pop(0).encode("utf-8"))
        truncated = True
    return kept, truncated


def append_memory_entry(
    brain_dir: Path,
    entry: MemoryEntry,
    *,
    max_bytes: int = MAX_TIER_BYTES,
) -> Path:
    """Append one narrative entry to its tier file, capped oldest-first.

    Read → parse → append → fit → atomic rewrite. Not concurrency-safe against
    another writer, which is fine under the single-writer invariant (only this
    sidecar writes the brain dir).

    :returns: The tier file written.
    """
    target = tier_path(brain_dir, entry.tier, ts=entry.ts)
    existing = target.read_text(encoding="utf-8") if target.exists() else ""
    entries = [*parse_entries(existing), render_entry(entry)]
    header_bytes = len(render_tier_file(entry.tier, [], truncated=True).encode("utf-8"))
    kept, truncated = fit_entries(entries, max(0, max_bytes - header_bytes))
    atomic_write_text(target, render_tier_file(entry.tier, kept, truncated=truncated))
    _log.info(
        "ACT memory append: tier=%s entries=%d truncated=%s → %s",
        entry.tier.value,
        len(kept),
        truncated,
        target,
    )
    return target


def read_tier(brain_dir: Path, tier: MemoryTier, *, ts: str | None = None) -> str:
    """Read a tier file's text, or ``''`` when it does not exist yet."""
    try:
        target = tier_path(brain_dir, tier, ts=ts)
    except ValueError:
        return ""
    return target.read_text(encoding="utf-8") if target.exists() else ""


def latest_session_note(brain_dir: Path) -> str:
    """The most recent day's session note, or ``''`` when none exist.

    Date-stamped filenames sort lexicographically in chronological order, so
    "newest" needs no stat() calls and stays deterministic.
    """
    notes_dir = memory_dir(brain_dir) / SESSION_NOTES_DIRNAME
    if not notes_dir.is_dir():
        return ""
    notes = sorted(p for p in notes_dir.glob("*.md") if p.is_file())
    return notes[-1].read_text(encoding="utf-8") if notes else ""


def tail_entries(text: str, max_entries: int) -> str:
    """The newest ``max_entries`` entries of a tier file, headerless.

    Used to bound what session context injects (plan B6.3): a model needs the
    recent corrections, not the project's whole history.
    """
    entries = parse_entries(text)
    if not entries or max_entries <= 0:
        return ""
    return "".join(entries[-max_entries:]).rstrip("\n") + "\n"
