# AI Edit Continuity & Timeline Motion

> Sub-plan of [`plan/PLAN.md`](./PLAN.md). Covers two coupled problems observed in
> real agent-mode use on 2026-07-16:
>
> 1. **Orchestration continuity** — the agent, finding a partially-edited
>    timeline, "starts fresh": one big `ripple_delete` clears the track and the
>    run rebuilds from scratch. Every follow-up run wipes the previous one's
>    output, so a project can never converge — the user cannot finish an edit.
> 2. **Timeline motion feedback** — AI applies, undo, and redo snap the timeline
>    to its new state with zero visual account of what changed; the user has to
>    diff before/after in their head.

**Legend:** `[ ]` not started · `[~]` in progress · `[x]` done

---

## Part A — Orchestration plan: continue, never restart

### Root-cause analysis

- The agent contract told the model to "prefer the smallest correct edits" but
  said **nothing about the provenance of the timeline it was given**. A model
  that receives a goal plus a half-edited timeline can rationally conclude the
  cleanest path is to clear and rebuild — nothing marked the existing clips as
  the user's accepted progress.
- Nothing deterministic stopped a full-track wipe. The validator checks
  structural validity (overlaps, ids, ranges) — a `ripple_delete` spanning the
  whole track is structurally _valid_.
- The failure compounds across runs: run N's partial output becomes run N+1's
  "mess to clean up", so the loop never terminates ("it will keep on ripple
  deleting").

### Defense in depth (three layers)

- [x] **A1. Prompt contract (advice).** `AGENT_CONTRACT_HEAD` now states: the
      timeline is the user's work so far (earlier runs and manual edits included);
      CONTINUE from it; never clear a track to rebuild; if the state looks wrong,
      fix the specific clips. (`packages/ai-sdk/src/prompts.ts`)
> **REMOVED 2026-08-30 — ADR 0166.** A2/A3/A5/A6 below are the historical record of a
> guard that no longer exists. It refused legitimate user-intended track clears because
> its reset-intent regex could not enumerate every way an editor asks for one, and the
> default on no match was refusal. A1's continuity instruction stays; the deterministic
> refusal is gone, and a full-track clear is now an ordinary reversible operation.

- [x] ~~**A2. Wipe guard (deterministic backstop).**~~ New
      `packages/ai-sdk/src/wipe-guard.ts`:
  - `wipeGuardFor(userPrompt, baseline)` snapshots run-start clip ids per track;
    returns `undefined` (guard off) when the user's own prompt expresses
    delete/reset intent (`delete`, `clear`, `start over`, `from scratch`, …) —
    then wiping IS the goal.
  - `detectTimelineWipe(ops, working, guard)` rejects a `ripple_delete` /
    `delete_range` that would remove **every** clip on a **multi-clip** track
    where at least one victim predates the run. The rejection note teaches the
    model to continue with targeted edits and to stop and say so if it believes
    the goal requires discarding work — only the editor may decide that.
  - Deliberate non-triggers (kept honest by tests): narrow silence-removal
    ripples, single-clip tracks, partial-range deletes, and wiping clips the
    run itself created (iteration, not destruction).
  - Wired into `runAgentCall`'s mutation path (before the validator probe) and
    threaded through both control paths — the Conductor streaming loop AND the
    legacy `agent()` loop — for parity. (`packages/ai-sdk/src/orchestrator.ts`)
- [x] **A3. Tests.** `wipe-guard.test.ts` (15 cases) + full ai-sdk suite green
      (1374 tests).

### Follow-ups

- [ ] A4. Feed a compact "edits already applied this conversation" digest into
      agent context (from the project's patch history / brain session notes) so a
      resumed conversation knows _why_ the timeline looks the way it does, not just
      that it must not destroy it.
- [ ] A5. Golden transcript test: a two-run conversation fixture where run 2's
      provider tries a full-track ripple_delete and the run must settle with the
      rejection note and a non-destructive follow-up.
- [~] ~~A6. Consider surfacing the wipe-guard rejection in the UI as a distinct
      "protected your timeline" notice~~ — moot: the guard is removed (ADR 0166).

---

## Part B — UI/UX plan: animated timeline feedback for AI edits, undo, redo

### Goals

- Every committed change to the timeline is **visually narrated**: the touched
  clips flare, and ripple shifts glide rather than teleport.
- AI-authored changes read differently from the user's own (stronger ember
  halo), so "the agent did this" is legible at a glance.
- Undo reads as "stepping back" (cool, quiet), apply/redo as forward motion
  (ember accent).
- Zero perf regression: the timeline is virtualized and memoized
  (`TimelineClip` is `memo`-wrapped; lanes are a cached subtree); animation
  must never add per-frame work during playback or dragging.
- Honour `prefers-reduced-motion` end to end.

### Architecture (implemented)

- [x] **B1. Pulse derivation** — `apps/web-editor/src/editor/useEditPulse.ts`.
      The store's `EditHistory` (entries + cursor) is the single source of truth
      for every committed edit, so the hook derives everything from history
      transitions — no store changes, no second mutation path:
  - cursor advance + entries grew ⇒ `apply`; advance over existing entries ⇒
    `redo`; retreat ⇒ `undo` (touched set includes inverse-op targets, since
    undo _restores_ clips).
  - touched ids come from patch operations (`clipId`, embedded `clip.id`,
    range-op `trackId`s); author comes from `patch.createdBy` (`agent` vs
    `user`).
  - the pulse is transient (like a toast): auto-clears after 1.6 s, token-keyed
    so identical back-to-back edits still restart the animation.
- [x] **B2. Highlight + glide** — `TimelineView.tsx`:
  - pulsed clips get a `framer-motion` overlay (`.clip-pulse`) that flares and
    fades (1.2 s ease-out); `useReducedMotion` drops the scale flourish.
  - while a pulse is live the root gains `.is-edit-pulse`, enabling
    `left`/`width` CSS transitions on `.clip-block` so clips that _shifted_
    (ripple deletes, moves) glide to their new position. Scoped to the pulse
    window on purpose: no pulse is active mid-drag, so gestures stay snappy.
  - per-clip props are primitives (`pulseKind`/`pulseAgent`/`pulseToken`), so
    the `memo` bailout keeps working — only touched clips re-render.
- [x] **B3. Styling** — token-driven additions to `styles.css` (ADR 0028
      system): ember accent for apply/redo, muted cool tone for undo, stronger
      halo for `is-agent`. Global reduced-motion kill-switch already zeroes the
      transitions.
- [x] **B4. Tests** — `useEditPulse.test.ts` (derivation: apply/undo/redo
      classification, touched-id extraction, author attribution, null on unrelated
      renders); full web-editor suite green (1134 tests).
- [x] **B5. Dependency** — `framer-motion` (MIT) added to `apps/web-editor`;
      `pnpm license:scan` clean. Used ONLY for the bounded pulse overlays (touched
      clips), never wrapped around the virtualized clip list itself.

### Follow-ups

- [ ] B6. Pulse the AI sidebar's per-turn diff cards in sync with the timeline
      pulse (same token), so cause (card) and effect (clips) read as one gesture.
- [ ] B7. "Ghost preview" during agent runs: render the pending turn diff as
      translucent ghost clips before Accept, animated in via `AnimatePresence`.
- [ ] B8. Minimap echo: touched regions blink once on the `TimelineMinimap` so
      off-viewport edits are still noticed.
- [ ] B9. Desktop-scale perf pass: verify the pulse window causes no dropped
      frames on a minutes-long, many-track project (perf-monitor budget).
