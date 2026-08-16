# ADR 0066 — Visual embeddings via NVIDIA's cloud API (frames leave the machine)

- **Status:** accepted (2026-07-18)
- **Plan:** `plan/MEDIA-INTELLIGENCE.md` (D1, D6, §3.2, MI2.1)
- **Relates to:** [ADR 0058](./0058-project-brain-derived-sqlite-substrate.md)
  (brain substrate, honest degradation), [ADR 0005](./0005-multi-provider-ai-anthropic-nvidia.md)
  (multi-provider AI), [ADR 0067](./0067-plaintext-key-storage-multi-key-failover.md)
  (key storage)
- **Packages:** `engine/python/framepilot_engine/brain/` (`visual_embed.py`)

## Context

Every other fact in the Project Brain is computed **locally** — ffmpeg probes,
silence/scene/beat/loudness analysis, whisper transcription, ONNX text embeddings.
Media Intelligence needs cross-modal image↔text embeddings so a text query ("the
product shot") can rank frames it has no words for. FramePilot bundles **no local
visual-embedding model** (an explicit non-goal for this plan; the `Embedder`-style
seam keeps a local ONNX backend possible later). The forces:

- We need a **cross-modal** encoder where image *passages* and text *queries*
  share a vector space — a plain image classifier won't do.
- Bundling and running a multi-billion-parameter VLM encoder locally is out of
  scope for a desktop app right now.
- Sending user footage to a third party is a **real privacy boundary** that must
  be explicit, consented, and honestly documented — not buried.

## Decision

**Compute visual embeddings by calling NVIDIA's hosted
`nvidia/llama-nemotron-embed-vl-1b-v2` model over HTTPS
(`https://integrate.api.nvidia.com/v1/embeddings`), from the Python sidecar only.**
Configuring an NVIDIA embeddings key **is the user's consent** for footage to
leave the machine; with no key, no frame is ever sent and indexing simply does
not run (honest `available:false`).

The contract:

- **Passages (images):** sampled frames, JPEG-encoded at a bounded long edge
  (the model does not need 4K), sent `modality:["image"]`, `input_type:"passage"`,
  base64 data URIs, batched — split on 413/400.
- **Queries (text):** the same model, text modality, `input_type:"query"`. This
  cross-modal passage/query pairing is the whole point; query vectors are never
  stored.
- **`dim` is captured from the first response and stored in the schema — never
  hardcoded** (the model owns its dimensionality).
- **The engine never logs, echoes, or persists the key.** Keys arrive in the
  runtime config payload from the host app the same way other runtime config
  does, are held in memory for the request, and appear nowhere in logs or the
  brain (key *storage* on the host is [ADR 0067](./0067-plaintext-key-storage-multi-key-failover.md)).
- **Sidecar-only** (D6): the browser build has no engine, so it honestly reports
  the tools unavailable rather than shipping frames from the renderer.

## Consequences

- **Easier:** state-of-the-art cross-modal recall with zero local model weight,
  install, or GPU requirement; the quality bar is NVIDIA's, not ours.
- **Harder / risk accepted:** **footage content leaves the machine** during
  indexing (down-scaled, deduped JPEG frames POSTed to NVIDIA). This is the single
  most privacy-significant thing Media Intelligence does, and the guide states it
  plainly. It is opt-in and consented (the key), never on by default with no key.
- **Cloud dependency:** indexing needs network + a live key; transient failures
  are handled by the key ring (rotate/cooldown, ADR 0067) and surface honestly as
  `all_keys_failing` rather than as fabricated vectors.
- **Guardrails:** no live NVIDIA calls in any test tier (mocked with respx —
  success, each failover branch, exhaustion, `dim` capture); a hand-run smoke
  script for manual key verification; the privacy statement in
  `docs/guides/media-intelligence.md`.

## Alternatives Considered

- **Local ONNX visual encoder** — no data leaves the machine, but no suitable
  bundled cross-modal model exists today and shipping VLM weights is out of scope.
  The `Embedder` seam keeps this open for later; declared a non-goal for now.
- **Reuse the configured chat VLM to embed** — chat providers expose captioning,
  not a cross-modal embedding endpoint; we already use them for captions (D7), a
  different job.
- **No cloud, captions-only recall** — loses the cross-modal image signal
  entirely (the exact thin-caption tail `search_visual` exists to serve, per
  [ADR 0064](./0064-visual-recall-in-find-similar.md)).
</content>
