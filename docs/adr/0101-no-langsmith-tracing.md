# ADR 0101: LangSmith is not adopted

Status: **Accepted** · Date: 2026-08-06 · Decides the §11.2 gate of
[`plan/LANGCHAIN-MIGRATION.md`](../../plan/LANGCHAIN-MIGRATION.md) (phase M11.4) ·
Relates to [ADR 0098](./0098-langchain-adapter-at-the-provider-seam.md)

## Context

The LangChain migration scheduled LangSmith as its tracing backend (M11.4), gated on a
privacy review (§11.2). That gate exists because of what FramePilot's traces would
contain.

LangSmith transmits prompts, tool arguments and tool results to a third party. In a code
assistant those are source files. In FramePilot they are **the user's own footage-derived
content**:

- transcripts of their recordings, verbatim;
- `get_frame` images of their video (ADR 0096) — actual frames, as image blocks;
- absolute file paths, which carry names, clients and project titles;
- memory entries, including the editorial preferences and corrections the user has taught
  the agent over time (PRD §8.7).

This is user content leaving the machine. It is a privacy decision, not an observability
one, and the difference matters: an observability decision can be made on engineering
grounds by the team, and this cannot.

Two facts constrain it further:

1. **`langsmith` is already installed.** It is a hard dependency of `@langchain/core`, not
   an opt-in extra, and it arrived at M1 — eight phases before this decision was
   scheduled. Tracing stays inert without `LANGSMITH_*` environment variables, but the
   control is now "this ships and must stay unconfigured" rather than "we have not
   installed a tracing client".
2. **Ambient environment variables would enable it.** A developer or CI machine with
   `LANGSMITH_TRACING` or `LANGCHAIN_API_KEY` exported for an unrelated project would
   switch tracing on **without touching any FramePilot flag**.

## Decision

**FramePilot does not adopt LangSmith.** M11.4 is closed as declined rather than deferred.

`providers/langchain-telemetry.test.ts` remains: it asserts tracing is inert and documents
the ambient-variable hazard, so the installed dependency cannot quietly become active
without a test failing.

## Consequences

### Why declining is the right answer rather than the cautious one

§11.2 states the requirements for adoption — default off, opt-in per project through
explicit UI rather than an env var alone, project content redacted by default even when
enabled, and documentation in the privacy policy and `SECURITY.md` before shipping — and
then says plainly: _if any cannot be met, do not adopt LangSmith._

The deciding consideration is not that those requirements are hard. It is that meeting
them produces something with little value left. Redacting project content by default
leaves structure and timings — and FramePilot already has both, locally:

- the **event WAL** records every run's full event stream, durably, with ids;
- `kernel/replay/` replays a run from its recorded results with zero provider calls;
- `cost-meter.ts` and `run-metrics.ts` price and aggregate every model call;
- the **M0.2 golden-session corpus** compares whole runs byte for byte.

A hosted tracer that has been redacted down to structure and timings would duplicate that,
while adding a third party to the trust boundary and a network dependency to a desktop
app whose selling point is that editing works offline.

### What we give up

Cross-run aggregate dashboards and LangSmith's prompt-experimentation tooling. Real, and
not currently a need the local instruments fail to meet. If that changes, this ADR is
revisited on its own merits — and the §11.2 requirements are the starting point, not a
formality to be re-litigated.

### The dependency stays

Removing `langsmith` is not possible without vendoring or patching `@langchain/core`, and
neither is worth it for a package that does nothing unconfigured. The mitigation is the
test, plus this record explaining to a future reader why an unused tracing client is
present in the dependency tree.

### If the decision is reversed

Implement §11.2's four requirements in full before any trace leaves the machine, and treat
the ambient-variable hazard as part of the work: FramePilot's own flag must be able to
**disable** tracing that an inherited `LANGSMITH_*` variable would otherwise enable, not
merely fail to enable it.
