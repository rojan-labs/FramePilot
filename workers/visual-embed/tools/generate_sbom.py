"""Generate the Visual Embed SBOM and license notice from the real environment.

Everything this emits is read from installed distribution metadata, from `uv.lock`, and
from `pack/models.lock.toml` — never hand authored. A license record that was typed by
hand is a record of what someone believed, not of what ships.

This pack has one obligation Tracking Lite does not: **the weights are redistributable
artifacts with their own licences**, so each model (the SigLIP 2 towers, the tokenizer,
and the shared YuNet/SFace face pair) appears in the SBOM as a component with its own
digest and licence, and `--check` fails if the compiled-in pins and the lock file ever
disagree.

Native libraries bundled *inside* the OpenCV wheel are the one case metadata cannot
describe: they appear only in the wheel's `LICENSE-3RD-PARTY.txt` prose. Those are
declared here and then **verified against that file**, so the record cannot silently
drift when the wheel changes.

Neither this check nor `--check` downloads a single weight byte: it reads
`pack/models.lock.toml` and the digests compiled into `models.py`, and compares them to
each other. Verifying the *installed* weight files against their pins is
`tools/fetch_models.py --check`'s job, not this one's — which is exactly why this script
can run in the no-weights PR tier.

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
MODELS_LOCK_PATH = PROJECT_ROOT / "pack" / "models.lock.toml"
SBOM_DIRECTORY = PROJECT_ROOT / "pack" / "sbom"
LICENSES_PATH = PROJECT_ROOT / "LICENSES.md"

SELF_DISTRIBUTION = "framepilot-visual-embed"
#: Weights may only carry licences a commercial desktop product can ship.
PERMITTED_MODEL_LICENSES = frozenset({"MIT", "Apache-2.0", "BSD-3-Clause"})


@dataclass(frozen=True, slots=True)
class BundledNative:
    """A native library redistributed inside a Python wheel."""

    name: str
    license_id: str
    #: The wheel whose LICENSE-3RD-PARTY.txt must still mention this library.
    inside: str
    platforms: tuple[str, ...]
    note: str


# Declared from the wheel's own LICENSE-3RD-PARTY.txt, then verified below. Same wheel,
# same list Tracking Lite and Subject Intelligence already carry.
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


@dataclass(frozen=True, slots=True)
class ModelRecord:
    identifier: str
    name: str
    file: str
    sha256: str
    size: int
    license_id: str
    license_verified: bool
    copyright: str
    url: str
    role: str
    notes: str


class RecordDriftError(RuntimeError):
    """The generated record no longer matches what the environment actually ships."""


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


def collect_models() -> list[ModelRecord]:
    """Every pinned artifact named in `pack/models.lock.toml`.

    The lock file names several source tables (`[source]`, `[faceSource]`, …) and each
    `[[model]]` entry says which one it came from via its own `source` key, defaulting to
    the table literally named `source`. This reads that generically rather than hard-coding
    the table names, so a new source table needs no change here.
    """
    lock = tomllib.loads(MODELS_LOCK_PATH.read_text(encoding="utf-8"))
    source_urls: dict[str, str] = {
        key: str(value["baseUrl"]).rstrip("/")
        for key, value in lock.items()
        if isinstance(value, dict) and "baseUrl" in value
    }
    records: list[ModelRecord] = []
    for entry in lock.get("model", []):
        source_key = str(entry.get("source", "source"))
        base = source_urls.get(source_key, "")
        path = str(entry.get("path", ""))
        url = f"{base}/{path}" if base and path else ""
        records.append(
            ModelRecord(
                identifier=str(entry["id"]),
                name=str(entry["name"]),
                file=str(entry["file"]),
                sha256=str(entry["sha256"]),
                size=int(entry["bytes"]),
                license_id=str(entry["license"]),
                license_verified=bool(entry.get("licenseVerified", False)),
                copyright=str(entry.get("copyright", "")),
                url=url,
                role=str(entry.get("role", "")),
                notes=str(entry.get("notes", "")),
            )
        )
    return sorted(records, key=lambda record: record.identifier)


def verify_models(models: list[ModelRecord]) -> list[str]:
    """The lock file, the compiled pins, and the licence policy must all agree."""
    sys.path.insert(0, str(PROJECT_ROOT / "src"))
    from framepilot_visual_embed.models import MODELS_BY_ID

    problems: list[str] = []
    if {model.identifier for model in models} != set(MODELS_BY_ID):
        problems.append("models.lock.toml and the compiled model pins name different models")
        return problems
    for model in models:
        pinned = MODELS_BY_ID[model.identifier]
        if pinned.sha256 != model.sha256:
            problems.append(f"{model.file}: compiled digest != locked digest")
        if pinned.file != model.file:
            problems.append(f"{model.identifier}: compiled filename != locked filename")
        if pinned.license != model.license_id:
            problems.append(f"{model.file}: compiled licence != locked licence")
        if model.license_id not in PERMITTED_MODEL_LICENSES:
            problems.append(
                f"{model.file} is {model.license_id}, which is not a permitted model licence"
            )
    return problems


def third_party_notice_text() -> str:
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
    sys.path.insert(0, str(PROJECT_ROOT / "src"))
    from framepilot_visual_embed import PACK_CAPABILITIES, PACK_ID, PACK_VERSION

    manifest = tomllib.loads(MANIFEST_PATH.read_text(encoding="utf-8"))["pack"]
    problems: list[str] = []
    if manifest["id"] != PACK_ID:
        problems.append(f"manifest pack id {manifest['id']} != worker identity {PACK_ID}")
    if manifest["version"] != PACK_VERSION:
        problems.append(f"manifest version {manifest['version']} != worker identity {PACK_VERSION}")
    if tuple(sorted(manifest["capabilities"])) != tuple(sorted(PACK_CAPABILITIES)):
        problems.append("manifest capability roster != the roster the worker enforces")
    return problems


def build_sbom(
    components: list[Component], models: list[ModelRecord], platform: str
) -> dict[str, object]:
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
    # Weights are first-class components: a downstream scanner must be able to see what
    # models a signed artifact carries and under what terms.
    for model in models:
        entry = {
            "type": "machine-learning-model",
            "name": model.name,
            "version": model.file,
            "licenses": [{"expression": model.license_id}],
            "hashes": [{"alg": "SHA-256", "content": model.sha256}],
            "description": f"{model.role}. {model.copyright}",
            "properties": [
                {"name": "framepilot:bytes", "value": str(model.size)},
                {
                    "name": "framepilot:licenseVerified",
                    "value": str(model.license_verified).lower(),
                },
            ],
        }
        if model.url:
            entry["externalReferences"] = [{"type": "distribution", "url": model.url}]
        entries.append(entry)
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


def build_licenses_markdown(components: list[Component], models: list[ModelRecord]) -> str:
    lines = [
        "# Visual Embed — third-party licenses",
        "",
        "Generated by `tools/generate_sbom.py` from the resolved environment, `uv.lock`",
        "and `pack/models.lock.toml`. Do not edit by hand; regenerate after any change.",
        "",
        "## Model weights",
        "",
        "Downloaded at pack build time from a URL pinned to an immutable upstream revision",
        "and verified against these digests. They are never committed to the repository and",
        "never enter the base installer.",
        "",
        "| Model | File | License | Verified | Bytes | SHA-256 |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    lines.extend(
        f"| {model.name} | `{model.file}` | {model.license_id} "
        f"| {'✅' if model.license_verified else '❌ open — see notes'} "
        f"| {model.size} | `{model.sha256}` |"
        for model in models
    )
    lines += [
        "",
        "Copyright holders:",
        "",
    ]
    lines.extend(f"- **{model.name}** — {model.copyright}" for model in models)
    unverified = [model for model in models if not model.license_verified]
    if unverified:
        lines += [
            "",
            "### Licence rows not independently verified",
            "",
            "`licenseVerified` in `pack/models.lock.toml` is `false` for these — the licence in",
            "the table above is what the model card or an inherited `base_model` declares, not a",
            "licence file this project has itself read at the pinned revision:",
            "",
        ]
        for model in unverified:
            note = f" {model.notes}" if model.notes else ""
            lines.append(f"- **{model.name}** (`{model.file}`).{note}")
    lines += [
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
        "- **Model attribution.** Every weight above is MIT or Apache-2.0. Both require this",
        "  notice to travel with the binaries, which is why it ships inside the pack artifact",
        "  and is surfaced in the catalog record before a user approves the download. The",
        "  SigLIP 2 ONNX export's own licence is not yet independently verified beyond its",
        "  inherited `base_model` declaration (see `pack/models.lock.toml`); the face pair's",
        "  licence IS independently verified against the OpenCV Zoo `LICENSE` files.",
        "- **No copyleft weight may ship.** `tools/generate_sbom.py --check` fails if any",
        "  pinned model ever carries a licence outside MIT/Apache-2.0/BSD-3-Clause.",
        "- **LGPL-2.1-or-later components are redistributed.** FFmpeg (all platforms) and the",
        "  macOS support libraries above are dynamically linked binaries inside the OpenCV wheel.",
        "  Shipping them obliges FramePilot to distribute this notice, offer the corresponding",
        "  source for those components, and keep them replaceable — they must stay separate",
        "  dynamically linked binaries inside the pack artifact, never statically folded in.",
        "  FramePilot's own code and the base application are unaffected: the pack is an isolated",
        "  process, not a link-time dependency of the editor.",
        "- **OpenCV itself is Apache-2.0** and NumPy is BSD-3-Clause-family, both permissive.",
        "",
        "The catalog record for this pack must surface the LGPL obligation, a source-offer URL,",
        "and the model provenance above before a user approves the download.",
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

    models = collect_models()
    problems = verify_capability_roster()
    problems.extend(verify_models(models))
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
        print(
            f"record verified: {len(components)} distributions, "
            f"{len(models)} models, {len(BUNDLED_NATIVES)} natives"
        )
        return 0

    SBOM_DIRECTORY.mkdir(parents=True, exist_ok=True)
    sbom_path = SBOM_DIRECTORY / f"{arguments.platform}.cdx.json"
    sbom_path.write_text(
        json.dumps(build_sbom(components, models, arguments.platform), indent=2) + "\n",
        encoding="utf-8",
    )
    LICENSES_PATH.write_text(build_licenses_markdown(components, models), encoding="utf-8")
    print(f"wrote {sbom_path.relative_to(PROJECT_ROOT)} and {LICENSES_PATH.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
