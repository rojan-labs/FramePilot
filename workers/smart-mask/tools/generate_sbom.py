"""Generate the Smart Mask SBOM and verify the hand-reviewed licence record against reality.

Unlike the other packs, ``LICENSES.md`` here is **hand reviewed**, not generated: it carries
licence texts read at pinned upstream revisions and an open training-data finding (BR0.5) that
no metadata can express. This tool therefore *checks* it instead of overwriting it: every
shipped Python distribution, every pinned model file and the ffmpeg build must appear in it
with the licence the environment actually reports, and the open finding must still be there
verbatim until the maintainer resolves it.

Checks (``--check``, writes nothing):

* manifest identity/roster == the worker's compiled identity;
* ``pack/models.lock.toml`` == the compiled pins, every model licence permitted, every pin real
  (a placeholder digest fails: a pack is never built around an unrecorded graph);
* no PyAV in the environment (every wheel checked bundles libx264/libx265, GPL);
* OpenCV's bundled natives still listed in its own third-party notice;
* the ffmpeg binary that ships (``--ffmpeg``) is LGPL-only (``media.assess_ffmpeg_build``);
* ``LICENSES.md`` names every distribution with its licence, every model file, the ffmpeg
  licence, and the BR0.5 open finding.

    python tools/generate_sbom.py --check --ffmpeg bin/ffmpeg
    python tools/generate_sbom.py --platform darwin-arm64 --ffmpeg bin/ffmpeg   # write pack/sbom
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tomllib
from dataclasses import dataclass, field
from datetime import UTC, datetime
from importlib.metadata import Distribution, distributions
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "src"))

LOCK_PATH = PROJECT_ROOT / "uv.lock"
MANIFEST_PATH = PROJECT_ROOT / "pack" / "manifest.toml"
MODELS_LOCK_PATH = PROJECT_ROOT / "pack" / "models.lock.toml"
SBOM_DIRECTORY = PROJECT_ROOT / "pack" / "sbom"
LICENSES_PATH = PROJECT_ROOT / "LICENSES.md"

SELF_DISTRIBUTION = "framepilot-smart-mask"
PERMITTED_MODEL_LICENSES = frozenset({"MIT", "Apache-2.0"})
#: Build/test-only distributions that never enter the pack artifact.
DEV_ONLY = frozenset({"pytest", "ruff", "mypy", "mypy-extensions", "iniconfig", "pluggy", "packaging",
                      "pygments", "typing-extensions", "pathspec", "librt", "tomli", "ast-serialize"})  # fmt: skip
#: The BR0.5 finding, carried forward verbatim until the maintainer resolves MO-11.
OPEN_FINDING_MARKERS = (
    "## Open finding: the DIS5K commercial-use statement was not found",
    "**licence-text verified,\ntraining-data terms unverified**",
)
OPENCV_NATIVES = ("FFmpeg", "libvpx")

SPDX_ALIASES: dict[str, str] = {
    "Apache 2.0": "Apache-2.0",
    "Apache Software License": "Apache-2.0",
    "BSD License": "BSD-3-Clause",
    "MIT License": "MIT",
    "MIT-CMU": "MIT-CMU",
    "3-Clause BSD License": "BSD-3-Clause",
}


class RecordDriftError(RuntimeError):
    """The record no longer matches what the pack actually ships."""


@dataclass
class Component:
    name: str
    version: str
    license_id: str
    hashes: list[str] = field(default_factory=list)


def _license_of(distribution: Distribution) -> str:
    metadata = distribution.metadata
    expression = metadata.get("License-Expression")
    if expression:
        return str(expression)
    declared = metadata.get("License")
    if declared and len(declared) < 80:
        return SPDX_ALIASES.get(str(declared).strip(), str(declared).strip())
    classifiers = [
        SPDX_ALIASES.get(value.split("::")[-1].strip(), value.split("::")[-1].strip())
        for value in (metadata.get_all("Classifier") or [])
        if value.startswith("License ::")
    ]
    return " AND ".join(classifiers) if classifiers else "UNKNOWN"


def _lock_hashes() -> dict[tuple[str, str], list[str]]:
    lock = tomllib.loads(LOCK_PATH.read_text(encoding="utf-8"))
    hashes: dict[tuple[str, str], list[str]] = {}
    for package in lock.get("package", []):
        digests = [
            str(wheel.get("hash", "")).removeprefix("sha256:")
            for wheel in package.get("wheels", []) or []
            if str(wheel.get("hash", "")).startswith("sha256:")
        ]
        hashes[(str(package.get("name")), str(package.get("version")))] = sorted(set(digests))
    return hashes


def collect_components() -> list[Component]:
    hashes = _lock_hashes()
    components = []
    for distribution in distributions():
        name = distribution.metadata["Name"]
        if not name or name == SELF_DISTRIBUTION or name.lower().replace("_", "-") in DEV_ONLY:
            continue
        components.append(
            Component(
                name,
                distribution.version,
                _license_of(distribution),
                hashes.get((name, distribution.version), []),
            )
        )
    return sorted(components, key=lambda component: component.name.lower())


def verify_identity() -> list[str]:
    from framepilot_smart_mask import PACK_CAPABILITIES, PACK_ID, PACK_VERSION

    manifest = tomllib.loads(MANIFEST_PATH.read_text(encoding="utf-8"))["pack"]
    problems = []
    if (manifest["id"], manifest["version"]) != (PACK_ID, PACK_VERSION):
        problems.append("manifest identity differs from the worker's compiled identity")
    if tuple(sorted(manifest["capabilities"])) != tuple(sorted(PACK_CAPABILITIES)):
        problems.append("manifest capability roster differs from the worker's roster")
    return problems


def verify_models() -> tuple[list[dict], list[str]]:
    from framepilot_smart_mask.models import MODELS_BY_ID, UNPINNED_DIGEST

    lock = tomllib.loads(MODELS_LOCK_PATH.read_text(encoding="utf-8"))
    models = lock.get("model", [])
    problems = []
    if {entry["id"] for entry in models} != set(MODELS_BY_ID):
        problems.append("models.lock.toml and the compiled pins name different models")
        return models, problems
    for entry in models:
        pinned = MODELS_BY_ID[entry["id"]]
        if (pinned.file, pinned.sha256, pinned.bytes, pinned.license) != (
            entry["file"],
            entry["sha256"],
            entry["bytes"],
            entry["license"],
        ):
            problems.append(f"{entry['file']}: compiled pin differs from models.lock.toml")
        if entry["license"] not in PERMITTED_MODEL_LICENSES:
            problems.append(f"{entry['file']} is {entry['license']}, not a permitted model licence")
        if entry["sha256"] == UNPINNED_DIGEST:
            problems.append(
                f"{entry['file']} has no recorded digest (export it and record the pin)"
            )
    return models, problems


def verify_no_pyav(components: list[Component]) -> list[str]:
    if any(component.name.lower() == "av" for component in components):
        return ["PyAV is installed: its wheels bundle libx264/libx265 (GPL) and must not ship"]
    return []


def verify_opencv_notice() -> list[str]:
    for distribution in distributions():
        if not (distribution.metadata["Name"] or "").startswith("opencv"):
            continue
        for file in distribution.files or []:
            if file.name == "LICENSE-3RD-PARTY.txt":
                text = Path(str(distribution.locate_file(file))).read_text(
                    encoding="utf-8", errors="replace"
                )
                return [
                    f"{native} is recorded as bundled in OpenCV but its notice no longer mentions it"
                    for native in OPENCV_NATIVES
                    if re.search(re.escape(native), text, re.IGNORECASE) is None
                ]
    return ["the OpenCV third-party notice could not be read (is the cv extra installed?)"]


def verify_ffmpeg(path: Path | None) -> tuple[dict[str, object], list[str]]:
    from framepilot_smart_mask.media import assess_ffmpeg_build

    if path is None:
        return {}, ["no ffmpeg binary given (--ffmpeg): the LGPL-only build cannot be verified"]
    version = subprocess.run(
        [str(path), "-hide_banner", "-version"], capture_output=True, text=True, check=False
    ).stdout
    licence = subprocess.run(
        [str(path), "-hide_banner", "-L"], capture_output=True, text=True, check=False
    ).stdout
    verdict = assess_ffmpeg_build(version, licence)
    record = {
        "version": version.splitlines()[0] if version else "",
        "licence": verdict.licence,
        "approved": verdict.approved,
    }
    return record, [f"ffmpeg build refused: {reason}" for reason in verdict.reasons]


def verify_licenses_record(
    components: list[Component], models: list[dict], ffmpeg: dict[str, object]
) -> list[str]:
    text = LICENSES_PATH.read_text(encoding="utf-8")
    problems = []
    for marker in OPEN_FINDING_MARKERS:
        if marker not in text:
            problems.append("LICENSES.md no longer carries the BR0.5 open finding verbatim")
            break
    for component in components:
        row = re.search(
            rf"\|\s*`{re.escape(component.name)}`\s*\|\s*{re.escape(component.version)}\s*\|\s*([^|]+)\|",
            text,
            re.IGNORECASE,
        )
        if row is None:
            problems.append(f"LICENSES.md has no row for {component.name} {component.version}")
        elif row.group(1).strip() != component.license_id:
            problems.append(
                f"LICENSES.md records {component.name} as {row.group(1).strip()}, the wheel says {component.license_id}"
            )
    for entry in models:
        if f"`{entry['file']}`" not in text:
            problems.append(f"LICENSES.md does not list the model file {entry['file']}")
    if ffmpeg.get("licence") and str(ffmpeg["licence"]) not in text:
        problems.append(
            f"LICENSES.md does not record the shipped ffmpeg licence {ffmpeg['licence']}"
        )
    return problems


def build_sbom(
    components: list[Component], models: list[dict], ffmpeg: dict[str, object], platform: str
) -> dict[str, object]:
    manifest = tomllib.loads(MANIFEST_PATH.read_text(encoding="utf-8"))["pack"]
    entries: list[dict[str, object]] = []
    for component in components:
        entry: dict[str, object] = {
            "type": "library", "name": component.name, "version": component.version,
            "purl": f"pkg:pypi/{component.name.lower()}@{component.version}",
            "licenses": [{"expression": component.license_id}],
        }  # fmt: skip
        if component.hashes:
            entry["hashes"] = [{"alg": "SHA-256", "content": digest} for digest in component.hashes]
        entries.append(entry)
    entries.append({
        "type": "application", "name": "ffmpeg", "version": str(ffmpeg.get("version", "")),
        "licenses": [{"expression": str(ffmpeg.get("licence", "UNKNOWN"))}],
        "description": "LGPL-only build shipped in bin/ (tools/build_ffmpeg_lgpl.sh).",
    })  # fmt: skip
    for entry in models:
        entries.append({
            "type": "machine-learning-model", "name": entry["id"], "version": entry["file"],
            "licenses": [{"expression": entry["license"]}],
            "hashes": [{"alg": "SHA-256", "content": entry["sha256"]}],
            "properties": [{"name": "framepilot:bytes", "value": str(entry["bytes"])},
                           {"name": "framepilot:precision", "value": entry.get("precision", "")}],
        })  # fmt: skip
    return {
        "bomFormat": "CycloneDX", "specVersion": "1.5", "version": 1,
        "metadata": {
            "timestamp": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "component": {"type": "application", "name": manifest["id"], "version": manifest["version"]},
            "properties": [{"name": "framepilot:platform", "value": platform}],
        },
        "components": entries,
    }  # fmt: skip


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--check", action="store_true", help="verify only; write nothing")
    parser.add_argument("--platform", default="darwin-arm64")
    parser.add_argument("--ffmpeg", type=Path, help="the ffmpeg binary the pack ships")
    arguments = parser.parse_args()
    components = collect_components()
    problems = verify_identity()
    models, model_problems = verify_models()
    problems += model_problems
    problems += verify_no_pyav(components)
    problems += verify_opencv_notice()
    ffmpeg, ffmpeg_problems = verify_ffmpeg(arguments.ffmpeg)
    problems += ffmpeg_problems
    problems += verify_licenses_record(components, models, ffmpeg)
    if problems:
        for problem in problems:
            sys.stderr.write(f"license/SBOM record drift: {problem}\n")
        raise RecordDriftError(f"{len(problems)} record problem(s)")
    if arguments.check:
        print(
            f"record verified: {len(components)} distributions, {len(models)} models, ffmpeg {ffmpeg.get('licence')}"
        )
        return 0
    SBOM_DIRECTORY.mkdir(parents=True, exist_ok=True)
    path = SBOM_DIRECTORY / f"{arguments.platform}.cdx.json"
    path.write_text(
        json.dumps(build_sbom(components, models, ffmpeg, arguments.platform), indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {path.relative_to(PROJECT_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
