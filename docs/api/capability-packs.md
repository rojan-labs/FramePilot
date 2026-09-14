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
over-expansion entries and writes every file with no-overwrite semantics. Every file is written
`0644` whatever mode bits the archive claims. After a verified macOS extraction the host marks
exactly the signed entrypoint plus the artifact's optional signed `executables` list `0755`. That
list must be a duplicate-free subset of `files`, and it is the only way a bundled interpreter or
helper binary stays runnable. Failure or cancellation removes the whole staging directory. The production ZIP reader and its transitive helper add about
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
file allowlist plus a deterministic file-level SBOM. For a macOS artifact it also derives
`executables` from the staged payload's real execute bits, and it refuses an entrypoint that is not
executable. The catalog `schemaVersion` stays `1` because the field is optional and additive. A host
older than the field drops it while parsing, so the release digest no longer matches and the install
fails closed. No signed catalog had been published when the field was added. The command applies the same artifact schema as
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

## Release pipeline (build → sign → record)

What runs where:

| Where                                                       | Trigger                                             | What it proves or produces                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capability-pack-<pack>.yml` (all four packs)               | PR / push touching the worker                       | Unit suite, ruff, mypy with no ML stack and no weights; weights are not committed; the base engine does not import the worker. **All four packs** now also run an SBOM/license drift check (`tools/generate_sbom.py --check`) on every PR — the `cv` extra (onnxruntime/tokenizers/OpenCV, tens of MiB) is installed, but no pinned weight is ever downloaded for it, because the check is a metadata comparison against `pack/models.lock.toml`, not a hash of the installed weight file. Tracking Lite and Subject Intelligence additionally run their decoded-media proof on every PR (their weights are small enough to fetch there too). |
| `capability-pack-visual-embed.yml` / `-visual-describe.yml` | `workflow_dispatch` only                            | Weight tier: fetch and verify every pin (cached by `actions/cache`, keyed on `pack/models.lock.toml`'s digest, so an unchanged pin never re-downloads), Visual Embed's decoded-media proof, Visual Describe's standalone payload build. Dispatch-only because ~1.5–2.5 GiB of weights per run is an infrastructure-cost decision. |
| `capability-pack-release.yml`                               | tag `capability-pack/<pack>/v<version>` or dispatch | Per pack, per platform: darwin-arm64 on `macos-14` (`build-capability-pack.sh`), win32-x64 on `windows-latest` (`build-capability-pack.ps1`) — each `--stage payload` → codesign/signtool → `--stage finalize` → (notarize, darwin only) → `prepare-artifact`. A `release-record` job then combines whichever platforms actually built into ONE cross-platform release record per pack (`release-core` → `prepare-release`). Finally one `catalog` job: unsigned `catalog.json` → `sign-catalog` → `publication-plan` → merge into the live catalog → upload to the CDN → move `latest`. |

`scripts/build-capability-pack.sh` (darwin) and `scripts/build-capability-pack.ps1` (win32) each
build a payload that is standalone by proof. Darwin vendors the interpreter **and the standard
library** and removes `pyvenv.cfg`; win32 vendors the interpreter directory (`python.exe`, its DLL,
`DLLs\`, `Lib\`) beside the venv for the same reason. Both move the payload and run it with a
scrubbed environment, then check that every import root lies inside the moved payload before
running the worker's own health handshake from there.

The darwin entrypoint `bin/<entrypoint>` is a native launcher compiled from
`scripts/pack-launcher/launcher.c` with the system `cc`, not uv's `#!/bin/sh` wrapper. It resolves
its own real path and execs the sibling `bin/python` as `-P -c "from <module> import <function>;
sys.exit(<function>())"`. The target comes from the wrapper it replaces. It forwards every argument
and keeps the environment unchanged. `-P` stops the launch directory from shadowing worker modules.
It exists because macOS keeps a script's code signature in extended attributes, and the host's ZIP
install drops them. A Mach-O embeds its signature, so it survives. The release job signs every other
Mach-O file first and the launcher last, then verifies it. The win32 entrypoint `Scripts\<entrypoint>.exe`
needs no such replacement: uv's Windows console-script launcher is already a real PE binary (a
distlib stub with the script data appended), and an Authenticode signature lives in the PE's own
certificate table, so it survives a ZIP round-trip with no help — `signtool` signs it directly. Both
scripts refuse:

- a payload that references the repository or uv's managed CPython/Python install
- a payload that contains a symbolic link, which the installer rejects
- a payload that exceeds the manifest's `max_unpacked_mib`

Each ships only the files `pack/models.lock.toml` pins. The archive is a ZIP, the only multi-file
format the installer accepts. `scripts/capability_pack_release.py` assembles the
`prepare-artifact`, `prepare-release` and catalog inputs from the manifest, models lock, SBOM and
build receipt, deriving the entrypoint's in-archive path (`bin/` on darwin, `Scripts/` on win32) and
executable-trust kind (`macos_codesign` with a Team ID, `windows_authenticode` with a certificate
SHA-256 thumbprint) from the artifact's own `os`. It refuses a pack without an SBOM record rather
than hand-typing a license set — which is why **every** pack now needs one (see below).

Which secret enables which step. Every credentialed step is skipped with a visible workflow
warning when its secret is absent, and nothing is recorded as signed, merged, or uploaded that was
not:

| Step                                                           | Requires                                                                                                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS Developer ID codesign of every Mach-O file + the entrypoint | `MAC_CERT_P12`, `MAC_CERT_PASSWORD`, `CSC_NAME`                                                                                                             |
| macOS notarization (`notarytool submit --wait`)                  | a signed payload plus `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`                                                                            |
| Real `executableTrust.teamIdentifier` in the darwin record        | `APPLE_TEAM_ID` (otherwise `UNSIGNED00`, and that platform can never enter a signed catalog)                                                                |
| Windows Authenticode signing (`signtool sign`)                    | `WIN_CSC_LINK` (base64 `.pfx`), `WIN_CSC_KEY_PASSWORD` — **wired but unproven, see the checklist below**                                                    |
| Real `executableTrust.certificateSha256` in the win32 record      | a successful `signtool` sign (otherwise `UNSIGNED00`)                                                                                                       |
| `sign-catalog` + `publication-plan`                               | `CAPABILITY_PACK_CATALOG_SIGNING_KEY` (PEM secret), variable `CAPABILITY_PACK_CATALOG_KEY_ID`, and **every** platform of every release in the run signed to its own bar (darwin: codesigned **and** notarized; win32: codesigned) |
| Publishable artifact URLs                                        | variable `CAPABILITY_PACK_ARTIFACT_BASE_URL` (otherwise `https://capability-packs.invalid/unpublished`)                                                     |
| `minAppVersion` on tag runs                                       | variable `CAPABILITY_PACK_MIN_APP_VERSION` (dispatch asks for it)                                                                                           |
| Merging into the live catalog                                    | variable `CAPABILITY_PACK_CATALOG_URL` (otherwise the merge treats "nothing published yet" and starts from an empty catalog — safe, but only really correct on the very first release) |
| Uploading artifacts + the catalog to the CDN, and moving `latest` | `CAPABILITY_PACK_CDN_ACCESS_KEY_ID`, `CAPABILITY_PACK_CDN_SECRET_ACCESS_KEY`, variable `CAPABILITY_PACK_CDN_BUCKET` (S3-compatible: AWS S3, Cloudflare R2, Backblaze B2, MinIO, … all work); `CAPABILITY_PACK_CDN_ENDPOINT` for a non-AWS endpoint; `CAPABILITY_PACK_CATALOG_LATEST_KEY` to move the live pointer (otherwise the digest-addressed catalog is uploaded but `latest` stays where it was) |

### SBOMs — all four packs now generate one

`tools/generate_sbom.py` exists for all four workers (Tracking Lite, Subject Intelligence, Visual
Embed, Visual Describe), sharing one mechanism: read installed distribution metadata + `uv.lock` +
(where the pack ships weights) `pack/models.lock.toml`; verify the compiled model pins agree with
the lock file and that every model carries a licence a commercial desktop product may redistribute
(MIT/Apache-2.0/BSD-3-Clause — `--check` fails otherwise, which is how the AGPL-3.0 YOLO default was
kept out of Subject Intelligence and stays enforced for the two newer packs); verify the OpenCV
wheel's own `LICENSE-3RD-PARTY.txt` still names every bundled native (FFmpeg and friends); and write
`pack/sbom/<platform>.cdx.json` + `LICENSES.md`. Visual Embed's and Visual Describe's generators also
record a `licenseVerified` flag per weight (from `pack/models.lock.toml`) so the hand-reviewed
caveat about the SigLIP 2 ONNX export's unverified upstream licence — and the GGUF quantisation/mmproj
licences — survives as generated content instead of being lost when the record stops being hand-typed.

Only a `darwin-arm64.cdx.json` is committed for each pack today. **No `win32-x64.cdx.json` exists
for any of the four packs yet**, which means `capability_pack_release.py`'s `pack_licenses()` will
refuse a win32 artifact at `prepare-artifact` until one is generated — on a real Windows machine
(or a `windows-latest` CI run) with the `cv` extra installed, the same way the darwin ones were
produced. This is the one concrete blocker between "the Windows job is wired" and "the Windows job
produces a signed artifact" (see the checklist below).

### Windows — wired, not yet proven

`build-windows-x64` in `capability-pack-release.yml` runs `scripts/build-capability-pack.ps1` on
`windows-latest`: relocatable venv, vendor the interpreter directory, strip non-entrypoint console
scripts, fetch pinned weights (cached), `signtool`-sign when `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`
are configured, re-verify, zip, `prepare-artifact`. It has `continue-on-error: true`, and
`release-record` only includes a platform whose build actually produced an `artifact.json` — so a
Windows failure today degrades to a visible warning and a darwin-only release, never a broken
pipeline.

**This was authored, reviewed, and YAML/PowerShell-syntax-checked in a session with no Windows
machine available, and has never executed.** Concretely still open:

- No `win32-x64.cdx.json` SBOM exists yet (see above) — the very first Windows CI run will fail at
  `prepare-artifact` until one is generated and committed.
- Whether `uv venv --relocatable`'s Windows layout, and vendoring `python.exe` + its DLL + `DLLs\` +
  `Lib\` from the interpreter directory named in `pyvenv.cfg`'s `home`, actually produces a payload
  that imports cleanly once moved and run under a scrubbed environment (the `Invoke-HealthCheck`
  function's job) is unconfirmed.
- Whether `signtool` signing `Scripts\python.exe` and the entrypoint `.exe` (no native-launcher
  replacement needed — see above) actually satisfies the host's future Windows executable-trust
  check is unconfirmed; the host-side Windows trust check itself is unimplemented (`packages/capability-packs`
  currently verifies `macos_codesign` identities; a `windows_authenticode` verifier is a separate,
  not-yet-written piece of work outside this release pipeline).
- The first real `windows-latest` run is the actual proof. Until then, treat every claim in
  `build-capability-pack.ps1`'s header comment as "should," not "does."

### CDN publish and catalog merge — automated, gated, unit-tested

The `catalog` job now does everything the release pipeline used to leave to a person, each gated on
its own secret (table above):

1. **Merge**, via `scripts/capability_pack_catalog_merge.py` — a small, dependency-free module with
   its own pytest suite (`capability_pack_catalog_merge_test.py`, 10 cases): fetch whatever is
   currently live at `CAPABILITY_PACK_CATALOG_URL` (a missing or unreachable URL reads as "nothing
   published yet," not an error), replace this run's exact `(packId, version)` entries, and leave
   every other pack/version in the live catalog untouched. Covered explicitly: adding a genuinely
   new pack version, replacing the very same version (e.g. a re-signed digest), and preserving
   every entry the run did not touch — plus deterministic ordering regardless of input order, and
   accepting either a bare catalog or a `{catalog, signature}` envelope as "current."
2. **Re-sign** the merged catalog with the same `CAPABILITY_PACK_CATALOG_SIGNING_KEY`, and re-run
   `publication-plan` on the merged result (the per-run `catalog.json`'s own digest is not what gets
   published — the merged one is).
3. **Upload**: match each `publication-plan.json` artifact to a downloaded build by its own SHA-256
   (never by filename or path, so two platforms of the same pack can never be confused), `aws s3 cp`
   it to its immutable object key; upload the merged signed catalog to its own digest-addressed key;
   and, only when `CAPABILITY_PACK_CATALOG_LATEST_KEY` is configured, overwrite that one stable
   object — this is what "moving `latest`" means in practice, a plain overwrite of a well-known
   object, not a separate pointer-file indirection.

None of steps 1–3 has run against a real CDN in this session — no credentials exist to run them
with — so the first real run with `CAPABILITY_PACK_CDN_*` configured is still the proof that the
S3-compatible API calls, the object-key layout `publication-plan` produces, and whatever CDN/bucket
policy fronts it all agree with each other.

### Size caps — decided 2026-09-14: raised

Visual Embed's cap went from 1200 to 2000 MiB and Visual Describe's from 2600 to 3000 MiB, so both
measured payloads fit with roughly 10–12% headroom and an unexpected growth still fails the build.
The alternatives were not taken: an fp16 or int8 SigLIP 2 text tower (about 540–800 MiB smaller, but
new pins and backend support) and moving the 500M low-memory pair (606.8 MiB) into a separate
optional pack.

Measured 2026-09-14 on darwin-arm64. Health check passes from the relocated payload in all three
builds. Sizes are the sum of file bytes, which is what `prepare-artifact` records:

| Pack            | Before     | After    | Cap  | Weights (unchanged)                                 | Largest non-weight parts                |
| --------------- | ---------- | -------- | ---- | --------------------------------------------------- | --------------------------------------- |
| Tracking Lite   | —          | 178 MiB  | 400  | 0                                                   | OpenCV                                  |
| Visual Embed    | 1812.0 MiB | 1781 MiB | 2000 | 1501.6 MiB (SigLIP 2 fp32 text tower alone: 1077.1) | OpenCV 139, onnxruntime 76, Python 27   |
| Visual Describe | 2750.5 MiB | 2709 MiB | 3000 | 2499.8 MiB (2.2B pair 1893.0, 500M pair 606.8)      | OpenCV 137, llama runtime 31, Python 27 |

Visual Describe's llama.cpp dylibs still ship under both their versioned and unversioned names, a
15.5 MiB duplicate forced by the no-symlink artifact rule unless `models.py` pins the unversioned
names instead.

Install-time execute bits and a zip-surviving signature were two blockers for any real catalog
install. Both are fixed with the signed `executables` list and the native launcher (see above).
Proven on 2026-09-14 with an ad-hoc-signed Tracking Lite ZIP installed through the real extractor:
`codesign --verify --strict` passes on the extracted entrypoint, `bin/python` is executable, and the
host health check handshakes. The same install without `executables` fails with `Permission denied`.

Vendored interpreter licenses: the release tool adds `PSF-2.0` for the vendored CPython. The
natives python-build-standalone links into it (OpenSSL, libffi, SQLite, xz, zlib, bzip2, mpdecimal,
ncurses) are not yet enumerated by any SBOM.

### What is left — a credential and a first signed run, nothing else

Everything above this line is code, wired and (Windows and CDN publish aside) verified locally.
What remains is provisioning real credentials and watching the first real signed run confirm what
only a signed, notarized, Gatekeeper-checked artifact can confirm:

- [ ] **Apple Developer ID application certificate** — `MAC_CERT_P12` (base64-encoded `.p12`),
      `MAC_CERT_PASSWORD`, `CSC_NAME` (the certificate's common name, e.g.
      `Developer ID Application: Your Name (TEAMID1234)`).
- [ ] **Apple notarization credentials** — `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` (an
      app-specific password for that Apple ID, not the account password), `APPLE_TEAM_ID` (the
      10-character Team ID).
- [ ] **Authenticode code-signing certificate** — `WIN_CSC_LINK` (base64-encoded `.pfx`),
      `WIN_CSC_KEY_PASSWORD`. Needs a first `windows-latest` run to prove `build-capability-pack.ps1`
      and the `signtool` step actually work (see "Windows — wired, not yet proven" above); a
      win32-x64 SBOM must also exist first (see "SBOMs" above).
- [ ] **Capability-pack catalog signing key** — an Ed25519 private key as
      `CAPABILITY_PACK_CATALOG_SIGNING_KEY` (PEM), plus the repository variables
      `CAPABILITY_PACK_CATALOG_KEY_ID` and `CAPABILITY_PACK_MIN_APP_VERSION`. The
      application's embedded root public key(s) must delegate to this key before any installed app
      will trust a catalog it signs (see "Catalog trust and key rotation" above).
- [ ] **CDN credentials and layout** — `CAPABILITY_PACK_CDN_ACCESS_KEY_ID`,
      `CAPABILITY_PACK_CDN_SECRET_ACCESS_KEY`, and the repository variables
      `CAPABILITY_PACK_CDN_BUCKET`, `CAPABILITY_PACK_CDN_ENDPOINT` (omit for AWS S3 itself),
      `CAPABILITY_PACK_ARTIFACT_BASE_URL` (the public read URL artifacts resolve under),
      `CAPABILITY_PACK_CATALOG_URL` (the public read URL the live catalog resolves at — must match
      what a packaged app's `FRAMEPILOT_CAPABILITY_PACK_CATALOG_URL` is configured to fetch), and
      `CAPABILITY_PACK_CATALOG_LATEST_KEY` (the object key `CAPABILITY_PACK_CATALOG_URL` serves).
- [ ] **A first real signed run**, after all of the above exist: tag or dispatch
      `capability-pack-release.yml` for one pack (Tracking Lite is the smallest and cheapest) and
      confirm, on a real Mac: `codesign --verify --strict` and `spctl --assess` both pass on the
      installed entrypoint, notarization succeeds (`notarytool submit --wait` exits 0 and the ticket
      staples), and the installed pack's worker handshakes through the real (not ad-hoc) signature.
      Confirm on a real Windows machine, once the Windows leg is proven: the signed `.exe` launches
      without a SmartScreen/Defender block strong enough to fail the install, and the worker
      handshakes there too. Whether the interpreter's extension modules need hardened-runtime
      entitlements on macOS (`--options runtime` is already passed; whether that alone suffices for
      every bundled `.so`/`.dylib` is unproven without a real Developer ID run) is part of this
      first-run confirmation, not a separate task.

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
