# ADR 0059 — The agent may ask the editor (`ask_user`)

- **Status:** Accepted
- **Date:** 2026-07-15
- **Relates to:** ADR 0055 (never advertise a capability that does not exist),
  ADR 0033 (streaming event model), P11.3 (the plan-approval gate this borrows
  its shape from), `plan/AGENT-ORCHESTRATION-HARDENING.md` (W2).

## Context

When the agent reached something only a human could settle, it had two options:
guess, or stop. Both are bad, and W1 made the case common rather than rare — a
model that cannot see the footage (no multimodal path exists; see
`0057`/W1) is routinely one question away from being useful:

> "This footage has no faces to track. Do you want a punch-in instead, or leave
> the framing alone?"

Guessing is the worse option. FramePilot edits the user's own footage, and a
confident wrong assumption costs them work and trust. The pre-existing
plan-approval gate (P11.3) proved the run _can_ pause for a human — but it
pauses for one fixed question we wrote, at one fixed moment we chose. The
situations worth asking about are the ones nobody enumerated.

## Decision

1. **`ask_user` is a tool the model calls with its own question.** It supplies
   `question` and, when it is a choice, 2–5 `options` (label + optional
   description); omitting options invites a free-text answer. **No question text
   is hardcoded anywhere.** The orchestration carries whatever the model
   authors, so an unanticipated situation works exactly like an anticipated one.
2. **`ask` is its own `ToolKind`.** It is the only tool whose answer comes from
   a _person_: not in-process (`read`/`mutate`), not the engine sidecar
   (`analysis`/`action`). Making it an `action` would have dispatched it to the
   sidecar executor, which cannot answer a question about what the editor wants.
3. **No Conductor effect.** A question IS a tool call, so the turn that asks
   simply awaits its own result — exactly as it already awaits an ffmpeg
   analysis — and the answer lands in the action log by the ordinary route, so
   the next turn plans from it with **no reducer change at all**. A dedicated
   `await_answer` effect would have added a second pause mechanism for no gain.
4. **The gate is live; the wire is data.** `AskUser`/`AskUserGate` join
   `run-controls.ts` beside the approval gate, for the same reason: a
   Promise-resolving gate cannot cross the kernel's marshallable command
   boundary. Unlike the approval gate, it resolves **keyed by `toolCallId`**, so
   a late answer to an abandoned question can never satisfy the current one.
5. **Desktop is not a follow-up.** Desktop is the #1 target, and the existing
   run-controls are browser-only because IPC cannot carry live functions. The
   split resolves it: the **gate lives in main** beside the run it blocks, the
   question crosses to the renderer as an ordinary `ask` event on the existing
   push channel, and the answer returns as plain data on a new IPC channel.
   Nothing live is marshalled. The answer is **sender-scoped exactly like
   abort** — an answer is an instruction the model acts on, so another window
   must not supply one — and is validated like any untrusted renderer input
   (bounded length; malformed input drops the message and leaves the question
   pending rather than killing a healthy run).
6. **`hostUiOnly` keeps it off the MCP surface.** That surface has no UI to
   render a question in and nobody to answer it, so advertising it there would
   promise a capability it does not have (ADR 0055). An MCP client is itself an
   agent with its own user: if it wants to ask, it asks them. Same reason it is
   absent from the Python registry — the sidecar cannot ask anyone anything.
   This is the first registry-vs-MCP asymmetry; the parity test encodes it as a
   principle rather than an exception.
7. **Unwired hosts degrade honestly.** The non-streaming paths (the legacy loop,
   the repair pass) have no UI. The model is told plainly that it cannot reach
   anyone, that it must use its judgement, and that it must disclose the
   assumption in its summary. It is **never** handed a fabricated "the editor
   said yes" — the worst possible outcome of asking.
8. **Dismissal is a stop, not an answer.** Cancelling settles the call
   `cancelled`, which the turn loop already treats as a stop. The model is told
   nothing about what the editor "wanted".

## Consequences

- The honest answer to "I can't see the footage" stops being silence or a guess.
  W1 removes the fabrication; this gives the model somewhere to go instead.
- Asking costs a turn and blocks on a human, so the tool description is blunt
  about when not to: never ask what a tool can answer, never ask twice.
  `awaiting_answer` reads as "needs your attention", never a spinner implying
  progress that is not happening.
- The free-text field is always offered, even alongside options: a model can only
  guess at the choices, and the editor must never be trapped inside its guesses.
- One question at a time per run, by construction — the turn that asked is
  blocked on it.
