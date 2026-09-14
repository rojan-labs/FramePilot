"""Merge this run's releases into the currently-published Capability Pack catalog.

WHY THIS EXISTS: `capability_pack_release.py catalog` (and the node
`release-cli.js catalog`/`sign-catalog` commands it feeds) build a catalog from ONLY the
releases a single CI run produced — deliberately, so a run that builds one pack never
has to know about every other pack's latest release. But the CDN's `latest` catalog is
the union of every pack ever released, so publishing needs a MERGE step: take whatever is
live right now, replace the entries this run built (by exact packId+version), and leave
every other entry untouched. Getting that merge wrong is either data loss (silently
dropping a pack nobody rebuilt this run) or a stale catalog (never publishing a genuine
new version) — so it is a pure, unit-tested function here, not inline shell in a workflow.

This module knows nothing about the CDN or how the current catalog was fetched; it
merges two already-loaded JSON documents and returns a new one. The workflow step that
calls it is responsible for downloading the current live catalog (or treating "not found
yet" as an empty catalog for the very first release) and for signing the result
afterward via `release-cli.js sign-catalog` — this module produces the UNSIGNED merged
catalog body, exactly what `sign-catalog` already expects as input elsewhere in this
pipeline.

    python3 capability_pack_catalog_merge.py \
        --current current-catalog.json \
        --incoming this-runs-catalog.json \
        --generated-at 2026-09-14T00:00:00Z \
        --expires-in-days 30 \
        --out merged-catalog.json

`--current` may be omitted (or point at a nonexistent file) for the first-ever release:
merging into an empty catalog is just "this run's releases, sorted."
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

#: A catalog with no releases and no delegated keys — the identity element for merging,
#: used when no catalog has ever been published.
EMPTY_CATALOG: dict[str, Any] = {
    "schemaVersion": 1,
    "generatedAt": "1970-01-01T00:00:00Z",
    "expiresAt": "1970-01-01T00:00:00Z",
    "releases": [],
    "delegatedKeys": [],
}


class CatalogMergeError(Exception):
    """The inputs cannot be merged into one well-formed catalog."""


def _release_key(release: dict[str, Any]) -> tuple[str, str]:
    try:
        return (str(release["id"]), str(release["version"]))
    except KeyError as error:
        raise CatalogMergeError(f"release is missing '{error.args[0]}': {release}") from error


def merge_releases(
    current: list[dict[str, Any]], incoming: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Combine two release lists, keyed by (packId, version).

    An incoming release REPLACES a current one with the same key (this run rebuilt that
    exact version — its record, e.g. a newly-added platform artifact or a re-signed
    digest, is the one to keep). A current release whose key is not in `incoming` is
    preserved untouched. The result is sorted by (id, version), the same order
    `capability_pack_release.py catalog` already produces, so merging is idempotent and
    a diff of two catalog.json files is meaningful.
    """
    by_key: dict[tuple[str, str], dict[str, Any]] = {}
    for release in current:
        by_key[_release_key(release)] = release
    for release in incoming:
        by_key[_release_key(release)] = release
    return sorted(by_key.values(), key=_release_key)


def merge_catalog(
    current: dict[str, Any] | None,
    incoming_releases: list[dict[str, Any]],
    generated_at: str,
    expires_in_days: int,
) -> dict[str, Any]:
    """Produce the next unsigned catalog body: current releases, with this run's applied.

    :param current: the currently-published catalog's body (the `catalog` field of a
        signed envelope, or the plain catalog if reading an already-unwrapped one) — or
        ``None``/absent for "nothing has ever been published".
    :param incoming_releases: this run's `catalog.json["releases"]`.
    :param generated_at: RFC3339 UTC timestamp (``...Z``) for the merged catalog.
    :param expires_in_days: catalog lifetime from `generated_at`.
    """
    base = _unwrap(current) if current is not None else EMPTY_CATALOG
    for field in ("releases",):
        if field not in base:
            raise CatalogMergeError(f"current catalog has no '{field}' field: {base}")
    generated = datetime.fromisoformat(generated_at.replace("Z", "+00:00")).astimezone(UTC)
    if expires_in_days <= 0:
        raise CatalogMergeError(f"expires_in_days must be positive, got {expires_in_days}")
    expires = generated + timedelta(days=expires_in_days)
    return {
        "schemaVersion": 1,
        "generatedAt": generated.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "expiresAt": expires.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "releases": merge_releases(list(base["releases"]), incoming_releases),
        # Root-key delegation is a maintainer-driven security event of its own, never an
        # incidental side effect of a pack release merge; carry the current set forward
        # unchanged rather than silently dropping or inventing a delegation.
        "delegatedKeys": list(base.get("delegatedKeys", [])),
    }


def _unwrap(document: dict[str, Any]) -> dict[str, Any]:
    """Accept either a bare catalog or a `{catalog, signature}` signed envelope."""
    if "catalog" in document and "releases" not in document:
        return dict(document["catalog"])
    return document


def _load(path: Path | None) -> dict[str, Any] | None:
    if path is None or not path.is_file():
        return None
    return _unwrap(json.loads(path.read_text(encoding="utf-8")))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--current",
        type=Path,
        default=None,
        help="the current catalog/envelope; omitted or missing = nothing published yet",
    )
    parser.add_argument(
        "--incoming",
        type=Path,
        required=True,
        help="this run's catalog.json (from `capability_pack_release.py catalog`)",
    )
    parser.add_argument(
        "--generated-at", required=True, help="RFC3339 UTC, e.g. 2026-09-14T00:00:00Z"
    )
    parser.add_argument("--expires-in-days", type=int, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)

    current = _load(args.current)
    incoming = _unwrap(json.loads(args.incoming.read_text(encoding="utf-8")))
    merged = merge_catalog(
        current, list(incoming["releases"]), args.generated_at, args.expires_in_days
    )
    args.out.write_text(json.dumps(merged, indent=2) + "\n", encoding="utf-8")
    print(
        f"merged {len(incoming['releases'])} incoming release(s) into "
        f"{len(current['releases']) if current else 0} existing -> {len(merged['releases'])} total"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
