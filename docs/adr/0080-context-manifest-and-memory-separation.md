# 0080. The context manifest, and separating memory from prompt occupancy

- Status: Accepted; extends ADR 0075 (durable run working state) and ADR 0078 (context visibility)
- Date: 2026-07-27

## Context

ADR 0078 added a `context_usage` stream event carrying `{usedTokens, contextWindow,
estimated}` and rendered it as a ring in the composer. That was the right direction and
the wrong resolution. Three concrete defects followed from it.

**One number, no attribution.** Request occupancy legitimately moves between calls: one
call carries a large tool result and the next replaces it with a summary; a skill loads
for one stage and not the next; the tier budgeter trims the transcript. With nothing to
attribute the movement to, a drop from 60K to 12K reads as "my conversation was erased".
It was not — the durable run memory (ADR 0075), the project memory and the committed
decisions all survived — but the UI had no way to say so, and the tooltip spent its three
lines restating the same fact (`17K / 190K`, `16,984 / 190,000 tokens`, `173,016
remaining`) instead of explaining it.

**The capacity was a constant, not the model's.** `contextWindowFor` returned
`DEFAULT_CONTEXT_BUDGET.contextWindow` — 190,000 — for every provider and every model. A
Claude Opus 4.8 run with a 1M window and a 32K local model both reported 190K, so the
meter under-reported pressure on the small model, over-reported it on the large one, and
did not move at all when the creator switched model in Settings.

**Nothing checked that a request still knew what it was doing.** A turn could go out
mid-run with no objective and no next action. The model then has nothing to continue
from, so it does the only thing available: re-reads the timeline, re-browses the media
bin, re-derives the beats, re-proposes a plan the run already committed to. That is the
behaviour reported as "the agent loses its memory". The harness was handing it an
amnesiac prompt.

The underlying error is treating conversation history, current request prompt, provider
capacity, durable run memory, project memory, tool-result storage and remaining capacity
as one unstable number.

## Decision

**Every model request produces a context manifest.** A typed record of the sections it
contained (with cost, and with the omitted ones kept and labelled), the compaction event
if any, the durable run memory that outlives the request, and four token figures that are
kept distinct and never conflated: the model's context limit, the tokens reserved for the
reply, the input this request occupies (estimated before send, replaced by the provider's
reported figure when it settles and never presented as exact before), and the remaining
capacity derived from them. The manifest rides on `context_usage`; the three scalar fields
remain as a projection so existing consumers keep working.

Manifests are payload-derived by default, so agent-loop calls that assemble their own
messages are accounted for, with tool schemas counted as the real prompt cost they are.
Where the caller holds `assembleContext`'s tier account it supplies that richer
breakdown — the only way a trimmed tier can be reported at all, since a trim leaves no
trace in the payload. Payload not covered by the account is shown as its own row rather
than silently under-reported.

**Capacity comes from the selected provider and model.** A per-model table resolves by
exact id, then longest prefix, then a per-provider floor. An unknown id falls back
conservatively and reports `source: 'provider_default'`, so an assumed capacity is
labelled rather than presented as fact. `AiProvider` exposes the `modelId` it will
actually send.

**Invariants are asserted before each agent turn.** An objective, a next action, a
revision that has not regressed, and something committed once the run is executing. What
state already implies is repaired deterministically — the creator's own request stands in
for a missing objective; the stage and outstanding objectives derive a missing next
action — never by a model call and never by a guess. An executing run with nothing
committed is surfaced as a warning rather than repaired: an invented plan is worse than an
honest gap, because the run would then execute against something nobody chose.

**The UI reads the manifest instead of reverse-engineering occupancy.** One string on the
surface — `17K/1M`, used over capacity — and a hover/focus tooltip behind it that gives
the exact figures, the room left against the reply reservation, when history was last
compacted (only if it ever was), and, in plain words, that a moving number is not lost
memory. An active request dims the figure rather than animating it. A development-only
inspector adds the identifiers and a diff of the two most recent requests, paired by
section label.

*Amended 2026-07-27:* the first implementation put this behind a click-opened panel that
also itemised every context section, the durable/project-memory rows and the model id.
Correct information, wrong surface — the composer is a writing surface, and a ledger
beside the send button is read once and ignored after. The manifest still carries all of
it (the inspector and this document use it); the creator-facing readout is now the number
plus the reassurance, on hover.

## Consequences

- A change in reported occupancy always arrives with its cause attached, in the product
  for creators and in the inspector for developers.
- Switching model moves the reported capacity, because the capacity is the model's.
- The estimate and the provider's figure are both retained, so the ≈4-chars-per-token
  heuristic's drift stays measurable rather than unfalsifiable.
- A mid-run turn missing its objective or next action is repaired or reported, so the
  model no longer compensates by re-exploring the project.
- The capability table is a cache and will drift as vendors ship models. Drift costs an
  inaccurate meter, never a wrong edit; the conservative floor keeps an unknown model
  under-promising room rather than overflowing the provider.
- The manifest is derived telemetry, never authority. The project file and the reversible
  patch log remain the source of truth, and a missing manifest degrades the UI to "no
  breakdown available" rather than to a wrong number.
- No timeline or project schema change, and no new IPC channel: the manifest travels on
  the existing `context_usage` event.
