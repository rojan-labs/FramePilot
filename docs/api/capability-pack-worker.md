# Capability Pack worker protocol

Heavy tracking and subject-intelligence dependencies are not imported into FramePilot's bundled
render engine. They run in signed, immutable Capability Pack workers installed on demand. The base
application therefore stays small, while a project can pin the exact worker and model digests that
produced its analysis.

## Transport and trust

The protocol is versioned JSON Lines over an isolated process boundary. Installation first runs the
worker in health-check mode and requires one handshake whose pack id, semantic version, release
digest, protocol version, capabilities, hardware backend, and model digests exactly match the signed
catalog. Because a catalog release digest is computed only after the artifact hash exists, the
trusted installer passes that approved identity and capability roster into health-check mode; the
already signature-verified worker echoes them and independently reports backend/model digests. This
avoids an impossible circular “embed the digest before hashing the artifact” build. Runtime messages
are capped at 1 MiB per line.

The desktop host resolves and sandbox-checks project media before invocation. A request contains a
read-only absolute media handle, bounded source/frame range, fps, project revision, capability id,
and typed parameters. Workers receive no project-file write authority, arbitrary command arguments,
or unrelated provider secrets. Network access is disabled for local packs.

## Requests

Protocol v1 supports:

| Capability        | Input                                              |
| ----------------- | -------------------------------------------------- |
| `tracking.point`  | One normalized point                               |
| `tracking.region` | One normalized in-frame box                        |
| `tracking.planar` | Four normalized plane corners                      |
| `subject.detect`  | Bounded face/person/object labels and result count |
| `subject.segment` | Exactly one normalized point or region prompt      |

Every request carries a stable request id and authoritative project revision. Source and frame ranges
must be positive. Normalized geometry must remain fully inside the frame; pixel-shaped or escaped
coordinates fail schema validation before a worker starts.

## Progress and results

Progress identifies the decode/initialize/track/detect/segment/encode phase and a bounded completed /
total count. It can never report more completed work than its declared total.

Tracking results contain frame-indexed normalized boxes, confidence, and explicit occlusion. Detection
results contain frame, label, box, and confidence. Segmentation results contain bounded COCO-style
row-major binary-mask run lengths plus dimensions and confidence. All results record the backend and
exact model digests. A worker cannot return more than 18,000 temporal samples in one request.

Terminal failures are typed as cancelled, unreadable media, lost target, missing model, unsupported
hardware, invalid request, or internal failure, with an explicit retryability decision. Missing or
low-confidence output is never converted into a plausible track.

The Node runtime client resolves both the approved media root and media file through `realpath`
before launch, so `..` and symlink escapes fail before worker execution. It starts the signed
entrypoint without a shell and with a minimal environment that excludes provider keys, validates
every output line, requires request id/revision/capability identity, bounds stderr, and enforces
cancellation and a hard timeout. Observer failures cannot change the worker transaction.

## Tracking Lite: the first real worker

`workers/tracking-lite/` implements `tracking.point`, `tracking.region`, and `tracking.planar` as a
separately packaged Python artifact. It is deliberately not a workspace member, not a dependency of
the base render engine, and not importable by Electron: the base installer carries the catalog,
verifier, installer, and launcher, never the CV payload.

Point tracking uses pyramidal Lucas–Kanade flow with confidence derived from patch matching error
and a forward–backward round-trip check. Region tracking uses CSRT, but confidence comes from a
measured appearance similarity against the initialization template rather than from the tracker's
boolean status. Planar tracking fits a RANSAC homography from the initial feature positions to their
current positions — so the plane stays anchored to the requested quad instead of accumulating
frame-to-frame drift — with confidence from the inlier ratio and residual flow error. Protocol v1
carries axis-aligned boxes, so a planar result reports the projected quad's bounding box.

Occlusion and loss are reported honestly. A real measurement is always emitted where it was measured
and flagged `occluded` below the confidence threshold. A frame with no measurement holds the last
known box with zero confidence — frozen, never extrapolated — and holding is bounded to 15
consecutive frames, after which the request fails as `target_lost` naming the last measured frame.
The worker does not smooth: smoothing, gap policy, and correction limits stay with the host, where
they are versioned and invertible alongside the timeline operation.

Determinism comes from one OpenCV thread, disabled OpenCL, a fixed RNG seed, pinned thread-count
environment variables, sorted feature ordering, and ascending frame order in every result. The worker
also disables its own networking at startup and holds no project-write authority.

Its protocol, policy, and tracker layers have no third-party dependency, so the unit suite runs
against an injectable scripted backend without installing OpenCV. Real decoded-media pixel proof
requires the `cv` extra and belongs to the separate pack build job.

## Subject Intelligence: the first worker that ships weights

`workers/subject-intelligence/` implements `subject.detect` and `subject.segment` as a second
standalone artifact project on the same isolation terms.

Faces come from **YuNet** (MIT), people and objects from **YOLOX-S** (Apache-2.0), and segmentation
from **PPHumanSeg** (Apache-2.0). The mainstream default — YOLOv8/YOLO11 through Ultralytics — was
rejected because it is **AGPL-3.0**, whose network-copyleft terms are wrong for a shipped desktop
product; `tools/generate_sbom.py --check` now fails if any pinned weight carries a non-permissive
licence, so that decision is enforced rather than remembered. All three run on OpenCV's `dnn`
module, so the pack introduces no second ML runtime, and the weights total ~42 MiB.

Weights are the part of a pack that is *data*, and data is the easiest thing to swap unnoticed. So
they are never committed: `pack/models.lock.toml` pins each file to an immutable upstream commit and
a sha256, `tools/fetch_models.py` verifies on download and refuses a mismatch, and the worker
re-hashes every file before loading it. Those digests are reported in the handshake and in every
result, which is how an edit's lineage can name the exact model that produced it. Pre- and
post-processing follows each model's own reference implementation rather than a reconstruction —
YOLOX decodes grid offsets with `exp`-scaled sizes against a letterbox ratio, PPHumanSeg expects
`(x/255 - 0.5) / 0.5` on RGB — because getting either subtly wrong yields confident boxes in the
wrong place.

The honesty rules match Tracking Lite's. Detections below the confidence floor are dropped and
finding nothing returns nothing; there is no fallback centre-frame box. A point prompt is resolved
against a real person detection — the smallest detected person containing the point — and nobody
there is `target_lost`, because a guessed rectangle would produce a confident mask of the wrong
thing. An empty or near-empty mask is `target_lost` rather than an all-zero "mask". Detections are
emitted in a stable total order (frame, label, descending confidence, position), and masks as
row-major run lengths beginning with the zero run.

PPHumanSeg is trained for portrait and half-body subjects, so it runs **inside** the caller's prompt
region rather than over the whole frame: measured on the pinned proof photograph, whole-frame
segmentation reads 1.25% foreground against 47% on the prompted subject.

Real-inference proof is a separate tier requiring the `cv` extra and the fetched weights. It runs the
models over a pinned photograph and requires the detectors to find the people and faces genuinely in
it, every detected person to contain a detected face, and a deliberately mis-registered copy of the
same data to fail that check.

The canonical schemas live in `packages/capability-packs/src/worker-protocol.ts`; the process client
lives in `packages/capability-packs/src/node/worker-client.ts`. Platform builds, exact locks,
licenses/SBOM, desktop invocation, smoothing/occlusion consumers, and pixel-negative controls are
tracked in C4 of `plan/PROFESSIONAL-EDITOR-P0-P3-CLOSURE.md`.

## Desktop development loop: running a worker without a catalog

The production install path starts at a signed HTTPS catalog, which does not exist yet. To run
Tracking Lite on a dev machine, register a locally built payload directly into the pack store:

```bash
FRAMEPILOT_DEV_PACK_REGISTRATION=1 pnpm --filter @framepilot/capability-packs release:pack -- \
  register-local input.json "$HOME/Library/Application Support/FramePilot/capability-packs" record.json
```

`input.json` carries `{packId, version, payloadRoot, entrypoint, capabilities, licenses, os, arch}`:

```json
{
  "packId": "framepilot.tracking-lite",
  "version": "1.0.0-dev.local",
  "payloadRoot": "/absolute/path/to/built/pack",
  "entrypoint": "bin/framepilot-tracking-lite",
  "capabilities": ["tracking.point", "tracking.region", "tracking.planar"],
  "licenses": ["Apache-2.0"],
  "os": "darwin",
  "arch": "arm64"
}
```

What registration does and does not trust:

- **Gated**: without `FRAMEPILOT_DEV_PACK_REGISTRATION=1` it refuses (`LocalRegistrationDisabledError`),
  so a packaged build or CI can never take this path by accident.
- **Health-checked**: the staged worker must pass the same isolated health check a signed install
  runs — handshake identity (id/version/release digest), protocol version, capability roster
  equality, backend probe — before anything is recorded. A failed check leaves the store empty.
- **Content-digested**: `artifactDigest` is a sha256 over the sorted payload tree (symlinks
  preserved), `releaseDigest` derives from id/version/capabilities, so identical bytes replace
  their record cleanly while changed bytes land under a distinct identity instead of shadowing a
  stale healthy one.
- **Not signed**: the acquisition receipt's `catalogDigest` names itself as a dev registration;
  nothing here touches keys or catalogs. Rebuilding with the same `version` leaves the previous
  record behind — bump the prerelease (or clear the store root) to avoid two healthy candidates.

Once registered, the agent can use the pack through the `track_subject_automatically` tool: it
resolves one selected clip via `resolveAutomaticTrackingObjective`, builds the exact pack request
(the mask supplies all geometry), runs the isolated worker through the desktop tracking authority
(leases + typed failures + install proposals), and the orchestrator compiles the validated samples
into the same reversible `track_object` patch as manual tracking, recording `${packId}@${version}`
as provenance. A missing pack fails honestly with `pack_missing`; an unusable track is reported as
refused, never smoothed into a plausible edit.

> The storage root above is the default for macOS; `capability-pack-location.json` next to it may
> point at a relocated root (Settings › Storage).
