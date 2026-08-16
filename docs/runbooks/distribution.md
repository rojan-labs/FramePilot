# Distribution runbook — update feed, pack catalog, rollback

How a built FramePilot actually reaches a paying user, and what to do when that
goes wrong. The [release runbook](./release.md) covers versioning and changelog;
this covers the two things users depend on after they have bought the app: the
**desktop update feed** and the **Capability Pack catalog**.

Both are trust surfaces. A user's installed app believes what these say, so a
mistake here is not a bad release — it is a bad release that cannot be fixed by
shipping a better one, because the client is stuck on whatever the broken
artifact told it.

---

## 1. The two channels, and why they are separate

| | Update feed | Pack catalog |
| --- | --- | --- |
| Serves | Desktop installers + `latest*.yml` | Signed pack releases + artifacts |
| Trusted via | HTTPS + electron-updater's sha512 | HTTPS + **Ed25519 catalog signature** |
| Client reads | The `generic` URL baked into `electron-builder.yml` | `FRAMEPILOT_CAPABILITY_PACK_CATALOG_URL` |
| Outage impact | No updates; installed app unaffected | No new pack installs; installed packs unaffected |

Neither can disable an app that is already working. That is deliberate: a
catalog outage must never turn into an editor outage.

**The repository is private, so GitHub Releases cannot be the client feed** — a
shipped app cannot carry a token to read private release assets. The draft
GitHub Release is for humans reviewing a build; the static host is what clients
actually poll.

---

## 2. Feed host setup (once)

Any S3-compatible bucket behind an HTTPS hostname works — Cloudflare R2, AWS S3
+ CloudFront, DigitalOcean Spaces, Backblaze B2.

1. Create the bucket and make it **publicly readable** (objects only; never list).
2. Point `updates.framepilot.ai` at it via CDN. This hostname is baked into
   `apps/desktop/electron-builder.yml` and shipped inside every installer, so
   **changing it later strands every client already installed.** Decide once.
3. Serve `/desktop/` as the key prefix, matching `DIST_PREFIX`.
4. Set the repository secrets listed at the top of `.github/workflows/release.yml`:
   `DIST_BUCKET`, `DIST_ENDPOINT`, `DIST_PREFIX`, `AWS_ACCESS_KEY_ID`,
   `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION`.

Cache headers are set by the publish step and matter: installers are immutable
for a year, `latest*.yml` for 60 seconds. A long-cached feed is how "we shipped
the fix" becomes "nobody got the fix for a day".

### Verifying before you publish

```bash
pnpm release:check-feed --dir apps/desktop/release --version 1.2.3
pnpm release:check-installer --dir apps/desktop/release
```

The first refuses a feed naming a missing file, a wrong hash, a wrong size, or a
version that is not the one being released. The second refuses an installer
carrying a Capability Pack payload (ONNX weights, OpenCV, a pack worker) — the
ADR 0114 line, checked mechanically because a leak is otherwise silent.

Both run in CI on every build, including manual ones.

> **How the payload check earns its keep.** The engine is a PyInstaller bundle,
> and PyInstaller absorbs whatever is importable in the environment it builds
> in — not only what is declared. A developer who installs a pack's `cv` extra
> into the engine venv and then builds locally gets an installer with OpenCV
> inside `Resources/engine/_internal/cv2/`, with no error and no lockfile
> change. The first run of this check found exactly that in a stale local build.
> CI builds from the lock and is clean; local builds are the risk.

---

## 3. Catalog root key ceremony (once, and rarely again)

The root key is the trust anchor for every pack a user will ever install.

```bash
pnpm --filter @framepilot/capability-packs exec node dist/node/release-cli.js \
  generate-root-key framepilot.root.2026 \
  /Volumes/OFFLINE/framepilot-root-2026.pem \
  apps/desktop/build/capability-pack-root-keys.json
```

Rules, in order of how badly breaking them ends:

1. **The private key never touches CI, this repository, or a shared password
   manager.** Generate it on a machine that is offline, keep it on removable
   media or an HSM. A root that has been in a CI log is burned.
2. **It is never printed.** The command writes it `0600` and refuses to
   overwrite an existing file, because silently replacing a root invalidates
   every catalog already signed and every installed pack's trust chain.
3. The **public** half goes to `apps/desktop/build/capability-pack-root-keys.json`,
   which is git-ignored and packaged into the build by glob. A build without it
   ships with no trust and **every pack proposal fails closed** — safe, but the
   app can install no packs at all. That is the correct failure direction, and
   it is also why a production build must have this file.
4. Day-to-day signing should use a **delegated key** authorized by a root-signed
   catalog (`delegatedKeys`, time-bounded). The root then only signs delegations,
   a handful of times a year.

### Rotation

Publish a root-signed catalog that lists the new delegated key and drops the old
one. `FileCapabilityPackCatalogTrust` accepts delegations only from a root,
refuses a delegate that tries to delegate further, and rejects a delegate that
shadows a root id. Rotation is therefore a normal catalog publish, not a client
update.

---

## 4. Publishing a release

1. Tag `v1.2.3` and let `.github/workflows/release.yml` build all four targets.
2. CI runs the installer-payload check and the feed check on each target.
3. Artifacts land on a **draft** GitHub Release for human review.
4. Smoke-test per [`../guides/release-checklist-v1.md`](../guides/release-checklist-v1.md).
5. The publish step uploads installers first and `latest*.yml` last, so the feed
   never points at a file that is still uploading. Do not reorder this.
6. Publish the GitHub Release for the humans.

---

## 5. Rollback

### Desktop update feed

Auto-update has no "undo": clients that already updated have the new build. So
rollback is **roll forward to a known-good build with a higher version**.

1. Re-tag the last good tree as a new patch version (`1.2.4` reverting to
   `1.2.2`'s content). Never re-publish `1.2.2`'s feed — clients on `1.2.3` will
   not downgrade, and a lower version in the feed silently strands them.
2. Publish normally. Because installers are immutable and content-addressed by
   name, nothing already downloaded is affected.

### Pack catalog

Packs have a real rollback path, because the catalog is a statement rather than
a push:

```bash
framepilot-pack rollback <signed-catalog.json> <rollback.json> <key.pem> <key-id> <out.json>
```

This re-signs a catalog restricted to a set of `releaseDigests`. Semantics that
matter:

- a delisted pack **remains usable** by projects that already have it — the
  catalog can revoke future acquisition, never mutate local bytes;
- pack updates are side-by-side and reversible while any project or rollback
  lease pins the old version;
- a security revocation is explicit and signed, disables execution, preserves
  project data, and reports affected projects.

---

## 6. Incidents

| Symptom | Likely cause | Action |
| --- | --- | --- |
| Clients report update failures | Feed names a file that failed to upload | Re-run publish; `pnpm release:check-feed` locally against the release dir |
| "Update available" loops | `latest*.yml` cached too long, or version mismatch | Check CDN cache headers on the feed object only |
| Packs stop installing, app fine | Catalog expired, or delegated key expired | Publish a fresh root-signed catalog |
| `catalog_invalid` / `signature_invalid` | Catalog signed by an untrusted key | Confirm the build's packaged root keys match the signing key |
| A pack must be pulled | Bad weights, licence issue, security | `rollback` to the last good digests; installed copies keep working |
| Installer suddenly much larger | Pack payload leaked into the base app | `pnpm release:check-installer` names the file; fix the import or resource entry |

Corrupt trust state on a client is quarantined and fails closed rather than
resetting the chain — a user in that state cannot install packs, but their
projects, editing and rendering are untouched.

---

## 7. Preconditions this runbook assumes

These are **not** yet satisfied and block a production release:

- **Code signing.** macOS pack artifacts require an Apple Team Identifier and
  Windows artifacts an Authenticode certificate digest — both are required
  fields in `CapabilityPackArtifactSchema`. Without them **no pack can be
  published or installed at all**, and on macOS an unsigned app is blocked by
  Gatekeeper and cannot auto-update.
- **A feed hostname and bucket**, per §2.
- **A root key**, per §3.
- **A Freemius product id**, or the app runs unlicensed (`license-service.ts`
  treats an unconfigured product as unlocked).
