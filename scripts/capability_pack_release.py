#!/usr/bin/env python3
"""Generate the JSON inputs `framepilot-pack` consumes, from the pack's own records.

`framepilot-pack prepare-artifact` / `prepare-release` validate and digest release facts,
but something has to ASSEMBLE those facts, and doing it by hand in a workflow is exactly
how a catalog record starts saying something the manifest does not. So every value below
is read from a record that already exists — `pack/manifest.toml`, `pack/models.lock.toml`,
`pack/sbom/<platform>.cdx.json`, the build receipt — and nothing is typed here twice.

Standard library only: it runs on a release runner before any pack environment exists.

    capability_pack_release.py artifact-input --pack visual-embed --build-dir D \
        --base-url https://cdn.example --team-id ABCDE12345 --out input.json
    capability_pack_release.py release-core --pack visual-embed --artifact artifact.json \
        --min-app-version 1.0.0 --notice-url https://… --out release-core.json
    capability_pack_release.py catalog --release a.json --release b.json \
        --generated-at 2026-09-14T00:00:00Z --expires-in-days 30 --out catalog.json

WHY IT REFUSES A PACK WITHOUT AN SBOM: the license set shown to a user before download
and checked against `ALLOWED_LICENSES` must be the set that ships. For a pack whose SBOM
generator does not exist yet, the only alternative is a hand-typed list — a record of
what someone believed, not of what ships — so this fails and says so instead.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tomllib
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent

#: Licences a commercial desktop product may redistribute inside a pack. LGPL-2.1 is
#: here for the FFmpeg family bundled inside the OpenCV wheel, which the SBOMs already
#: record and the licence notices already disclose. Anything else fails `prepare-artifact`.
ALLOWED_LICENSES = (
    "0BSD",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "CC0-1.0",
    "ISC",
    "LGPL-2.1-or-later",
    "MIT",
    "PSF-2.0",
    "Zlib",
)

#: The build vendors CPython itself (scripts/build-capability-pack.sh), which no worker
#: SBOM lists because the SBOMs describe the worker's dependency tree.
VENDORED_INTERPRETER_LICENSE = "PSF-2.0"

_HASH_CHUNK = 1024 * 1024


class ReleaseInputError(Exception):
    """A release fact could not be derived from the pack's records."""


def _load_toml(path: Path) -> dict[str, Any]:
    with path.open("rb") as handle:
        return tomllib.load(handle)


def _manifest(pack: str) -> dict[str, Any]:
    path = REPO_ROOT / "workers" / pack / "pack" / "manifest.toml"
    if not path.is_file():
        raise ReleaseInputError(f"no manifest for pack '{pack}' at {path}")
    return _load_toml(path)


def _platform(manifest: dict[str, Any], os_name: str, arch: str) -> dict[str, Any]:
    for platform in manifest.get("platforms", []):
        if platform["os"] == os_name and platform["arch"] == arch:
            return dict(platform)
    raise ReleaseInputError(
        f"{manifest['pack']['id']} declares no {os_name}-{arch} platform in its manifest"
    )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(_HASH_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def _spdx_ids(expression: str) -> list[str]:
    """Split a conjunctive SPDX expression. A disjunction is a CHOICE, not a fact to copy."""
    if " OR " in expression or " WITH " in expression:
        raise ReleaseInputError(
            f"SPDX expression '{expression}' needs a licence decision, not a copy"
        )
    return [part.strip("() ") for part in expression.split(" AND ") if part.strip("() ")]


def pack_licenses(pack: str, os_name: str, arch: str) -> list[str]:
    """The licence identifiers that ship in one platform artifact of a pack."""
    worker = REPO_ROOT / "workers" / pack
    sbom_path = worker / "pack" / "sbom" / f"{os_name}-{arch}.cdx.json"
    if not sbom_path.is_file():
        raise ReleaseInputError(
            f"{pack} has no SBOM record at {sbom_path.relative_to(REPO_ROOT)}; its licence "
            "set cannot be derived, so no release record is emitted (see module docstring)"
        )
    sbom = json.loads(sbom_path.read_text(encoding="utf-8"))
    licenses: set[str] = {VENDORED_INTERPRETER_LICENSE}
    for component in sbom.get("components", []):
        for entry in component.get("licenses", []):
            if "expression" in entry:
                licenses.update(_spdx_ids(str(entry["expression"])))
            elif "license" in entry and "id" in entry["license"]:
                licenses.add(str(entry["license"]["id"]))
            else:
                raise ReleaseInputError(
                    f"{sbom_path.name}: component {component.get('name')} has a licence "
                    "with no SPDX identifier"
                )
    models_lock = worker / "pack" / "models.lock.toml"
    if models_lock.is_file():
        lock = _load_toml(models_lock)
        for entry in [*lock.get("model", []), *lock.get("archive", [])]:
            licenses.add(str(entry["license"]))
    return sorted(licenses)


def artifact_input(args: argparse.Namespace) -> dict[str, Any]:
    manifest = _manifest(args.pack)
    build_dir = Path(args.build_dir)
    receipt = json.loads((build_dir / "build-receipt.json").read_text(encoding="utf-8"))
    pack = manifest["pack"]
    if receipt["packId"] != pack["id"] or receipt["version"] != pack["version"]:
        raise ReleaseInputError(
            f"build receipt {receipt['packId']}@{receipt['version']} does not match the "
            f"manifest {pack['id']}@{pack['version']}"
        )
    platform = _platform(manifest, receipt["os"], receipt["arch"])
    archive = build_dir / receipt["archive"]
    archive_sha = _sha256(archive)
    # `publication-plan` requires every artifact URL to contain its own sha256, so the
    # object key is immutable by construction.
    url = (
        f"{args.base_url.rstrip('/')}/{pack['id']}/{pack['version']}/"
        f"{receipt['os']}-{receipt['arch']}/{archive_sha}.zip"
    )
    if receipt["os"] == "darwin":
        trust = {"kind": "macos_codesign", "teamIdentifier": args.team_id}
    else:
        trust = {"kind": "windows_authenticode", "certificateSha256": args.team_id}
    return {
        "packId": pack["id"],
        "version": pack["version"],
        "payloadRoot": str(build_dir / "payload"),
        "archivePath": str(archive),
        "url": url,
        "os": receipt["os"],
        "arch": receipt["arch"],
        "format": receipt["format"],
        "entrypoint": f"bin/{platform['entrypoint']}",
        "executableTrust": trust,
        "licenses": pack_licenses(args.pack, receipt["os"], receipt["arch"]),
        "allowedLicenses": list(ALLOWED_LICENSES),
    }


def release_core(args: argparse.Namespace) -> dict[str, Any]:
    manifest = _manifest(args.pack)
    pack = manifest["pack"]
    artifacts = [
        json.loads(Path(path).read_text(encoding="utf-8"))["artifact"] for path in args.artifact
    ]
    licenses = sorted(
        {
            spdx
            for artifact in artifacts
            for spdx in pack_licenses(args.pack, artifact["os"], artifact["arch"])
        }
    )
    network = manifest["runtime"]["network"]
    if network != "disabled":
        raise ReleaseInputError(
            f"{pack['id']} declares network '{network}'; the privacy record for a "
            "network-enabled pack needs a human-written disclosure"
        )
    return {
        "id": pack["id"],
        "version": pack["version"],
        "displayName": pack["display_name"],
        "description": pack["description"],
        "channel": pack["channel"],
        "capabilities": sorted(pack["capabilities"]),
        "licenses": [
            {
                "spdx": spdx,
                "name": spdx,
                "noticeUrl": args.notice_url,
                "redistribution": "allowed",
            }
            for spdx in licenses
        ],
        "privacy": {
            "execution": "local",
            "mediaLeavesDevice": False,
            "disclosure": (
                "Runs entirely on this device with network access disabled; "
                "media never leaves the device."
            ),
        },
        "compatibility": {
            "minAppVersion": args.min_app_version,
            "workerProtocolVersion": pack["worker_protocol_version"],
        },
        "artifacts": artifacts,
        "dependencies": [],
        "conflicts": [],
    }


def catalog(args: argparse.Namespace) -> dict[str, Any]:
    generated = datetime.fromisoformat(args.generated_at.replace("Z", "+00:00")).astimezone(UTC)
    expires = generated + timedelta(days=args.expires_in_days)
    releases = [json.loads(Path(path).read_text(encoding="utf-8")) for path in args.release]
    return {
        "schemaVersion": 1,
        "generatedAt": generated.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "expiresAt": expires.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "releases": sorted(releases, key=lambda release: (release["id"], release["version"])),
        "delegatedKeys": [],
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)

    artifact = commands.add_parser("artifact-input", help="input for `prepare-artifact`")
    artifact.add_argument("--pack", required=True)
    artifact.add_argument("--build-dir", required=True)
    artifact.add_argument("--base-url", required=True)
    artifact.add_argument(
        "--team-id",
        required=True,
        help="Apple Team ID (darwin) or Authenticode signer certificate sha256 (win32)",
    )
    artifact.add_argument("--out", required=True)

    release = commands.add_parser("release-core", help="input for `prepare-release`")
    release.add_argument("--pack", required=True)
    release.add_argument("--artifact", action="append", required=True)
    release.add_argument("--min-app-version", required=True)
    release.add_argument("--notice-url", required=True)
    release.add_argument("--out", required=True)

    catalog_parser = commands.add_parser("catalog", help="input for `sign-catalog`")
    catalog_parser.add_argument("--release", action="append", required=True)
    catalog_parser.add_argument("--generated-at", required=True)
    catalog_parser.add_argument("--expires-in-days", type=int, default=30)
    catalog_parser.add_argument("--out", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    builders = {"artifact-input": artifact_input, "release-core": release_core, "catalog": catalog}
    try:
        value = builders[args.command](args)
    except (ReleaseInputError, KeyError, OSError) as error:
        print(f"capability_pack_release {args.command}: {error}", file=sys.stderr)
        return 1
    Path(args.out).write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
