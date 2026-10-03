# ADR 0199 — The model decides; the harness informs

- **Status:** Accepted
- **Date:** 2026-10-03
- **Supersedes, in part:** ADR 0075 §3.5–3.6 (semantic-loop recovery; the stage-scoped tool
  surface), ADR 0081 (a run with no traceable mutation is `failed` — now only when the model did
  not finish on its own or was refused), ADR 0147's action-recovery surface, the research budget
  (R1), the P4.3 verification fix turn, AL37 (the advisory fix turn), AL39 (the blocked-item
  turn), the per-turn op cap ending the run, and the per-run caption restyle cap.
- **Relates to:** ADR 0196 (patterns do not read a request), ADR 0055 (a model routes a command),
  `kernel/model-plan.ts` (the model owns its plan, PR #148).
- **Decided by:** the maintainer, 2026-10-03: "handle the orchestrator in general way … instead
  of restricting on lot of things like goal and stuffs we handle it intelligently without writing
  unnecessary if else on its work … do the necessary changes even if its structural".

## Context

Desktop run `001be135` (claude-opus-5-5): sync a 6:55 Hindi voiceover with anime footage, then
caption it. The edit was poor, and almost every cause was the harness overruling its own model:

- **Tools withheld by a derived stage.** The model put the voiceover down first. That patch moved
  the derived stage to `apply`, where analysis tools were "held back for this stage", so on step
  two `describe_footage` was refused for the rest of the run. Every `apply` step also thought at
  `low` effort. The step that matched the narration to its footage — 137 picks — ran at `low`
  and laid the shots out in source order.
- **Finished replies re-opened by a check.** "The request is not met yet — continuing" re-opened
  a finished reply five times. The check said 35–81 cuts landed inside words, measured against
  the footage's own soundtrack, which was muted under the voiceover. The model said so
  correctly. Then came a hidden repair pass (a second model editing behind the first) and a
  "verification fix turn". The run ended with "Applied 162 changes, but the run could not
  finish", its edit on the timeline.
- **A cap that ended the run.** A 111-clip rebuild was refused as 222 operations (each clip's
  auto-crop counted twice). The refusal ended the run, which finished with one uncut clip.
- **Turns forced after the model stopped.** After the model asked the editor which font
  treatment they wanted, "Blocked plan items, with tools never loaded (colour, motion, effects,
  …) — one turn to try them" forced another turn. Then the shortfall rule forced another.
- **A cap on restyles.** A sixth caption restyle, the accent the editor had just chosen through
  `ask_user`, was refused with "Stop restyling".

Every one of these rules began as a fix for an earlier run, and each grew its own exemption list
as it stranded later runs. `stage-policy.ts` alone exempted `get_frame`, `detect_beats`,
`transcribe`, `measure_color`, `measure_subject`, `render_preview`, `verify_transitions` and
`get_mapped_transcript`. The rules interacted (a recovery latch that reset on every applied edit
is what turned the shortfall rule into a loop), and the model could not see most of them.

## Decision

The run's model makes the run's decisions. The harness gives it accurate information and
bounds the cost; it does not overrule it.

1. **A turn's tools are what the run has loaded.** No stage, recovery or commit-only scope
   narrows the surface (`orchestrator.ts#agentTools` takes a route and the loaded domains, and
   nothing else). Progressive disclosure (ADR 0167) is unchanged; a call to an unloaded tool
   still loads its domain and runs.
2. **Every step thinks at one effort** (`AGENT_STEP_REASONING_EFFORT`).
3. **A reply with no tool call ends the run**, except in two cases, both read off structured
   state rather than off a rule's view of the timeline:
   - the model's own plan (`update_plan`) still has an item pending or in progress, bounded by
     progress (`planProgressMark`); or a drafted planFirst step no edit has reached, once;
   - a review of the run's last edit rendered evidence the model has not seen (once per run).
4. **The deterministic checks inform, every turn.** `critic.ts#standingFindings` puts every
   finding the run is answerable for into the briefing after every edit (WHERE YOU STAND).
   These are worded as measurements to weigh — "fix what is wrong for this request; a finding
   that does not apply, leave and say why". The end-of-run self-check reports the same lines.
   It runs no repair pass, buys no fix or advisory turn, and never fails a run that delivered
   work.
5. **A run's status rests on what happened.**
   - A traceable edit landed, or the model finished on its own and nothing it tried was refused:
     `completed`. A model that answered "this is already done" is not a failure.
   - Otherwise the run was stopped with nothing to show, or every attempt was refused: `failed`,
     and the empty-run notice says why.
   - A turn that ended the run with no reply from the model (every attempt cut off, an empty
     response, an untrusted ledger) carries `unanswered` and is never read as an answer.
6. **What still stops a run:** the stall streak (`STALL_CONFIRM_TURNS` turns that learned nothing
   and attempted no new change), diminishing returns, the per-run operation cap, the step cap,
   and the editor's cost and time budgets. These bound a stuck or runaway run; they never steer a
   working one.
7. **A refusal is information, not an ending.** A turn over the per-turn cap is an ordinary
   rejection the run continues past, so the model can batch. Companion operations a tool attaches
   on its own (`ToolSpec.derivedOpTypes`, e.g. `add_clip`'s fill crop) are not counted against it.

## What was removed

- The stage gate (`stageAllowsTool` and its exemption sets) and the stage-based reasoning effort.
- The research budget (`RESEARCH_BUDGET_TURNS`).
- The action-recovery turn and its triggers (all-from-cache, semantic loop, no-progress streak).
  `kernel/loop-detector.ts` is deleted.
- The commit-only catalogue-search latch.
- The exact-repeat stop. A repeat that learns nothing climbs the stall streak instead.
- The acceptance-shortfall continuation and the AL39 blocked-item turn.
- The verify repair pass for agent runs, the P4.3 fix turn, the AL37 advisory turn, and the
  "could not finish" error card.
- The per-run restyle cap on `set_track_caption_style`.

## Consequences

- **More checks, no forced turns.** The model sees more findings than before. The whole battery
  is in front of it, not only the whole-cut checks. A check that measures the wrong thing for an
  edit costs a sentence in the reply, not a loop and a failed run.
- **Long research is bounded by cost.** A model that researches for a long time is bounded by
  the editor's budget. It is not forced to act on a turn count, which is the trade the
  maintainer chose.
- **Stable tool blocks.** The tool block no longer changes between turns. On the cache-boundary
  golden scenario the re-billed schema tokens went from 8,862 to 0. Each request carries ~620
  more tokens of tools while executing.
- **Checks must measure the right thing.** With the gate gone, the checks have to be right
  rather than enforced. The same change made `word_severed`, `mapTranscript` and captions follow
  only clips that are heard (`timeline-map.ts#clipIsAudible`), and made `search_visual` rank by
  the picture alone.
- **Do not reintroduce these one incident at a time.** A future run that seems to need one of the
  removed rules should get better information (a tool result, a briefing line, a check that
  measures the right thing) or a maintainer decision recorded here, not a new gate.
