"""Process-level self-restriction.

The host already launches the worker with a minimal environment, no shell and a
sandbox-checked media path. These guards are the worker's own half of that
contract: a local Capability Pack must not open a network socket, so any attempt
fails loudly instead of quietly exfiltrating a customer's media.

Determinism setup lives here too, because both are "configure the process before
any measurement happens" concerns.
"""

from __future__ import annotations

import os
import random
import socket
from typing import Any, Final, NoReturn

#: Fixed seed for every stochastic step (RANSAC included), so the same media and
#: request always produce byte-identical samples.
DETERMINISTIC_SEED: Final = 20260813


class NetworkDisabledError(RuntimeError):
    """A local Capability Pack worker attempted network access."""


def _refuse(*_args: Any, **_kwargs: Any) -> NoReturn:
    raise NetworkDisabledError(
        "Tracking Lite runs with networking disabled; media never leaves the machine."
    )


def disable_network() -> None:
    """Make socket creation raise for the rest of this process."""
    # `setattr` rather than direct assignment: these are module attributes being
    # replaced at runtime, which the type checker cannot express.
    for attribute in ("socket", "create_connection", "create_server"):
        if hasattr(socket, attribute):
            setattr(socket, attribute, _refuse)


def configure_determinism() -> None:
    """Pin thread counts and RNG state before any CV work.

    Thread limits are set through the environment as well as the OpenCV API
    because the underlying math libraries read them at import time.
    """
    for variable in (
        "OMP_NUM_THREADS",
        "OPENBLAS_NUM_THREADS",
        "MKL_NUM_THREADS",
        "NUMEXPR_NUM_THREADS",
        "OPENCV_FOR_THREADS_NUM",
    ):
        os.environ[variable] = "1"
    random.seed(DETERMINISTIC_SEED)
