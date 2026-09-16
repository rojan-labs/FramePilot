# 01 — Architecture

## End-to-end flow

```mermaid
sequenceDiagram
  participant UI as Inspector (web-editor)
  participant Main as Desktop main (pack host)
  participant W as background-removal worker
  participant FS as project/.framepilot-derived/mattes
  participant Core as editor-core
  participant Eng as engine (export)

  UI->>Main: capabilityPackStatus(subject.matte)
  Main-->>UI: installed+healthy | missing(proposal) | unhealthy(reason)
  Note over UI: missing ⇒ warning + Install; Remove disabled
  UI->>Main: capabilityPackMatte(intent: asset, source range, prompts, revision)
  Main->>Main: cache key → hit? return artifact
  Main->>FS: create empty staging dir (request-scoped)
  Main->>W: request(subject.matte, media handle, output handle)
  W-->>Main: progress(decode/segment/refine/matte/encode)
  W->>FS: matte.mkv (FFV1 gray, lossless) + preview.webm + frames.json
  W-->>Main: result(artifact descriptor, digests, low-confidence ranges)
  Main->>FS: verify (ffprobe, frame count, pts, sha256) → atomic rename
  Main-->>UI: MatteArtifactWire
  UI->>Core: apply_matte op → validate → applyPatchChecked (undoable)
  UI->>UI: preview composites preview.webm (destination-in)
  Eng->>FS: export reads matte.mkv by pts, verifies digest, composites
```

## Ownership

| Concern                                           | Owner                                                            | Rule                                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Inference (segmentation, refinement, matting)     | `workers/background-removal` pack                                | The only place an ML runtime runs (ADR 0114). The frozen engine gains no dependency.                           |
| Where a matte is written, verified, cached        | `apps/desktop/electron/capability-packs/matte.ts` (new)          | The host issues the output handle and owns the atomic rename. The worker never picks a path.                   |
| What a matte means on the timeline                | `packages/timeline-schema` (`matte` effect, v22) + Pydantic twin | Zod and Pydantic stay in sync, with a migration.                                                               |
| Attaching, replacing, removing, refining a matte  | `packages/editor-core` operations with `apply` + `invert`         | Every change is a typed op, validated before apply.                                                            |
| Pixels at export                                  | `engine/.../render/mattes.py` (new), called from `compiler.py`    | Renders only. Never infers, and never renders a missing or mismatched matte silently.                         |
| Pixels in the monitor                             | `apps/web-editor/src/preview/clip-matte.ts` (new) + compositor    | Parity with the engine on edge shift, feather, invert and the combination with shape masks.                    |
| When the feature is usable, and how it is started | `apps/web-editor/src/components/inspector/BackgroundRemovalSection.tsx` (new) | Reads pack status before offering the action.                                                                  |

## Invariants

1. **The project never depends on the pack to render.** After a matte is computed, export and
   reopen need only the artifact, which is pinned by digest (ADR 0114: "analysis outputs are
   baked"). Uninstalling the pack disables *recomputing and correcting*, not playing or exporting.
2. **A matte is addressed by source media time.** Trims, splits, moves and ripple edits never
   invalidate it while the clip's source range stays within the matte's coverage.
3. **Preview and export agree.** The preview uses a lossy proxy of the same matte, the export
   uses the lossless master, and both apply the same refine parameters in the same order.
   Parity is asserted by test (BR5).
4. **Missing, stale or mismatched is loud.** A missing artifact, a digest mismatch or
   out-of-coverage source time is a validation issue with a remedy. Nothing falls back to
   the unmatted picture silently.
5. **Nothing downloads without approval.** The warning offers a signed proposal. The click is the consent.
6. **Media never leaves the machine.** The pack manifest has `network = "disabled"`, and the consent copy says so.

## Cache key

```
sha256( asset.contentHash
      | sourceStartPts | sourceEndPts        # coverage, including handles
      | canonical(prompts)                    # clicks, boxes, corrections (sorted, rounded to 1e-4)
      | packId@version | modelDigests[]       # from the worker's handshake
      | MATTE_PIPELINE_VERSION )              # bumped when refinement changes
```

The same request on the same media returns the existing artifact instantly. A correction
changes `prompts`, so it gets a new key and the old artifact stays referenced by undo history
(see [`03`](./03-PROTOCOL-AND-HOST.md#retention)).
