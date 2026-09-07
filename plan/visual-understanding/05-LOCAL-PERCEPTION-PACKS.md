# 05 — Phases VU5–VU6: local perception as capability packs

**User outcome.** With no key, offline, the agent can search footage by meaning ("wide shots
of the street"), knows who appears where, spots duplicate takes, and reads a one-line
description of every shot. Heavy weights install on demand with progress and verification,
exactly like Whisper models do today.

**Scope gate.** Gap: tiers 1 and 2 exist only as hosted, key-gated arms. Minimum slice: two
packs, each one worker speaking the existing JSON-line protocol, each writing the ledger
columns defined in `01-ARCHITECTURE.md`. Reuse: `packages/capability-packs` (installer,
verifier, worker client/health, local registration), `workers/*` layout, `visual_embed.py`
batching, `captioner.py` prompt discipline, `vector_store.py`. Deferred: OCR beyond what the
VLM reads, audio events, segmentation/depth (that is `SCENE-UNDERSTANDING` P3).

## Why packs, not sidecar dependencies

ADR 0114 already decided it: the frozen engine is ~129 MiB; weights and native runtimes are
hundreds of MB to GB and many editors never use them. The engine keeps `onnxruntime` optional
(it already is, for MiniLM text embeddings) and never gains torch or transformers: PyInstaller
size and the GPU matrix would sink the desktop build.

## VU5 Tier 1: `framepilot.visual-embed`

### VU5.1 Models (verify licences before adding; CLAUDE.md §5) `[~]`

| Purpose                                   | Model                                                                            | Runtime                                             | Size         | Licence to verify                 |
| ----------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------- | ------------ | --------------------------------- |
| Image + text embeddings, zero-shot labels | SigLIP 2 base patch16-224 exported to ONNX (fallback: OpenAI CLIP ViT-B/32 ONNX) | onnxruntime CPU (CoreML EP on macOS when available) | ~370 MB fp16 | Apache-2.0 (SigLIP 2), MIT (CLIP) |
| Face detection                            | YuNet (OpenCV zoo)                                                               | OpenCV DNN                                          | ~0.3 MB      | MIT                               |
| Face identity                             | SFace (OpenCV zoo)                                                               | OpenCV DNN                                          | ~37 MB       | Apache-2.0                        |

The `subject-intelligence` worker already carries OpenCV headless (`workers/subject-intelligence/pyproject.toml`
`cv` extra) and detects faces/persons; tier 1 identity embedding is added to that worker
rather than a third pack. The embedding model ships in a new `workers/visual-embed` worker.
Run `pnpm license:scan` and record the result in `LICENSES.md` of each worker.

### VU5.2 Worker contract `[x]`

Request (JSON line, per `worker-protocol.ts`): a media handle, a list of `(shotIndex, keyframeT)`
and the text prompt bank version. Response per shot: `vector` (base64 fp16, `dim`), `labels`
(`shotSize`, `subjectKind`, `setting`, `screenContent` with `p`), `faces` (count + SFace
vectors). Bounded batch (≤ 64 shots per line, within `CAPABILITY_PACK_WORKER_MAX_LINE_BYTES`).

Zero-shot labels come from a fixed **prompt bank** (`analysis/prompt_bank.py`, versioned):
seven shot sizes, ten subject kinds, ~20 settings, six screen-content classes, each phrased
as "a photo of …". Text vectors are computed once per bank version and cached in the pack
store; a label is the softmax over its class group; `p` is that probability. Bank changes bump
`tier1_version`.

### VU5.3 Engine integration `[x]`

- `resolve_visual_embedder` gains a `local` arm: when the pack is installed and healthy
  (`worker-health.ts` → engine sees a `FRAMEPILOT_PACK_VISUAL_EMBED` handle passed by the
  host in the index request, the same channel the NVIDIA keys use), the local worker is
  preferred over NVIDIA. Both write `visual_vectors` under their own `model` id; a project
  indexed under one never mixes with the other (existing rule).
- Text queries for `search_visual` and `find_similar` embed locally through the same worker.
  `vector_store.py` is unchanged.
- `shots.labelled` written per shot; `entities` clustered per project after each slice:
  agglomerative on SFace vectors with a fixed cosine threshold, stable ids (`person_NN` by
  first appearance), centroid stored; re-cluster only when new faces arrive. Settings
  clusters (`setting_NN`) from SigLIP vectors, coarse, optional.
- `duplicateOf`: phash Hamming ≤ 6 across shots of the project (the `_SIMILAR_GROUP_SPAN_CAP`
  pairwise bound exists; replace pairwise with a 64-bit multi-index bucket so 7,200 shots is
  cheap).

### VU5.4 Evidence `[ ]` — NOT MEASURED

- Worker tests on captured keyframes (decoded_media marker, pack build job only); protocol
  tests without media.
- Zero-shot accuracy on the labelled fixtures (`06`): shot size ≥ 75% exact, ≥ 95% within one
  step; subject kind ≥ 85%; screen content ≥ 90% on `talk-1080p-98s` vs `ref/fast-cut-vertical`.
- Identity: `talk-1080p-98s.mp4` and `camera-4k60-40s.mov` produce the expected number of
  person clusters (label the fixtures once).
- Offline: `search_visual "street"` on `mission-montage` with no key and Wi-Fi off returns the
  street shots.
- Speed on the M1 Pro: ms per shot, batch of 64; record.

### VU5 state, 2026-09-07 — everything except the weights

`workers/visual-embed/` exists and is complete around a model that has **not been
downloaded**. No weight was fetched (deliberately: the pack machinery is reviewable before
~410 MiB of binaries are), so `pack/models.lock.toml` carries placeholder digests,
`models.py` refuses them by name, and the health check fails while any remains. Nothing in
this repository has produced a SigLIP vector, and no accuracy figure in VU5.4 has been
measured — the targets there stand untouched.

What IS done and tested against a fake backend:

- the worker: protocol mirror (`visual.embed` + the media-free `visual.text`), prompt-bank
  mirror, labelling policy, fp16 packing, prompt-vector cache, one-shot runtime, identity
  and pin verification — 64 tests, no ML runtime installed;
- the protocol: two capabilities added to `packages/capability-packs`'s frozen union
  (`worker-protocol.ts`), still version 1, additive;
- the prompt bank: `engine/.../analysis/prompt_bank.py`, 43 phrases in 4 groups,
  `PROMPT_BANK_VERSION` IS `TIER1_VERSION`, with a drift test against the pack's mirror;
- the engine: `pack_worker.py` (JSON-line subprocess client), `local_visual_embed.py`,
  the `local` arm of `resolve_visual_embedder` (preferred over NVIDIA), and tier-1 writes
  through `upsert_shots(tier="labelled")` + `visual_spans`/`visual_vectors` under the LOCAL
  model id;
- `duplicates.py`: the 64-bit multi-index bucket, proved equal to an all-pairs scan on
  random hashes. **The pairwise `_SIMILAR_GROUP_SPAN_CAP` scan is deleted**, cap and all —
  the VU5 deprecation row in `08` is discharged;
- `entities.py` + the `entities` table accessors: agglomerative clustering at SFace's own
  0.363 cosine, `person_NN` by first appearance, centroids stored, human labels preserved
  across a re-cluster.

Remaining, in order: verify the SigLIP 2 **export**'s licence and SFace's; fetch and pin
(`tools/fetch_models.py --record`, then copy the digests into `models.py`); run
`pytest -m decoded_media`; register with `scripts/dev-register-visual-embed.sh`; then and
only then measure VU5.4 against VU0.2's labels. Two smaller pieces are also open: the
desktop host does not yet pass a `visualEmbedPack` handle (the env var is the only route
today), and `search_visual`/`find_similar` still query the hosted space — the local text
arm exists and is tested, but nothing selects the space with coverage yet.

## VU6 Tier 2: `framepilot.visual-describe`

### VU6.1 Runtime and model `[~]`

| Piece         | Choice                                                                                    | Why                                                                                                                |
| ------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Runtime       | llama.cpp multimodal server or CLI (`llama-server` / `llama-mtmd-cli`), MIT               | same ggml family as the `whisper-cli` the ASR path already ships; Metal on macOS, CPU elsewhere, no Python ML deps |
| Default model | SmolVLM2-2.2B-Instruct, Q4_K_M GGUF + mmproj, Apache-2.0                                  | multi-image input, small, well-quantised; ~1.5 GB resident                                                         |
| Low-RAM model | SmolVLM2-500M-Instruct GGUF, Apache-2.0                                                   | machines under 12 GB                                                                                               |
| Excluded      | Qwen2.5-VL-3B (research licence), Gemma 3 (Gemma terms), anything without a clear licence | licence gate                                                                                                       |

Verify each licence and hash at pack build; `models.lock.toml` per worker as the tracking
pack does. Hosted fallback remains the existing captioner (`captioner.py`) with the same
output schema (VU6.3).

### VU6.2 Structured caption `[x]`

One call per shot with 1–3 keyframes (first, middle, last of the span; stills get one).
Output constrained with llama.cpp's JSON-schema grammar to the `described` object in
`01-ARCHITECTURE.md` §3. Prompt keeps `captioner.py`'s discipline: state only what is visible;
no intent, no narration; `onScreenText` verbatim; `quality` from a closed list. `p` is the
model's self-rated confidence bucketed to 0.5/0.7/0.9; it is a hint, never a gate.

### VU6.3 Hosted parity `[x]`

`captioner.py` moves to the same structured prompt with JSON output (Anthropic and
OpenAI-compatible wire formats both support it); `visual_captions.text` keeps `summary` for
FTS. TwelveLabs's arm maps its span text into `summary` only. One schema, three producers.

### VU6.4 Scheduling `[x]`

Tier 2 is the slow tier. It runs one worker instance, lowest priority, `timeline` assets
first, then `bin`, and yields to renders/exports and to any interactive `get_frame`
(`07-SCALE-AND-OPERATIONS.md` governor). The media bin shows a small "describing 12/61" badge;
Settings shows per-tier coverage. The agent reads coverage as a fact and never waits.

### VU6.5 Evidence `[~]` — FLOOR MEASURED 2026-09-08, quality targets still open

`workers/visual-describe/eval/` measures what needs no labeller: four fixtures whose content
is true **by construction**, scored through the signed worker entrypoint. On
SmolVLM2-2.2B-Instruct-Q4_K_M: **9/9 checks, ~11 s per shot** — no invented person on seeded
noise or colour bars, no invented `onScreenText`, a title card read verbatim, and a
featureless frame declined cleanly rather than guessed at.

It found two defects a fake backend could not have: `onScreenText` returned as sixteen
identical copies of one line (deduplicated now, in the pack and the engine mirror), and a
featureless frame failing its whole batch as `retryable` forever (now
`ShotNotDescribableError`, not retryable). Both fixed in `bfb58bc`.

**Still open, and the floor does not touch it:** the ≥80% `subject`/`setting` agreement
below needs human labels. `tests/fixtures/mission/labels/tier2.json` is a scaffold whose
every field is `null`, and a generated label set scores the model against itself. Recorded
from the same run and deliberately unscored: the model collapses `subject`, `action` and
`setting` to one filler string.

### VU6.5 Evidence — the original targets

- Every mission fixture shot has a `described` row after a background run on the M1 Pro with
  the UI in use; record wall clock and peak RSS.
- Caption quality: on 50 labelled shots, `subject` and `setting` agree with the human label
  ≥ 80%; `onScreenText` exact on the `ref/design.png`, `ref/thumbnail.png` stills.
- Hosted and local produce schema-identical rows on the same 10 shots.
- `describe_footage` output reads as a shot list an editor would recognise (reviewed by hand,
  pasted into this file).

### VU6 state, 2026-09-07 — everything except the weights and the binary

`workers/visual-describe/` exists and is complete around a model and a runtime that have
**not been downloaded**. No weight and no `llama-mtmd-cli` was fetched (deliberately, the
same call VU5 made): `pack/models.lock.toml` carries placeholder digests, `models.py`
refuses them by name, and the health check fails while any remains. **Nothing in this
repository has produced a local description**, and no figure in VU6.5 has been measured —
those targets need real weights and human labels and are untouched.

What IS done and tested against a fake backend:

- the worker: protocol mirror (`visual.describe`), schema mirror, keyframe choice,
  normalisation, one-shot runtime, identity and pin verification — 82 tests, no ML stack
  and no binary installed;
- the protocol: one capability added to `packages/capability-packs`'s frozen union
  (`worker-protocol.ts`), still version 1, additive, plus a `describe` progress phase;
- the schema: `engine/.../brain/described.py` — `DESCRIBED_JSON_SCHEMA`,
  `DESCRIBE_INSTRUCTION`, the closed vocabularies, `parse_described` (the one funnel every
  producer passes through) and `keyframe_times`, with a drift test against the pack's
  mirror that compares the schema, the prompt, the bounds AND the chosen frames;
- the engine: `local_visual_describe.py` (the pack client) and `_describe_tier2` — tier 2
  is now a tier of the shot LEDGER with two producers, so a keyless machine with the pack
  describes its footage and a machine with a vision key and no embedding key does too. It
  writes `shots.described` via `upsert_shots(tier="described")` and the `summary` into
  `visual_captions` for FTS, keyed by the SHOT;
- scheduling: the VU8 governor is the only mechanism — one worker, deep pass only, stands
  down under the low-memory rule — plus a 90 s per-asset budget that keeps the job cursor
  on an unfinished asset instead of advancing past undescribed shots;
- **the free-text `CAPTION_INSTRUCTION` and the whole prose path are DELETED**, with their
  tests, and the `08` deprecation row is discharged. The hosted captioner now forces an
  Anthropic tool call / an OpenAI `json_schema` against the same schema; `captioner.py` no
  longer has a function that returns a string.

Two things are NOT wired, and are named rather than implied:

- **the TwelveLabs arm.** `described_from_summary` exists and is tested (prose into
  `summary`, every other field left empty), but `_tl_index_slice` still records
  `described: skipped` for videos. Mapping TL spans onto ledger shots is its own piece.
- **the desktop host does not pass a `visualDescribePack` handle.** The request field and
  `FRAMEPILOT_PACK_VISUAL_DESCRIBE` are the only routes today, exactly as VU5 left tier 1.

One behaviour change worth reviewing: `visual_captions` rows are now keyed by SHOT, while
the hosted NVIDIA span space is keyed by the sampler's scenes. The readers that joined the
two by `scene_index` now join by **time overlap** (`_caption_for_span`), because index
equality across two different segmentations is a confident, invisible lie.

Remaining, in order: verify the SmolVLM2 GGUF **quantisation** and mmproj licences and the
llama.cpp **release artifact**'s; fetch and pin (`tools/fetch_models.py --record`, then
copy the digests into `models.py`); run `pytest -m decoded_media` — the first evidence
`llama_backend.py` is correct at all; register with
`scripts/dev-register-visual-describe.sh`; then and only then measure VU6.5.

## Definition of done

`[ ]` two packs registered via `framepilot-pack register-local` on the maintainer machine and
documented in `scripts/dev-register-*.sh` · `[ ]` pack catalog entries prepared for release ·
`[ ]` licences recorded · `[ ]` engine, worker and ai-sdk suites green · `[ ]` ADR "Local
perception ships as packs; hosted arms are optional" · `[ ]` `docs/guides/media-intelligence.md`
rewritten around tiers · `[ ]` CHANGELOG · `[ ]` plan reconciled.
