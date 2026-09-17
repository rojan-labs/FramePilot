"""Writes: declared names under a byte ceiling. Reads: declared regular files only."""

from __future__ import annotations

from pathlib import Path

import pytest

from framepilot_smart_mask.protocol import InputHandle, OutputHandle, ProtocolError
from framepilot_smart_mask.sandbox import InputDirectory, NetworkDisabledError, OutputDirectory


def output(root: Path, max_bytes: int = 1_000) -> OutputDirectory:
    return OutputDirectory(
        OutputHandle("out", str(root), ("matte.mkv", "frames.json", "report.json"), max_bytes)
    )


def test_declared_names_only(staging: Path) -> None:
    directory = output(staging)
    assert directory.artifact_path("matte.mkv") == staging / "matte.mkv"
    with pytest.raises(ProtocolError):
        directory.artifact_path("preview.webm")
    with pytest.raises(ProtocolError):
        directory.private_directory("elsewhere")


def test_linked_staging_directory_is_refused(tmp_path: Path, staging: Path) -> None:
    link = tmp_path / "link"
    link.symlink_to(staging, target_is_directory=True)
    with pytest.raises(ProtocolError) as caught:
        output(link)
    assert caught.value.code == "output_unwritable"
    with pytest.raises(ProtocolError):
        output(tmp_path / "missing")


def test_byte_ceiling_and_finalise(staging: Path) -> None:
    directory = output(staging, max_bytes=100)
    directory.artifact_path("matte.mkv").write_bytes(b"x" * 60)
    directory.enforce_ceiling()
    with pytest.raises(ProtocolError, match="byte ceiling"):
        directory.enforce_ceiling(pending_bytes=41)
    (directory.private_directory("windows") / "0").mkdir()
    (directory.private_directory("scratch") / "frames.raw").write_bytes(b"y" * 10_000)
    directory.finalise()
    assert sorted(entry.name for entry in staging.iterdir()) == ["inputs", "matte.mkv"]


def test_finalise_refuses_stray_files(staging: Path) -> None:
    directory = output(staging)
    (staging / "evil.sh").write_text("#!/bin/sh")
    with pytest.raises(ProtocolError, match="did not declare"):
        directory.finalise()


def test_inputs_are_declared_regular_files_inside_the_handle(tmp_path: Path) -> None:
    root = tmp_path / "inputs"
    (root / "locked").mkdir(parents=True)
    (root / "locked" / "0.png").write_bytes(b"png")
    outside = tmp_path / "secret.png"
    outside.write_bytes(b"secret")
    (root / "corrections").mkdir()
    (root / "corrections" / "5.png").symlink_to(outside)
    directory = InputDirectory(InputHandle("in", str(root), ("locked/0.png", "corrections/5.png")))
    assert directory.read_bytes("locked/0.png") == b"png"
    with pytest.raises(ProtocolError, match="not declared"):
        directory.path("locked/1.png")
    with pytest.raises(ProtocolError, match="regular file"):
        directory.read_bytes("corrections/5.png")


def test_network_is_disabled_after_disable_network() -> None:
    import socket

    from framepilot_smart_mask import sandbox

    saved = {
        name: getattr(socket, name) for name in ("socket", "create_connection", "create_server")
    }
    try:
        sandbox.disable_network()
        with pytest.raises(NetworkDisabledError):
            socket.create_connection(("127.0.0.1", 9))
    finally:
        for name, value in saved.items():
            setattr(socket, name, value)
