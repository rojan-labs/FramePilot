"""Process-level self-restriction.

Identical in intent to Visual Embed's, and load-bearing for the same reason: this pack
looks at every frame of a customer's footage and writes sentences about it. It must not be
able to open a socket, so any attempt fails loudly instead of quietly exfiltrating media or
a description derived from it. The privacy statement ADR 0175 narrows to — *frames leave
the machine only on a hosted arm, only with a key* — is enforced here, not merely asserted.
"""

from __future__ import annotations

import os
import random
import socket
from typing import Any, Final, NoReturn

#: Fixed seed for every stochastic step. The VLM itself is run at temperature 0 by
#: :mod:`framepilot_visual_describe.llama_backend`; this covers everything around it.
DETERMINISTIC_SEED: Final = 20260907


class NetworkDisabledError(RuntimeError):
    """A local Capability Pack worker attempted network access."""


def _refuse(*_args: Any, **_kwargs: Any) -> NoReturn:
    raise NetworkDisabledError(
        "Visual Describe runs with networking disabled; media never leaves the machine."
    )


def disable_network() -> None:
    """Make socket creation raise for the rest of this process."""
    for attribute in ("socket", "create_connection", "create_server"):
        if hasattr(socket, attribute):
            setattr(socket, attribute, _refuse)


def configure_determinism() -> None:
    """Pin thread counts and RNG state before any inference.

    Thread limits go through the environment because llama.cpp and OpenCV both read them
    at process start; the model's own thread count is set on its command line.
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
