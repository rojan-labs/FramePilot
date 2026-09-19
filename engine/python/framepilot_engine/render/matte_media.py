"""Refuse a matte whose source media changed after it was made (BR4.14, audit P9).

WHY: relinking or replacing an asset's file keeps the asset id, so every matte on it still
"belongs" to the clip while the pictures underneath may be different footage. The desktop
host records, when it commits a matte, the source's content fingerprint and the decoded-frame
sha256 of the coverage's exact first and last frames plus 16 samples
(``.framepilot-derived/mattes/.results/<key>.json``). Before an export draws the matte this
module re-measures them, exactly as the desktop's ``matte-media-recheck.ts`` does:

* the fingerprint matches → unchanged, no decode;
* otherwise every recorded frame must decode to the same hash at the same pts, or the export
  refuses with ``matte_media_changed`` and the same sentence the Inspector shows.

A matte whose record is missing or unreadable in a store that keeps records (a ``.results``
folder exists) is refused as changed: nothing can prove its media still matches. A store with no
records at all (made before records existed) is not re-checked here; its digests and frame
alignment are still verified by :mod:`mattes`.
"""

from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
from typing import Any

from framepilot_engine.render.frame_hashes import FrameHashError, frame_hashes_by_pts
from framepilot_engine.render.mattes import MatteRefusal, MatteRefusalCode, PreparedMatte
from framepilot_engine.render.pts_reader import VideoTiming, VideoTimingError, video_timing

_log = logging.getLogger(__name__)

RESULTS_DIR = ".results"
#: Bytes hashed from each end of the source; must equal the desktop's ``FINGERPRINT_EDGE_BYTES``.
FINGERPRINT_EDGE_BYTES = 8 * 1024 * 1024
#: Largest record the engine reads.
RECORD_MAX_BYTES = 8 * 1024 * 1024


def source_content_fingerprint(path: Path, timing: VideoTiming) -> str:
    """The desktop's content fingerprint (``matte-store.ts::sourceContentFingerprint``)."""
    size = path.stat().st_size
    edge = min(FINGERPRINT_EDGE_BYTES, size)
    with path.open("rb") as handle:
        head = handle.read(edge)
        handle.seek(size - edge)
        tail = handle.read(edge)
    pts_hash = hashlib.sha256(",".join(str(p) for p in timing.pts).encode()).hexdigest()
    parts = [
        f"size:{size}",
        f"head:{hashlib.sha256(head).hexdigest()}",
        f"tail:{hashlib.sha256(tail).hexdigest()}",
        f"timebase:{timing.time_base.numerator}/{timing.time_base.denominator}",
        f"pts:{pts_hash}",
    ]
    return hashlib.sha256("|".join(parts).encode()).hexdigest()


def read_record(prepared: PreparedMatte) -> dict[str, Any] | None:
    """The host record for this artifact, or ``None`` when absent or unreadable."""
    record_path = prepared.directory.parent / RESULTS_DIR / f"{prepared.directory.name}.json"
    try:
        if record_path.is_symlink() or not record_path.is_file():
            return None
        if record_path.stat().st_size > RECORD_MAX_BYTES:
            return None
        document = json.loads(record_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(document, dict) or document.get("key") != prepared.directory.name:
        return None
    return document


def assert_media_unchanged(prepared: PreparedMatte, source_path: str | Path) -> None:
    """Refuse the matte when its source media no longer decodes to the recorded frames.

    :raises MatteRefusal: ``matte_media_changed``.
    """
    refusal = MatteRefusal(MatteRefusalCode.MEDIA_CHANGED, prepared.mask_id, prepared.clip_id)
    record = read_record(prepared)
    if record is None:
        # A host-managed store (it has a `.results` folder) writes a record for every matte it
        # commits, so a missing or unreadable one means nothing can prove the media still matches:
        # STALE, not a silent pass (BR4.12 re-review). A store with no records at all predates them.
        results = prepared.directory.parent / RESULTS_DIR
        if results.is_dir() and not results.is_symlink():
            raise refusal
        return
    path = Path(source_path)
    try:
        timing = video_timing(path)
        if source_content_fingerprint(path, timing) == record.get("contentFingerprint"):
            return
    except (OSError, VideoTimingError) as exc:
        raise refusal from exc
    samples = record.get("sourceSamples")
    if not isinstance(samples, list) or not samples:
        raise refusal
    try:
        pts = [int(sample["pts"]) for sample in samples]
        expected = [str(sample["sha256"]) for sample in samples]
    except (KeyError, TypeError, ValueError) as exc:
        raise refusal from exc
    try:
        actual = frame_hashes_by_pts(path, pts[:256], "native")
    except (FrameHashError, ValueError) as exc:
        raise refusal from exc
    if actual != expected[:256]:
        _log.info("matte %s: source frames changed", prepared.directory.name[:12])
        raise refusal
