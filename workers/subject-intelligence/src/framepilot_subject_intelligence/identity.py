"""Health-check identity verification.

Same contract as Tracking Lite: the trusted installer — which has already
verified the signed catalog, the artifact hash and the platform code signature —
passes the approved identity and capability roster in the environment, and the
worker echoes it only after checking everything it can independently know.

This pack adds one check the algorithmic packs cannot have: health mode verifies
every pinned model file against its compiled-in digest and reports those digests
in the handshake. A pack whose weights were swapped fails its health check
instead of quietly detecting with an unapproved model.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from . import PACK_CAPABILITIES, PACK_ID, PACK_VERSION
from .backend import BackendUnavailableError, ModelUnavailableError, SubjectBackend
from .protocol import (
    IDENTIFIER_PATTERN,
    SEMVER_PATTERN,
    SHA256_PATTERN,
    handshake_message,
)

ENV_PACK_ID = "FRAMEPILOT_CAPABILITY_PACK_ID"
ENV_PACK_VERSION = "FRAMEPILOT_CAPABILITY_PACK_VERSION"
ENV_RELEASE_DIGEST = "FRAMEPILOT_CAPABILITY_PACK_RELEASE_DIGEST"
ENV_CAPABILITIES = "FRAMEPILOT_CAPABILITY_PACK_CAPABILITIES"


class HealthCheckError(Exception):
    """The installer-provided identity does not describe this worker."""


@dataclass(frozen=True, slots=True)
class InstallerIdentity:
    pack_id: str
    version: str
    release_digest: str
    capabilities: tuple[str, ...]


def read_installer_identity(environment: dict[str, str] | None = None) -> InstallerIdentity:
    env: dict[str, str] = dict(os.environ) if environment is None else environment
    pack_id = env.get(ENV_PACK_ID, "")
    version = env.get(ENV_PACK_VERSION, "")
    release_digest = env.get(ENV_RELEASE_DIGEST, "")
    raw_capabilities = env.get(ENV_CAPABILITIES, "")
    if IDENTIFIER_PATTERN.match(pack_id) is None:
        raise HealthCheckError(f"{ENV_PACK_ID} is missing or malformed.")
    if SEMVER_PATTERN.match(version) is None:
        raise HealthCheckError(f"{ENV_PACK_VERSION} is missing or malformed.")
    if SHA256_PATTERN.match(release_digest) is None:
        raise HealthCheckError(f"{ENV_RELEASE_DIGEST} is missing or malformed.")
    try:
        capabilities = json.loads(raw_capabilities)
    except ValueError as error:
        raise HealthCheckError(f"{ENV_CAPABILITIES} is not valid JSON.") from error
    if not isinstance(capabilities, list) or not all(
        isinstance(capability, str) for capability in capabilities
    ):
        raise HealthCheckError(f"{ENV_CAPABILITIES} must be a JSON array of strings.")
    if pack_id != PACK_ID:
        raise HealthCheckError(f"approved pack id '{pack_id}' is not this worker ('{PACK_ID}').")
    if version != PACK_VERSION:
        raise HealthCheckError(
            f"approved version '{version}' does not match this worker ('{PACK_VERSION}')."
        )
    if tuple(sorted(capabilities)) != tuple(sorted(PACK_CAPABILITIES)):
        raise HealthCheckError(
            "approved capability roster does not exactly match this worker's roster "
            f"({', '.join(sorted(PACK_CAPABILITIES))})."
        )
    return InstallerIdentity(
        pack_id=pack_id,
        version=version,
        release_digest=release_digest,
        capabilities=tuple(sorted(capabilities)),
    )


def build_handshake(
    create_backend: Callable[[], SubjectBackend],
    environment: dict[str, str] | None = None,
) -> dict[str, Any]:
    identity = read_installer_identity(environment)
    try:
        backend = create_backend()
    except BackendUnavailableError as error:
        raise HealthCheckError(f"inference backend is unavailable: {error}") from error
    except ModelUnavailableError as error:
        raise HealthCheckError(f"pinned model verification failed: {error}") from error
    return handshake_message(
        pack_id=identity.pack_id,
        version=identity.version,
        release_digest=identity.release_digest,
        capabilities=identity.capabilities,
        hardware_backend=backend.name,
        model_digests=backend.model_digests,
    )
