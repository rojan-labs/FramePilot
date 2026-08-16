# Transcription (ASR)

FramePilot's AI needs to "hear" footage before it can caption it, search it, cut fillers, or
propose a hook — that hearing comes from **speech-to-text (ASR)**, delivered by a **model**, not a
custom ML stack we own (plan `FRAMEPILOT-AI-PRODUCT-PLAN.md` H0.1). This guide covers setup for
the four shipped providers and the editor workflow.

## Providers

| Provider      | Default?    | Where it runs                                                                   | Cost                 | Setup                                           |
| ------------- | ----------- | ------------------------------------------------------------------------------- | -------------------- | ----------------------------------------------- |
| `whisper-cli` | **Yes**     | Locally, via a `whisper-cli` (whisper.cpp) subprocess the Python engine invokes | Free                 | Install the binary + download the model (below) |
| `twelvelabs`  | No (opt-in) | Hosted — **your media is uploaded and indexed by TwelveLabs**                   | TwelveLabs API usage | Shared Media intelligence key in Settings       |
| `groq`        | No (opt-in) | Hosted — **your audio is sent to Groq's API**                                   | Groq API usage       | Dedicated ASR API key in Settings               |
| `nvidia`      | No (opt-in) | Hosted — **your audio is sent to NVIDIA's API**                                 | NVIDIA API usage     | Dedicated ASR API key in Settings               |

The local provider is the default so transcription works fully offline with no consent gate. The
hosted providers are opt-in and always disclosed in Settings.

## Local setup (`whisper-cli`, default)

1. Install whisper.cpp's CLI. On macOS:

   ```bash
   brew install whisper-cpp
   ```

   This installs a `whisper-cli` binary on `PATH`. If your install ships a differently named
   binary (`whisper-cpp`/`main`), the engine also looks for those, or you can point directly at
   it with `FRAMEPILOT_WHISPER_CLI=/path/to/whisper-cli`.

2. Download + verify the professional default model (`large-v3-turbo-q5_0`, ~548MiB) — an
   **explicit** step, never a silent download on first transcribe:

   ```bash
   framepilot setup-asr
   # or, from the desktop app / web editor, Settings → AI → Providers →
   # Whisper / Speech-to-text → "Set up"
   ```

   The model is SHA256-verified before it is installed and cached at `~/.framepilot/models`
   (override with `FRAMEPILOT_ASR_MODEL_DIR`) — outside any project directory, since models are
   large and shared across projects.

3. Check readiness at any time:

   ```bash
   framepilot asr-status
   # {"binaryAvailable": true, "model": "large-v3-turbo-q5_0", "modelPresent": true, ...}
   ```

If either the binary or the model is missing, `/transcribe` (and the `transcribe` AI tool's
upstream provider call) reports **honest-unavailable** with an actionable message — it never
fabricates a transcript.

## TwelveLabs setup (opt-in)

1. Add a TwelveLabs API key in Settings → AI → Speech-to-text, or reuse the key under
   Media intelligence — both fields write the same local credential.
2. Choose **TwelveLabs** as the transcription provider.
3. Transcribe normally. FramePilot uploads the selected file through TwelveLabs' media-asset API,
   waits for the upload to become ready, attaches it to the project's Marengo + Pegasus index,
   then reads TwelveLabs' native timed words from the indexed asset. This two-stage path preserves
   the file's real media type, so WAV, MP3, and FLAC are handled as audio rather than being sent to
   the legacy video-only task API.

There is no silent fallback. If indexing, authentication, or the network fails, the existing
transcript is preserved and the editor shows the real failure. **Try again** starts a fresh upload
after a terminal indexing failure; it does not keep polling the failed remote task. See
[twelvelabs-understanding.md](./twelvelabs-understanding.md) for indexing and privacy details.

## Other hosted setup (`groq` or `nvidia`, opt-in)

1. Get a speech-to-text key from Groq or NVIDIA.
2. In Settings → AI → Speech-to-text, choose the provider and paste its key into the dedicated
   ASR key field. This key is separate from every chat-provider credential.

Groq (`whisper-large-v3`) and NVIDIA (`nemotron-asr-streaming`) return **word-level timestamps
directly**, so no client-side token merging is needed — unlike the local path, which reconstructs
words from whisper.cpp's sub-word tokens.

## Transcribe in the editor

1. Open the **Transcript** tab in the right rail.
2. Choose the audio/video source when the project contains more than one.
3. Select **Transcribe**. The current project is saved first so the trusted desktop host can
   sandbox-resolve the media.
4. The Transcript rail and the header Transcription panel read the same shared job state. If
   **Automatically on import** already started speech-to-text, opening either surface shows the
   provider, elapsed time, and indeterminate progress instead of offering a duplicate Transcribe
   button.
5. On success, the panel reports the timed-word count. **Undo** restores the prior transcript;
   **Retranscribe** replaces it through another reversible patch.

An unavailable provider, missing local model, invalid asset, or empty ASR response is shown as an
error. None of these cases clears an existing transcript.

## How a transcript becomes a patch

1. The explicitly configured provider (local sidecar call, TwelveLabs indexed transcript, or a
   hosted audio client) produces
   `TranscriptWord[]` — real per-word `{ word, start, end }` timings, never interpolated.
2. The model-facing `transcribe` tool accepts only an asset id. The trusted host validates the
   provider result and turns it into a `set_transcript` operation — a normal, reversible
   [timeline operation](../guides/adding-a-timeline-operation.md), exactly like every other AI
   edit.
3. The operation goes through the same validate → preview → apply → undo pipeline as any other
   patch (AGENTS.md invariant 5) — the transcript is never written directly.

## Model management internals

- Engine module: `framepilot_engine/audio/asr.py`.
- Sidecar routes: `GET /asr/status`, `POST /asr/setup`, `POST /transcribe` (`service.py`).
- CLI: `framepilot asr-status`, `framepilot setup-asr`.
- Audio prep: ffmpeg extracts mono 16kHz PCM WAV (whisper.cpp's expected input format).
- Word-level timing: whisper-cli is invoked with `-ml 1 -sow --dtw large.v3.turbo -ojf -l auto
-sns -np` (max segment length 1, split-on-word, DTW-based word timestamps, full JSON output,
  automatic language detection, non-speech-token suppression, and no console progress); the parser merges
  whisper.cpp's sub-word BPE tokens into whole words using the leading-space token-boundary
  convention (never a whitespace split of segment text with interpolated timings).
- Results are content-hash cached (`FRAMEPILOT_ASR_CACHE_DIR`, default alongside the model cache)
  so re-transcribing the same file + model is instant on a cache hit.

The model's published Hugging Face LFS SHA256 and byte size are pinned in the registry. A wrong
checksum fails setup closed. Override a checksum only for a deliberately mirrored model via
`FRAMEPILOT_ASR_<MODEL>_SHA256`.

No speech recognizer can promise literal 100% accuracy for every accent, lyric, mix, or recording.
FramePilot's contract is narrower and testable: it preserves the provider's real word offsets
(including leading silence such as a first word at `0.930s`), never interpolates multi-word timing,
never fabricates missing words, and never clears a good transcript after a failed retry.
