# 03 — Protocol, desktop host, artifacts

## The `subject.matte` capability (`packages/capability-packs/src/worker-protocol.ts`)

Additive to the existing discriminated unions. The protocol version stays 1 if the union is
additive under the existing negotiation. If it is not, bump it and keep v1 packs working, with a
test for each case.

**Request**

```ts
RequestBaseSchema.extend({
  capability: z.literal('subject.matte'),
  parameters: z
    .object({
      output: MatteOutputHandleSchema, // opaque host-issued write handle, never a raw path
      inputs: MatteInputHandleSchema.optional(), // read-only handle to correction masks + locked alpha
      prompts: z.array(MattePromptSchema).min(1).max(MAX_MATTE_PROMPTS),
      // MattePrompt =
      //   { kind: 'points', pts, points: [{ x, y, label: 'include'|'exclude' }] }
      // | { kind: 'box', pts, box: NormalizedBox }
      // | { kind: 'brush', pts, file: 'corrections/<pts>.png' }   // keep=255, remove=0, untouched=128
      // | { kind: 'lock', pts, file: 'locked/<pts>.png' }         // editor-approved alpha, hard constraint
      previousArtifact: ArtifactKeySchema.optional(), // re-run reuses unaffected frames' verified alpha
      previewHeight: z.number().int().min(180).max(1080),
    })
    .strict(),
}).strict();
```

The frame range and media handle come from `RequestBase`, as for `tracking.*`.

**Progress**: add `refine`, `consensus`, `self_correct`, `matte`, `foreground`, `stabilise` and
`verify` to the phase enum (`segment`, `decode` and `encode` exist already), with
`{ completed, total, round? }`.

**Result** (small JSON, far under 1 MiB; bulk data lives in files):

```ts
ResultBaseSchema.extend({
  capability: z.literal('subject.matte'),
  artifact: z
    .object({
      files: z.array(ArtifactFileSchema), // matte.mkv, foreground.mkv, preview.webm, foreground.preview.webm,
      // frames.json, report.json — each { name, bytes, sha256 }
      width: z.number().int(),
      height: z.number().int(),
      frameCount: z.number().int(),
      firstPts: z.number(),
      lastPts: z.number(),
      timeBase: RationalSchema,
    })
    .strict(),
  executionProvider: z.enum(['coreml', 'directml', 'cpu']),
  summary: z
    .object({
      verifiedFrames: z.number().int(),
      flaggedFrames: z.number().int(),
      lockedFrames: z.number().int(),
      selfCorrectionRounds: z.number().int(),
    })
    .strict(),
  needsReview: z
    .array(
      z.object({
        startPts: z.number(),
        endPts: z.number(),
        reason: z.enum([
          'subject_lost',
          'estimates_disagree',
          'flow_inconsistent',
          'new_region',
          'edge_misaligned',
          'occlusion',
          'motion_blur',
        ]),
      }),
    )
    .max(4096),
}).strict();
```

**Failures** reuse `target_lost`, `hardware_unsupported`, `model_unavailable`, `media_unreadable`
and `cancelled`, and add `output_unwritable` as a distinct code so the host can say "disk full or
folder not writable" without matching text (see the `error-message-text-is-a-guard-key` lesson).
A pipeline that cannot reach its own verification for a frame **flags** that frame. It never
reports it verified.

## Sandbox broadening (MD-3)

Today a worker has read-only media handles. This capability adds exactly one write surface and one
extra read surface:

- **Write:** the host creates `<project>/.framepilot-derived/mattes/.staging/<requestId>/`, empty,
  and passes an opaque handle. The worker resolves it through `sandbox.py` and refuses anything
  outside it, including symlinks and `..`. It may create only the declared file names. A byte
  ceiling per request (frames × pixels × an FFV1 bound, ×2 for foreground) is enforced by both
  worker and host.
- **Read:** corrections and locked frames are written **by the host** into
  `.../.staging/<requestId>/inputs/` before the job starts, and passed as a read-only handle.
- **Verification by the host, independent of the worker's claims:** `ffprobe` dimensions, pixel
  format and frame count for every video; `frames.json` pts monotonic and equal to the source's
  decoded pts over the range; locked frames bit-identical to their inputs; sha256 of every file.
  Then an atomic rename to `mattes/<cacheKey>/`.
- On failure or cancel the staging directory is deleted. A startup sweep removes orphans older than 24 h.

The security-reviewer subagent reviews this before merge (BR4 DoD).

## Frame identity

The worker, the engine and the preview must agree on which picture a matte frame belongs to.

- Worker and engine decode with ffmpeg semantics (the worker via PyAV/ffmpeg, never
  `cv2.VideoCapture`), with edit lists honoured.
- `frames.json` stores each matte frame's source pts. The engine and the preview look up by **pts**
  (nearest at or before, within half a frame), never by an index computed from `fps`. The frame
  plan in [`09`](./09-PREVIEW-EXPORT-PARITY.md) supplies the same source pts to both.
- BR2 adds VFR and edit-list fixtures. A matte off by one frame on either fails the test.

## Desktop host (`apps/desktop/electron/capability-packs/matte.ts`, new)

Reuses `service.ts` resolution, the `tracking.ts` job lifecycle and the progress channel. New IPC,
added to `packages/shared-types/src/ipc.ts`:

| Method                                                                    | Returns                                                                                                                                        |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `capabilityPackStatus(capability)`                                        | `{ state: 'ready', pack } \| { state: 'missing', proposal } \| { state: 'unhealthy', reason, proposal? } \| { state: 'unsupported_platform' }` |
| `capabilityPackMatte(intent)`                                             | `MatteRunResultWire`: `{ ok: true, artifact, summary, needsReview, cacheHit } \| pack_missing proposal \| typed refusal`                       |
| `capabilityPackCancelMatte(requestId)`                                    | void                                                                                                                                           |
| `onCapabilityPackMatteProgress(cb)`                                       | unsubscribe fn, carrying `{ requestId, phase, completed, total, round?, etaSeconds? }`                                                         |
| `onCapabilityPackInstalled(cb)`                                           | fires after any install or uninstall completes its health check, so open panels refresh without restart                                        |
| `matteSaveCorrection({ artifactKey, pts, kind: 'brush' \| 'lock', png })` | writes the input file into the project's matte inputs store (validated size and dimensions) and returns its reference                          |

`capabilityPackStatus` is **generic** (any capability id), not matte-specific.

`intent` carries `timelineRevision`. The host re-checks it on completion and returns
`stale_revision` if the clip no longer exists, following the tracking path's rule.

**Auto prompt:** when `prompts` is empty, the host runs `subject.detect` on the clip's first
in-range frame through `subject-intelligence` (if installed) and turns the largest person or
object box into a prompt. If that pack is missing, it returns `needs_prompt` and the UI asks for a
click. It never proposes a second download on its own.

## Cache key and retention

```
sha256( asset.contentHash | sourceStartPts | sourceEndPts
      | canonical(prompts, including sha256 of each brush/lock PNG)
      | packId@version | modelDigests[] | MATTE_PIPELINE_VERSION )
```

- Mattes and their correction inputs are **project-owned** (MD-4). The storage manager shows them
  per project and never evicts one referenced by the current timeline **or** by undo history in the
  open session.
- "Clean unused mattes" removes directories no saved timeline revision references. It is an
  explicit, confirmed action.
- Paths are relative to the project root, so moving a project moves its mattes.
