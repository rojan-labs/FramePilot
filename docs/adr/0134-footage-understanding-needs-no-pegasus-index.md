# ADR 0134 — Footage understanding is read from the asset, not from a Pegasus index

**Status:** accepted
**Date:** 2026-08-21

## Context

Footage understanding showed nothing for freshly imported footage. The panel said the clip
"is not indexed yet" and pointed at a media-bin action that does not exist; Rebuild re-asked
for a map that could never appear; no progress was shown because nothing was running.

The engine was honest — the project genuinely had no visual index. The cause was one line
upstream: `create_index` asked TwelveLabs for **two** models, Marengo and `pegasus1.2`,
because `/analyze` used to require a Pegasus model on the index. TwelveLabs has since sunset
`pegasus1.2` for indexing, so `POST /indexes` answers HTTP 400 `parameter_invalid`. That is
the **first** call any project's first indexing slice makes, so the whole job died there
(`{"available": true, "reason": "TwelveLabs API error (HTTP 400) (parameter_invalid)."}`),
nothing was ever indexed, and every downstream surface — the map, `describe_footage`,
TwelveLabs transcription — correctly reported `not_indexed` forever.

Two further contract changes came with it: `pegasus1.5` **rejects `video_id`** and takes a
video context (`{"type": "asset_id", …}`) instead; and it sometimes mis-escapes the JSON
string it returns for a schema with more than one string field, then repeats the tail — which
a strict `json.loads` turns into an empty map.

## Decision

**An index carries Marengo only, and generative understanding reads the uploaded asset.**

- `create_index` requests `marengo3.0` (visual + audio) and nothing else. Search, embeddings
  and the indexed transcription are what an index is for.
- `/analyze` is called with `model_name="pegasus1.5"` and the **uploaded asset** we already
  POST to `/assets` during indexing. Generation needs no index at all.
- The uploaded asset id is persisted on each asset's mapping (`sourceAssetId` in the existing
  `tl:video` row — no schema change). It is a different id from the indexed `video_id` the
  search path uses, so both are kept.
- Mappings written before that recover the id once from
  `GET /indexes/{index}/indexed-assets/{video}` and store it, so footage indexed by an earlier
  version maps without a re-upload — re-uploading would be slow **and** billable.
- The structured body is decoded tolerantly (unescape, then read the valid object at the head)
  and, if that still fails, re-asked **once** with the schema described in the prompt. A
  provider formatting bug must not read as "this footage has no structure".

**And unread footage gets an action, not advice.** The `not_indexed` state now renders a
**Read this footage** button in the Footage understanding panel, which runs the same paced
preparation pass an import runs (`ensureMediaUnderstanding` — joinable, cancellable, honest)
and streams its progress into the panel. Rebuild does the same thing when there is nothing to
rebuild. Explicit, never automatic: on a hosted backend it spends the user's credits.

## Consequences

- Newly created indexes are Marengo-only. Existing Marengo+Pegasus indexes keep working
  unchanged — nothing needs recreating, and nothing needs re-uploading.
- `TwelveLabsIndexNotGenerativeError` (HTTP 400 `index_not_supported_for_generate`) can no
  longer be reached now that generation does not target an index. The type and its
  degrade-to-built-in path are kept: the cost is a few lines, and the failure it names is a
  provider-side classification we do not control.
- Every honest state is preserved. What changed is that the one state with work to do can now
  actually do it.

## Evidence

Live-API probes against the maintainer's account established each contract change
(index create rejected with the sunset message; `video_id` rejected for 1.5; `asset_id`
accepted; the mis-escaped structured body reproduced). Engine tests: the index-create
regression, the `/analyze` request shape, the mis-escape recovery, the single retry, and the
legacy `sourceAssetId` lookup; 2584 engine tests green, ruff + mypy clean. Panel tests cover
the read action end to end (unread → read → map) and each honest failure.
