# Capability Packs

Capability Packs are FramePilot's on-demand distribution boundary for heavyweight professional
runtimes and models. The base application continues to own project authority, deterministic render,
validation, and orchestration. Packs provide bounded analysis capabilities and never mutate a
project file directly.

ADR 0114 defines the decision. The executable project-pin schema ships in
`@framepilot/timeline-schema`. `@framepilot/capability-packs` owns the host-neutral catalog,
artifact, signature, install lifecycle, storage index, pin/lease, error, and worker-handshake
contracts. The Electron main process owns install, storage, relocation, and cleanup authority. The
remaining capability-triggered approval and project dependency workflows are tracked in
`plan/PROFESSIONAL-EDITOR-P0-P3-CLOSURE.md` and must not be advertised as complete until their gates
pass.

The Node host surface now includes `FileCapabilityPackStore`. It serializes mutations, validates
and atomically replaces `index.json`, quarantines a malformed index, resets process-owned leases
after a crash, and enforces project-pin and active-lease guards before two-phase removal. It stores
only paths relative to its configured root and rejects an index containing traversal. Disk
accounting and safe removal build on this authority rather than scanning arbitrary folders.

`CapabilityPackDownloader` is the acquisition authority for signed platform artifacts. A request is
accepted only when its explicit approval, immutable install identity, platform, signed size, and
artifact digest agree. Downloads are content-addressed, refuse insufficient disk space before
network access, share one in-flight operation per identity, retain safe partial bytes on
cancellation, and verify both exact length and SHA-256 before promotion to a complete artifact.
Resume is deliberately conservative: it sends `Range` plus `If-Range` only for a stored strong ETag
and appends only after the server returns the same ETag and matching `Content-Range`; otherwise it
deletes the partial and starts clean.

Verified artifacts extract only into a fresh disposable staging directory. Raw artifacts must be
the one signed entrypoint. ZIP extraction accepts exactly the signed file allowlist; it rejects
absolute, traversal, backslash, duplicate, extra, missing, symbolic-link, over-count, over-size, and
over-expansion entries and writes every file with no-overwrite semantics. Failure or cancellation
removes the whole staging directory. The production ZIP reader and its transitive helper add about
140 KiB unpacked in the development installation and pass the dependency license gate; models and
worker binaries remain outside the base app.

The signed platform artifact also carries its executable trust identity: a ten-character Apple
Developer Team ID on macOS or the SHA-256 of the Authenticode signer certificate on Windows. The
host runs fixed, shell-free OS verification commands and requires the exact signer; macOS also must
pass Gatekeeper. Only then may the entrypoint run in health-only mode. Its single bounded JSON
handshake must exactly match pack ID, version, release digest, protocol version, and the signed
capability set. Extra capabilities fail closed just like missing ones. Atomic commit, quarantine,
crash recovery, and cross-process locking complete the host-neutral install transaction.

`CapabilityPackInstaller` revalidates identity, release, platform artifact, approved size, exact
license set, and privacy consent before touching the network. It serializes an immutable artifact
across processes, refreshes the shared atomic index under its own filesystem lock, and performs the
full download → extract → executable trust → worker health sequence. A healthy staging directory
receives a validated recovery receipt, moves atomically into its side-by-side version path, and only
then enters the index. Trust or health failures move to quarantine; cancellation removes staging;
stale disposable staging has a bounded cleanup API. If the process dies between directory and index
commit, the next explicitly approved request reads the receipt, reruns executable and worker checks,
and repairs the index without downloading again. It never promotes an orphan from receipt alone.

The host must instantiate one storage authority for worker leases; Electron's single-instance main
process is that authority. Separate installer instances still coordinate artifact and index writes,
so an updater or duplicate launch cannot overwrite another committed version.

## Catalog trust and key rotation

The application embeds offline Ed25519 root public keys; private roots never ship. A root-signed
catalog may authorize a time-bounded online signing key. `FileCapabilityPackCatalogTrust` persists
only delegations that were accepted from a root, refuses a delegated signer that attempts further
delegation, and lets a newer root catalog replace or revoke the delegated set. It also records the
last catalog generation time and canonical digest, rejecting older catalogs, conflicting catalogs
at the same time, implausibly future-dated catalogs, expired delegates, and a delegate that shadows
a root ID. Corrupt trust state is quarantined and fails closed instead of resetting the chain.

Catalog expiry affects discovery/install only. Already installed, pinned, healthy packs continue to
work from their immutable local identity; an online outage never silently swaps or disables them.

## Storage accounting and eviction

`CapabilityPackStorageManager` reports exact installed, quarantined, pending-removal, reclaimable,
and per-project byte totals from the authoritative index. Removal impact always includes affected
project IDs and live lease count. Cleanup is proposal-driven: it offers quarantined packs first,
then least-recently-used unpinned and unleased versions until the requested space is covered. It
does not delete while planning. Execution requires the exact displayed identity list and the store
rechecks pins and leases immediately before each two-phase removal. A stale or edited approval fails
instead of broadening deletion.

Custom storage uses a native main-process folder picker; the renderer never supplies a path. The
destination must be absent or empty and separate from the current root. With installs and worker
leases stopped, the host streams every non-transient file into a sibling staging directory, rejects
unexpected links, validates the copied index and identities, and atomically promotes the copy. Only
then does Electron atomically replace its durable root pointer and swap the live storage service.
Cancellation or failure leaves the old root authoritative. A successful move deliberately retains
the previous copy and shows its exact location for manual recovery; FramePilot never silently
deletes it.

## Desktop authority

The Electron preload exposes only validated data operations. The renderer can request a capability
ID; it cannot supply a catalog URL, release manifest, artifact URL, checksum, install path, command,
or trusted key. Main fetches the configured HTTPS catalog, verifies the durable root/delegation
chain, selects the exact host artifact, and returns a short-lived proposal containing the facts the
user must see. Installation accepts only that proposal ID plus an exact approval of identity, size,
license set, and media-egress fact. It returns a main-owned operation ID; progress is pushed and
cancellation only aborts that operation.

Settings → Storage reads main's authoritative index and provides real totals, pack health,
project/lease blockers, install progress, cleanup planning, and an explicit “Remove exactly these
packs” confirmation. The browser build states that native packs require desktop and never attempts
a download. Renderer observer failure does not affect install authority.

Production builds load public root keys from a bounded packaged JSON resource; development may set
`FRAMEPILOT_CAPABILITY_PACK_ROOT_KEYS_PATH`. The catalog endpoint is main-only
`FRAMEPILOT_CAPABILITY_PACK_CATALOG_URL`. With either absent, proposal calls fail closed while local
installed-pack accounting remains available.

Opening a desktop project now reconciles every logical pin against the exact installed release
identity. The reconciliation is one storage-index transaction: it removes stale pins for that
project, pins matching healthy or unhealthy records, and returns typed ready/missing/unhealthy plus
render/edit blocking facts. Save and patch commits repeat the reconciliation, so removing a project
dependency releases its old storage pin. Matching requires ID, version, and cross-platform release
digest; an installed pack with only the same ID is not substituted.

A missing dependency opens an explicit modal gate. “Review download” rereads the active project in
main, resolves only its exact immutable release from the signed catalog, and shows size, installed
size, licenses, platform, privacy, and media-egress facts. A separate approval starts the existing
cancellable installer. The installed event is withheld until the project pin is durable. “Open
degraded” never installs or substitutes anything, and a render-required missing pack continues to
refuse export. Verified adoption of an existing local store, catalog-declared cloud alternatives,
and automatic interception of capability invocations remain C1 work; the UI does not pretend those
choices exist without an executable provider.

## Local Whisper migration

Packaged desktop builds resolve `asr.whisper.local` to `framepilot.local-whisper`; Settings no longer
calls Python's direct model-download endpoint when the desktop pack authority exists. It first shows
the signed proposal and requires exact approval, then uses the common downloader, verifier,
extraction, executable-trust, health, commit, progress, cancellation, and cleanup machinery. The
base sidecar bundle discovers only ffprobe; it never opportunistically adopts a colocated
`whisper-cli`.

After a healthy local-Whisper install, Electron resolves `bin/whisper-cli` and `models/` strictly
inside the immutable installed directory and injects those two paths into the Python sidecar. The
sidecar restarts only after installation authority has committed. Startup resolves the same paths
before launching, and a custom-root move refreshes them before leaving the relocated store active.
The existing Python setup route remains a source-development compatibility tool, not the packaged
desktop distribution path. Publishing the signed macOS arm64 and Windows x64 pack artifacts remains
part of the C1 release-tooling gate.

## Release publication and rollback

`@framepilot/capability-packs` builds the `framepilot-pack` offline operator command. It never builds
workers or downloads dependencies itself; it turns an already staged, platform-signed payload into
facts that can be reviewed and published:

```text
pnpm --filter @framepilot/capability-packs release:pack -- prepare-artifact input.json artifact.json
pnpm --filter @framepilot/capability-packs release:pack -- prepare-release release-core.json release.json
pnpm --filter @framepilot/capability-packs release:pack -- sign-catalog catalog.json release-key.pem key-id signed.json
pnpm --filter @framepilot/capability-packs release:pack -- publication-plan signed.json plan.json
pnpm --filter @framepilot/capability-packs release:pack -- rollback signed.json rollback.json release-key.pem key-id rolled-back.json
```

`prepare-artifact` inventories regular files only, rejects links and unapproved license identifiers,
requires the declared entrypoint, hashes the archive and each unpacked file, and emits the signed
file allowlist plus a deterministic file-level SBOM. The command applies the same artifact schema as
the installer, including platform executable-trust identity and raw/ZIP constraints.
`prepare-release` validates the assembled cross-platform release and derives its canonical logical
release digest; the later signing step recomputes that digest independently.

`sign-catalog` reads an Ed25519 private key from a file, never a command argument, and refuses to
sign any release whose canonical digest is false. `publication-plan` hashes the exact signed
envelope and requires every artifact URL to contain its SHA-256, producing only immutable CDN object
keys. Publication uploads artifacts and the digest-addressed catalog before atomically changing a
small `latest` pointer outside this package.

Rollback never overwrites an artifact or old catalog. The operator supplies exact release digests;
the command removes them from a strictly newer catalog generation and signs a new immutable
envelope. Installed pinned releases remain on disk under the normal revocation policy. The command
writes outputs through a sibling temporary file and atomic rename, and reports no private-key
material. Platform worker builds, OS signing/notarization, CDN credentials, and the `latest` pointer
remain release-infrastructure responsibilities and are not implied by this host-neutral tool.

## Logical release pin

Schema v19 adds an optional `Project.capabilityPacks` array:

```json
{
  "id": "framepilot.subject-intelligence",
  "version": "1.2.0",
  "releaseDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "capabilities": ["tracking.face", "tracking.segmentation"],
  "requiredFor": "analysis"
}
```

- `id` is a stable reverse-domain-style pack identifier.
- `version` is the immutable semantic release version.
- `releaseDigest` is the SHA-256 of the canonical signed cross-platform release record.
- `capabilities` is the bounded subset this project consumed.
- `requiredFor` is `render`, `edit`, or `analysis`, describing the degraded-open consequence.

The pin deliberately contains no platform, architecture, local path, URL, or credential. The same
project must travel from macOS arm64 to Windows x64. The signed release record selects the correct
platform artifact and verifies its separate digest.

Pack IDs are unique within a project. Updating means replacing the logical pin through a validated,
reversible project operation after compatibility and output verification; two versions of one pack
cannot ambiguously claim authority inside one project.

## Trust and lifecycle contract

The target lifecycle is:

1. Verify the signed catalog/release record.
2. Show size, disk requirement, license, privacy, and hardware facts before approval.
3. Resume or start a deduplicated download into a partial file.
4. Verify size and SHA-256.
5. Extract into a sandboxed staging directory with traversal, symlink, file-count, and expansion
   limits.
6. Verify executable policy and run the versioned worker health check.
7. Atomically install the immutable directory and update the storage index.
8. Acquire a lease before execution and retain project pins until the dependency is removed.

Removal is also transactional: `requestRemoval` seals the record against new leases, the host
removes that exact committed directory, and `completeRemoval` deletes the index record. A pinned or
leased identity cannot enter this sequence. Leases are process lifetime claims rather than durable
locks; on restart the storage authority safely resets their counts because the crashed process can
no longer own a worker.

No capability invocation may silently start a download. Missing packs resolve to an explicit
install proposal, cloud alternative, or typed unavailable result.

## Worker authority

Pack workers receive only host-resolved sandboxed media handles, bounded ranges/parameters, project
revision, and cancellation identity. They return typed analysis evidence and provenance. They do
not receive project-write access, arbitrary command execution, or unrelated provider credentials.

Tracking and segmentation results are compiled into typed reversible project operations. The pack
that inferred a path is recorded as provenance, but ordinary project rendering consumes the baked
track/mask data rather than rerunning hidden inference.
