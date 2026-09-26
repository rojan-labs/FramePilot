"""Build the sticker library from Microsoft Fluent Emoji (MIT) at a pinned commit.

plan/elements 03 §3. One script, no new dependency: Pillow (the engine's) encodes WebP. Run it with
the engine's environment from the repository root::

    uv run --project engine/python python scripts/elements/build_library.py          # build
    uv run --project engine/python python scripts/elements/build_library.py --lock   # re-pin

``--lock`` lists the upstream tree at ``COMMIT``, fetches every ``metadata.json`` and every
default-tone 3D PNG, checks each against the tree's git blob id, and writes
``fluent.lock.json`` with their SHA-256 — review it in the PR like any lockfile. A build then
refuses any byte that does not match its pin. Downloads are cached under
``~/.cache/framepilot/elements/<commit>/``, so a rebuild is offline.

The build writes:

- ``packages/ai-sdk/src/providers/elements/sticker-catalog.generated.ts`` — every sticker's
  name, glyph, group, collections and keywords; the curated ones (``collections.json``) are
  ``bundled`` and carry their encoded file's size and SHA-256; the rest are ``packaged`` (the
  desktop installer's set, EL6b);
- ``apps/web-editor/public/elements/stickers/{full,thumbs}/<id>.webp`` for the curated set — the
  3D art padded by 12% on every side (room for an outline or a shadow) as lossless WebP, and a
  144 px lossy thumbnail — with ``LICENSE-fluent-emoji.txt`` beside them.

Deterministic for a given Pillow/libwebp: the same lock writes the same bytes, and a test compares
the catalogue with the committed files.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from pathlib import Path
from typing import Any

from PIL import Image

REPO = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
LOCK = HERE / "fluent.lock.json"
COLLECTIONS = HERE / "collections.json"
CATALOG = (
    REPO / "packages" / "ai-sdk" / "src" / "providers" / "elements" / "sticker-catalog.generated.ts"
)
BUNDLED_DIR = REPO / "apps" / "web-editor" / "public" / "elements" / "stickers"

UPSTREAM = "microsoft/fluentui-emoji"
#: The pinned upstream commit (2026-08-24). Changing it is a reviewed change to the lock.
COMMIT = "1ffb34c752ecf5d402f04cfb4b392c77f57c54bc"
RAW = f"https://raw.githubusercontent.com/{UPSTREAM}/{COMMIT}/"
TREE = f"https://api.github.com/repos/{UPSTREAM}/git/trees/{COMMIT}?recursive=1"
CACHE = Path.home() / ".cache" / "framepilot" / "elements" / COMMIT

LIBRARY = "fluent3d"
LICENSE = "mit"
LICENSE_URL = f"https://github.com/{UPSTREAM}/blob/{COMMIT}/LICENSE"
ATTRIBUTION = "Fluent Emoji by Microsoft (MIT)"
#: Transparent margin on every side, as a share of the art's side (256 -> 318 px canvas): an
#: outline or shadow edge style draws inside the layer's picture bounds and needs the room.
PAD = 0.12
THUMB_SIZE = 144
THUMB_QUALITY = 80
#: Emoji presentation selector and zero-width joiner noise the collection file may carry.
_VS16 = "️"


def _log(message: str) -> None:
    sys.stdout.write(f"build_library: {message}\n")


def _fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "framepilot-build-library"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return bytes(response.read())


def _git_blob_id(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data, usedforsecurity=False).hexdigest()


def _cached(path: str) -> bytes:
    """The upstream file at ``path``, from the cache or the pinned commit."""
    target = CACHE / path
    if target.exists():
        return target.read_bytes()
    data = _fetch(RAW + urllib.parse.quote(path))
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    return data


def _default_png(paths: list[str], folder: str) -> str | None:
    """The default-tone 3D PNG of ``folder`` (``Default/3D`` for toned emoji, else ``3D``)."""
    prefix = f"assets/{folder}/"
    pngs = [p for p in paths if p.startswith(prefix) and "/3D/" in p and p.endswith(".png")]
    toned = [p for p in pngs if p.startswith(f"{prefix}Default/3D/")]
    plain = [p for p in pngs if p.startswith(f"{prefix}3D/")]
    found = toned or plain
    return found[0] if found else None


def make_lock() -> None:
    tree = json.loads(_fetch(TREE))
    if tree.get("truncated"):
        raise SystemExit("build_library: the upstream tree listing is truncated; cannot pin it.")
    blobs = {entry["path"]: entry["sha"] for entry in tree["tree"] if entry["type"] == "blob"}
    paths = sorted(blobs)
    folders = sorted({p.split("/")[1] for p in paths if p.endswith("/metadata.json")})
    wanted: list[str] = ["LICENSE"]
    for folder in folders:
        wanted.append(f"assets/{folder}/metadata.json")
        png = _default_png(paths, folder)
        if png is None:
            raise SystemExit(f"build_library: '{folder}' has no 3D art at the pinned commit.")
        wanted.append(png)
    with ThreadPoolExecutor(max_workers=16) as pool:
        datas = list(pool.map(_cached, wanted))
    inputs: dict[str, dict[str, str]] = {}
    for path, data in zip(wanted, datas, strict=True):
        if _git_blob_id(data) != blobs[path]:
            raise SystemExit(f"build_library: '{path}' does not match the commit's tree.")
        inputs[path] = {"sha256": hashlib.sha256(data).hexdigest()}
    lock = {
        "spec": "Pinned inputs of scripts/elements/build_library.py: the upstream commit and the "
        "SHA-256 of every file the build reads. Written by --lock; a build refuses any byte "
        "that does not match.",
        "upstream": UPSTREAM,
        "commit": COMMIT,
        "folders": folders,
        "inputs": inputs,
    }
    LOCK.write_text(json.dumps(lock, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    _log(f"pinned {len(inputs)} files from {len(folders)} emoji at {COMMIT[:12]}")


def _pinned(lock: dict[str, Any], path: str) -> bytes:
    data = _cached(path)
    if hashlib.sha256(data).hexdigest() != lock["inputs"][path]["sha256"]:
        raise SystemExit(f"build_library: '{path}' does not match its pin in fluent.lock.json.")
    return data


def item_id(cldr: str) -> str:
    """A sticker's id: its CLDR name in snake case (``thumbs up`` -> ``thumbs_up``)."""
    return re.sub(r"[^a-z0-9]+", "_", cldr.lower()).strip("_")


def _plain(glyph: str) -> str:
    return glyph.replace(_VS16, "")


def _padded(art: Image.Image) -> Image.Image:
    side = art.width + 2 * round(art.width * PAD)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.alpha_composite(art, ((side - art.width) // 2, (side - art.height) // 2))
    return canvas


def _webp(image: Image.Image, *, lossless: bool, quality: int = 100) -> bytes:
    out = io.BytesIO()
    image.save(out, "WEBP", lossless=lossless, quality=quality, method=6, exact=True)
    return out.getvalue()


def write_catalog(catalog: dict[str, Any]) -> None:
    """Write the catalogue as a typed TS module, one sticker per line: ai-sdk's generated data are
    modules (they compile into ``dist`` for the desktop main process like any other code), and a
    review diff stays readable."""
    head = {key: value for key, value in catalog.items() if key != "items"}
    lines = [
        json.dumps(item, ensure_ascii=False, separators=(",", ":")) for item in catalog["items"]
    ]
    body = json.dumps(head, indent=2, ensure_ascii=False)[:-2]
    text = (
        "// Generated by scripts/elements/build_library.py. Do not edit.\n"
        "import type { StickerCatalogData } from './sticker-catalog.js';\n\n"
        "export const STICKER_CATALOG_DATA: StickerCatalogData = "
        + body
        + ',\n  "items": [\n    '
        + ",\n    ".join(lines)
        + "\n  ]\n};\n"
    )
    CATALOG.parent.mkdir(parents=True, exist_ok=True)
    CATALOG.write_text(text, encoding="utf-8")


def _encoded_png(png: bytes) -> tuple[bytes, bytes, int, int]:
    """:func:`_encoded` of an upstream PNG, plus its art width: a process pool's unit of work."""
    art = Image.open(io.BytesIO(png)).convert("RGBA")
    full, thumb, side = _encoded(art)
    return full, thumb, side, art.width


def _encoded(art: Image.Image) -> tuple[bytes, bytes, int]:
    """A sticker's padded full file (lossless WebP), its thumbnail and the padded side."""
    full = _webp(_padded(art), lossless=True)
    thumb_image = art.copy()
    thumb_image.thumbnail((THUMB_SIZE, THUMB_SIZE), Image.Resampling.LANCZOS)
    thumb = _webp(thumb_image, lossless=False, quality=THUMB_QUALITY)
    return full, thumb, art.width + 2 * round(art.width * PAD)


def _library(
    lock: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]], dict[str, list[str]], dict[str, int]]:
    """The collections, every emoji's metadata, which collections each curated one is in, and
    its rank: what decides a sticker's id, and whether it is bundled or packaged."""
    if lock["commit"] != COMMIT:
        raise SystemExit("build_library: fluent.lock.json pins another commit; run --lock.")
    collections = json.loads(COLLECTIONS.read_text(encoding="utf-8"))["collections"]
    metas: dict[str, dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=16) as pool:
        for folder, data in zip(
            lock["folders"],
            pool.map(lambda f: _pinned(lock, f"assets/{f}/metadata.json"), lock["folders"]),
            strict=True,
        ):
            metas[folder] = json.loads(data)
    by_glyph = {_plain(meta["glyph"]): folder for folder, meta in metas.items()}
    member_of: dict[str, list[str]] = {}
    #: A curated sticker's place in collections.json, flattened: how a collection lists and how
    #: search breaks ties.
    rank: dict[str, int] = {}
    for collection in collections:
        for glyph in collection["glyphs"]:
            folder = by_glyph.get(_plain(glyph))
            if folder is None:
                raise SystemExit(
                    f"build_library: {glyph} in collections.json is not in the library."
                )
            member_of.setdefault(folder, []).append(collection["id"])
            rank.setdefault(folder, len(rank))
    return collections, metas, member_of, rank


def build() -> None:
    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    collections, metas, member_of, rank = _library(lock)
    inputs = list(lock["inputs"])

    ids: dict[str, str] = {}
    items: list[dict[str, Any]] = []
    full_dir, thumb_dir = BUNDLED_DIR / "full", BUNDLED_DIR / "thumbs"
    full_dir.mkdir(parents=True, exist_ok=True)
    thumb_dir.mkdir(parents=True, exist_ok=True)
    bundled_bytes = thumb_bytes = 0
    for folder in lock["folders"]:
        meta = metas[folder]
        sticker_id = item_id(meta["cldr"])
        if sticker_id in ids:
            raise SystemExit(f"build_library: '{folder}' and '{ids[sticker_id]}' share an id.")
        ids[sticker_id] = folder
        png_path = _default_png(inputs, folder)
        assert png_path is not None
        item: dict[str, Any] = {
            "id": sticker_id,
            "name": meta["cldr"][:1].upper() + meta["cldr"][1:],
            "glyph": meta["glyph"],
            "unicode": meta.get("unicode"),
            "group": meta["group"],
            "collections": member_of.get(folder, []),
            **({"rank": rank[folder]} if folder in rank else {}),
            "keywords": sorted({*meta.get("keywords", []), *meta.get("glyphAsUtfInEmoticons", [])}),
            "availability": "bundled" if folder in member_of else "packaged",
            "source": png_path,
        }
        if folder in member_of:
            art = Image.open(io.BytesIO(_pinned(lock, png_path))).convert("RGBA")
            full, thumb, side = _encoded(art)
            (full_dir / f"{sticker_id}.webp").write_bytes(full)
            (thumb_dir / f"{sticker_id}.webp").write_bytes(thumb)
            item |= {
                "file": f"full/{sticker_id}.webp",
                "thumb": f"thumbs/{sticker_id}.webp",
                "sha256": hashlib.sha256(full).hexdigest(),
                "bytes": len(full),
                "width": side,
                "height": side,
                "sharpSize": art.width,
            }
            bundled_bytes += len(full)
            thumb_bytes += len(thumb)
        items.append(item)
    # Files a previous build wrote for stickers no longer curated would ship unused: remove them.
    keep = {f"{i['id']}.webp" for i in items if i["availability"] == "bundled"}
    for directory in (full_dir, thumb_dir):
        for stale in directory.glob("*.webp"):
            if stale.name not in keep:
                stale.unlink()
    (BUNDLED_DIR / "LICENSE-fluent-emoji.txt").write_bytes(_pinned(lock, "LICENSE"))
    catalog = {
        "spec": "Generated by scripts/elements/build_library.py from fluent.lock.json and "
        "collections.json. Do not edit. An item's source URL is sourceBase + its source path.",
        "library": LIBRARY,
        "provider": "fluent-emoji",
        "commit": COMMIT,
        "license": LICENSE,
        "licenseUrl": LICENSE_URL,
        "attribution": ATTRIBUTION,
        "creator": "Microsoft",
        "attributionRequired": False,
        "sourceBase": RAW,
        "collections": [{"id": c["id"], "name": c["name"]} for c in collections],
        "items": items,
    }
    write_catalog(catalog)
    bundled = sum(1 for i in items if i["availability"] == "bundled")
    _log(
        f"{len(items)} stickers, {bundled} bundled: {bundled_bytes / 1e6:.2f} MB full + "
        f"{thumb_bytes / 1e6:.2f} MB thumbnails"
    )


#: What the packaged set may weigh (MD-E1: 40 MB). Raising it is a decision made in the same PR.
PACKAGED_BUDGET_BYTES = 40_000_000
#: The manifest the packaged set carries: what the library verifies each copy against.
MANIFEST = "manifest.json"


def lock_digest(lock_bytes: bytes) -> str:
    """The key the packaged set is cached by: the lock pins every byte it is built from."""
    return hashlib.sha256(lock_bytes).hexdigest()


def packaged_is_current(out: Path, lock_bytes: bytes) -> bool:
    """Whether ``out`` already holds the packaged set for this lock, every file present."""
    manifest_path = out / MANIFEST
    if not manifest_path.is_file():
        return False
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("lockSha256") != lock_digest(lock_bytes):
        return False
    return all(
        (out / entry["file"]).is_file() and (out / entry["thumb"]).is_file()
        for entry in manifest["items"].values()
    )


def packaged_manifest(entries: dict[str, dict[str, Any]], lock_bytes: bytes) -> dict[str, Any]:
    """The packaged set's manifest: per sticker id, its files, the SHA-256 and size of the full
    file as THIS build encoded it, its canvas and its sharp size.

    Encoded here rather than pinned in the catalogue because a lossless WebP's bytes can differ
    between build machines (the encoder's entropy estimates are floating point, with per-CPU
    fast paths): the pixels are identical, the hash need not be. The inputs are pinned by the
    lock either way.
    """
    return {
        "spec": "Written by scripts/elements/build_library.py --packaged. The desktop library "
        "verifies each copy against it. Do not edit.",
        "commit": COMMIT,
        "lockSha256": lock_digest(lock_bytes),
        "totalBytes": sum(entry["bytes"] + entry["thumbBytes"] for entry in entries.values()),
        "items": dict(sorted(entries.items())),
    }


def build_packaged(out: Path) -> None:
    """Encode every sticker the committed set does not ship into ``out`` (the desktop
    installer's ``extraResources``), with its licence and manifest; skipped when ``out`` already
    holds this lock's set. Refuses a set over its budget."""
    lock_bytes = LOCK.read_bytes()
    if packaged_is_current(out, lock_bytes):
        _log(f"packaged set in {out} is current for this lock; nothing to do")
        return
    lock = json.loads(lock_bytes)
    _, metas, member_of, _ = _library(lock)
    inputs = list(lock["inputs"])
    (out / "full").mkdir(parents=True, exist_ok=True)
    (out / "thumbs").mkdir(parents=True, exist_ok=True)
    todo: list[tuple[str, bytes]] = []
    for folder in lock["folders"]:
        if folder in member_of:
            continue
        png_path = _default_png(inputs, folder)
        assert png_path is not None
        todo.append((item_id(metas[folder]["cldr"]), _pinned(lock, png_path)))
    entries: dict[str, dict[str, Any]] = {}
    # A lossless method-6 encode is about a second a sticker; one process per core makes the
    # whole set minutes, not half an hour. `map` keeps the order, so the set is deterministic.
    with ProcessPoolExecutor() as pool:
        encoded = pool.map(_encoded_png, [png for _, png in todo], chunksize=16)
        for (sticker_id, _), (full, thumb, side, sharp) in zip(todo, encoded, strict=True):
            (out / "full" / f"{sticker_id}.webp").write_bytes(full)
            (out / "thumbs" / f"{sticker_id}.webp").write_bytes(thumb)
            entries[sticker_id] = {
                "file": f"full/{sticker_id}.webp",
                "thumb": f"thumbs/{sticker_id}.webp",
                "sha256": hashlib.sha256(full).hexdigest(),
                "bytes": len(full),
                "thumbBytes": len(thumb),
                "width": side,
                "height": side,
                "sharpSize": sharp,
            }
    manifest = packaged_manifest(entries, lock_bytes)
    if manifest["totalBytes"] > PACKAGED_BUDGET_BYTES:
        raise SystemExit(
            "build_library: the packaged set is over its budget. Raise PACKAGED_BUDGET_BYTES in "
            "the same change, with the reason, or ship fewer stickers."
        )
    (out / "LICENSE-fluent-emoji.txt").write_bytes(_pinned(lock, "LICENSE"))
    (out / MANIFEST).write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
    _log(f"packaged {len(entries)} stickers into {out}: {manifest['totalBytes'] / 1e6:.2f} MB")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--lock", action="store_true", help="re-pin the upstream inputs")
    parser.add_argument(
        "--packaged",
        type=Path,
        metavar="DIR",
        help="encode every sticker the committed set does not ship into DIR (desktop packaging)",
    )
    args = parser.parse_args()
    if args.lock:
        make_lock()
    elif args.packaged is not None:
        build_packaged(args.packaged)
    else:
        build()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
