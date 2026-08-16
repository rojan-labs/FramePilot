# Professional operation scorecard

FramePilot derives its professional-operation evaluation manifest from the same capability registry
the agent can inspect. A capability cannot be advertised as editable without one explicit fixture
registration covering these required stages:

`resolve → compile → validate → apply → invert → verify → persist/reload → cross-host`

## Current registration

| Domain        | Registered editable rows | Explicitly unsupported |
| ------------- | -----------------------: | ---------------------: |
| Timeline      |                       12 |                      0 |
| Motion        |                        5 |                      0 |
| Color         |                        7 |                      0 |
| Tracking/mask |                        1 |                      1 |
| Audio         |                        8 |                      0 |
| **Total**     |                   **33** |                  **1** |

Automatic subject tracking is the unsupported row. Its runtime reason is preserved verbatim: no
approved automatic CV tracker or segmentation engine is bundled. It is not counted as a passing
fixture.

## Executable cases

Every registered fixture id is backed by a runnable case in `PROFESSIONAL_EVAL_CASES`. Each case:

1. builds a fresh fixture project and a live interaction snapshot;
2. resolves its referent through the real resolver or domain controller — never a guessed id;
3. compiles the resulting semantic command with its real compiler;
4. runs the shared evaluator: patch validation, application, exact inverse restoration, canonical
   project save/reload, JSON-stable host transport, and temporal evidence-request planning;
5. asserts the **editorial outcome** on the persisted project — a roll moves only the shared cut, a
   slip leaves timeline placement untouched, a J-cut offsets only the sound edit, a camera switch
   lands on the same instant from the other lens, a tracked region stays inside frame — rather than
   which tool spelling produced it.

Cases live in source rather than test files precisely so the drift gate can see them.

## The `verify` stage is earned, not assumed

Planning evidence requests is not the same as looking at a rendered result, so a case reports only
the deterministic stages by default:

`resolve → compile → validate → apply → invert → persist/reload → cross-host`

`runProfessionalEvalCase` accepts the production `TemporalEvidenceAcquirer` — the same callback the
orchestrator uses against the Python sidecar. When one is supplied, the case acquires evidence for
its planned requests, runs `reviewTemporalEvidence`, and only then adds `verify`. There is
deliberately no implicit acquirer in the deterministic suite: a case that cannot reach a renderer
reports `not_acquired` rather than inventing samples, and an acquirer that throws fails the case
instead of passing quietly. The release-oriented rendered suite uses the repository-owned,
one-shot Node-to-Python bridge and requires every registered row to earn `verify`.

```bash
# Fast compiler/patch/outcome spine. Reports review:not_acquired by design.
pnpm --filter @framepilot/ai-sdk test -- professional-evals.cases.test.ts

# Stages synthetic media, uses production acquisition, and requires 33/33 verified.
pnpm eval:professional:rendered
```

The bridge receives the applied, revision-incremented project — never the pre-edit fixture — and
stages media inside an isolated temporary project directory. Missing `uv`, ffmpeg, acquisition
errors, or a single unreviewed row fail the rendered command; they are not converted to skips.

## What `cross-host` means

It does not mean the capability runs on every host. Professional operations depend on live editor
interaction state — your selection, playhead, and source monitor — so hosts that cannot supply a
validated interaction snapshot are refused them outright. Requiring MCP execution would contradict
that policy.

It means the compiled result is host-portable: the patch survives serialisation unchanged and
applies identically wherever it lands. The evaluator proves the transport half per row;
`packages/mcp-server/src/cross-host-parity.test.ts` proves the shared-engine half — identical
operations, validation, ordering, and reversal across the in-app path and the MCP session.

`summarizeProfessionalEvalResults` reduces a run to a serializable scorecard — per-row status,
stages, review state, planned request count, and failures. The fast suite intentionally reports
`verified: 0`; the rendered release command currently requires `verified: 33` and has passed on a
fully provisioned development machine.

The current rendered rows prove every registered applied project can be compiled, acquired, and
accepted by the production temporal reviewer. P3 remains open for property-specific negative
controls and controller-variant coverage: generic black/flash and metadata trajectory evidence must
not be presented as pixel proof of every motion, mask, grade, or mix semantic.

## Drift policy

`professionalEvalDriftIssues` fails when:

- an advertised editable capability has no registered fixture;
- its row omits any required lifecycle stage;
- a capability has duplicate rows;
- an eval row names a capability that no longer exists;
- a registered fixture id has no executable case, or more than one; or
- an executable case has no registered scorecard row.

This makes capability additions fail visibly instead of silently expanding the product promise
without evaluation coverage.
