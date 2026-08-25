# Media understanding with TwelveLabs (optional)

FramePilot understands your footage so the AI can find moments by what is _shown_
or _said_ — "the shot where the door opens", "where they say hello". By default
this runs on the **built-in indexer** (local frame sampling + NVIDIA visual
embeddings; see [project-brain.md](./project-brain.md)). You can optionally route
understanding through **[TwelveLabs](https://www.twelvelabs.io/)** instead, whose
hosted index understands a video's visual, audio, and speech content together.

See [ADR 0070](../adr/0070-twelvelabs-optional-understanding-backend.md) for the
design and rationale, and [ADR 0097](../adr/0097-twelvelabs-official-sdk-adoption.md)
for why the engine talks to TwelveLabs through the official `twelvelabs` SDK (and the
license caveat that comes with it).

## When to use it

- You want stronger search over **what is spoken** and **what is on screen**
  together (TwelveLabs fuses visual + audio + transcription internally).
- You already have a TwelveLabs account/API key.

If you don't set a key, nothing changes — the built-in indexer is used. That built-in
path needs its own key: set **On-device embeddings key** in the same Settings section
(or `FRAMEPILOT_NVIDIA_EMBEDDINGS_KEYS`). With both configured TwelveLabs takes
priority, and Settings names the backend that will actually run.

## Enabling it

1. Get an API key from the [TwelveLabs dashboard](https://www.twelvelabs.io/).
2. **Desktop / web-editor:** Settings → AI → Media intelligence → **TwelveLabs API
   key**. Paste the key; there is no manual indexing step. FramePilot prepares media
   on import or on first semantic need, joins duplicate requests, and reuses
   unchanged results.
3. **Engine env (headless/CI/desktop sidecar):** set `TWELVELABS_API_KEY`. The
   Settings key takes precedence; the env var is the fallback.

The key is stored as plain text on your machine and sent only to TwelveLabs —
never to FramePilot. It is never written to logs.

## What changes

| Capability                           | Built-in backend                                  | TwelveLabs backend                                                                          |
| ------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Visual search (`search_visual`)      | local vectors + FTS fusion                        | TwelveLabs clips (visual + audio + speech)                                                  |
| Indexing                             | frame sampling → NVIDIA embeddings → `sqlite-vec` | upload → TwelveLabs asset → Marengo index (search) + Pegasus over the asset (map)           |
| Captions & transcript                | local whisper (word timestamps)                   | TwelveLabs' own word-level transcription (from the indexed audio), when explicitly selected |
| `describe_footage` (scene walk)      | enumerates local spans                            | walks the Pegasus chapter map in time order                                                 |
| `map_footage` (whole-footage digest) | derived from local spans/captions                 | TwelveLabs Pegasus chapters + highlights + summary                                          |
| `backend` reported by status/search  | `sqlite-vec`                                      | `twelvelabs`                                                                                |

When TwelveLabs is explicitly selected under Settings → AI → Speech-to-text, the
word-level transcript is pulled from TwelveLabs' own transcription of the indexed
audio (no second ASR pass). Provider selection is strict: an unindexed asset or a
TwelveLabs failure is reported and preserves the current transcript; it never
silently falls back to local whisper.

## Understanding the whole footage (the footage map)

On unfamiliar or hours-long footage the AI needs a map before it can plan an
edit — it does not know _what_ to search for. The **footage map** provides that:
a time-ordered digest of the whole footage with **no query**, made of chapters
(`{ t0, t1, title, summary }`) and highlights (`{ t0, t1, label, score }`) in
timeline seconds, plus a one-paragraph summary.

- On the **TwelveLabs** backend the map is produced by **Pegasus 1.5** via the
  `/analyze` endpoint (one call each for chapters, highlights, and summary, each
  with a JSON-schema `response_format`), cached per video by content hash so it is
  computed once and rebuilt only when the footage is re-indexed. (The older
  `/summarize` and `/gist` endpoints this used were sunset by TwelveLabs on
  2026-02-15 — a live index answers HTTP 410 for them — so the client migrated to
  `/analyze`, which returns the same structured chapters/highlights/summary.)
  - **Pegasus is not an index model any more.** `pegasus1.2` was sunset for
    indexing: `POST /indexes` rejects it with HTTP 400 `parameter_invalid`. Because
    FramePilot asked for it on every index, the FIRST index a project created failed
    — nothing indexed, and every footage map reported `not_indexed` forever. Indexes
    now carry **Marengo only**, and `pegasus1.5` analyses the **uploaded asset**
    directly (`video: {type: "asset_id", …}`; `video_id` is rejected for 1.5), so the
    map needs no Pegasus-enabled index at all.
  - **The uploaded asset id is persisted** on each asset's mapping
    (`sourceAssetId`), because it is a different id from the indexed `video_id` the
    search path uses. Mappings written before this recover it once from
    `GET /indexes/{index}/indexed-assets/{video}` and store it, so footage indexed by
    an earlier version maps without re-uploading (no re-billing).
  - **Structured output is decoded tolerantly.** Pegasus 1.5 sometimes mis-escapes
    the JSON string it returns for a multi-string schema and then repeats the tail;
    the client unescapes and reads the valid object at the head, and retries once with
    the schema described in the prompt if that still fails, rather than blanking the map.
- On the **built-in** backend the map is derived from the already-indexed visual
  spans and captions (chapters only; highlights need a salience signal the local
  index does not have).

The AI reaches it with the **`map_footage`** tool (called first on long or
unfamiliar footage, then drilling in with `describe_footage` / `search_visual`),
and can then lay the map's chapters and highlights alongside silence, scene cuts
and spoken emphasis through the **`read_edit_signals`** tool, which describes what
is measurably there — a chapter's length and how many highlights sit inside it, a
gap long enough to notice, a word the speaker leaned on — in time order, and says
of each whether it was supplied or measured. It deliberately does not rank those
observations or recommend a move: which of them earns a punch-in, a reframe, a
ramp or nothing at all is the AI's judgement, and each move it chooses becomes a
normal, reversible timeline patch.

You can see the same map yourself: the **Footage understanding** panel (the map
icon in the top bar) lists the chapters and highlights; click one to seek to it.

### Honest states (footage map)

- **Not indexed** → `not_indexed`: the footage has not been read yet. The
  **Footage understanding** panel offers a **Read this footage** button for exactly
  this state (it runs the same paced preparation pass an import runs and streams its
  progress); the AI reaches the same path through the ensure gate.
- **No Pegasus entitlement** (valid key, plan without generative understanding) →
  `pegasus_unavailable`: search/index still work; the built-in structure is shown
  once indexed. Marengo (search/index) is unaffected.
- **No key / invalid key** → `no_api_key` / `invalid_api_key`.

In every case the panel and the tool report the typed reason — a map is never
fabricated.

## Search ranking (visual + audio + transcription)

A visual search sends the query against all three Marengo search modalities —
**visual, audio, and transcription** (lexical + semantic) — the same fused
configuration the TwelveLabs dashboard uses, so FramePilot's ranking matches what
you see there. The index itself is still created with only the `visual` + `audio`
model options (the transcription modality is derived from the indexed audio at
search time; it is _not_ a valid index option).

Marengo 3.0's `/search` response returns each clip's **`rank`** (1 = best match)
and **no numeric score**. FramePilot derives the relevance score the orchestrator
ranks on directly from that rank (`1/rank`), so the best clip leads with the
highest score. (Before this was handled, every clip arrived with `score = 0`,
which left the agent unable to tell scenes apart — it would repeat the same search
and stop with "no further edits could be found".)

## How it behaves (honest degradation)

- **No key** → the built-in indexer runs.
- **Indexing** is paced: FramePilot uploads a typed media asset first, then attaches it to the
  index; both states are resumed across background slices. Large uploads index in the background;
  status shows coverage (`indexed / total` assets) with `backend: twelvelabs`.
- **Invalid key** → search/index report `invalid_api_key` (nothing fabricated).
- **Project not indexed yet** → search reports `not_indexed` with no results.
- **Sidecar/network down** → the caller degrades cleanly, as with any brain read.

## Tracing an index that looks stuck

Indexing a long clip is genuinely slow: TwelveLabs uploads the **whole** file as a media asset,
then attaches and indexes it server-side, which can take minutes for a multi-minute video. Audio
files retain their audio MIME type; they are not submitted to the legacy video-only task API. The
Settings panel shows a single job at `0%` for the whole time, because progress is
counted per **asset** — one video is `0/1` until it finishes, then jumps to `1/1`.
That `0%` alone does **not** mean it is stuck.

To see what is actually happening, watch the engine sidecar log. Every TwelveLabs
call is traced (never the key or media bytes):

- `ACT twelvelabs upload start … size=…MB` / `upload done … in …s` — the file
  transfer to TwelveLabs (the slow part for large videos).
- `ACT twelvelabs index attach …` — the ready upload was attached to the project index.
- `twelvelabs indexed asset poll: … status=…` (enable `debug`) — each indexing poll.
- `twelvelabs index asset still indexing … yielding to re-post` — a paced slice
  handed back so the client continues; normal while a big video indexes.
- `ACT twelvelabs index asset ready … video=…` — the asset finished indexing.
- `twelvelabs ✗ …` — a rejected key, an HTTP error, or a transport/timeout
  failure, with the status code and elapsed time.

Set the engine log level to `debug` to include the per-poll lines. Uploads use a
generous timeout (both the engine and the index client), so a large file is given
minutes to transfer rather than being cut off early.

If the panel reads `sqlite-vec` while you have a TwelveLabs key in Settings, that
is expected only until the project's TwelveLabs index is created; once indexing
has started, status detects the TwelveLabs backend from the stored index and
reports `twelvelabs`.

## Privacy note

Like the built-in NVIDIA embeddings path (ADR 0066), this uploads your footage to
a third party — here, TwelveLabs — for indexing and search. Only enable it if that
is acceptable for your material.
