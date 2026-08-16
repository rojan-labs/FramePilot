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
