"""FramePilot Tracking Lite Capability Pack worker.

An isolated, signed, on-demand worker that answers exactly three capabilities —
``tracking.point``, ``tracking.region`` and ``tracking.planar`` — over the
versioned JSON-line protocol defined in
``packages/capability-packs/src/worker-protocol.ts``.

The worker has no project-write authority, no network access and no knowledge of
the timeline. It returns measurements; the host converts them into typed,
validated, reversible timeline operations.
"""

PACK_ID = "framepilot.tracking-lite"
PACK_VERSION = "1.0.0"
#: The constant, actual capability roster. Health mode refuses any installer
#: identity whose signed roster differs from this tuple.
PACK_CAPABILITIES: tuple[str, ...] = ("tracking.planar", "tracking.point", "tracking.region")

__all__ = ["PACK_CAPABILITIES", "PACK_ID", "PACK_VERSION"]
