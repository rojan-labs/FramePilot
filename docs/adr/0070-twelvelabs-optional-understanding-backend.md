# ADR 0070 — TwelveLabs as an optional media-understanding backend

- **Status:** accepted (2026-07-20)
- **Plan:** `plan/MEDIA-INTELLIGENCE.md` (visual index / search), extends MI2–MI5
- **Relates to:** [ADR 0066](./0066-nvidia-cloud-visual-embeddings.md)
  (built-in NVIDIA visual embeddings), [ADR 0067](./0067-plaintext-key-storage-multi-key-failover.md)
  (plaintext key storage), [ADR 0058](./0058-project-brain-derived-sqlite-substrate.md)
  (brain substrate, honest degradation)
- **Packages:** `engine/python/framepilot_engine/brain/` (`twelvelabs.py`,
  `twelvelabs_index.py`), `engine/python/framepilot_engine/service.py`,
  `packages/ai-sdk` (`visual-index-client.ts`, `sidecar-executor.ts`),
  `packages/shared-types` (`ipc.ts`), `apps/desktop`, `apps/web-editor`

## Context

FramePilot ships a **built-in visual-understanding pipeline** (ADR 0066): adaptive
frame sampling → NVIDIA visual embeddings → local `sqlite-vec` vector store →
reciprocal-rank fusion of visual + caption + transcript hits into
`EvidencePacket`s, all behind the sidecar's `/brain/visual/*` routes. Audio
understanding comes from local `whisper.cpp` ASR feeding the word-level transcript
that drives captions/FTS.

That pipeline understands *frames* well but has no first-class model of a video's
**audio and speech content together with its visuals**. [TwelveLabs](https://www.twelvelabs.io/)
offers exactly that: a single hosted index (the Marengo model) that understands
visual + audio + speech jointly and answers text/image queries with ranked clips.
Users who have a TwelveLabs account should be able to opt into it for stronger
"find the moment where X is shown/said" recall — without us rebuilding the search
contract or regressing the built-in path for everyone else.

## Decision

**Add TwelveLabs as an alternate backend behind the *same* `/brain/visual/*`
routes, selected by the presence of a `TWELVELABS_API_KEY`.** When a key resolves
(request body, host config slot, or engine env), the routes delegate
index/search/status to TwelveLabs; when it does not, the built-in NVIDIA-embed
pipeline runs unchanged.

Key points:

- **One branch point per route.** Each route resolves
  `resolve_twelvelabs(req.twelve_labs_key or settings.twelvelabs_api_key)` and,
  if a client comes back, takes the TwelveLabs arm; otherwise the existing arm.
  `resolve_twelvelabs` mirrors `resolve_visual_embedder` (client-or-typed-reason),
  so every existing test path is untouched when no key is set.
- **Backend swap, not an interface change.** TwelveLabs search clips
  (`video_id`, `start`, `end`, `transcription`) are mapped straight onto the
  `EvidencePacket` contract, reusing `project_span_to_timeline` /
  `transcript_overlap`. The ai-sdk client, the orchestrator, and the UI are
  unchanged; `backend` is reported as `"twelvelabs"`.
- **Rank, not score.** Marengo 3.0's `/search` returns each clip's `rank`
  (1 = best) with **no** numeric `score`. The packet `score` is derived as
  `1/rank` so the orchestrator gets the same "higher = more relevant" signal the
  built-in RRF lane provides; the response is sorted best-first defensively.
  Search queries the **visual + audio + transcription** modalities (matching the
  TwelveLabs dashboard), while index creation uses only the valid `visual` +
  `audio` model options — `transcription` is a search-time modality over the
  indexed audio, not an index option, so the two option sets are kept distinct
  (`DEFAULT_SEARCH_OPTIONS` vs `DEFAULT_INDEX_OPTIONS`).
- **Migration-free storage.** The project's TwelveLabs `index_id` is a
  provenance-guarded `fields` row; each asset's `video_id` is an
  `analysis_results` row (`kind="tl:video"`). No schema change, no migration.
- **Whisper keeps captions.** TwelveLabs powers *search relevance* (visual +
  audio + transcription); the word-level transcript that drives captions/FTS
  stays local whisper, so caption timing never regresses. TwelveLabs indexes
  audio itself, so per-scene VLM captions are skipped on this backend (reported
  in `captionsReason`).
- **`describe_footage` is honestly unsupported** on this backend: TwelveLabs'
  remote index is organised for search, not a deterministic scene walk, so the
  route returns `available: true` with a typed reason rather than a fabricated or
  empty enumeration. Use visual search instead.
- **Host-owned key, never logged** (ADR 0067 pattern): the key rides in the
  `/brain/visual/*` request body (or falls back to the engine env). It is a
  visible-plaintext Settings slot alongside the NVIDIA embeddings key, forwarded
  from both the desktop config and the web-editor.

## Consequences

- **Honest degradation preserved.** No key → built-in pipeline. A TwelveLabs
  auth failure reports `invalid_api_key`; a transport failure degrades to
  `available: false`; an unindexed project reports `not_indexed`. Never a
  fabricated result.
- **Privacy boundary is the same shape as ADR 0066** — footage leaves the machine
  to a third party — now to TwelveLabs. The Settings hint states this explicitly.
- **No new dependency**: the client is a thin `httpx` REST wrapper (`httpx` is
  already an engine dependency).
- **Indexing is paced, not blocking.** Uploads are async on TwelveLabs' side; the
  route polls one asset's task within a bounded slice budget and re-posts (the
  existing paced-slice loop), so no request blocks for minutes.
- **Search from the orchestrator relies on the engine env key** (the executor has
  no per-call key channel for search — the same limitation the built-in NVIDIA
  search already has). Desktop sets the sidecar env from its config slot.

## Alternatives considered

- **Swap only the embedder** (call TwelveLabs' embedding endpoint to fill the
  local vector store). Rejected: it ignores TwelveLabs' audio/speech understanding
  — its main value — and its async, segment-based embeddings fit the local
  frame-vector store awkwardly.
- **A separate parallel search surface.** Rejected: it would fork the orchestrator
  tools and UI; keeping the route contract identical is simpler and safer.
