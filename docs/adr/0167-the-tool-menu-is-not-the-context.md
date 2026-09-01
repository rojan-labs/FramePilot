# ADR 0167 — The tool menu is not the context

- **Status:** Accepted
- **Date:** 2026-09-01
- **Schema:** unchanged (runtime prompt-assembly policy; existing project files are
  untouched and every golden session replays with identical events)
- **Relates to:** ADR 0055 (model-classified routing), ADR 0057 (skills are pinned, not
  logged), ADR 0080 (the context manifest), ADR 0143/0147 (withholding a tool strands a
  run), ADR 0102 (the golden corpus)

## Context

Captured run `35746d4c` — "i dont like the current captioning, use different template" on
a 50-second talking head — spent 11 model calls, 230,473 tokens and $1.20 and put nothing
on the timeline. The immediate cause was a blast-radius cap defect, fixed separately. The
reason the run was _expensive_ rather than merely wrong is measurable in its own context
manifests, and it is not specific to that run.

Summing the 21 manifests the run recorded:

| Share    | Tokens     | Section                                      |
| -------- | ---------- | -------------------------------------------- |
| 62.6%    | 347,108    | tool schemas                                 |
| 25.9%    | 143,645    | system contract + the agent's own action log |
| 5.9%     | 32,980     | skills manifest                              |
| **4.6%** | **25,740** | **every piece of evidence about the video**  |

Its final request carried 12,823 tokens of tool definitions against 222 tokens of the
transcript it was captioning. The `retrieved_evidence` block sat at exactly 1,287 tokens
for the entire run and never grew as the run learned anything.

Stage narrowing was not addressing this. `kernel/stage-policy.ts` withholds only
`analysis`-role tools, and only during the three execution stages. Measured directly:
87 tools / 18,449 tokens at every stage except `apply`/`enhance`/`repair`, where it is
75 / 15,994 — a 13% reduction on three stages out of eight.

The consequence is not only cost. A model asked to make editorial decisions with 4.6% of
its context describing the material, and 63% describing tools it might call, is being set
up to edit badly. Every registry addition since has made that ratio worse, and the
registry grows whenever the product does.

`AGENT_LOG_CLEAR_THRESHOLD_TOKENS`'s docstring already recorded this pathology for an
earlier run (`e36235cc`: "the model was handed ~17x more context about tools it COULD
call than about what it had already found"). The response then was to raise the findings
budget — treating the symptom on the other side of the ledger.

## Decision

**Advertise the tools a run needs, and let it ask for the rest.**

A core set is always advertised: read the project, make an ordinary cut, ask the editor,
load a skill, preview, export. Everything else is grouped into domains (`captions`,
`audio`, `color`, `motion`, `effects`, `footage`, `sourcing`, `tracking`, `media`,
`professional`) that a run pins with `load_tools`. A pinned domain stays for the rest of
the run — the same lifetime as a playbook loaded through `load_skill` (ADR 0057).

The domains are **the module boundaries `tool-registry.ts` already assembles from**, not a
new taxonomy laid over them. A tool's domain is therefore a fact about where its code
lives rather than one of 87 annotations that can quietly rot, and `tool-domains.test.ts`
asserts the map and the registry agree in both directions.

### Measured effect

From the regenerated goldens, consistent across all eight recorded sessions:

|               | Before | After         |
| ------------- | ------ | ------------- |
| tool block    | 18,449 | 6,207 (−66%)  |
| whole request | 22,392 | 10,150 (−55%) |

Every line that changed in the golden sessions, the langchain fixtures and the frozen
snapshot is one of five token fields — 69 insertions against 69 deletions, with no event
added, removed or reordered. The saving is the entire diff.

## Why this does not repeat ADR 0143

ADR 0143 withheld `search_stock` from an executing run and stranded it: it had nothing to
add by `remoteId` and no sanctioned way to learn one. ADR 0147 reversed that. The lesson
was that **a withheld tool must not become an unreachable capability**, and it applies
here with more force, because this withholds far more.

Three things keep every tool reachable, and they are ordered by how little they cost:

1. **The index is always visible.** `load_tools`'s own description names every domain and
   what it is for, in outcome terms ("cut to the beat", not module names), for a few
   hundred tokens a turn.
2. **A skill brings its domains.** Loading the caption playbook pins the caption tools, so
   the craft instructions and the tools they name arrive together (`SKILL_DOMAINS`).
3. **Naming a tool loads it and runs the call.** A model that names a real tool from an
   unpinned domain has guessed correctly and is being refused over token economy, not
   policy. Spending a turn to tell it so teaches it nothing, so `admitCall` pins the
   domain and executes.

Point 3 is the load-bearing one, and it is what makes this different in kind from a
withholding rule. Every _behavioural_ rail — the stage policy, the action-recovery turn,
the commit-only latch — is unaffected and still refuses exactly as before; only the
economic gate is self-healing.

Two existing tests were pinning exemptions that this makes structural, and both now assert
the property rather than the exemption:

- **GAP-008** kept `discover_transitions` advertised during execution because withholding
  it left a run holding `add_transition` with no way to learn a transition id. Both are in
  the `effects` domain now, so a run has both or neither. `tool-domains.test.ts` asserts
  that pairing for every discovery/consumer pair in the registry, which is a stronger
  guarantee than the exemption list it replaces.
- **ADR 0143's `add_stock` test** asserted the descriptor was advertised, "not merely
  accepted when called". What has to hold is reachability: the test now runs the call from
  a turn where it was not on offer, and additionally proves the pin persists to the next.

## What was rejected

- **Raising the context budget.** The window is not the constraint; the ratio is. A larger
  window spends more to show the model the same menu.
- **Shrinking the descriptors.** Worth doing on its own merits — the three most expensive
  are `set_caption_style` (1,003 tokens), `set_track_caption_style` (965) and
  `professional_audio` (895) — but it is a constant factor against a set that grows with
  the product.
- **Picking a tool set at plan time from the classified task.** Cheaper to build, and it
  fails exactly when the plan was wrong, which is when the run most needs to reach
  something new.
- **Making the stage policy narrow harder.** Stages describe _when_ a run is acting, not
  _what kind of edit_ it is making. A caption pass and a colour pass are the same stages.

## Consequences

- The budget reservation (`agentToolCost`) still reserves the widest set, so the trimmer's
  room stays stable for a whole run even as domains are pinned. This over-reserves by
  design; the saving that matters is in what is actually sent. Tightening it is a
  follow-up, not a prerequisite.
- `load_tools` is `hostUiOnly`. Its ledger belongs to one TS orchestrator run and decides
  what that run's next request advertises; the Python sidecar holds no such ledger and does
  not assemble the request, and an external MCP client brings its own agent and its own
  tool selection. For both it would report loading something and change nothing — so
  unlike `caption_the_edit` it is **not** in `UI_INDEPENDENT_HOST_TOOLS` either.
- Adding a tool now requires giving it a domain. The registry-shape test fails otherwise,
  which is the intended cost: an unclassified tool would be advertised on every turn again.
