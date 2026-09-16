# 03 — Protocol, desktop host, artifacts

## The `subject.matte` capability (`packages/capability-packs/src/worker-protocol.ts`)

Additive to the existing discriminated unions. The protocol version stays 1 if the union is
additive under the existing negotiation. If it is not, bump it and keep v1 packs working, with
a test for each case.

**Request**

```ts
RequestBaseSchema.extend({
  capability: z.literal('subject.matte'),
  parameters: z
    .object({
      output: MatteOutputHandleSchema, // opaque host-issued handle, never a raw path
      prompts: z.array(MattePromptSchema).min(1).max(MAX_MATTE_PROMPTS),
      // MattePrompt = { pts, points?: [{x,y,label:'include'|'exclude'}], box?: NormalizedBox }
      previewHeight: z.number().int().min(180).max(1080),
      window: z
        .object({
          frames: z.number().int().min(60).max(900),
          overlap: z.number().int().min(8).max(90),
        })
        .strict(),
    })
    .strict(),
}).strict();
```

Frame range and media handle come from `RequestBase`, as for `tracking.*`.

**Progress**: add `refine`, `matte`, `stabilise` to the phase enum (`segment`, `decode` and
`encode` exist already).

**Result** (small JSON, far under 1 MiB):

```ts
ResultBaseSchema.extend({
  capability: z.literal('subject.matte'),
  artifact: z
    .object({
      master: ArtifactFileSchema, // { name: 'matte.mkv', bytes, sha256 }
      preview: ArtifactFileSchema, // { name: 'preview.webm', bytes, sha256 }
      frames: ArtifactFileSchema, // { name: 'frames.json', bytes, sha256 }
      width: z.number().int(),
      height: z.number().int(),
      frameCount: z.number().int(),
      firstPts: z.number(),
      lastPts: z.number(),
      timeBase: RationalSchema,
    })
    .strict(),
  executionProvider: z.enum(['coreml', 'directml', 'cpu']),
  lowConfidence: z
    .array(
      z.object({
        startPts,
        endPts,
        reason: z.enum(['subject_lost', 'ambiguous_edge', 'occlusion', 'motion_blur']),
      }),
    )
    .max(512),
}).strict();
```

**Failures** reuse the existing codes: `target_lost` (the subject vanished for the whole range),
`hardware_unsupported`, `model_unavailable`, `media_unreadable`, `cancelled`. Add
`output_unwritable`, distinct so the host can say "disk full / folder not writable" without
matching text (see the `error-message-text-is-a-guard-key` lesson).

## Sandbox broadening (MD-3)

Today a worker has read-only media handles. This capability adds exactly one write surface:

- The host creates `<project>/.framepilot-derived/mattes/.staging/<requestId>/`, empty, and
  passes an opaque handle to it. The worker resolves the handle through `sandbox.py` and refuses
  any path outside it, including symlinks and `..`.
- The worker may create only the three declared file names. Anything else fails the request.
- A byte ceiling per request (computed from frames × pixels × an FFV1 bound) is enforced by
  both the worker and the host.
- On success the host runs its own verification, independent of the worker's claims:
  `ffprobe` dimensions, pixel format and frame count; `frames.json` pts are monotonic and match
  the source's decoded pts over the range; sha256 of all three files. Then it renames atomically
  to `mattes/<cacheKey>/`.
- On failure or cancel the staging directory is deleted. A startup sweep removes orphans older
  than 24 h.

The security-reviewer subagent reviews this before merge (BR4 DoD).

## Frame identity

The worker and the engine must agree on which picture a matte frame belongs to.

- Both decode with ffmpeg semantics (the worker via PyAV/ffmpeg, never `cv2.VideoCapture`), with
  edit lists honoured.
- `frames.json` stores each matte frame's source pts. The engine and the preview look up the
  matte frame **by pts** (nearest at or before, within half a frame), never by computing an index
  from `fps`.
- BR2 adds a VFR fixture and an edit-list fixture. A matte that is off by one frame on either
  fails the test.

## Desktop host (`apps/desktop/electron/capability-packs/matte.ts`, new)

Reuses `service.ts` resolution, `tracking.ts` job lifecycle patterns and the progress channel.
New IPC, added to `packages/shared-types/src/ipc.ts`:

| Method                                 | Returns                                                                                                                                        |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `capabilityPackStatus(capability)`     | `{ state: 'ready', pack } \| { state: 'missing', proposal } \| { state: 'unhealthy', reason, proposal? } \| { state: 'unsupported_platform' }` |
| `capabilityPackMatte(intent)`          | `MatteRunResultWire`: `{ ok: true, artifact, cacheHit } \| pack_missing proposal \| typed refusal`                                             |
| `capabilityPackCancelMatte(requestId)` | void                                                                                                                                           |
| `onCapabilityPackMatteProgress(cb)`    | unsubscribe fn, carrying `{ requestId, phase, completed, total, etaSeconds? }`                                                                 |
| `onCapabilityPackInstalled(cb)`        | fires after any install or uninstall completes its health check, so open panels refresh without restart                                        |

`capabilityPackStatus` is **generic** (any capability id), not matte-specific. The Mask tab's
existing tracking actions can adopt it later; that is not in scope here.

`intent` carries `timelineRevision`. The host re-checks it on completion and returns
`stale_revision` if the clip no longer exists, following the tracking path's rule.

Auto prompt: when `prompts` is empty, the host runs `subject.detect` on the clip's first
in-range frame through `subject-intelligence` (if installed) and turns the largest
person or object box into a prompt. If that pack is missing, the host returns
`needs_prompt` and the UI asks for a click. It never proposes a second download on its own.

## Retention

- Matte directories are **project-owned** (MD-4). The storage manager shows them per project
  and never evicts one that is referenced by the current timeline **or by undo history in the
  open session**.
- "Clean unused mattes" in project storage removes directories that no saved timeline
  revision references. It is an explicit, confirmed action.
- Moving or copying a project moves `.framepilot-derived/mattes/` with it. The artifact is
  addressed relative to the project root, never absolutely.
