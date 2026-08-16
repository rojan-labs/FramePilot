# ADR 0114: Heavy professional capabilities ship as immutable on-demand packs

- Status: Accepted
- Date: 2026-08-13

## Context

FramePilot's frozen render engine is already about 129 MiB before the Electron runtime. Automatic
tracking, segmentation, local vision, speech, and future audio intelligence each add platform-native
runtimes and model weights ranging from hundreds of megabytes to several gigabytes. Bundling them
all would make first install and every application update pay for capabilities many editors never
use.

FramePilot already downloads Whisper model weights explicitly, with progress, cancellation,
streaming writes, SHA-256 verification, and atomic installation. That implementation proves the
user experience but is specific to one model and cannot install native workers, manage project
dependencies, or support safe eviction and rollback.

## Decision

FramePilot will use a general Capability Pack platform.

The base application contains the deterministic editor/render/validation stack and the pack
manager. Heavy ML runtimes, weights, and optional creative payloads are absent from the installer
and downloaded only after explicit approval. Apple Silicon macOS and Windows x64 are the first pack
targets.

Packs are immutable, identified by ID/version/platform/architecture/artifact digest, and installed
side by side. A signed catalog supplies platform artifacts, sizes, licenses, privacy facts,
compatibility, dependencies, SHA-256 digests, and versioned worker entrypoints. The application
embeds verification public keys; release signing keys remain offline.

Projects pin exact pack identities. Installed packs required by an active project cannot be
automatically evicted or silently upgraded. Opening a project with a missing pack offers explicit
download, locate, cloud alternative, or degraded-open choices. Analysis outputs such as tracking
paths are baked into typed reversible project operations so rendering does not secretly depend on
the original inference provider.

Heavy packs run as isolated workers behind a versioned bounded protocol. They receive sandboxed
media handles and cannot write project files or execute arbitrary commands. Download and install
are transactional: resumable partial download, checksum, sandboxed extraction, platform executable
verification, health check, atomic rename, and atomic index update.

Cloud implementations may satisfy the same capability contract only after explicit media-egress
consent. Core editing, reopen, and rendering remain local and offline-capable.

## Consequences

- First install and routine app updates remain bounded as professional capabilities expand.
- Pack release/signing/CDN infrastructure becomes a separate operational surface with its own
  rollback, SBOM, and license gates.
- Multiple pack versions may consume disk while projects pin them; Storage Manager must make pinned
  and reclaimable bytes visible.
- Old projects remain reproducible even when the catalog advances or delists a pack.
- Whisper's downloader will migrate onto the common platform after its behavioral contract is
  preserved by integration tests.
- Pack workers can fail independently without taking down the render engine or desktop main process.

## Rejected alternatives

- **Bundle every model/runtime:** simplest implementation, unacceptable installer/update growth.
- **Download latest on first use without pinning:** small installer, but old projects silently change
  and catalog removals break reproducibility.
- **Cloud-only intelligence:** avoids local storage but violates offline editing, privacy, and project
  reopen guarantees.
- **Import optional ML libraries into the frozen engine:** couples pack ABI to the render process and
  turns a tracker crash or dependency conflict into an editor/render failure.
