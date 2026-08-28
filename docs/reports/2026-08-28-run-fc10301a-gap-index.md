# Run `fc10301a` — gap index

The 61-photo montage run that this branch's fixes come from. It placed 34 of 61 photos over
0–24.079s of a 47.8s music bed, applied no motion, transitions, grade or crop, and settled
`failed` with 11 of 30 steps unspent.

This is the **index**: what each gap was and where it was closed. The long form — per-gap
run transcript excerpts, code citations and line numbers — is the maintainer's local
`TOOL_REPORT.md`, which is deliberately not committed. Everything a reader needs to find the
fix and its test is here.

Decisions taken along the way: [ADR 0154](../adr/0154-a-thing-that-says-nothing-still-costs-a-model-turn.md)
(payload), [ADR 0155](../adr/0155-a-frame-the-renderer-fits-into-needs-a-shape-to-fit.md) (schema v21).

| Gap | Symptom | Where it was closed |
| --- | --- | --- |
| GAP-001 | The run's own acceptance criteria were computed, stored, hidden from the model, then used to fail it | `kernel/briefing.ts` — `WHAT DONE LOOKS LIKE`; the suppression test was inverted |
| GAP-002 | The exact-repeat spin guard killed a healthy run, and said nothing | `turnSignature` carries the project revision; the exact-repeat arm now says why it stopped |
| GAP-003 | Every applied patch wiped the run's timeline memory, forcing the read that tripped GAP-002 | `arrangementLine` fact recorded after each patch |
| GAP-004 | A 61-shot brief is arithmetically impossible under per-clip tool granularity | `add_clips` (`domain-tools/timeline.ts`, `ai_tools/handlers.py`) |
| GAP-005 | `add_clip` was exempt from frame-grid quantization, so no cut in a 30fps brief was frame-aligned | `editor-core/src/frame-grid.ts#snapAddClip` |
| GAP-006 | Coverage acceptance could not read a stills brief, so motion / grade / crop were never checked | `acceptance.ts#explicitCoverage` — stills vocabulary, per-line, prohibition-aware |
| GAP-007 | The repair pass could not fix the failure that mattered — 23.7s of black | `critic.ts#repairTrailingSoundOverrun` (deterministic, tried before the model) |
| GAP-008 | Entering `apply` permanently withheld footage inspection and the effect/transition catalogues | `stageAllowsRole` admits `guidance` during execution stages |
| GAP-009 | Nothing knew a photo was landscape, and the renderer letterboxes rather than fills | Schema **v21** `AssetMedia.width/height`; `checkReframeCoverage` warn → fail |
| GAP-010 | `warn` check details were counted and then discarded | `VerifyResult.warnedChecks`, surfaced as notifications |
| GAP-011 | `add_music` rejected the asset id it had itself minted | `add_music` local-id refusal text corrected |
| GAP-012 | The media bin was not part of the agent's project view | Media bin added to the project view |
| GAP-013 | "Evaluate multiple tracks and pick the strongest" was not possible with the tools provided | `search_music` states what the catalogue does not publish |
| GAP-014 | No in-flight feedback on duration or picture coverage — the fatal decision was silent for ten minutes | `critic.ts#standingAgainstAcceptance` → `WHERE YOU STAND` |
| GAP-015 | Interpretation and planning gates were satisfied by echoing the request | A drafted plan is the run's own reading of the request |
| GAP-016 | A repair pass that ran and did nothing was invisible | `VerifyResult.repairOutcome` + `describeRepairOutcome` |
| GAP-017 | `apply_color_grade` had an untyped, undocumented parameter bag and no discovery tool | `apply_color_grade` contract text |
| GAP-018 | `get_project_state` re-dumped the media bin `list_assets` had just returned | `assetSummary` tally; see [docs/api/ai-tools.md](../api/ai-tools.md) |
| GAP-019 | Three project-revision counters disagreed | Reconciled to one |
| GAP-020 | The agent route's context manifest was message-granular, so it could not show what the model saw | Tier account carried out of `assembleContext` |
| GAP-021 | "Create the finished Instagram Reel" was not read as a request for a file | `acceptance.ts#DELIVERABLE_HEADING` (section form, linear-time) |

**Not yet measured.** The next run of the same brief settles whether these hold end to end.
