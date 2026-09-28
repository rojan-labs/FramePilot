# ADR 0196 — The router reads what a request asks for; patterns do not

- **Status:** Accepted
- **Date:** 2026-09-28
- **Relates to:** ADR 0055 (a model, not a keyword table, routes a command), ADR 0147 (progress
  guards), ADR 0167 (progressive tool disclosure). Issue #136 tracks the readers this ADR does not
  yet replace.

## Context

Desktop run `6cb12e30` (claude-opus-5-5, agent mode, a 27,043-character travel-reel brief) did
95 correct edits and ended **failed**. The brief said "MASTER: … 58–62s" for the deliverable and
"Use only the best 2–4s of each" for shots. `critic.ts#explicitDurationTarget` anchors on words
like `best` within forty characters of a number and a time unit, and read the second phrase as a
3-second deliverable. That one misreading became an acceptance criterion the run could not
satisfy without deleting its own work:

- seven "The request is not met yet — continuing. Timeline is 60s but the target is 3s" recoveries;
- the briefing's DO THIS NOW pinned to that sentence for the rest of the run, so the model kept
  ending turns to explain itself instead of working;
- an `ask_user` whose answer ("Keep the 60s master") nothing could apply to the criterion;
- a verification repair turn that could change nothing, and a final error card.

The reader had been patched brief by brief (`PER_UNIT_QUALIFIER` for "0.3–0.6s per clip", the
range reader for "20–35 seconds"); each patch fixed the brief in front of it. The follow-up
message "load the tools and complete the task" failed the same way in a second reader: the
continuation word list (`kernel/continuation.ts`, at most four words) kept it as the objective,
so the next runs lost the brief entirely.

The same run was told, as "acceptance criteria", capability limits triggered by keywords in the
brief — "track_object only ATTACHES a tracker … tell the editor to draw the mask" and "Sound
effects cannot be sourced here". Both were false on the desktop; the model believed them. The
completion receipt's "Not attempted" block keyword-matched the brief without negation handling
and told the editor "you asked for stock" (from "No stock transitions") and "you asked for
important" (from "Reframing (important)").

## Decision

1. **What a request asks for is read by the model that routes it**, not by patterns. The command
   classifier (ADR 0055) already reads the whole message on every turn; for `edit` it now also
   returns `continues` (which earlier request, shown to it numbered, this message carries on) and
   `length` (the finished video's stated length, one number or a range) with `quote`, the words
   that state it.
2. **Every reading is grounded before it is used.** A `length` is kept only when its quote appears
   in the message or in the request it continues (case, whitespace, dash and quote-mark variants
   folded); a `continues` only when it names a request that was shown. An ungrounded reading is
   dropped — a missing criterion costs a check, a wrong one fails a run that did the work.
3. **One reading feeds everything.** `streamAuto` passes it as `AgentOptions.requestReading`; the
   run's objective, its acceptance criteria and the Critic's duration check all resolve from it
   (`acceptance.ts#statedDuration`, host target first). Criteria quote their source ("runs 58–62s
   (the request says “58–62s”)"), so a misreading is visible rather than argued with.
4. **The pattern reader is deleted, not kept as a fallback.** Entry points that skip the router
   (`streamAgent` direct) state no length criterion unless the host passes one.
5. **What the product cannot do is a product fact, not a keyword trigger.** The agent contract
   states the real limits once, unconditionally (no text-to-speech; rendering and export happen in
   the Export dialog). The keyword-triggered labels and the keyword-matched "Not attempted" block
   are deleted; the fix for a domain the model never loads is discovery (a registry-derived domain
   list in the contract, accurate domain summaries), not a guess about what the editor meant.

## Consequences

- The classifier call reads earlier user messages (newest four, ≤ 40,000 characters) on
  continuation turns, so a follow-up turn under a long brief costs that much more input on the
  small tier.
- A host `durationTargetSeconds` is now listed as a criterion as well as checked; before, the
  Critic checked it and the objective never said so (the golden snapshot changed accordingly).
- Golden and replay harnesses that call `streamAgent` directly no longer get a length criterion
  read from their prompts; cases that need one should pass it explicitly.
- Shot count, per-clip coverage, requested elements, file/preview/memory requests and cutaway caps
  are still pattern readers (issue #136). They should move to the same grounded reading.
