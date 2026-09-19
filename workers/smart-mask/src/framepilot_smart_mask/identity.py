"""Health-check identity verification.

Same contract as Subject Intelligence and Visual Embed: the trusted installer — which has
already verified the signed catalog, the artifact hash and the platform code signature —
passes the approved identity and capability roster in the environment, and the worker echoes
it only after checking everything it can know itself, including that every pinned model
file hashes to its approved digest and that the bundled ffmpeg is an approved build.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from . import PACK_CAPABILITIES, PACK_ID, PACK_VERSION
from .backend import BackendUnavailableError, ModelUnavailableError, ToolUnavailableError
from .protocol import IDENTIFIER_PATTERN, SEMVER_PATTERN, SHA256_PATTERN, handshake_message

ENV_PACK_ID = "FRAMEPILOT_CAPABILITY_PACK_ID"
ENV_PACK_VERSION = "FRAMEPILOT_CAPABILITY_PACK_VERSION"
ENV_RELEASE_DIGEST = "FRAMEPILOT_CAPABILITY_PACK_RELEASE_DIGEST"
ENV_CAPABILITIES = "FRAMEPILOT_CAPABILITY_PACK_CAPABILITIES"


class HealthCheckError(Exception):
    """The installer-provided identity does not describe this worker, or it cannot run."""


@dataclass(frozen=True, slots=True)
class InstallerIdentity:
    pack_id: str
    version: str
    release_digest: str
    capabilities: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class HealthFacts:
    """What the worker proved about itself: backend label and verified model digests."""

    backend_label: str
    model_digests: dict[str, str]


def read_installer_identity(environment: Mapping[str, str] | None = None) -> InstallerIdentity:
    env: Mapping[str, str] = os.environ if environment is None else environment
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
        isinstance(item, str) for item in capabilities
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
    probe_health: Callable[[], HealthFacts],
    environment: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Verify identity, then the models and tools, then emit the handshake."""
    identity = read_installer_identity(environment)
    try:
        facts = probe_health()
    except BackendUnavailableError as error:
        raise HealthCheckError(f"inference runtime is unavailable: {error}") from error
    except ModelUnavailableError as error:
        raise HealthCheckError(f"pinned model verification failed: {error}") from error
    except ToolUnavailableError as error:
        raise HealthCheckError(f"media tool verification failed: {error}") from error
    return handshake_message(
        pack_id=identity.pack_id,
        version=identity.version,
        release_digest=identity.release_digest,
        capabilities=identity.capabilities,
        hardware_backend=facts.backend_label,
        model_digests=facts.model_digests,
    )
