"""Process self-restriction and the two host-issued file surfaces (plan 03, MD-3).

A Smart Mask worker runs models over people. It must not open a network socket, and it may
touch the filesystem in exactly two places:

* **Write:** the host-created staging directory (``parameters.output``). Only the declared
  artifact names may be created there, never through a link, never past the byte ceiling.
  Two worker-private sub-directories exist while a job runs and are removed before the result:
  ``windows/`` (finished-window checkpoints, kept across a crash so a restart resumes) and
  ``scratch/`` (decoded frames and spilled embeddings). The host verifies the directory
  independently after the result, and anything else there refuses the artifact.
* **Read:** the host-written inputs directory (``parameters.inputs``): declared correction,
  lock and previous-artifact files only.

Pure standard library, so the contract suite runs without numpy.
"""

from __future__ import annotations

import hashlib
import os
import random
import shutil
import socket
import stat
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Final, NoReturn

from .protocol import InputHandle, OutputHandle, ProtocolError

#: Fixed seed for every stochastic step, so the same media and request give the same output.
DETERMINISTIC_SEED: Final = 20260917
WINDOWS_DIRECTORY: Final = "windows"
SCRATCH_DIRECTORY: Final = "scratch"
#: The host writes correction inputs here, inside the staging directory; never ours to touch.
HOST_INPUTS_DIRECTORY: Final = "inputs"
#: A correction/lock PNG is at most an 8K gray frame, compressed; anything larger is refused.
MAX_INPUT_FILE_BYTES: Final = 64 * 1024 * 1024
_HASH_CHUNK: Final = 1024 * 1024


class NetworkDisabledError(RuntimeError):
    """A local Capability Pack worker attempted network access."""


def _refuse(*_args: Any, **_kwargs: Any) -> NoReturn:
    raise NetworkDisabledError(
        "Smart Mask runs with networking disabled; media never leaves the machine."
    )


def disable_network() -> None:
    """Make socket creation raise for the rest of this process."""
    for attribute in ("socket", "create_connection", "create_server"):
        if hasattr(socket, attribute):
            setattr(socket, attribute, _refuse)


def configure_determinism() -> None:
    """Seed Python's RNG before any work. numpy seeds are passed explicitly where used."""
    random.seed(DETERMINISTIC_SEED)


def _unwritable(detail: str) -> ProtocolError:
    return ProtocolError("output_unwritable", detail, retryable=True)


def _is_real_directory(path: Path) -> bool:
    try:
        info = path.lstat()
    except OSError:
        return False
    return stat.S_ISDIR(info.st_mode)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(_HASH_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass
class OutputDirectory:
    """The one write surface. Every path the pipeline writes comes from here."""

    handle: OutputHandle
    root: Path = field(init=False)

    def __post_init__(self) -> None:
        root = Path(self.handle.absolute_path)
        if not _is_real_directory(root):
            raise _unwritable("The staging directory does not exist or is not a real directory.")
        # Resolving must not move the path: a link anywhere in it is refused, not followed.
        if Path(os.path.realpath(root)) != Path(os.path.abspath(root)):  # noqa: PTH100 - resolve() follows links
            raise _unwritable("The staging directory path goes through a link.")
        if not os.access(root, os.W_OK):
            raise _unwritable("The staging directory is not writable.")
        self.root = root

    def artifact_path(self, name: str) -> Path:
        """Path of a declared artifact file; any other name is refused."""
        if name not in self.handle.allowed_files:
            raise ProtocolError("internal_error", f"'{name}' is not a file this job may create.")
        path = self.root / name
        if path.is_symlink():
            raise _unwritable("An artifact path is a link.")
        return path

    def private_directory(self, name: str) -> Path:
        """``windows/`` or ``scratch/``: created on demand, never through a link."""
        if name not in (WINDOWS_DIRECTORY, SCRATCH_DIRECTORY):
            raise ProtocolError("internal_error", f"'{name}' is not a worker-private directory.")
        path = self.root / name
        if path.is_symlink():
            raise _unwritable("A worker-private directory is a link.")
        try:
            path.mkdir(exist_ok=True)
        except OSError as error:
            raise _unwritable(f"Could not create a working directory: {error.strerror}.") from error
        return path

    def unexpected_entries(self) -> list[str]:
        """Entries the host would refuse: anything but declared files and the host's inputs."""
        allowed = set(self.handle.allowed_files) | {HOST_INPUTS_DIRECTORY}
        return sorted(entry.name for entry in self.root.iterdir() if entry.name not in allowed)

    def declared_bytes(self) -> int:
        total = 0
        for name in self.handle.allowed_files:
            path = self.root / name
            if path.is_file() and not path.is_symlink():
                total += path.stat().st_size
        return total

    def enforce_ceiling(self, pending_bytes: int = 0) -> None:
        """Refuse once declared files (plus bytes about to be written) pass the job's ceiling."""
        if self.declared_bytes() + max(pending_bytes, 0) > self.handle.max_bytes:
            raise ProtocolError(
                "output_unwritable",
                "The matte would exceed the byte ceiling the host granted this job.",
                retryable=False,
            )

    def remove_private(self, name: str) -> None:
        path = self.root / name
        if path.is_symlink():
            path.unlink()
        elif path.exists():
            shutil.rmtree(path, ignore_errors=True)

    def finalise(self) -> None:
        """Drop worker-private directories and prove only declared names remain."""
        self.remove_private(SCRATCH_DIRECTORY)
        self.remove_private(WINDOWS_DIRECTORY)
        extra = self.unexpected_entries()
        if extra:
            raise ProtocolError(
                "internal_error", "The staging directory holds files the job did not declare."
            )
        self.enforce_ceiling()


@dataclass
class InputDirectory:
    """The read-only surface for brush corrections, locked frames and a previous artifact."""

    handle: InputHandle
    root: Path = field(init=False)

    def __post_init__(self) -> None:
        root = Path(self.handle.absolute_path)
        if not _is_real_directory(root):
            raise ProtocolError("invalid_request", "The inputs directory does not exist.")
        if Path(os.path.realpath(root)) != Path(os.path.abspath(root)):  # noqa: PTH100 - resolve() follows links
            raise ProtocolError("invalid_request", "The inputs directory path goes through a link.")
        self.root = root

    def has(self, name: str) -> bool:
        return name in self.handle.files and (self.root / name).is_file()

    def path(self, name: str) -> Path:
        if name not in self.handle.files:
            raise ProtocolError(
                "invalid_request", "An input file was not declared in the inputs handle."
            )
        path = self.root / name
        try:
            info = path.lstat()
        except OSError as error:
            raise ProtocolError("invalid_request", "A declared input file is missing.") from error
        if not stat.S_ISREG(info.st_mode):
            raise ProtocolError("invalid_request", "A declared input file is not a regular file.")
        resolved = Path(os.path.realpath(path))
        if self.root.resolve() not in resolved.parents:
            raise ProtocolError(
                "invalid_request", "A declared input file resolves outside its handle."
            )
        return path

    def read_bytes(self, name: str) -> bytes:
        path = self.path(name)
        if path.stat().st_size > MAX_INPUT_FILE_BYTES:
            raise ProtocolError("invalid_request", "A declared input file exceeds its size bound.")
        return path.read_bytes()


__all__ = [
    "DETERMINISTIC_SEED",
    "HOST_INPUTS_DIRECTORY",
    "SCRATCH_DIRECTORY",
    "WINDOWS_DIRECTORY",
    "InputDirectory",
    "NetworkDisabledError",
    "OutputDirectory",
    "configure_determinism",
    "disable_network",
    "sha256_file",
]
