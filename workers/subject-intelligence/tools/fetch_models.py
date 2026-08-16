"""Download the pinned model weights and proof fixtures, verifying every digest.

Weights are not committed. They are fetched from a URL pinned to an immutable
upstream commit and checked against the sha256 in ``pack/models.lock.toml``. A
file that does not match its pin is deleted and the run fails: a signed pack must
never be built around a weight nobody approved.

    uv run python tools/fetch_models.py [--destination DIR] [--check]

``--check`` verifies what is already on disk without downloading anything.
"""

from __future__ import annotations

import argparse
import hashlib
import sys
import tomllib
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

PACK_ROOT = Path(__file__).resolve().parent.parent
LOCK_PATH = PACK_ROOT / "pack" / "models.lock.toml"
DEFAULT_DESTINATION = PACK_ROOT / "models"
_CHUNK = 1024 * 1024
#: A weight download that stalls should fail the build, not hang it forever.
_TIMEOUT_SECONDS = 300


@dataclass(frozen=True, slots=True)
class PinnedArtifact:
    kind: str
    identifier: str
    file: str
    url: str
    sha256: str
    size: int
    license: str


def load_pins(lock_path: Path = LOCK_PATH) -> tuple[PinnedArtifact, ...]:
    with lock_path.open("rb") as handle:
        lock = tomllib.load(handle)
    base = str(lock["source"]["baseUrl"]).rstrip("/")
    artifacts: list[PinnedArtifact] = []
    for kind, key in (("model", "model"), ("fixture", "fixture")):
        for entry in lock.get(key, []):
            artifacts.append(
                PinnedArtifact(
                    kind=kind,
                    identifier=str(entry["id"]),
                    file=str(entry["file"]),
                    url=f"{base}/{entry['path']}",
                    sha256=str(entry["sha256"]),
                    size=int(entry["bytes"]),
                    license=str(entry["license"]),
                )
            )
    if not artifacts:
        raise SystemExit(f"{lock_path} pins no artifacts.")
    return tuple(artifacts)


def digest_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def verify(path: Path, pin: PinnedArtifact) -> None:
    actual = digest_of(path)
    if actual != pin.sha256:
        raise ValueError(f"{pin.file} hashes to {actual}, not its pinned {pin.sha256}")
    size = path.stat().st_size
    if size != pin.size:
        raise ValueError(f"{pin.file} is {size} bytes, not its pinned {pin.size}")


def fetch(pin: PinnedArtifact, destination: Path) -> bool:
    """Return True when a download happened; False when the file was already correct."""
    target = destination / pin.file
    if target.is_file():
        try:
            verify(target, pin)
        except ValueError:
            target.unlink()
        else:
            return False
    destination.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".partial")
    try:
        with (
            urllib.request.urlopen(pin.url, timeout=_TIMEOUT_SECONDS) as response,
            temporary.open("wb") as handle,
        ):
            while chunk := response.read(_CHUNK):
                handle.write(chunk)
    except urllib.error.URLError as error:
        temporary.unlink(missing_ok=True)
        raise SystemExit(f"could not download {pin.file}: {error}") from error
    try:
        verify(temporary, pin)
    except ValueError as error:
        # Never leave an unapproved weight where a build could pick it up.
        temporary.unlink(missing_ok=True)
        raise SystemExit(f"refusing {pin.file}: {error}") from error
    temporary.replace(target)
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", type=Path, default=DEFAULT_DESTINATION)
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify files already on disk instead of downloading",
    )
    arguments = parser.parse_args(argv)
    pins = load_pins()
    for pin in pins:
        target = arguments.destination / pin.file
        if arguments.check:
            if not target.is_file():
                print(f"MISSING  {pin.file}")
                return 1
            try:
                verify(target, pin)
            except ValueError as error:
                print(f"MISMATCH {error}")
                return 1
            print(f"ok       {pin.file}  ({pin.license})")
            continue
        downloaded = fetch(pin, arguments.destination)
        print(f"{'fetched ' if downloaded else 'cached  '} {pin.file}  ({pin.license})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
