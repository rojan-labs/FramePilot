# 04 — Supporting defects (D1–D5)

**Status:** `[x]` done — 2026-08-27, commit `de57046`

**What shipped.** D1: `createStockHost` takes an enrolment hook, wired in `main.ts`,
fire-and-forget on the commit side; and the engine's bare `not_indexed` reaches the model
as an instruction that closes the loop. D2: orientation defaults to the project's frame, an
explicit choice still honoured. D3: the tool description states the phrase-matching limit.
D4: an outcome that is the request handed back verbatim is stored bounded. D5:
`from`/`here`/`off` join the continuation vocabulary, and `critiqueOptions` derives
acceptance from the resolved objective rather than from what was typed last.

**Closed by judgement rather than code.** D3's "report once per run": the degraded notice no
longer repeats the failed six-word phrase back — it states the rule the same way every time,
so the fact store folds ten occurrences into one line instead of ten. D4's `briefing.ts`
filter needed no change: `isRequestEcho` already matches the request "whole or excerpted",
which is exactly the bounded form the outcome is now stored in.
**Depends on:** nothing. D1 and D2 materially change output quality and should land with 02.

Five defects from run `e36235cc` that do not fit 01–03 but each cost the run real quality.

---

## D1 — `describe_footage` is dead on agent-downloaded stock

**Symptom:** all 11 calls returned
`{"packets":[],"backend":"twelvelabs","reason":"not_indexed"}` (4 at 11:24:58, 7 at
11:31:04). The run tried twice, got nothing twice, and had **no way to tell one downloaded
clip from another**. A montage judged on _visual variety_, _motion matching_ and
_intensity-to-beat pairing_ was assembled blind.

**Cause — a wiring gap, not a decision.** `createStockHost`
(`apps/desktop/electron/ai/stock-host.ts:97-131`) returns the asset and enrolls nothing. The
only automatic enrollment is `autoIndexImportedAssets`
(`apps/web-editor/src/components/MediaBin.tsx:908`) — the **human** import path.
`ensureProjectMediaUnderstanding` is called only from
`FootageUnderstandingPanel.tsx:555`, a button. So agent-downloaded stock never gets a video
mapping, and `_tl_describe` returns `not_indexed`
(`engine/python/framepilot_engine/service.py:3325-3334`).
`apps/web-editor/src/editor/visualIndex.ts:5-7` states the intent **is** implicit
enrollment — the agent acquisition path is simply missing the hook.

**Fix:** enroll on the agent path too. Land it in 03's **commit** phase, where the asset is
registered — not the acquire phase, which must stay side-effect-free
(`orchestrator.ts:4774-4782`).

**Edge cases:** enrollment must be non-blocking (it must never add to `add_stock` latency —
that is the whole point of 03); a failed enrollment must degrade to `not_indexed` rather than
failing the placement; TwelveLabs is optional (`TWELVELABS_API_KEY`, ADR 0070) so the
no-backend path must stay clean; and enrollment must not re-bill for an asset already
indexed. **Verify:** an agent `add_stock` followed by `describe_footage` returns packets;
with no API key it returns `not_indexed` without erroring.

---

## D2 — searches request landscape for a vertical brief

**Symptom:** every `search_stock` call passed `orientation: "landscape"`. The brief's
MASTER SPECIFICATION opens `**Format:** 9:16 vertical`, and the run's own recorded acceptance
criterion was _"Every picture clip carries its own reframe."_ It knew, and still sourced the
wrong shape.

**Fix:** derive the orientation default from the **project's aspect ratio**, not from a
hardcoded literal. A 9:16 project should default `search_stock` to `portrait`, falling back
to `landscape` only when portrait returns too few candidates — reframing a landscape plate
into 9:16 is a real technique, but it should be the fallback, not the default.

**Edge cases:** a project with no aspect set yet (new project, as here — the brief declared
9:16 in prose but the project was empty); a square project; a mixed brief. Do **not** infer
the aspect from the prose — `acceptance.ts`'s header is explicit that inventing readers is
how you fail runs that did the work. Use the project setting, and if the project has none,
keep today's behaviour.

**Verify:** a 9:16 project defaults to portrait; a 16:9 project defaults to landscape; an
unset project is unchanged from today.

---

## D3 — multi-word music queries silently degrade

**Symptom:** all 10 `search_music` calls report the same shape —
`Found 17 tracks for "epic cinematic" (nothing matched the whole phrase "epic cinematic
electronic driving percussion…")`. The provider matched only the first two words. The run
burned 10 searches and ~76k tokens rediscovering this each time, then settled on a **70 BPM**
track for a _"super-fast-paced"_ montage.

The message is honest — round 2 added it. The problem is it arrives **after** the tokens are
spent, and nothing carries the lesson to search 2.

**Fix:** two parts. (a) State the provider's phrase-matching behaviour in the `search_music`
tool description so the first query is shaped correctly. (b) When a search degrades, say so
once as a run-level fact rather than re-deriving it per call.

Also worth checking: whether a BPM filter or a BPM field is available from the provider. A
montage brief that says "super-fast-paced" and gets 70 BPM has a matching problem the search
digest could surface — but **only if the provider returns BPM**. Do not synthesize it.

**Verify:** a degraded search is reported once per run, not once per call; the tool
description names the phrase-matching limit; goldens regenerated (skill/descriptor edits
shift `ai-sdk` token goldens — the diff **is** the measured token delta).

---

## D4 — the run state carries the brief twice, every turn

**Symptom:** 57 run-state blocks in the transcript, each embedding
`objective.request` **and** `objective.outcome` — the same 9,885-character brief twice, in
every serialization.

`acceptance.ts:JUDGEMENT_CRITERION` documents this exact problem being solved for
`criteria`:

> "It used to be the request PASTED IN … In a captured run that was a ~7,000-token brief
> stored five times over, and `briefing.ts` has to filter four of those copies back out as
> noise before it can render anything. A pointer keeps the meaning and drops the duplication."

The same fix was not applied to `outcome`, which is still a verbatim copy of `request` when
no distinct outcome has been interpreted.

**Fix:** when `outcome` is byte-identical to `request`, do not store the copy — the
`provisional` flag already marks that state. Every reader holds the objective the field
belongs to.

**Edge cases:** a genuinely interpreted outcome must still be stored; `briefing.ts`'s
existing de-duplication filter must be updated in the same change, not left to filter a field
that no longer duplicates; run-state schema consumers must tolerate the absence.

**Verify:** a run whose outcome is the request stores it once; `briefing.ts` renders
identically; measure the token delta on a replayed run and publish it.

---

## D5 — the run cannot restart itself from a stall

**Symptom:** turn 2 blocked on
`Verification found: No traceable project mutation for the committed plan.` The session only
continued because the user typed **"continue from here"** — twice (turns 3 and 5).

Both continuations reset the objective to the literal string `"continue from here"` with
`provisional: true`, and the acceptance criteria collapsed to the single catch-all judgement
criterion. **The 50-clip requirement was lost at the first continuation**, independently of
the regex bug in 01. Turn 5's run state shows `objective.request: "continue from here"` and
one criterion.

**Fix:** a continuation must inherit the prior run's objective and acceptance criteria rather
than reinterpreting the continuation phrase as a new brief. This is adjacent to the
run-memory carry-forward already in `run-memory-carryforward.test.ts` — check what that
covers and extend rather than building a parallel path.

**Edge cases:** a continuation that genuinely changes the brief ("actually make it 30
seconds") must override, not inherit; a continuation after a _successful_ run must not
re-assert satisfied criteria; the inherited objective must not re-bill as uncached prefix
(round 1 item 5).

**Verify:** `continue from here` after a 50-clip brief retains `minShotCount: 50`; a
continuation carrying a new requirement replaces it.

---

## Sequencing

D1 and D2 change what the model can see and source, so they should land with 02 — a run
forced to commit will otherwise commit _blindly_, from landscape plates, which is a
different bad outcome rather than a fixed one. D3–D5 are independent and can follow.

## Definition of done

- [ ] D1: agent-downloaded stock is enrolled; `describe_footage` returns packets; no added
      `add_stock` latency; no-API-key path clean.
- [ ] D2: orientation follows the project aspect; unset projects unchanged.
- [ ] D3: degradation reported once per run; tool description states the limit; goldens
      regenerated.
- [ ] D4: the brief is stored once; `briefing.ts` updated; token delta published.
- [ ] D5: continuations inherit objective and acceptance; overriding continuations still work.
- [ ] `pnpm verify` green; `docs/` and `CHANGELOG.md` updated.
