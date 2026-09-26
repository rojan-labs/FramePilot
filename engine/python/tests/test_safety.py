"""Real tests for the path sandbox primitive (PRD §18.1/§18.2)."""

from __future__ import annotations

from pathlib import Path

import pytest

from framepilot_engine.safety import PathTraversalError, resolve_within


def test_normal_relative_path_resolves(tmp_path: Path) -> None:
    resolved = resolve_within(tmp_path, "assets/clip.mp4")
    assert resolved == (tmp_path / "assets" / "clip.mp4").resolve()
    assert tmp_path.resolve() in resolved.parents


def test_base_itself_is_allowed(tmp_path: Path) -> None:
    assert resolve_within(tmp_path, ".") == tmp_path.resolve()


def test_dotdot_escape_raises(tmp_path: Path) -> None:
    with pytest.raises(PathTraversalError):
        resolve_within(tmp_path, "../escape.key")


def test_absolute_outside_base_raises(tmp_path: Path) -> None:
    with pytest.raises(PathTraversalError):
        resolve_within(tmp_path, "/etc/passwd")


def test_escape_message_names_configured_root_and_hints_other_sidecar(
    tmp_path: Path,
) -> None:
    """§G2: the refusal must name this engine's configured root and hint that a
    request for a path outside it may belong to a sidecar started for a
    different projects root — without revealing anything beyond what the
    caller already supplied (base/candidate/resolved, as before).
    """
    with pytest.raises(PathTraversalError) as excinfo:
        resolve_within(tmp_path, "../escape.key")

    message = str(excinfo.value)
    assert str(tmp_path.resolve()) in message
    assert "configured for projects root" in message
    assert "different projects root" in message


def test_nul_byte_is_a_refusal_not_a_crash(tmp_path: Path) -> None:
    """A NUL byte can never name a file. Before, it surfaced as the ``ValueError`` the OS
    layer raises ("embedded null byte"), which every route turned into a 500; a caller
    that sent a bad path deserves the same 400 every other bad path gets."""
    with pytest.raises(PathTraversalError):
        resolve_within(tmp_path, "a\x00b.mp4")


def test_sibling_directory_sharing_the_roots_name_prefix_is_outside(tmp_path: Path) -> None:
    """``/projects-evil`` starts with the string ``/projects``; a bare prefix test on the
    root would let it through. It is a different directory and must be refused."""
    root = tmp_path / "projects"
    root.mkdir()
    (tmp_path / "projects-evil").mkdir()
    with pytest.raises(PathTraversalError):
        resolve_within(root, "../projects-evil/x")
    with pytest.raises(PathTraversalError):
        resolve_within(root, str(tmp_path / "projects-evil" / "x"))


def test_symlink_pointing_outside_the_root_is_refused(tmp_path: Path) -> None:
    root = tmp_path / "root"
    outside = tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    (outside / "secret").write_text("x", encoding="utf-8")
    (root / "link").symlink_to(outside)
    with pytest.raises(PathTraversalError):
        resolve_within(root, "link/secret")


def test_symlink_inside_the_root_resolves_to_its_target(tmp_path: Path) -> None:
    root = tmp_path / "root"
    (root / "media").mkdir(parents=True)
    (root / "alias").symlink_to(root / "media")
    assert resolve_within(root, "alias/clip.mp4") == (root / "media" / "clip.mp4").resolve()


@pytest.mark.parametrize(
    ("candidate", "expected"),
    [
        (".", ""),
        ("", ""),
        ("sub", "sub"),
        ("sub/", "sub"),
        ("sub/./clip.mp4", "sub/clip.mp4"),
        ("sub/../clip.mp4", "clip.mp4"),
        ("nonexist/../clip.mp4", "clip.mp4"),
        ("a//b", "a/b"),
    ],
)
def test_contained_candidates_resolve_like_the_filesystem_does(
    tmp_path: Path, candidate: str, expected: str
) -> None:
    root = tmp_path / "root"
    root.mkdir()
    resolved = resolve_within(root, candidate)
    assert resolved == (root / expected).resolve()
    # The containment check compares with a trailing separator; the caller never sees it.
    assert not str(resolved).endswith("/") or str(resolved) == "/"


def test_absolute_candidates_inside_the_root_are_accepted(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    assert resolve_within(root, str(root)) == root.resolve()
    inside = root / "media" / "x.mp4"
    assert resolve_within(root, str(inside)) == inside.resolve()


@pytest.mark.parametrize("candidate", ["..", "../", "nonexist/../../x", "sub/../../x"])
def test_candidates_that_climb_out_are_refused(tmp_path: Path, candidate: str) -> None:
    root = tmp_path / "root"
    root.mkdir()
    with pytest.raises(PathTraversalError):
        resolve_within(root, candidate)
