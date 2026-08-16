"""Generate the Tracking Lite SBOM and license notice from the real environment.

Everything this emits is read from installed distribution metadata and from
`uv.lock`, never hand authored — a license record that was typed by hand is a
record of what someone believed, not of what ships.

Native libraries bundled *inside* the OpenCV wheel are the one case metadata
cannot describe: they appear only in the wheel's `LICENSE-3RD-PARTY.txt` prose.
Those are declared here and then **verified against that file**, so the record
cannot silently drift when the wheel changes.

    python tools/generate_sbom.py            # write pack/sbom + LICENSES.md
    python tools/generate_sbom.py --check    # verify the record, write nothing
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tomllib
from dataclasses import dataclass, field
from datetime import UTC, datetime
from importlib.metadata import Distribution, distributions
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
LOCK_PATH = PROJECT_ROOT / "uv.lock"
MANIFEST_PATH = PROJECT_ROOT / "pack" / "manifest.toml"
SBOM_DIRECTORY = PROJECT_ROOT / "pack" / "sbom"
LICENSES_PATH = PROJECT_ROOT / "LICENSES.md"

SELF_DISTRIBUTION = "framepilot-tracking-lite"


@dataclass(frozen=True, slots=True)
class BundledNative:
    """A native library redistributed inside a Python wheel."""

    name: str
    license_id: str
    #: The wheel whose LICENSE-3RD-PARTY.txt must still mention this library.
    inside: str
    platforms: tuple[str, ...]
    note: str


# Declared from the wheel's own LICENSE-3RD-PARTY.txt, then verified below.
BUNDLED_NATIVES: tuple[BundledNative, ...] = (
    BundledNative(
        name="FFmpeg",
        license_id="LGPL-2.1-or-later",
        inside="opencv_contrib_python_headless",
        platforms=("darwin-arm64", "win32-x64"),
        note="Media decode used by VideoCapture. Redistributed in every opencv-python wheel.",
    ),
    *(
        BundledNative(
            name=library,
            license_id="LGPL-2.1-or-later",
            inside="opencv_contrib_python_headless",
            platforms=("darwin-arm64",),
            note="Redistributed inside the macOS opencv-python wheel.",
        )
        for library in (
            "libbluray",
            "libgnutls",
            "libnettle",
            "libhogweed",
            "libintl",
            "libmp3lame",
            "libp11",
            "librtmp",
            "libsoxr",
            "libtasn1",
        )
    ),
    BundledNative(
        name="libvpx",
        license_id="BSD-3-Clause",
        inside="opencv_contrib_python_headless",
        platforms=(),
        note="Linux opencv-python wheels only; not shipped in the macOS/Windows pack artifacts.",
    ),
)


@dataclass
class Component:
    name: str
    version: str
    license_id: str
    hashes: list[str] = field(default_factory=list)
    kind: str = "library"


class RecordDriftError(RuntimeError):
    """The generated record no longer matches what the environment actually ships."""


#: Free-text license fields that are not valid SPDX identifiers, mapped to the
#: identifier a downstream license scanner can actually match.
SPDX_ALIASES: dict[str, str] = {
    "Apache 2.0": "Apache-2.0",
    "Apache Software License": "Apache-2.0",
    "BSD License": "BSD-3-Clause",
    "MIT License": "MIT",
}


def _spdx(value: str) -> str:
    return SPDX_ALIASES.get(value.strip(), value.strip())


def _license_of(distribution: Distribution) -> str:
    metadata = distribution.metadata
    expression = metadata.get("License-Expression")
    if expression:
        return str(expression)
    declared = metadata.get("License")
    if declared and len(declared) < 80:
        return _spdx(str(declared))
    classifiers = [
        _spdx(value.split("::")[-1])
        for value in (metadata.get_all("Classifier") or [])
        if value.startswith("License ::")
    ]
    return " AND ".join(classifiers) if classifiers else "UNKNOWN"


def _lock_hashes() -> dict[tuple[str, str], list[str]]:
    """Artifact digests for each locked (name, version), straight from uv.lock."""
    if not LOCK_PATH.exists():
        return {}
    lock = tomllib.loads(LOCK_PATH.read_text(encoding="utf-8"))
    hashes: dict[tuple[str, str], list[str]] = {}
    for package in lock.get("package", []):
        key = (str(package.get("name")), str(package.get("version")))
        digests: list[str] = []
        for wheel in package.get("wheels", []) or []:
            digest = str(wheel.get("hash", ""))
            if digest.startswith("sha256:"):
                digests.append(digest.removeprefix("sha256:"))
        hashes[key] = sorted(set(digests))
    return hashes


def collect_components() -> list[Component]:
    """Python distributions actually installed in the current environment."""
    hashes = _lock_hashes()
    components: list[Component] = []
    for distribution in distributions():
        name = distribution.metadata["Name"]
        if not name or name == SELF_DISTRIBUTION:
            continue
        version = distribution.version
        components.append(
            Component(
                name=name,
                version=version,
                license_id=_license_of(distribution),
                hashes=hashes.get((name, version), []),
            )
        )
    return sorted(components, key=lambda component: component.name)


def third_party_notice_text() -> str:
    """The OpenCV wheel's own third-party notice, read from the installed wheel."""
    for distribution in distributions():
        name = (distribution.metadata["Name"] or "").replace("-", "_")
        if not name.startswith("opencv"):
            continue
        for file in distribution.files or []:
            if file.name == "LICENSE-3RD-PARTY.txt":
                return Path(str(distribution.locate_file(file))).read_text(
                    encoding="utf-8", errors="replace"
                )
    return ""


def verify_bundled_natives(notice: str) -> list[str]:
    """Fail if a declared bundled library is no longer named by the wheel's notice."""
    if not notice:
        return ["the OpenCV third-party notice could not be read from the environment"]
    problems: list[str] = []
    for native in BUNDLED_NATIVES:
        if re.search(re.escape(native.name), notice, re.IGNORECASE) is None:
            problems.append(
                f"{native.name} is recorded as bundled but the wheel notice no longer mentions it"
            )
    return problems


def verify_capability_roster() -> list[str]:
    """The build manifest and the worker's enforced roster must agree."""
    sys.path.insert(0, str(PROJECT_ROOT / "src"))
    from framepilot_tracking_lite import PACK_CAPABILITIES, PACK_ID, PACK_VERSION

    manifest = tomllib.loads(MANIFEST_PATH.read_text(encoding="utf-8"))["pack"]
    problems: list[str] = []
    if manifest["id"] != PACK_ID:
        problems.append(f"manifest pack id {manifest['id']} != worker identity {PACK_ID}")
    if manifest["version"] != PACK_VERSION:
        problems.append(f"manifest version {manifest['version']} != worker identity {PACK_VERSION}")
    if tuple(sorted(manifest["capabilities"])) != tuple(sorted(PACK_CAPABILITIES)):
        problems.append("manifest capability roster != the roster the worker enforces")
    return problems


def build_sbom(components: list[Component], platform: str) -> dict[str, object]:
    manifest = tomllib.loads(MANIFEST_PATH.read_text(encoding="utf-8"))["pack"]
    entries: list[dict[str, object]] = []
    for component in components:
        entry: dict[str, object] = {
            "type": "library",
            "name": component.name,
            "version": component.version,
            "purl": f"pkg:pypi/{component.name.lower()}@{component.version}",
            "licenses": [{"expression": component.license_id}],
        }
        if component.hashes:
            entry["hashes"] = [
                {"alg": "SHA-256", "content": digest} for digest in component.hashes
            ]
        entries.append(entry)
    for native in BUNDLED_NATIVES:
        if platform not in native.platforms:
            continue
        entries.append(
            {
                "type": "library",
                "name": native.name,
                "version": "bundled",
                "licenses": [{"expression": native.license_id}],
                "description": f"{native.note} Redistributed inside {native.inside}.",
            }
        )
    return {
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "version": 1,
        "metadata": {
            "timestamp": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "component": {
                "type": "application",
                "name": manifest["id"],
                "version": manifest["version"],
                "description": manifest["description"],
            },
            "properties": [{"name": "framepilot:platform", "value": platform}],
        },
        "components": entries,
    }


def build_licenses_markdown(components: list[Component]) -> str:
    lines = [
        "# Tracking Lite — third-party licenses",
        "",
        "Generated by `tools/generate_sbom.py` from the resolved environment and `uv.lock`.",
        "Do not edit by hand; regenerate after any dependency change.",
        "",
        "## Python distributions",
        "",
        "| Component | Version | License |",
        "| --- | --- | --- |",
    ]
    lines.extend(
        f"| `{component.name}` | {component.version} | {component.license_id} |"
        for component in components
    )
    lines += [
        "",
        "## Native libraries redistributed inside the OpenCV wheel",
        "",
        "These ship as binaries inside `cv2/` and are named by the wheel's own",
        "`LICENSE-3RD-PARTY.txt`, which `--check` verifies still lists every one of them.",
        "",
        "| Library | License | Platforms | Note |",
        "| --- | --- | --- | --- |",
    ]
    for native in BUNDLED_NATIVES:
        platforms = ", ".join(native.platforms) if native.platforms else "not shipped"
        lines.append(f"| `{native.name}` | {native.license_id} | {platforms} | {native.note} |")
    lines += [
        "",
        "## Obligations this pack carries",
        "",
        "- **LGPL-2.1-or-later components are redistributed.** FFmpeg (all platforms) and the",
        "  macOS support libraries above are dynamically linked binaries inside the OpenCV wheel.",
        "  Shipping them obliges FramePilot to distribute this notice, offer the corresponding",
        "  source for those components, and keep them replaceable — they must stay separate",
        "  dynamically linked binaries inside the pack artifact, never statically folded in.",
        "  FramePilot's own code and the base application are unaffected: the pack is an isolated",
        "  process, not a link-time dependency of the editor.",
        "- **The contrib wheel exposes non-free algorithms** (`cv2.xfeatures2d.SURF_create`).",
        "  Tracking Lite never calls them; the capability roster is enforced at health check and",
        "  is limited to point, region, and planar tracking.",
        "- **OpenCV itself is Apache-2.0** and NumPy is BSD-3-Clause-family, both permissive.",
        "",
        "The catalog record for this pack must surface the LGPL obligation and a source-offer URL",
        "before a user approves the download.",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify only; write nothing")
    parser.add_argument(
        "--platform", default="darwin-arm64", help="platform tag recorded in the SBOM"
    )
    arguments = parser.parse_args()

    problems = verify_capability_roster()
    notice = third_party_notice_text()
    components = collect_components()
    if any(component.name.startswith("opencv") for component in components):
        problems.extend(verify_bundled_natives(notice))
    elif arguments.check:
        problems.append(
            "the `cv` extra is not installed, so the license record cannot be verified"
        )

    if problems:
        for problem in problems:
            sys.stderr.write(f"license/SBOM record drift: {problem}\n")
        raise RecordDriftError(f"{len(problems)} record problem(s)")

    if arguments.check:
        print(f"record verified: {len(components)} distributions, {len(BUNDLED_NATIVES)} natives")
        return 0

    SBOM_DIRECTORY.mkdir(parents=True, exist_ok=True)
    sbom_path = SBOM_DIRECTORY / f"{arguments.platform}.cdx.json"
    sbom_path.write_text(
        json.dumps(build_sbom(components, arguments.platform), indent=2) + "\n", encoding="utf-8"
    )
    LICENSES_PATH.write_text(build_licenses_markdown(components), encoding="utf-8")
    print(f"wrote {sbom_path.relative_to(PROJECT_ROOT)} and {LICENSES_PATH.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
