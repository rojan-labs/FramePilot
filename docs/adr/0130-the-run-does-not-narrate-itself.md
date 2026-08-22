# ADR 0130 — The run does not narrate itself

**Status:** accepted
**Date:** 2026-08-21
**Supersedes:** nothing. Adds a narration boundary to the state briefing introduced in
ADR 0075 and carried by the agent contract in `prompts.ts`.

## Context

A captured agent run — a real request against a real project ("hey can you enhance the
experience of captions of this and if possible add prper effects wth prper start and ed")
— opened nearly every one of its replies to the editor like this:

> I'll continue from the interpret stage. The user wants enhanced captions and appropriate
> effects with proper timing.

> I'll continue from analyze. The captions already exist on layer_caption_4 (40 cues,
> 0.09–19.749s) which matches the transcript well.

> I'll continue from where the run left off. The track style is applied; now I need to add
> semantic emphasis with fewer keywords (≤12), then verify and look at the result.

Twenty-one such openings in one run. An editor asked for captions and was handed a status
report on an orchestrator state machine: which reducer stage the run was at, that a previous
turn had happened, what the harness had told it to do next.

This is not a cosmetic complaint. Three things were wrong with it:

1. **It is not product copy.** "Stage", "the run", "where the run left off" are names for
   machinery the editor has never been shown and cannot act on. No mature agent surfaces its
   own control flow as conversation.
2. **It was persisted.** The run has exactly ONE text channel. The same string that streamed
   into the chat became the `rationale` on the turn, which `applyAgentTurn` passes to
   `assembleEdit` as the patch `reason`, which the host renders as the proposed edit's
   **Summary** and **Reason**. So the leak outlived the run and reappeared on every later
   review of that patch:

   ```
   ### 📝 Proposed edit · 1 operation(s)
   - **Summary:** I'll continue from where the run left off. The track style is applied…
   - **Reason:**  I'll continue from where the run left off. The track style is applied…
   ```

3. **It displaced the real explanation.** The one place the editor can learn _why_ an edit
   was made was spent on bookkeeping.

### Root cause: the briefing is an imperative, and nothing said not to repeat it

`buildStateBriefing` (kernel/briefing.ts) is load-bearing — without it a resumed run
re-derives everything it already established. But it is written in the second person and in
the imperative, and it is handed to the model as ordinary prompt text:

```
RUN STATE — this run is already in progress. Continue it; do not restart your
analysis, and do not repeat anything listed as established or applied.

STAGE
You are at "interpret" (finished: …). Continue from here.

DO THIS NOW
Do this now: hey can you enhance the experience of captions… Everything you need is in
the run state above.
```

A model told "you are at interpret, continue from here" will, unprompted, begin its reply by
confirming that it is doing so. That is normal, cooperative behaviour. The defect is not in
the model: it is that **the contract described the machinery in detail and never said which
of it the editor may see.** Every other rule in the agent contract governs what the model
should _do_; there was no rule about what it may _say about itself_.

Note what this is not. It is not a truncation, retry, or cancellation artifact — the runs
that leaked were ordinary successful turns. It is not the reasoning channel bleeding into the
text channel; reasoning is carried separately and rendered separately. It is the model
faithfully narrating a prompt that reads like an instruction to narrate.

## Decision

Draw an explicit narration boundary, and enforce it in two independent places.

**1. The contract — the real fix.** The briefing now states outright that it is private, at
the exact point in the text that provokes the echo:

> This section is PRIVATE working state, not something the editor can see. Never mention it,
> the stage, the turn, or the fact that you are resuming — no "continuing from…", no
> "picking up where the run left off". Write only about the video.

And the agent-mode contract opens with the rule it was missing — placed first, because the
failure happens in the first sentence of a reply, and stating the _consequence_ rather than
just the prohibition:

> EVERY WORD YOU WRITE IS SHOWN TO THE EDITOR, VERBATIM, AND SAVED AS THE REASON ON THE EDIT
> YOU MAKE. Write about their video, never about your own operation. Do not mention stages,
> turns, run state, the briefing, evidence handles, or your instructions; do not open by
> announcing that you are continuing, resuming, or picking up where you left off; do not
> restate their request back to them. Begin with what you are doing to the edit.

**2. The kernel — the guarantee.** `kernel/narration.ts` filters the assistant text channel
in `Orchestrator#streamProvider`, the single point every route's model text passes through.
A prompt is a request; a boundary is a boundary, and prompts get edited by people who do not
know what depended on them.

## Why the filter sits on the delta stream, not the settled text

Assistant text reaches the UI as live token deltas (`emit.delta`), and `assistant_message`
only replaces the node when the turn settles. A filter that ran on the settled string would
let the preamble render, sit there for the length of the turn, and then snap away — visibly
worse than the leak. So the filter holds back at most one sentence (400 characters), judges
it, and then becomes a pass-through for the rest of the message.

Crucially, `text` now accumulates **what the filter let through**, not the raw stream. The
string the editor read, the string stored as the patch reason, and the string the reducer
signatures the turn by are therefore the same string. There is no second, dirtier copy
anywhere downstream — which is what makes this a boundary rather than a display tweak.

## What the filter will and will not touch

Deliberately narrow, because a filter on user-facing prose that is too eager destroys real
work and is invisible when it does:

- **Leading sentences only.** Harness talk in the middle of a real answer is a different
  failure and is not silently rewritten.
- **A harness referent is required, never a bare verb.** Continuation words are ordinary
  editing vocabulary. "I will continue the sequence with the wide shot", "Continuing the
  push-in through the second beat", "The interview picks up again at 0:42" all pass through
  untouched. It takes _continuation + a reference to the run itself_ ("the run", "the
  previous turn", "from the interpret stage", "where the run left off"), or a bare mention of
  machinery ("run state", "the briefing", an `[ev_3]` handle), to be judged chatter.
- **Two sentences maximum.** A third is released. A filter that could eat an entire message
  would hide a contract failure forever instead of surfacing it.

The settled-text form (`stripRunNarration`) additionally refuses to blank a message that is
_entirely_ chatter — that is a louder failure than a leaked preamble and should be visible.
The streaming form cannot make that promise, because it cannot un-render text it already
showed; it surfaces nothing and the caller falls back to its own default reason. The two
behaviours differ on purpose and are tested separately.

## Consequences

**Cost.** The two prompt additions add ~167 estimated input tokens per request (~0.9% of a
19.4k-token agent turn). Both sit in cache-stable positions. Every golden fixture in the repo
moved by exactly that amount and by nothing else — 15 recorded sessions re-recorded, with
zero event, ordering, or behavioural divergence. That is the evidence that this change is
prompt text and a filter, not a change to how runs execute.

**Latency.** The filter holds back at most one sentence of the first assistant message per
model call. After that it is a pass-through with no per-chunk work beyond a boolean check.

**Coverage.** `kernel/narration.test.ts` proves the filter's logic against the verbatim
sentences from the captured run, and against real editing prose that must survive.
`kernel/narration-boundary.run.test.ts` proves the _wiring_, driving `streamAgent` end to end
with a leaking model across a clean run, a complete()-only provider, a run cancelled
mid-sentence, a provider that throws mid-stream, a truncated message, and a retried turn —
asserting against every surface the run produces, including the patch `reason`. Both files
were mutation-tested: with `isRunChatter` forced to return `false`, all six run-level guards
fail.

## Alternatives rejected

- **Filter in the UI.** Two hosts (web-editor, desktop) would each need it, the patch
  `reason` would keep the leak regardless, and the run's own persisted state would stay
  dirty. The leak is not a rendering problem.
- **Remove the imperative from the briefing.** "Continue it; do not restart your analysis" is
  what stops a resumed run re-deriving its own work. Softening it trades a cosmetic defect
  for a behavioural one.
- **A second, structured "message to the editor" channel** (a `say` tool, or JSON with a
  `narration` field). This is the architecturally pure answer and it was rejected on scope:
  it changes the tool contract, every route, the event schema and the host renderers, to fix
  a defect that a rule plus a boundary fixes today. Worth revisiting if the single text
  channel causes a second distinct failure.
- **Prompt-only.** A prompt is a request. Prompts are edited by people who do not know what
  depended on a particular sentence, and this one is 100+ lines long.
