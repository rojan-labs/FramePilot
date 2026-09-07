#!/usr/bin/env python3
"""Fetch and verify this pack's pinned artifacts — weights AND the llama.cpp runtime.

Build-time tool. It is NOT part of the wheel and nothing in
``src/framepilot_visual_describe`` imports it.

Three modes:

``--check``   verify what is on disk against ``pack/models.lock.toml`` and exit non-zero
              on any mismatch, missing file, or placeholder pin. This is the gate the pack
              build job runs before an artifact may be signed.
``--record``  download every artifact, print its sha256 and byte count, and write both
              back into the lock file. Run once, by a human, after the licences in
              ``LICENSES.md`` have actually been verified.
(default)     download anything missing and verify everything against its pin.

WHY A PLACEHOLDER IS AN ERROR AND NOT A PROMPT: an unpinned weight means nobody has
approved the bytes this pack would load. Downloading it "to see" and then trusting
whatever arrived is the exact failure mode pinning exists to prevent, which is why
``--record`` is a separate, deliberate mode that a build job never runs.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
import tomllib
import urllib.request
from pathlib import Path
from typing import Any

PACK_ROOT = Path(__file__).resolve().parent.parent
LOCK_PATH = PACK_ROOT / "pack" / "models.lock.toml"
MODELS_DIR = PACK_ROOT / "models"
UNPINNED_DIGEST = "0" * 64
_CHUNK = 1024 * 1024


def _digest(path: Path) -> tuple[str, int]:
    hasher = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while chunk := handle.read(_CHUNK):
            hasher.update(chunk)
            size += len(chunk)
    return hasher.hexdigest(), size


def _lock() -> dict[str, Any]:
    with LOCK_PATH.open("rb") as handle:
        return tomllib.load(handle)


def _url(lock: dict[str, Any], model: dict[str, Any]) -> str:
    source = lock[model.get("source", "source")]
    return f"{source['baseUrl'].rstrip('/')}/{model['path'].lstrip('/')}"


def _download(url: str, destination: Path) -> None:
    """Stream to a temporary sibling, then rename.

    A killed download must never leave a partial file that the next run would hash and
    report as a digest mismatch on the wrong grounds.
    """
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(destination.suffix + ".partial")
    with urllib.request.urlopen(url) as response, partial.open("wb") as handle:
        while chunk := response.read(_CHUNK):
            handle.write(chunk)
    partial.replace(destination)


def _record(lock_text: str, file_name: str, digest: str, size: int) -> str:
    """Rewrite one model's ``sha256``/``bytes`` in the lock file's text.

    Text substitution rather than a TOML round trip because ``tomllib`` is read-only and
    the comments in that file carry most of its value.
    """
    pattern = re.compile(
        rf'(file = "{re.escape(file_name)}".*?sha256 = ")[0-9a-f]{{64}}("\n)(bytes = )\d+',
        re.DOTALL,
    )
    replaced, count = pattern.subn(rf"\g<1>{digest}\g<2>\g<3>{size}", lock_text)
    if count != 1:
        raise SystemExit(f"could not locate the lock entry for {file_name}")
    return replaced


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify only; never download")
    parser.add_argument(
        "--record", action="store_true", help="download and write digests back into the lock"
    )
    arguments = parser.parse_args(argv)
    lock = _lock()
    lock_text = LOCK_PATH.read_text(encoding="utf-8")
    failures: list[str] = []
    for model in lock["model"]:
        name = str(model["file"])
        pinned = str(model["sha256"])
        path = MODELS_DIR / name
        if arguments.check:
            if pinned == UNPINNED_DIGEST:
                failures.append(f"{name}: pin is still a placeholder; nothing approved it")
                continue
            if not path.is_file():
                failures.append(f"{name}: not fetched")
                continue
            actual, _ = _digest(path)
            if actual != pinned:
                failures.append(f"{name}: hashes to {actual}, not {pinned}")
            continue
        if not path.is_file():
            url = _url(lock, model)
            print(f"downloading {name} <- {url}", file=sys.stderr)
            _download(url, path)
            if model.get("executable"):
                # The runtime binary arrives without its mode bit over HTTP, and
                # `resolve_model` refuses a runtime that is not executable — so a fetched
                # pack would fail its own health check for a reason nobody could see.
                path.chmod(0o755)
        actual, size = _digest(path)
        if arguments.record:
            print(f"{name}: sha256={actual} bytes={size}")
            lock_text = _record(lock_text, name, actual, size)
            continue
        if pinned == UNPINNED_DIGEST:
            failures.append(
                f"{name}: pin is still a placeholder — run --record once the licence is verified"
            )
        elif actual != pinned:
            failures.append(f"{name}: hashes to {actual}, not {pinned}")
    if arguments.record:
        LOCK_PATH.write_text(lock_text, encoding="utf-8")
        print(f"wrote digests into {LOCK_PATH}", file=sys.stderr)
        print(
            "NOW copy the same digests into src/framepilot_visual_describe/models.py — that "
            "copy is the one the signed wheel enforces.",
            file=sys.stderr,
        )
    for failure in failures:
        print(f"FAIL {failure}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
