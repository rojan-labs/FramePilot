# ADR 0079 — Tool memory classification belongs to the registry, not to its consumers

- **Status:** Accepted
- **Date:** 2026-07-27
- **Supersedes parts of:** ADR 0075 (durable run working state) — the design stands; the
  two lookup tables that gate it move.
- **Related:** ADR 0057 (runtime skills), ADR 0068 (action recovery after cached reads),
  ADR 0074 (research budget), ADR 0077 (layered prompt architecture)

## Context

Runs kept re-doing expensive work inside a single task: re-reading the timeline,
re-browsing the media bin, re-detecting the beat, re-indexing media, re-mapping footage.
The reported diagnosis was that FramePilot had no run memory, no execution state machine
and no plan locking, and that the orchestration engine needed rebuilding.

That diagnosis was wrong about the cause. All three exist and are correct:
`kernel/working-state.ts` holds durable facts/decisions/objectives with revision-scoped
invalidation, `kernel/stage-policy.ts` runs a forward-only nine-stage machine that
withholds reconnaissance tools once a plan locks, and `kernel/briefing.ts` renders the
"ESTABLISHED — do not gather again" briefing that replaces the rolling note window.

The defect was that two small lookup tables gating all of it had drifted from the registry.

### Why the drift was invisible

Both tables were **opt-in allowlists with an unsafe default**:

| Table | Location | Unlisted tool becomes | Consequence |
| --- | --- | --- | --- |
| `INSPECTION_TOOLS` / `ANALYSIS_TOOLS` / `GUIDANCE_TOOLS` | `kernel/stage-policy.ts` | role `other` | `distil()` records **no fact**, so the tool never appears in the briefing; `stageAllowsRole` keeps it callable after the plan locks |
| `REVISION_INDEPENDENT_TOOLS` | `kernel/evidence-store.ts` | `timeline_dependent` | `invalidate()` evicts the payload on **every** applied patch; `onProjectRevisionChanged` drops the matching facts |

Each default reads as the conservative choice, and each is — considered alone. A stale
arrangement fact is genuinely more dangerous than a re-read. But the *aggregate* of the two
defaults is "this tool has no memory at all", and nothing reported that. A tool omitted from
both tables behaved exactly like a tool nobody had thought about, because it was.

By the time this was traced, the registry held 62 tools; the two tables between them omitted
a dozen and named three that no longer exist.

### The failure the user actually saw

`detect_beats` was absent from **both** tables. A beat-synced montage applies one cut per
beat, so:

1. Turn N runs `detect_beats`. Role is `other` → no fact recorded. The briefing never says
   the beat map is known.
2. Turn N+1 applies the first cut. `invalidate()` sees `timeline_dependent` and evicts the
   payload; the `recall_evidence` handle dies with it.
3. Turn N+2 has no memory that beats were found and no way to retrieve them. The only
   available move is to run `detect_beats` again.
4. Repeat for every beat in the montage.

`index_media`, `describe_footage`, `find_similar` and `list_assets` failed the same way —
and `list_assets` is the clearest illustration of why per-tool judgement is required:
adding a *clip* does not add an *asset*, so evicting the bin listing on a cut is simply
wrong. The `beat-synced-editing` playbook declares five of the misclassified tools among
its sixteen, which is why that workflow looked worst.

## Decision

**One explicit classification table, owned next to the registry, parity-tested against it.**

`packages/ai-sdk/src/tool-classification.ts` declares, for every registered tool, a
`ToolRole` (what the call teaches the run) and a `ToolEvidenceScope` (when the result stops
being true). `stage-policy.ts` and `evidence-store.ts` both delegate to it and keep no
local sets.

Three properties make this different from what it replaces:

1. **Explicit for every tool.** There is no "unlisted" state for a registered tool, so the
   dangerous default is unreachable in the path that matters. The kind-derived fallback
   survives only for names the registry does not know — an MCP client's tool, a test double
   — and it warns.
2. **Parity-tested in both directions.** `tool-classification.test.ts` asserts every
   `TOOL_REGISTRY` name is classified *and* that nothing classified has been deleted from
   the registry, plus that the table and the registry agree on which tools mutate. **A new
   tool fails CI until somebody decides what it means for the run's memory.** That is the
   whole point: the previous scheme let that decision be made by omission.
3. **Behaviour-pinned, not table-pinned.** The regression tests assert the montage survives
   thirty consecutive cuts with its analysis intact, not that a particular `Set` has a
   particular member.

### Finer-grained invalidation without a schema change

The store needs distinctions a fact does not. `list_assets` should survive every cut but not
`add_asset`; `get_transcript` should survive every cut but not `set_transcript`. So
`ToolEvidenceScope` adds `asset_dependent` and `transcript_dependent` alongside the original
two, and `invalidate()` keys them off the operation types that actually landed — generalising
the transcript special-case that was already there.

Facts stay binary. A fact is a one-line conclusion carrying no payload, and it is only ever
invalidated by a revision change — which is exactly what the two new scopes are defined to
survive. `factScopeOf` therefore narrows both to `revision_independent`, so
`working-state.ts`'s persisted `FactScope` and its schema version are untouched. The cost is
a cheap stale conclusion ("the bin holds 12 assets") after a mid-run asset add; the payload
it cites is invalidated correctly either way.

### Deliberately kept: `search_media` ages with the timeline

Its siblings are all sidecar analyses of source media and so are revision-independent, but
`search_media` returns timeline seconds and clip placements. It stays `timeline_dependent`.
This is the case that rules out deriving classification from `kind` alone, and it is pinned
by a test that says so.

## The second finding: the cached prefix did not exist

While tracing the token fluctuation in the same runs: `agentStableInstruction` (E3.2)
memoizes the agent contract + committed plan + pinned skill playbooks so they are
byte-identical across a run. That work was buying nothing. `agentMessages` emitted the head
**after** `buildContext`'s project block, which re-renders the timeline summary from the
mutating working copy — so every applied patch changed the prompt ahead of the head and
re-billed all of it, up to eight pinned playbooks, on the next turn.

The Anthropic provider compounded it. Its only breakpoints were on the system block and the
tool array, and its comment recorded the assumption that everything in a user message was
per-turn volatile. The head is not.

The head now sits in its own message between the system/history prefix and the turn-varying
tail, flagged `cacheBoundary: true`; the provider places a second breakpoint at its end.
Everything genuinely per-turn — project snapshot, request, state briefing, steering, action
log — follows it.

`cacheBoundary` is **advisory**. Providers without prompt caching ignore it, and a wrong
value costs cache efficiency, never correctness.

## Consequences

**Good**

- Expensive analysis is paid for once per run unless something actually invalidates it.
- Executing runs are genuinely closed to fresh reconnaissance: the misclassified tools were
  the ones slipping through the stage gate. The frozen golden's prompt is **338 tokens
  smaller** for exactly this reason, with a byte-identical event stream.
- The pinned playbooks are billed once per run instead of once per turn after each edit.
- Misclassification is now a CI failure rather than a silent behaviour change.

**Costs / risks**

- One more file to update when adding a tool. This is intentional — the test makes it
  mandatory, and the omission it forces you to notice is the bug this ADR exists for.
- A stale bin/transcript *conclusion* can survive a mid-run asset add or transcript rewrite
  (see above). Bounded and cheap; the payload invalidates correctly.
- `cacheBoundary` placement is a heuristic about what is stable. Wrong placement degrades
  caching silently — hence the test asserting the head contains no timeline block.

## Alternatives rejected

- **Derive classification from `kind` alone.** Handles ~55 of 62 and gets `search_media`,
  `list_assets`, `session_context` and the unavailable tools wrong — silently, which is the
  failure mode being removed.
- **Put `role`/`scope` on each `ToolSpec` literal.** Genuinely single-source, but a 62-site
  diff through the registry's constructor helpers for no additional guarantee: the parity
  test already makes omission impossible either way.
- **Rebuild the orchestration engine**, as the original report proposed. It would have
  re-implemented ADR 0073/0075/0077 at multi-week cost and high regression risk, and would
  not by itself have fixed anything — a rebuilt engine with the same two allowlists exhibits
  the same behaviour.

## Verification

- `tool-classification.test.ts` — two-way registry parity, mutation agreement, the eight
  specific regressions, fallback behaviour.
- `evidence-store.test.ts` — a montage survives thirty consecutive cuts with beat map, media
  index, bin and shot descriptions intact and recallable; `add_asset` still drops the bin.
- `stage-policy.test.ts` — `apply`/`enhance`/`repair` withhold re-analysis and guidance while
  keeping `get_timeline` and `recall_evidence` open; planning stages keep everything open.
- `orchestrator-stream.test.ts` — the head message is byte-identical across a mutating turn,
  carries `cacheBoundary`, and contains no timeline block.
- `providers.test.ts` — the breakpoint lands on the flagged message, on the **last** flag
  when several are present, and messages stay plain strings when nothing is flagged.
- Workspace green (`pnpm verify`, 16/16; ai-sdk 1,917 tests). ai-sdk coverage matches the
  pre-change baseline on all four metrics.
