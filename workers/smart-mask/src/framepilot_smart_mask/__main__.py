"""Signed entrypoint for the Smart Mask Capability Pack worker.

Three modes, all driven by the host:

``--framepilot-health-check``
    Print exactly one handshake JSON object and exit 0, or exit non-zero with a stderr
    reason. Proves every pinned model file hashes to its approved digest and the bundled
    ffmpeg is an approved (LGPL-only) build.

``--framepilot-worker-runtime``
    Speak the JSON-line protocol on stdin/stdout for exactly one request.

``--framepilot-worker-warm``
    Serve ``subject.segment_frame`` requests until stdin closes (BR3.13).

stdout carries protocol lines only; logs go to stderr through ``logging``.
"""

from __future__ import annotations

import json
import logging
import os
import signal
import sys
from collections.abc import Sequence
from types import FrameType

from .identity import HealthCheckError, HealthFacts, build_handshake
from .runtime import CancellationFlag, WorkerServices, run_warm_worker, run_worker
from .sandbox import configure_determinism, disable_network

HEALTH_CHECK_FLAG = "--framepilot-health-check"
RUNTIME_FLAG = "--framepilot-worker-runtime"
WARM_FLAG = "--framepilot-worker-warm"
ENV_LOG_LEVEL = "FRAMEPILOT_SMART_MASK_LOG_LEVEL"


def create_services() -> WorkerServices:
    """Import the pipeline lazily so a protocol refusal never needs numpy or onnxruntime."""
    from .services import create_services as build

    return build()


def probe_health() -> HealthFacts:
    from .services import probe_health as probe

    return probe()


def _configure_logging() -> None:
    level = os.environ.get(ENV_LOG_LEVEL, "WARNING").upper()
    logging.basicConfig(
        stream=sys.stderr,
        level=getattr(logging, level, logging.WARNING),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


def main(argv: Sequence[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    _configure_logging()
    disable_network()
    configure_determinism()
    if arguments == [HEALTH_CHECK_FLAG]:
        return _health_check()
    if arguments == [RUNTIME_FLAG]:
        return _runtime(warm=False)
    if arguments == [WARM_FLAG]:
        return _runtime(warm=True)
    sys.stderr.write(
        "framepilot-smart-mask requires exactly one of "
        f"{HEALTH_CHECK_FLAG}, {RUNTIME_FLAG} or {WARM_FLAG}.\n"
    )
    return 2


def _health_check() -> int:
    try:
        handshake = build_handshake(probe_health)
    except HealthCheckError as error:
        sys.stderr.write(f"Smart Mask health check failed: {error}\n")
        return 1
    except Exception as error:
        sys.stderr.write(f"Smart Mask health check failed: {type(error).__name__}: {error}\n")
        return 1
    sys.stdout.write(json.dumps(handshake, separators=(",", ":"), sort_keys=True))
    sys.stdout.flush()
    return 0


def _runtime(*, warm: bool) -> int:
    if warm:
        return run_warm_worker(sys.stdin, sys.stdout, create_services)
    cancellation = CancellationFlag()

    def on_signal(_number: int, _frame: FrameType | None) -> None:
        cancellation.cancel()

    for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        handled = getattr(signal, name, None)
        if handled is not None:
            signal.signal(handled, on_signal)
    return run_worker(sys.stdin, sys.stdout, create_services, cancellation)


if __name__ == "__main__":  # pragma: no cover - process entrypoint
    raise SystemExit(main())
