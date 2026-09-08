"""Process-level self-restriction.

Identical in intent to Subject Intelligence's, and load-bearing for the same reason: this
pack computes embeddings of people's faces. It must not be able to open a socket, so any
attempt fails loudly instead of quietly exfiltrating a customer's media or a vector
derived from it. The privacy statement ADR 0175 narrows to — *frames leave the machine
only on a hosted arm, only with a key* — is enforced here, not merely asserted.
"""

from __future__ import annotations

import os
import random
import socket
from typing import Any, Final, NoReturn

#: Fixed seed for every stochastic step, so the same media and request always produce
#: byte-identical output.
DETERMINISTIC_SEED: Final = 20260907


class NetworkDisabledError(RuntimeError):
    """A local Capability Pack worker attempted network access."""


def _refuse(*_args: Any, **_kwargs: Any) -> NoReturn:
    raise NetworkDisabledError(
        "Visual Embed runs with networking disabled; media never leaves the machine."
    )


def disable_network() -> None:
    """Make socket creation raise for the rest of this process."""
    for attribute in ("socket", "create_connection", "create_server"):
        if hasattr(socket, attribute):
            setattr(socket, attribute, _refuse)


def configure_determinism() -> None:
    """Pin thread counts and RNG state before any inference.

    Thread limits go through the environment as well as any runtime API because the
    underlying math libraries (and onnxruntime's own pools) read them at import time.
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
