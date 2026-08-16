# ADR 0106: One clip snapshot per track in a patch inverse

Status: **Accepted** · Date: 2026-08-07 · Phase 1.3 (patch engine) of
[`plan/PLAN.md`](../../plan/PLAN.md)

## Context

Every timeline edit is a reversible patch, and the inverse must be exact. Most operations
are lossy — `delete_range` does not carry what it deleted, `split_clip` does not carry the
clip it replaced — so `invertOperation` inverts them by snapshotting the **whole track**
they touched (`restoreFor` in `operations.ts`). That is exact and needs no per-op payload,
which is why it was chosen.

It is also quadratic. A patch that touches one track N times stores N snapshots of O(N)
clips. Nothing surfaced this while patches were small; caption generation made every patch
large, because generating captions rewrites an entire track in one patch.

Measured on a real project (`project_my_new.fp.json`), one
"Generate 434 captions on layer_caption_4" patch:

|                            | value                        |
| -------------------------- | ---------------------------- |
| forward operations         | 1,312 ops, **0.25 MB**       |
| inverse operations         | 1,312 ops, **115.5 MB**      |
| `restore_clips` ops        | **877**                      |
| clips carried across them  | **192,307** (track holds 443)|

The snapshot sizes are a perfect staircase — 433, 432, 431 … 441, 442, 443 — each one the
entire track. Across that project's whole history: **174.2 MB of inverse against 0.6 MB of
actual project content**, i.e. 99.8% of the file was undo data.

Three consequences, in increasing order of severity:

1. **Project files became unopenable.** Five of the user's projects were 71–384 MB. Parsing
   one produced a multi-GB object graph and aborted the Electron **main process** with
   `FATAL ERROR: JavaScript heap out of memory` — the whole app died at startup.
2. **Undo was silently lost.** `toPersistedHistory` keeps the newest entries fitting a
   4 MiB durable budget and drops any single entry exceeding it *whole*. A 115 MB entry
   never fits, so the biggest edit a user makes is precisely the one that cannot be undone
   after a restart — and nothing said so.
3. Every agent commit re-materialised this in the renderer via `replaceAuthoritativeProject`.

## Decision

`invertPatch`/`invertProjectPatch` post-process the generated inverse with
`collapseClipSnapshots`: **per track, keep exactly one `restore_clips` — the pre-patch
state — appended last; drop every other inverse operation that writes only that track's
clips.**

This is sound because `restore_clips` is an *absolute* write of one track's clip array:

- Applied last, it fixes that track's final content regardless of anything before it.
- The restored clips carry their own per-clip state (cue, style, crop, speed, keyframes),
  so a targeted inverse for any of those on the same track is redundant.
- Dropped operations addressed only that track, so no other track's inverse is affected.
- `applyRestoreClips` replaces `clips` only, so **track-level** state — `captionStyle`,
  flags, effect layers, layer order — is *not* covered and its inverses are kept.

The collapse is conservative by construction. It returns `null`, leaving the inverse
byte-for-byte as before, whenever it cannot positively prove safety: a clip it cannot
resolve to a track, a track the patch itself adds or removes, a cross-track `move_clip`
straddling the collapsed set, or any operation type it does not recognise. It can shrink an
inverse; it can never change what that inverse does.

## Consequences

**Measured.** A 443-cue track rewritten by 1,311 operations: inverse **39.37 MB → 0.05 MB
(737×)**, undo still exact. Replayed over the real project's full history: **174.2 MB →
0.5 MB (327×)**. Project files that were 384 MB now save at roughly 1 MB, so they parse in
milliseconds and undo fits the durable budget with room to spare — meaning restart-surviving
undo now actually works for the edits that most need it.

**Cost.** `invertPatch` still replays the patch forward to reconstruct intermediate states
(~480 ms for 1,311 ops); the collapse adds one linear pass. Unchanged.

**Not addressed here.** Legacy files already on disk keep their bloated history until they
are next saved; `readProjectFile` refuses to parse a history over 64 MiB and opens the
project without it, so they self-heal on the next save rather than crashing the app.

**Alternatives rejected.** *Making each lossy op carry its own undo payload* would be the
textbook fix, but it means touching all 35 operation types and their apply/invert/validate
paths — a far larger change to the invariant this ADR protects, for the same result.
*Deduplicating adjacent snapshots* does not work: the real inverse interleaves
`set_caption_cue` and `restore_clips` one-for-one, so no two snapshots are ever adjacent.
