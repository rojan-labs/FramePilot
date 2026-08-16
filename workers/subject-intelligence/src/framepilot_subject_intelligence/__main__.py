"""Signed entrypoint for the Subject Intelligence Capability Pack worker.

Two modes, both driven by the host:

``--framepilot-health-check``
    Print exactly one handshake JSON object and exit 0, or exit non-zero with a
    stderr reason. Run by the installer after signature verification. This pack's
    handshake also proves every pinned model file hashes to its approved digest.

``--framepilot-worker-runtime``
    Speak the JSON-line protocol on stdin/stdout for exactly one request.
"""

from __future__ import annotations

import json
import signal
import sys
from collections.abc import Sequence
from types import FrameType

from .backend import SubjectBackend
from .identity import HealthCheckError, build_handshake
from .runtime import CancellationFlag, run_worker
from .sandbox import configure_determinism, disable_network

HEALTH_CHECK_FLAG = "--framepilot-health-check"
RUNTIME_FLAG = "--framepilot-worker-runtime"


def create_backend() -> SubjectBackend:
    """Import the inference backend lazily so protocol failures never need OpenCV."""
    from .opencv_backend import OpenCvBackend

    return OpenCvBackend()


def main(argv: Sequence[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    disable_network()
    configure_determinism()
    if arguments == [HEALTH_CHECK_FLAG]:
        return _health_check()
    if arguments == [RUNTIME_FLAG]:
        return _runtime()
    sys.stderr.write(
        "framepilot-subject-intelligence requires exactly one of "
        f"{HEALTH_CHECK_FLAG} or {RUNTIME_FLAG}.\n"
    )
    return 2


def _health_check() -> int:
    try:
        handshake = build_handshake(create_backend)
    except HealthCheckError as error:
        sys.stderr.write(f"Subject Intelligence health check failed: {error}\n")
        return 1
    except Exception as error:
        sys.stderr.write(
            f"Subject Intelligence health check failed: {type(error).__name__}: {error}\n"
        )
        return 1
    sys.stdout.write(json.dumps(handshake, separators=(",", ":"), sort_keys=True))
    sys.stdout.flush()
    return 0


def _runtime() -> int:
    cancellation = CancellationFlag()

    def on_signal(_number: int, _frame: FrameType | None) -> None:
        cancellation.cancel()

    for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        handled = getattr(signal, name, None)
        if handled is not None:
            signal.signal(handled, on_signal)
    return run_worker(sys.stdin, sys.stdout, create_backend, cancellation)


if __name__ == "__main__":  # pragma: no cover - process entrypoint
    raise SystemExit(main())
