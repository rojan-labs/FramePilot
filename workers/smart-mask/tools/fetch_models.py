"""Provision and verify the pinned model files.

Unlike Subject Intelligence, the Smart Mask graphs are *derived* files: nobody publishes them.
They are produced by ``tools/export_onnx.py`` from the pinned upstream checkpoints, then
verified here against ``pack/models.lock.toml`` before a pack is built or registered.

    python tools/fetch_models.py --sources             # download + verify the upstream checkpoints
    python tools/fetch_models.py --from .cache/onnx    # copy verified exports into models/
    python tools/fetch_models.py --check               # verify models/ without changing it

A file that does not hash to its pin is refused and never copied. Placeholder pins (all zeros)
fail ``--check``: a pack cannot be built around a graph nobody recorded.
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import sys
import tomllib
import urllib.error
import urllib.request
from pathlib import Path

PACK_ROOT = Path(__file__).resolve().parent.parent
LOCK_PATH = PACK_ROOT / "pack" / "models.lock.toml"
DEFAULT_DESTINATION = PACK_ROOT / "models"
SOURCES_DESTINATION = PACK_ROOT / ".cache" / "weights"
UNPINNED = "0" * 64
_CHUNK = 1024 * 1024
_TIMEOUT_SECONDS = 300


def digest_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def load_lock() -> dict:
    with LOCK_PATH.open("rb") as handle:
        return tomllib.load(handle)


def verify(path: Path, sha256: str, size: int) -> str | None:
    """Return a refusal reason, or None when the file matches its pin."""
    if sha256 == UNPINNED:
        return "has no recorded digest (placeholder pin)"
    if not path.is_file():
        return "is missing"
    if path.stat().st_size != size:
        return f"is {path.stat().st_size} bytes, not its pinned {size}"
    if digest_of(path) != sha256:
        return "does not hash to its pinned digest"
    return None


def check(destination: Path, lock: dict) -> int:
    failures = 0
    for entry in lock["model"]:
        reason = verify(destination / entry["file"], entry["sha256"], int(entry["bytes"]))
        if reason is None:
            print(f"ok       {entry['file']}  ({entry['license']})")
        else:
            print(f"REFUSED  {entry['file']} {reason}")
            failures += 1
    return 1 if failures else 0


def copy_from(source: Path, destination: Path, lock: dict) -> int:
    destination.mkdir(parents=True, exist_ok=True)
    failures = 0
    for entry in lock["model"]:
        candidate = source / entry["file"]
        reason = verify(candidate, entry["sha256"], int(entry["bytes"]))
        if reason is not None:
            print(f"REFUSED  {entry['file']} {reason}")
            failures += 1
            continue
        target = destination / entry["file"]
        if target.is_file() and verify(target, entry["sha256"], int(entry["bytes"])) is None:
            print(f"cached   {entry['file']}")
            continue
        temporary = target.with_suffix(target.suffix + ".partial")
        shutil.copyfile(candidate, temporary)
        temporary.replace(target)
        print(f"copied   {entry['file']}")
    return 1 if failures else 0


def fetch_sources(lock: dict) -> int:
    SOURCES_DESTINATION.mkdir(parents=True, exist_ok=True)
    for name, source in lock["source"].items():
        target = SOURCES_DESTINATION / source["checkpoint"]
        if verify(target, source["sha256"], int(source["bytes"])) is None:
            print(f"cached   {name}: {source['checkpoint']}")
            continue
        temporary = target.with_suffix(target.suffix + ".partial")
        try:
            with (
                urllib.request.urlopen(source["url"], timeout=_TIMEOUT_SECONDS) as response,
                temporary.open("wb") as out,
            ):
                while chunk := response.read(_CHUNK):
                    out.write(chunk)
        except urllib.error.URLError as error:
            temporary.unlink(missing_ok=True)
            print(f"could not download {name}: {error}")
            return 1
        reason = verify(temporary, source["sha256"], int(source["bytes"]))
        if reason is not None:
            temporary.unlink(missing_ok=True)
            print(f"REFUSED  {name}: download {reason}")
            return 1
        temporary.replace(target)
        print(f"fetched  {name}: {source['checkpoint']}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--destination", type=Path, default=DEFAULT_DESTINATION)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--check", action="store_true", help="verify the destination without changing it"
    )
    mode.add_argument(
        "--from", dest="source", type=Path, help="copy verified exports from this directory"
    )
    mode.add_argument(
        "--sources", action="store_true", help="download and verify the upstream checkpoints"
    )
    arguments = parser.parse_args(argv)
    lock = load_lock()
    if arguments.check:
        return check(arguments.destination, lock)
    if arguments.sources:
        return fetch_sources(lock)
    return copy_from(arguments.source, arguments.destination, lock)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
