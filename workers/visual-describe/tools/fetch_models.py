#!/usr/bin/env python3
"""Fetch and verify this pack's pinned artifacts — weights AND the llama.cpp runtime.

Build-time tool. It is NOT part of the wheel and nothing in
``src/framepilot_visual_describe`` imports it.

Three modes:

``--check``   verify what is on disk against ``pack/models.lock.toml`` and exit non-zero
              on any mismatch, missing file, or placeholder pin. This is the gate the pack
              build job runs before an artifact may be signed.
``--record``  resolve every ``PENDING`` source revision to the immutable commit or
              release it currently points at, download every artifact, print its sha256
              and byte count, and write all of it back into the lock file. Run once, by a
              human, after the licences in ``LICENSES.md`` have actually been verified.
(default)     download anything missing and verify everything against its pin.

WHY ``--record`` RESOLVES THE REVISION AND THE DEFAULT MODE DOES NOT: a source pinned to
``PENDING`` has no immutable URL, so there is nothing to download and nothing to verify —
every fetch 404s. Resolving it means asking the remote which commit or release it is at
*right now* and freezing that answer, which is a pinning decision and therefore belongs in
the same deliberate, human-run mode as approving the bytes.

WHY THE RUNTIME COMES OUT OF AN ARCHIVE: llama.cpp does not publish bare binaries. Each
release ships one platform tarball, and ``llama-mtmd-cli`` inside it is dynamically linked
against nine ggml/llama dylibs that must sit beside it (its only ``LC_RPATH`` is
``@loader_path``). So the ARCHIVE is what gets pinned by digest — one artifact, one
licence, one approval covering every byte that will run — and the members this pack needs
are extracted from it and pinned individually as well.

WHY A PLACEHOLDER IS AN ERROR AND NOT A PROMPT: an unpinned weight means nobody has
approved the bytes this pack would load. Downloading it "to see" and then trusting
whatever arrived is the exact failure mode pinning exists to prevent, which is why
``--record`` is a separate, deliberate mode that a build job never runs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
import tarfile
import tempfile
import tomllib
import urllib.request
from pathlib import Path
from typing import Any

PACK_ROOT = Path(__file__).resolve().parent.parent
LOCK_PATH = PACK_ROOT / "pack" / "models.lock.toml"
MODELS_DIR = PACK_ROOT / "models"
UNPINNED_DIGEST = "0" * 64
#: The sentinel an unresolved source revision or release carries.
UNPINNED_REVISION = "PENDING"
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
    if UNPINNED_REVISION in source["baseUrl"]:
        raise SystemExit(
            f"source '{model.get('source', 'source')}' is still pinned to "
            f"{UNPINNED_REVISION}; run --record to resolve it."
        )
    return f"{source['baseUrl'].rstrip('/')}/{_member_path(source, model).lstrip('/')}"


def _member_path(source: dict[str, Any], entry: dict[str, Any]) -> str:
    """An entry's path, with ``{release}``/``{revision}`` filled in from its source.

    llama.cpp puts its release tag in both the asset name and the directory inside the
    tarball, so the two would have to be re-typed on every bump — and a stale one there is
    a 404 that looks like a network fault. Templating them off the pinned source means the
    tag is written down exactly once.
    """
    return str(entry["path"]).format(**{k: v for k, v in source.items() if isinstance(v, str)})


def _source_tables(lock: dict[str, Any]) -> list[str]:
    """Every source table an entry actually references, in lock order."""
    tables: list[str] = []
    for entry in [*lock.get("archive", []), *lock["model"]]:
        table = str(entry.get("source", "source"))
        if table not in tables:
            tables.append(table)
    return tables


def _huggingface_head(repository: str) -> str:
    """The commit the repository's default branch is at right now."""
    name = repository.rstrip("/").split("huggingface.co/", 1)[-1]
    with urllib.request.urlopen(f"https://huggingface.co/api/models/{name}") as response:
        return str(json.load(response)["sha"])


def _github_release(repository: str, asset_template: str) -> str:
    """The newest release tag that actually publishes the asset this pack needs.

    NOT ``/releases/latest``: llama.cpp's "latest" is a version tag carrying a single text
    file, while the builds live on the rolling ``bNNNNN`` tags. Asking for the newest
    release that HAS the asset is the question we actually mean.
    """
    name = repository.rstrip("/").split("github.com/", 1)[-1]
    url = f"https://api.github.com/repos/{name}/releases?per_page=30"
    with urllib.request.urlopen(url) as response:
        releases = json.load(response)
    for release in releases:
        tag = str(release["tag_name"])
        wanted = asset_template.format(release=tag)
        if any(asset["name"] == wanted for asset in release.get("assets", [])):
            return tag
    raise SystemExit(f"no release of {name} in the last 30 publishes carries {asset_template}")


def _resolve_source(lock_text: str, table: str, resolved: str) -> str:
    """Replace the ``PENDING`` sentinel inside one source table of the lock's text.

    Scoped to the table's own lines so three sources can carry the same sentinel without a
    substitution in one of them silently rewriting another.
    """
    start = lock_text.index(f"[{table}]")
    end = lock_text.find("\n[", start + 1)
    end = len(lock_text) if end == -1 else end + 1
    block = lock_text[start:end]
    if UNPINNED_REVISION not in block:
        return lock_text
    return lock_text[:start] + block.replace(UNPINNED_REVISION, resolved) + lock_text[end:]


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


def _extract(archive: Path, lock: dict[str, Any], entry: dict[str, Any]) -> None:
    """Unpack the members this pack needs out of one verified archive.

    Members are extracted by exact name into a scratch directory and then moved into
    ``models/`` under their flat local names, because ``llama-mtmd-cli``'s only RPATH is
    ``@loader_path`` — the dylibs have to be its directory siblings, not a subtree.

    ``links`` recreates the unversioned ``libfoo.0.dylib`` names the binary asks for. They
    are symlinks in the tarball, so they carry no content of their own and nothing to
    hash; what makes them safe is that the file each one points at IS pinned.
    """
    source = lock[entry.get("source", "source")]
    wanted = {
        _member_path(source, member): str(member["file"])
        for member in _members(lock, str(entry["id"]))
    }
    with tempfile.TemporaryDirectory(dir=str(MODELS_DIR)) as scratch:
        with tarfile.open(archive, "r:gz") as tar:
            members = [item for item in tar.getmembers() if item.name in wanted]
            found = {item.name for item in members}
            missing = sorted(set(wanted) - found)
            if missing:
                raise SystemExit(f"{archive.name}: archive has no member {', '.join(missing)}")
            tar.extractall(scratch, members=members, filter="data")
        for member_path, local in wanted.items():
            shutil.move(str(Path(scratch) / member_path), str(MODELS_DIR / local))
    for member in _members(lock, str(entry["id"])):
        if member.get("executable"):
            # The mode bit does not survive the move on every filesystem, and
            # `resolve_model` refuses a runtime that is not executable — so the pack would
            # fail its own health check for a reason nobody could see.
            (MODELS_DIR / str(member["file"])).chmod(0o755)
    for link, target in entry.get("links", {}).items():
        alias = MODELS_DIR / link
        alias.unlink(missing_ok=True)
        alias.symlink_to(target)


def _members(lock: dict[str, Any], archive_id: str) -> list[dict[str, Any]]:
    """The model entries that come out of one archive rather than off a URL."""
    return [model for model in lock["model"] if model.get("archive") == archive_id]


def _archives(lock: dict[str, Any]) -> list[dict[str, Any]]:
    return list(lock.get("archive", []))


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

    if arguments.record:
        # Resolve first: nothing below can be downloaded, let alone hashed, while a source
        # still points at a branch or a release we have not frozen.
        for table in _source_tables(lock):
            source = lock[table]
            if UNPINNED_REVISION not in str(source.get("baseUrl", "")):
                continue
            repository = str(source["repository"])
            if "github.com" in repository:
                asset = next(
                    str(archive["path"])
                    for archive in _archives(lock)
                    if archive.get("source") == table
                )
                resolved = _github_release(repository, asset)
            else:
                resolved = _huggingface_head(repository)
            print(f"{table}: {resolved}", file=sys.stderr)
            lock_text = _resolve_source(lock_text, table, resolved)
        LOCK_PATH.write_text(lock_text, encoding="utf-8")
        lock = _lock()

    if arguments.check:
        for table in _source_tables(lock):
            if UNPINNED_REVISION in str(lock[table].get("baseUrl", "")):
                failures.append(f"source '{table}': revision is still a placeholder")

    # Archives before models: the runtime's members only exist on disk once its tarball
    # has been fetched, verified against its own pin, and unpacked.
    for archive in _archives(lock):
        name = str(archive["file"])
        pinned = str(archive["sha256"])
        path = MODELS_DIR / name
        members = [MODELS_DIR / str(m["file"]) for m in _members(lock, str(archive["id"]))]
        if arguments.check:
            if pinned == UNPINNED_DIGEST:
                failures.append(f"{name}: pin is still a placeholder; nothing approved it")
            continue
        if not path.is_file():
            url = _url(lock, archive)
            print(f"downloading {name} <- {url}", file=sys.stderr)
            _download(url, path)
        actual, size = _digest(path)
        if arguments.record:
            print(f"{name}: sha256={actual} bytes={size}")
            lock_text = _record(lock_text, name, actual, size)
        elif pinned == UNPINNED_DIGEST:
            failures.append(f"{name}: pin is still a placeholder — run --record")
            continue
        elif actual != pinned:
            failures.append(f"{name}: hashes to {actual}, not {pinned}")
            continue
        if not all(member.is_file() for member in members):
            print(f"extracting {len(members)} members from {name}", file=sys.stderr)
            _extract(path, lock, archive)

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
            if model.get("archive"):
                failures.append(f"{name}: archive member missing after extraction")
                continue
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
