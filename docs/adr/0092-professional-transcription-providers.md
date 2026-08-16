# ADR 0092 — Precise local ASR and explicit TwelveLabs transcription

Status: **Accepted** · Date: 2026-08-01 · Extends ADR 0070 and ADR 0097.

## Context

Caption quality is bounded by transcript quality. The previous local default,
`base.en`, was a small English-only bootstrap model, and the service implicitly
used TwelveLabs whenever a key happened to exist. That made provider selection
unpredictable and left difficult audio, multilingual speech, lyrics, names, and
long recordings below a professional editing bar.

## Decision

- Local ASR defaults to whisper.cpp's quantized multilingual
  `large-v3-turbo-q5_0` model. Setup remains explicit, streamed, and SHA256
  verified. The older `base.en` registry entry remains addressable for callers
  that deliberately request it.
- Local transcription requests automatic language detection, split-on-word full
  JSON, and the upstream `large.v3.turbo` DTW alignment preset. FramePilot merges
  real token offsets and does not interpolate multi-word segment timing.
- `twelvelabs` is a first-class ASR provider. The desktop indexes the selected
  asset through the existing paced TwelveLabs job, then reads the native
  word-level transcription with the shared Media intelligence key.
  The paced job uses TwelveLabs' current two-stage asset workflow: upload through
  `/assets` with the source MIME type, then create/poll an indexed asset. This is
  required for audio-only sources; the legacy `/tasks` contract accepts a
  `video_file` and rejects MP3 input as `video_file_broken`. Existing stored
  legacy task ids remain pollable for backward compatibility.
- Provider choice is explicit end to end. `/transcribe` defaults to local only;
  TwelveLabs requires `provider: "twelvelabs"`. Missing indexing, credentials,
  authentication, or transport is an honest failure and never triggers a silent
  fallback.
- Both manual transcription and the AI `transcribe` tool use the same desktop
  TwelveLabs helper and still produce a validated, reversible `set_transcript`
  patch.

## Consequences

- The local first-run model download grows from about 141MiB to about 548MiB and
  needs more compute, in exchange for a materially stronger multilingual model.
- Existing installed `base.en` files are not deleted or overwritten, but the new
  default must be installed once.
- TwelveLabs uploads the selected media off-device and may take minutes to index;
  Settings discloses this before use.
- Word alignment is covered by an exact leading-silence regression at `0.930s`.
  This proves timestamp preservation, not an impossible guarantee that any ASR
  recognizes every word in every recording.
- No project schema changes, migration, or direct project-file mutation are
  introduced.
