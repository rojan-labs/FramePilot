# ADR 0158 — The facts every turn needs are stated once, in one shape

**Status:** accepted
**Date:** 2026-08-29
**Schema:** unchanged
**Related:** ADR 0080 (the context manifest), plan/system-mission P1.3, ADR 0157 (the turn
before this one on the same fixtures)

## Context

Every system context opened with a prose header (`Project: "name" — 1080x1920 @ 30fps`), a
separate droppable `Selected range: 1.2–3.4s` block, and — when the editor sent its
interaction snapshot — a third block that restated the revision, the playhead **and** the
selected range in its own words. Three places, three phrasings, one set of facts; and the
second of them could be budgeted away under pressure while the third could not, so a tight
turn could lose the selection in one block and keep it in another.

The prompt-cache prefix paid for this too: each phrasing changed independently between
turns, so the head of the prompt was rarely byte-identical from one request to the next.

## Decision

One block, `STATE`, opens every system context and is never budgeted away:

```text
STATE
project  { id, aspect, fps, duration, resolution, tracks: [{ id, kind, clips }] }
timeline { selection, playhead, revision }
```

- Key order is fixed and pinned by a test (`state-block.test.ts`); the same input renders
  byte-identically. Only values that changed change.
- The block is ≤ 400 tokens on a montage-sized project (8 tracks × 40 clips) — asserted.
- The prose header, the `Selected range` tier and the interaction summary's revision /
  playhead / range lines are **deleted**, not kept alongside. The interaction summary now
  carries only referents (clip / track / effect / keyframe ids, source monitor).
- The command classifier's structured header reuses the block's duration helper instead
  of its own loop.

Deliberately **not** in the block:

- `task { goal, stage, budgetLeft }` — owned by the agent loop's briefing
  (`kernel/briefing.ts`), rewritten per stage, and placed after the cache boundary by
  design. Moving it into the cached prefix would invalidate the cache on every stage change.
- `memory { style, pacing, references }` — stays its own tier so the budgeter can yield
  it when the request's own material needs the room; the STATE block never yields.

## Consequences

- Golden sessions: `usedTokens` per request 21,633 → 21,683 (+50). The block lists every
  track's id / kind / clip count, which the prose header did not; the deleted duplicates
  did not fully pay for that on the tiny golden project. On real projects the interaction
  summary's removed lines are the larger share.
- A prompt block that restates a STATE field is now a test failure
  (`context-builder.test.ts` asserts the old phrasings are absent).
- Hosts that pass `projectRevision` and the interaction snapshot (desktop) get all three
  `timeline` values; a bare browser call renders `–` for what it does not know rather than
  omitting the key, so the prefix shape never varies by host.
