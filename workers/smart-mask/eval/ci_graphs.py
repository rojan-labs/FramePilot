"""BR7.4 (CI only): which graphs the eval runner used, and pinning them for that runner.

The pack's ONNX graphs are derived files: nobody publishes them, and they never leave the pack
build machine. The dispatch-only eval workflow therefore exports them on the runner from the
SAME pinned upstream checkpoints with the SAME export scripts (``tools/export_onnx.py``,
``spike/export_*.py``). An export on another OS/CPU need not be byte-identical to the darwin
export whose digests ``models.py`` compiles in, and the worker refuses a graph that does not hash
to its pin. So on the runner, and only there:

    python eval/ci_graphs.py record --graphs DIR --out graphs.json   # digests vs pins, per file
    python eval/ci_graphs.py repin --graphs DIR --ci                 # models.py := DIR's digests

``repin`` edits the runner's checkout of ``models.py`` (never committed; it refuses to run
without ``--ci`` and the ``CI`` environment variable). The record goes into the eval report, so a
reader sees whether the measured graphs were byte-identical to the shipped ones.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any

PACK = Path(__file__).resolve().parent.parent
MODELS_SOURCE = PACK / "src" / "framepilot_smart_mask" / "models.py"
sys.path.insert(0, str(PACK / "src"))

from framepilot_smart_mask.models import PINNED_MODELS  # noqa: E402

_CHUNK = 1 << 20


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def record(graphs: Path) -> dict[str, Any]:
    """Per pinned file: its pin, the runner file's digest, and whether they are identical."""
    files: dict[str, Any] = {}
    for model in PINNED_MODELS:
        path = graphs / model.file
        runner = sha256(path) if path.is_file() else None
        files[model.file] = {
            "pinned": model.sha256,
            "runner": runner,
            "identical": runner == model.sha256,
        }
    present = [entry for entry in files.values() if entry["runner"] is not None]
    return {
        "files": files,
        "allPresentIdentical": all(entry["identical"] for entry in present),
        "missing": sorted(name for name, entry in files.items() if entry["runner"] is None),
    }


def repin(source: str, graphs: Path) -> tuple[str, list[str]]:
    """``models.py`` text with each present file's pin replaced by its runner digest."""
    changed: list[str] = []
    for model in PINNED_MODELS:
        path = graphs / model.file
        if not path.is_file():
            continue
        digest = sha256(path)
        if digest == model.sha256:
            continue
        if source.count(model.sha256) != 1:
            raise SystemExit(f"{model.file}: its pin must appear exactly once in models.py")
        source = source.replace(model.sha256, digest)
        changed.append(model.file)
    return source, changed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    commands = parser.add_subparsers(dest="command", required=True)
    rec = commands.add_parser("record")
    rec.add_argument("--graphs", type=Path, required=True)
    rec.add_argument("--out", type=Path, required=True)
    rec.add_argument("--note", default="", help="free text recorded beside the digests")
    pin = commands.add_parser("repin")
    pin.add_argument("--graphs", type=Path, required=True)
    pin.add_argument("--ci", action="store_true", help="required: this edits models.py in place")
    arguments = parser.parse_args(argv)
    if arguments.command == "record":
        result = {**record(arguments.graphs), "note": arguments.note}
        arguments.out.write_text(json.dumps(result, indent=2) + "\n")
        sys.stdout.write(json.dumps({"allPresentIdentical": result["allPresentIdentical"]}) + "\n")
        return 0
    if not arguments.ci or os.environ.get("CI") != "true":
        raise SystemExit("repin edits models.py; it runs only on a CI runner (--ci and CI=true).")
    text, changed = repin(MODELS_SOURCE.read_text(), arguments.graphs)
    MODELS_SOURCE.write_text(text)
    sys.stdout.write(json.dumps({"repinned": changed}) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
