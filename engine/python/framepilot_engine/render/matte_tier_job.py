"""Make a committed artifact's monitor tier in a project, safely and atomically (PX5.9).

WHY a module beside :mod:`framepilot_engine.render.matte_tier`: that module is the tier's
derivation (pixels, format, manifest). This one is what the sidecar route
``POST /mattes/monitor-tier`` does around it on the user's disk, under the same rules as the
desktop's matte store (``docs/runbooks/capability-pack-security.md``):

* **Only through real folders.** ``.framepilot-derived/mattes/<key>`` is walked component by
  component with ``lstat``: a symlinked folder anywhere on the way, or a master that is not a
  plain regular file, refuses the request. The tier folders are created the same way and
  checked after creation. Nothing is read or written through a link.
* **Digests before and after pixels.** The masters are hashed against the mask's pins before the
  first frame is decoded and again after the last; a master that changed in between discards
  the work, so a tier never describes pixels its pins do not.
* **Atomic.** Everything is written into ``matte-tiers/.staging/<random>/``, the written files
  are probed back (sizes, frame counts, the manifest), and only then is the folder renamed to
  ``matte-tiers/<key>``. A reader sees the old tier, no tier, or the whole new one; the monitor
  treats "no tier" as "decode the masters".
* **Idempotent.** A tier that already names these digests at this size, frame count and layout
  (with its alpha plane) is reported current and left alone.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import stat
import subprocess
import time
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from framepilot_engine.media.ffmpeg import find_ffprobe
from framepilot_engine.media.untrusted import FORMAT_WHITELIST
from framepilot_engine.render.matte_tier import (
    ALPHA_FILE,
    ALPHA_SCALE,
    MATTE_TIERS_DIR,
    PLANE_LAYOUT,
    PLANES_FILE,
    PROBE_TIMEOUT_SECONDS,
    TIER_FILE,
    TIER_KIND,
    TIER_VERSION,
    MatteTierError,
    probe_master,
    verified_source,
    write_monitor_tier,
)
from framepilot_engine.render.mattes import (
    FOREGROUND_FILE,
    FRAMES_FILE,
    MATTE_FILE,
    MATTES_DIR,
    read_frames_file,
)
from framepilot_engine.subprocess_safety import validate_safe_argv

_log = logging.getLogger(__name__)

#: Staged tiers, beside the tiers and never inside one: ``matte-tiers/.staging/<random>``.
TIER_STAGING_DIR = ".staging"
#: Largest ``tier.json`` read back (a few hundred bytes are expected).
TIER_JSON_MAX_BYTES = 64 * 1024
#: Largest side a monitor tier may have (the monitor's own bound, `matte-source.ts`).
TIER_MAX_SIDE = 8192
_KEY = re.compile(r"^[0-9a-f]{64}$")
_MASTERS = (MATTE_FILE, FOREGROUND_FILE, FRAMES_FILE)


class MatteTierUnsafePath(MatteTierError):
    """A folder on the way is a link or not a folder, or a master is not a plain file."""


class MatteTierMissing(MatteTierError):
    """The artifact (or the picture the tier is sized for) is not there."""


@dataclass(frozen=True)
class TierJobResult:
    """What the route reports: whether a tier was written or was already current, and its facts."""

    status: Literal["written", "current"]
    width: int
    height: int
    frame_count: int
    alpha: bool


# --- Real folders only ---------------------------------------------------------------------------


def _is_real_directory(path: Path) -> bool:
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return False
    return stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode)


def real_directory(base: Path, parts: Sequence[str], *, create: bool) -> Path:
    """``base / parts...``, every component a real directory (``lstat``: no symlink anywhere).

    :param create: Make missing components (then check what was made).
    :raises MatteTierUnsafePath: A component is a link or not a directory.
    :raises MatteTierMissing: A component is missing and ``create`` is false.
    """
    if not _is_real_directory(base):
        raise MatteTierUnsafePath("The project folder is not a plain folder.")
    current = base
    for part in parts:
        if part in ("", ".", "..") or "/" in part or "\\" in part:
            raise MatteTierUnsafePath("A matte folder name is not a plain name.")
        current = current / part
        try:
            info = os.lstat(current)
        except FileNotFoundError:
            if not create:
                raise MatteTierMissing("The background removal data is missing.") from None
            current.mkdir(mode=0o755)
            info = os.lstat(current)
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise MatteTierUnsafePath("A matte folder is a link or not a folder.")
    return current


def _regular_file(path: Path) -> bool:
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return False
    return stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode)


def _remove_tree(path: Path) -> None:
    """Remove a folder this module staged; a link is unlinked, never followed."""
    if path.is_symlink():
        path.unlink(missing_ok=True)
        return
    shutil.rmtree(path, ignore_errors=True)


# --- The size the monitor decodes the picture at --------------------------------------------------


def monitor_tier_size(proxy: Path, rotation: int) -> tuple[int, int]:
    """The size the desktop monitor decodes ``proxy`` at: its first video stream's coded size,
    turned for a 90/270 display rotation exactly as the monitor turns the decoded picture
    (``rotateI420`` by ``Asset.media.rotation``). Probed with the hardened input options.

    :raises MatteTierMissing: ``proxy`` is not a regular file.
    :raises MatteTierError: It has no readable video stream, or a size out of bounds.
    """
    if not _regular_file(proxy):
        raise MatteTierMissing("The picture the tier is made for is missing.")
    argv = validate_safe_argv(
        [
            find_ffprobe(),
            "-v",
            "error",
            "-protocol_whitelist",
            "file",
            "-format_whitelist",
            FORMAT_WHITELIST,
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "json",
            "-i",
            str(proxy),
        ]
    )
    try:
        completed = subprocess.run(
            argv, capture_output=True, check=False, timeout=PROBE_TIMEOUT_SECONDS
        )
        stream = (json.loads(completed.stdout or b"{}").get("streams") or [])[0]
        width, height = int(stream["width"]), int(stream["height"])
    except (subprocess.SubprocessError, ValueError, IndexError, KeyError, TypeError) as exc:
        raise MatteTierError("The picture could not be measured.") from exc
    if not (0 < width <= TIER_MAX_SIDE and 0 < height <= TIER_MAX_SIDE):
        raise MatteTierError("The picture is outside the sizes a tier is made at.")
    return (height, width) if rotation in (90, 270) else (width, height)


# --- Current, staged, verified, renamed -----------------------------------------------------------


def _read_manifest(directory: Path) -> dict[str, Any] | None:
    path = directory / TIER_FILE
    if not _regular_file(path) or path.stat().st_size > TIER_JSON_MAX_BYTES:
        return None
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return document if isinstance(document, dict) else None


def _manifest_matches(
    manifest: Mapping[str, Any] | None,
    source: Mapping[str, Any],
    size: tuple[int, int],
    frame_count: int,
) -> bool:
    if manifest is None:
        return False
    planes = manifest.get("planes") or {}
    alpha = manifest.get("alpha") or {}
    return (
        manifest.get("version") == TIER_VERSION
        and manifest.get("kind") == TIER_KIND
        and (manifest.get("width"), manifest.get("height")) == size
        and manifest.get("frameCount") == frame_count
        and manifest.get("source") == dict(source)
        and planes.get("file") == PLANES_FILE
        and planes.get("layout") == PLANE_LAYOUT
        and alpha.get("file") == ALPHA_FILE
        and alpha.get("layout") == PLANE_LAYOUT
        and alpha.get("scale") == ALPHA_SCALE
    )


def _tier_is_current(
    directory: Path, source: Mapping[str, Any], size: tuple[int, int], frame_count: int
) -> bool:
    manifest = _read_manifest(directory)
    if not _manifest_matches(manifest, source, size, frame_count):
        return False
    assert manifest is not None
    for name, entry in ((PLANES_FILE, manifest["planes"]), (ALPHA_FILE, manifest["alpha"])):
        path = directory / name
        if not _regular_file(path) or path.stat().st_size != entry.get("bytes"):
            return False
    return True


def _verify_staged(
    staged: Path, source: Mapping[str, Any], size: tuple[int, int], frame_count: int
) -> None:
    """The staged tier is what its manifest says: probe every file back before it is renamed."""
    width, height = size
    if not _tier_is_current(staged, source, size, frame_count):
        raise MatteTierError("The staged tier does not match its manifest.")
    for name, rows in ((PLANES_FILE, 8 * height), (ALPHA_FILE, 2 * height)):
        info = probe_master(staged / name)
        if (info.width, info.height, info.pixel_format) != (width, rows, "gray") or (
            info.frame_count != frame_count
        ):
            raise MatteTierError("A staged tier file is not what its manifest says.")


def make_monitor_tier(
    base_dir: Path,
    artifact: Mapping[str, Any],
    size: tuple[int, int],
    *,
    budget_seconds: Callable[[int], float],
) -> TierJobResult:
    """Make (or confirm) ``<base_dir>/.framepilot-derived/matte-tiers/<key>/`` for ``artifact``.

    :param artifact: What the mask pins: ``key``, ``files`` (name + sha256), ``width``, ``height``.
    :param size: The monitor's decoded size (:func:`monitor_tier_size`).
    :param budget_seconds: The total time allowed for a tier of so many frames.
    :raises MatteTierUnsafePath: A folder on the way is a link, or a master is not a plain file.
    :raises MatteTierMissing: The artifact is not there.
    :raises MatteTierChanged: A master's digest is not the pinned one (before or after).
    :raises MatteTierDeadline: The budget ran out; nothing was renamed into place.
    :raises MatteTierError: Anything else about the artifact or the written files.
    """
    key = str(artifact.get("key", ""))
    if not _KEY.fullmatch(key):
        raise MatteTierError("The artifact key is malformed.")
    started = time.monotonic()
    derived, mattes = MATTES_DIR.split("/")
    artifact_dir = real_directory(base_dir, [derived, mattes, key], create=False)
    for name in _MASTERS:
        if not _regular_file(artifact_dir / name):
            raise MatteTierUnsafePath("A background removal file is not a plain file.")
    source = verified_source(artifact_dir, artifact)
    frame_count = read_frames_file(artifact_dir / FRAMES_FILE).count
    deadline = started + budget_seconds(frame_count)
    tiers_parent, tiers = MATTE_TIERS_DIR.split("/")
    tier_root = real_directory(base_dir, [tiers_parent, tiers], create=True)
    final = tier_root / key
    if final.exists() or final.is_symlink():
        if not _is_real_directory(final):
            raise MatteTierUnsafePath("The tier folder is a link or not a folder.")
        if _tier_is_current(final, source, size, frame_count):
            _log.info("matte tier %s: current at %dx%d", key[:12], *size)
            return TierJobResult("current", size[0], size[1], frame_count, alpha=True)
    staging_root = real_directory(base_dir, [tiers_parent, tiers, TIER_STAGING_DIR], create=True)
    staged = staging_root / uuid.uuid4().hex
    staged.mkdir(mode=0o755)
    try:
        tier = write_monitor_tier(
            base_dir,
            {**artifact, "key": key},
            size,
            artifact_dir=artifact_dir,
            tier_dir=staged,
            deadline=deadline,
        )
        _verify_staged(staged, source, size, tier.frame_count)
        # Digests after pixels too: a master replaced while it was being read is caught here.
        verified_source(artifact_dir, artifact)
        retired: Path | None = None
        if _is_real_directory(final):
            retired = staging_root / f"{uuid.uuid4().hex}-retired"
            final.rename(retired)
        staged.rename(final)
        if retired is not None:
            _remove_tree(retired)
    finally:
        if staged.exists() or staged.is_symlink():
            _remove_tree(staged)
    _log.info(
        "matte tier %s: %d frames at %dx%d in %.1f s",
        key[:12],
        tier.frame_count,
        size[0],
        size[1],
        time.monotonic() - started,
    )
    return TierJobResult("written", size[0], size[1], tier.frame_count, alpha=True)
