"""Speaking the Capability Pack worker protocol from the engine.

WHY THE ENGINE AND NOT THE DESKTOP HOST (ADR 0114 / ``plan/visual-understanding`` VU5.3):
tier 1 runs inside the indexing slice, next to the brain it writes and the tier-0
measurements it labels. Round-tripping every batch of 64 shots out to the Electron main
process and back would put an IPC hop and a second copy of the vectors on the hot path of
a job that already owns a SQLite transaction.

What the host still owns is **authorisation**. The engine never discovers, installs,
verifies or locates a pack: it is handed a fully-resolved handle in the index request —
the same channel the NVIDIA keys already arrive on — and refuses to run anything else. The
host has by then verified the signed catalog record, the artifact digest, the platform code
signature and the worker's health handshake (``worker-health.ts``). A missing or malformed
handle is simply "no local pack", which is the shipped default.

The protocol itself is ``packages/capability-packs/src/worker-protocol.ts``: one JSON line
in, progress lines and exactly one terminal line out, one request per process. This module
is dependency free (``subprocess`` + ``json``), so the engine gains nothing optional and
nothing new for a pack it may never have.
"""

from __future__ import annotations

import json
import logging
import subprocess
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final, Protocol

_log = logging.getLogger(__name__)

__all__ = [
    "MAX_LINE_BYTES",
    "PROTOCOL_VERSION",
    "PackHandle",
    "PackWorkerError",
    "default_launcher",
    "parse_pack_handle",
    "run_pack_request",
]

PROTOCOL_VERSION: Final = 1
MAX_LINE_BYTES: Final = 1024 * 1024
#: Seconds a single worker request may take before it is killed. A batch of 64 shots on a
#: CPU-only machine is the worst realistic case; anything past this is a hung process, not
#: a slow one.
DEFAULT_TIMEOUT_SECONDS: Final = 300.0

#: Environment variables the installer sets for a worker process. Mirrors
#: ``worker-env.ts``: the identity the worker checks its own health against.
ENV_PACK_ID: Final = "FRAMEPILOT_CAPABILITY_PACK_ID"
ENV_PACK_VERSION: Final = "FRAMEPILOT_CAPABILITY_PACK_VERSION"
ENV_RELEASE_DIGEST: Final = "FRAMEPILOT_CAPABILITY_PACK_RELEASE_DIGEST"
ENV_CAPABILITIES: Final = "FRAMEPILOT_CAPABILITY_PACK_CAPABILITIES"
ENV_PACK_ROOT: Final = "FRAMEPILOT_CAPABILITY_PACK_ROOT"
ENV_PACK_CACHE: Final = "FRAMEPILOT_CAPABILITY_PACK_CACHE"

RUNTIME_FLAG: Final = "--framepilot-worker-runtime"


class PackWorkerError(Exception):
    """A pack worker could not produce a result.

    Carries the protocol's own failure ``code`` when the worker returned one, so a caller
    can tell "this machine has no CoreML" (``hardware_unsupported``, permanent) from "the
    host cancelled" (``cancelled``, not a fault) without parsing prose.
    """

    def __init__(
        self, detail: str, *, code: str = "internal_error", retryable: bool = False
    ) -> None:
        super().__init__(detail)
        self.detail = detail
        self.code = code
        self.retryable = retryable


@dataclass(frozen=True, slots=True)
class PackHandle:
    """An installed, verified pack the host has authorised this run to use.

    Everything here is the host's product. The engine treats the entrypoint as opaque and
    never composes a path of its own from ``root`` — resolving inside a pack is exactly the
    sandbox escape the handle exists to prevent.
    """

    pack_id: str
    version: str
    release_digest: str
    entrypoint: str
    capabilities: tuple[str, ...]
    root: str | None = None
    cache: str | None = None
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS

    def provides(self, capability: str) -> bool:
        return capability in self.capabilities

    def environment(self) -> dict[str, str]:
        """The identity variables the worker's health check reads back."""
        env = {
            ENV_PACK_ID: self.pack_id,
            ENV_PACK_VERSION: self.version,
            ENV_RELEASE_DIGEST: self.release_digest,
            ENV_CAPABILITIES: json.dumps(sorted(self.capabilities)),
        }
        if self.root:
            env[ENV_PACK_ROOT] = self.root
        if self.cache:
            env[ENV_PACK_CACHE] = self.cache
        return env


def parse_pack_handle(raw: str | None, *, require: Sequence[str] = ()) -> PackHandle | None:
    """Parse a host-supplied handle, or return ``None``.

    Honest-unavailable, deliberately: no handle, a malformed one, or one that does not
    claim the capabilities the caller needs all mean "no local pack", which is the shipped
    default and not an error. A malformed handle is logged at warning level because it
    means the host tried and failed, which is a bug worth seeing — but it must never fail
    an index slice, or a bad handle would make a machine WITH a pack index less than a
    machine without one.

    :param raw: JSON object as passed in the index request or the environment.
    :param require: Capabilities the handle must claim to be usable.
    """
    if not raw or not raw.strip():
        return None
    try:
        payload = json.loads(raw)
    except ValueError as error:
        _log.warning("capability pack handle is not valid JSON: %s", error)
        return None
    if not isinstance(payload, dict):
        _log.warning("capability pack handle must be a JSON object")
        return None
    try:
        entrypoint = str(payload["entrypoint"])
        capabilities = tuple(sorted(str(item) for item in payload["capabilities"]))
        handle = PackHandle(
            pack_id=str(payload["packId"]),
            version=str(payload["version"]),
            release_digest=str(payload["releaseDigest"]),
            entrypoint=entrypoint,
            capabilities=capabilities,
            root=str(payload["root"]) if payload.get("root") else None,
            cache=str(payload["cache"]) if payload.get("cache") else None,
            timeout_seconds=float(payload.get("timeoutSeconds", DEFAULT_TIMEOUT_SECONDS)),
        )
    except (KeyError, TypeError, ValueError) as error:
        _log.warning("capability pack handle is missing a required field: %s", error)
        return None
    if not Path(handle.entrypoint).is_file():
        _log.warning("capability pack entrypoint does not exist: %s", handle.entrypoint)
        return None
    missing = [capability for capability in require if not handle.provides(capability)]
    if missing:
        _log.warning("capability pack %s does not provide %s", handle.pack_id, ", ".join(missing))
        return None
    return handle


#: Launch one worker process. Injected so every branch here is testable with a scripted
#: process and no pack installed.
class PackProcess(Protocol):
    """What ``run_pack_request`` actually needs from a launched worker.

    A structural type rather than ``subprocess.Popen[str]``: the runner uses exactly three
    members, and demanding the concrete class made every scripted test double illegal —
    which is a statement about `Popen`, not about the contract. Naming the real contract
    lets a fake satisfy it honestly instead of being cast past the type checker.
    """

    returncode: int | None

    def communicate(
        self, input: str | None = ..., timeout: float | None = ...
    ) -> tuple[str, str]: ...

    def kill(self) -> None: ...


Launcher = Callable[[PackHandle], PackProcess]


def default_launcher(handle: PackHandle) -> subprocess.Popen[str]:
    # The entrypoint is host-verified and passed as a list: no shell, no composed path.
    return subprocess.Popen(
        [handle.entrypoint, RUNTIME_FLAG],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=handle.environment(),
    )


def run_pack_request(
    handle: PackHandle,
    request: dict[str, Any],
    *,
    launch: Launcher = default_launcher,
) -> dict[str, Any]:
    """Run exactly one request and return its ``result`` message.

    Progress lines are read and dropped: the indexing slice reports progress at the asset
    level, and re-publishing a per-shot progress stream through it would give the host two
    disagreeing numbers.

    :param handle: The authorised pack.
    :param request: A protocol request object; ``protocolVersion`` is stamped here.
    :param launch: Process launcher, injected for tests.
    :returns: The result message.
    :raises PackWorkerError: On a typed worker failure, a protocol violation, a timeout, or
        a process that exited without a terminal message. Never returns a partial answer.
    """
    capability = str(request.get("capability", ""))
    if not handle.provides(capability):
        raise PackWorkerError(
            f"pack {handle.pack_id} does not provide {capability!r}.",
            code="invalid_request",
        )
    line = json.dumps({**request, "protocolVersion": PROTOCOL_VERSION}, separators=(",", ":"))
    if len(line.encode("utf-8")) + 1 > MAX_LINE_BYTES:
        raise PackWorkerError("request line exceeded its 1 MiB bound.", code="invalid_request")
    process = launch(handle)
    try:
        stdout, stderr = process.communicate(f"{line}\n", timeout=handle.timeout_seconds)
    except subprocess.TimeoutExpired as error:
        process.kill()
        process.communicate()
        raise PackWorkerError(
            f"pack {handle.pack_id} did not answer within {handle.timeout_seconds:.0f}s.",
            retryable=True,
        ) from error
    terminal: dict[str, Any] | None = None
    for raw in stdout.splitlines():
        if not raw.strip():
            continue
        try:
            message = json.loads(raw)
        except ValueError as error:
            raise PackWorkerError(f"pack emitted a line that is not JSON: {error}") from error
        if not isinstance(message, dict):
            raise PackWorkerError("pack emitted a line that is not an object.")
        kind = message.get("type")
        if kind in {"progress", "handshake"}:
            continue
        if kind == "failure":
            raise PackWorkerError(
                str(message.get("detail") or message.get("code") or "pack failed"),
                code=str(message.get("code", "internal_error")),
                retryable=bool(message.get("retryable", False)),
            )
        if kind != "result":
            raise PackWorkerError(f"pack emitted an unexpected message type {kind!r}.")
        if terminal is not None:
            # One request, one terminal message. A second means the worker is confused
            # about which request it is answering, and trusting either would be a guess.
            raise PackWorkerError("pack emitted more than one terminal message.")
        terminal = message
    if terminal is None:
        detail = (stderr or "").strip()[:500]
        raise PackWorkerError(
            f"pack {handle.pack_id} exited {process.returncode} without a result"
            + (f": {detail}" if detail else ".")
        )
    if terminal.get("requestId") != request.get("requestId"):
        raise PackWorkerError("pack answered a different request id.")
    if terminal.get("capability") != capability:
        raise PackWorkerError("pack answered a different capability.")
    if terminal.get("protocolVersion") != PROTOCOL_VERSION:
        raise PackWorkerError("pack answered with a different protocol version.")
    return terminal
