"""Tests for capability_pack_catalog_merge.py.

Run directly (this script is not part of the root pytest suite's `testpaths`, same as
`capability_pack_release.py` beside it):

    uv run --python 3.13 --with pytest --no-project pytest \
        scripts/capability_pack_catalog_merge_test.py -q
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pytest
from capability_pack_catalog_merge import (
    EMPTY_CATALOG,
    CatalogMergeError,
    merge_catalog,
    merge_releases,
)


def _release(pack_id: str, version: str, digest: str = "d0") -> dict[str, object]:
    return {"id": pack_id, "version": version, "releaseDigest": digest, "artifacts": []}


def test_add_new_pack_version() -> None:
    """A pack this run never touched stays, and a genuinely new pack is added."""
    current = [_release("framepilot.tracking-lite", "1.0.0")]
    incoming = [_release("framepilot.visual-embed", "1.0.0")]
    merged = merge_releases(current, incoming)
    keys = {(r["id"], r["version"]) for r in merged}
    assert keys == {
        ("framepilot.tracking-lite", "1.0.0"),
        ("framepilot.visual-embed", "1.0.0"),
    }
    assert len(merged) == 2


def test_replace_same_version() -> None:
    """Rebuilding the SAME packId+version replaces the old record, not duplicates it."""
    current = [_release("framepilot.visual-embed", "1.0.0", digest="old-digest")]
    incoming = [_release("framepilot.visual-embed", "1.0.0", digest="new-digest")]
    merged = merge_releases(current, incoming)
    assert len(merged) == 1
    assert merged[0]["releaseDigest"] == "new-digest"


def test_preserves_other_entries() -> None:
    """Every pack/version this run did not build survives untouched."""
    current = [
        _release("framepilot.tracking-lite", "1.0.0"),
        _release("framepilot.subject-intelligence", "1.2.0"),
        _release("framepilot.visual-embed", "1.0.0", digest="old-digest"),
    ]
    # This run only rebuilt visual-embed 1.0.0 (a re-signed digest) and shipped a brand
    # new visual-describe 1.0.0. tracking-lite and subject-intelligence are untouched.
    incoming = [
        _release("framepilot.visual-embed", "1.0.0", digest="new-digest"),
        _release("framepilot.visual-describe", "1.0.0"),
    ]
    merged = merge_releases(current, incoming)
    by_key = {(r["id"], r["version"]): r for r in merged}
    assert len(merged) == 4
    assert by_key[("framepilot.tracking-lite", "1.0.0")] == current[0]
    assert by_key[("framepilot.subject-intelligence", "1.2.0")] == current[1]
    assert by_key[("framepilot.visual-embed", "1.0.0")]["releaseDigest"] == "new-digest"
    assert by_key[("framepilot.visual-describe", "1.0.0")] == incoming[1]


def test_different_versions_of_the_same_pack_both_survive() -> None:
    """A new version is an ADDITION, not a replacement of an older version."""
    current = [_release("framepilot.visual-embed", "1.0.0")]
    incoming = [_release("framepilot.visual-embed", "1.1.0")]
    merged = merge_releases(current, incoming)
    keys = {(r["id"], r["version"]) for r in merged}
    assert keys == {
        ("framepilot.visual-embed", "1.0.0"),
        ("framepilot.visual-embed", "1.1.0"),
    }


def test_merge_is_deterministic_regardless_of_input_order() -> None:
    current = [_release("framepilot.b-pack", "2.0.0"), _release("framepilot.a-pack", "1.0.0")]
    incoming = [_release("framepilot.c-pack", "1.0.0")]
    merged_a = merge_releases(current, incoming)
    merged_b = merge_releases(list(reversed(current)), incoming)
    assert merged_a == merged_b
    assert [r["id"] for r in merged_a] == sorted(r["id"] for r in merged_a)


def test_merge_catalog_with_no_current_catalog_is_just_incoming_sorted() -> None:
    """The very first release ever: nothing published yet, so the merge is a no-op union."""
    incoming = [_release("framepilot.tracking-lite", "1.0.0")]
    merged = merge_catalog(None, incoming, "2026-09-14T00:00:00Z", 30)
    assert merged["releases"] == incoming
    assert merged["generatedAt"] == "2026-09-14T00:00:00Z"
    assert merged["expiresAt"] == "2026-10-14T00:00:00Z"
    assert merged["schemaVersion"] == 1
    assert merged["delegatedKeys"] == []


def test_merge_catalog_preserves_delegated_keys_from_current() -> None:
    current = {**EMPTY_CATALOG, "delegatedKeys": [{"keyId": "k1", "publicKey": "abc"}]}
    incoming = [_release("framepilot.tracking-lite", "1.0.0")]
    merged = merge_catalog(current, incoming, "2026-09-14T00:00:00Z", 30)
    assert merged["delegatedKeys"] == [{"keyId": "k1", "publicKey": "abc"}]


def test_merge_catalog_accepts_a_signed_envelope_for_current() -> None:
    """`--current` may be the currently-published `{catalog, signature}` envelope."""
    envelope = {
        "catalog": {**EMPTY_CATALOG, "releases": [_release("framepilot.tracking-lite", "1.0.0")]},
        "signature": {"algorithm": "ed25519", "keyId": "k1", "value": "sig"},
    }
    incoming = [_release("framepilot.visual-embed", "1.0.0")]
    merged = merge_catalog(envelope, incoming, "2026-09-14T00:00:00Z", 30)
    keys = {(r["id"], r["version"]) for r in merged["releases"]}
    assert keys == {("framepilot.tracking-lite", "1.0.0"), ("framepilot.visual-embed", "1.0.0")}


def test_release_missing_id_or_version_is_rejected() -> None:
    with pytest.raises(CatalogMergeError):
        merge_releases([], [{"version": "1.0.0"}])
    with pytest.raises(CatalogMergeError):
        merge_releases([], [{"id": "framepilot.tracking-lite"}])


def test_nonpositive_expiry_is_rejected() -> None:
    with pytest.raises(CatalogMergeError):
        merge_catalog(None, [], "2026-09-14T00:00:00Z", 0)
    with pytest.raises(CatalogMergeError):
        merge_catalog(None, [], "2026-09-14T00:00:00Z", -1)
