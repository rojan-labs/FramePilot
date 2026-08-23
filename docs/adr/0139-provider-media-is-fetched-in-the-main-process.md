# ADR 0139 — Provider media is fetched in the main process

**Status:** accepted
**Date:** 2026-08-23
**Implements:** `plan/3rd-party-sourcing` Phases 2–3
**Related:** ADR 0138 (asset provenance), ADR 0114 (capability packs — deliberately not reused)

## Context

Music search is FramePilot's first outward reach for media. Something has to hold
the network connection to a third-party provider, and there were three candidates:
the renderer, the Python sidecar, or the Electron main process.

The renderer is ruled out by its own security policy. `buildCsp`
(`apps/desktop/electron/security/media-protocol.ts`) sets
`connect-src 'self' fp-media: <engineBaseUrl>`. Adding a provider origin there
would be a real widening of what the renderer can talk to, in the process that
runs the most untrusted content in the app.

The sidecar is ruled out by ownership. It is the render engine; it has no reason
to hold a provider connection, and routing user-facing search through it would
mean the query, the credentials and the download all cross an extra boundary for
no gain.

## Decision

**Main fetches. The renderer is never handed a provider URL.**

Search returns tracks stripped of `previewUrl` and `downloadUrl`
(`ProviderTrackWire`). The renderer addresses a track by `remoteId` and asks main
to act on it. Audition bytes come back over IPC and the renderer wraps them in a
`blob:` URL — which `media-src fp-media: blob: data:` already permits.

Three consequences follow, and they are the reason the shape is worth writing down:

**No CSP change was required, and none should ever be proposed.** A pull request
adding a provider origin to `connect-src` means the fetch has moved into the
renderer, which means the slice is wrong. A test asserts the exact `connect-src`
contents (`media-protocol.test.ts`).

**The guarantee is structural, not a convention.** It does not depend on anyone
remembering the rule: there is no provider host in the renderer to reach, because
the type that crosses the bridge does not carry one. A leak would be a type error
before it was a security bug.

**Downloads land in the existing sandbox.** `mediaRelativeDir` + `safeFileName` +
`dedupeName` are shared with `media-import.ts`, so a downloaded file sits exactly
where an imported one does and `fp-media://` and the render engine resolve it with
no change. **The path sandbox was not broadened.**

## Why not Capability Packs

ADR 0114's packs already do signed, resumable, atomic downloads with progress, and
reusing them was the obvious move. It is the wrong one.

A pack is an **immutable, FramePilot-controlled ML runtime**, identified by a
signed release digest, shared across every project on the machine, and verified
against a root key we hold. A music track is **mutable, third-party, licensed,
per-project media** with a crediting obligation attached and no signature we could
verify against anything.

They share a _mechanism_ — stream bytes, show progress, rename atomically — and
nothing else. So Phase 3 copies the **shape** of `capability-packs/service.ts`
(operation ids, `AbortController` cancellation, temp-then-rename) into a separate
`music-download` path, and reuses none of its identity, verification or storage.

## No API key, and why the plan's key field was not built

The plan specified a write-only `musicApiKey`, a `FRAMEPILOT_MUSIC_API_KEY` env
fallback, a Settings field, and a "no key configured" panel state.

**None of that was built, deliberately.** Openverse — the provider that actually
ships — serves anonymous requests, and its _optional_ authentication is an OAuth2
client-credentials exchange, not a bearer key. Shipping a key field would have
meant a Settings control that does nothing, an env var nothing reads, and a
first-run panel state that tells the user to add a key in order to search when
search already works.

What replaces it: the in-main search cache (5 min TTL, 50 entries), which is what
keeps a typing user inside the anonymous budget of 20 requests/minute.

**What would reverse this:** users hitting rate limits in practice, or Epidemic
Sound landing. Epidemic's model is bring-your-own-subscription, which is an OAuth
flow rather than a key field anyway — so the key custody design should be made
against that provider's real contract, not guessed at now. The custody _pattern_ is
already settled if it is needed: write-only and main-owned, following the chat-key
precedent, **not** the renderer-readable `twelveLabs`/`asrApiKey` one (those are
readable only because the renderer forwards them to the sidecar, which is not the
case here).

## Consequences

- **Browser degrades by absence.** The Sounds tab is filtered out of the left rail
  rather than opening a panel that explains it cannot work.
- **The main process owns a cache.** Search results (5 min, 50 entries) and preview
  bytes (~20 MB LRU) live in main, following the footage-map precedent: serve the
  cache first, stay independent of the remote index.
- **`sources.json` is a download ledger, not a provenance record.** It answers "have
  I already got this?" without loading the project. The project file remains the
  single source of truth for what must be credited (ADR 0138).
- **Agent tools are host tools.** `search_music` and `add_music` execute through
  `hostMusicSearch`/`hostAddMusic`, mirroring `hostTranscribe`. The sidecar is not
  involved and holds no credential. Absent overrides fail honestly rather than
  fabricating results.
