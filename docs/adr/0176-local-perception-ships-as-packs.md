# ADR 0176 — Local perception ships as capability packs, and hosted arms become optional

- **Status:** Accepted
- **Date:** 2026-09-07
- **Relates to:** ADR 0114 (heavy capabilities ship as on-demand packs), ADR 0175
  (perception is a compiled shot ledger), ADR 0066 (NVIDIA cloud visual embeddings),
  ADR 0070 / 0097 (TwelveLabs as an optional backend), ADR 0058 (the project brain).
- **Plan:** [`plan/visual-understanding/05-LOCAL-PERCEPTION-PACKS.md`](../../plan/visual-understanding/05-LOCAL-PERCEPTION-PACKS.md)

## Context

ADR 0175 made tier 0 of the shot ledger keyless: one ffmpeg pass measures every asset
locally, with no key, no network and no model. That closed the default-install blindness.
It did not close the other two tiers, and both were hosted-only:

- **Tier 1 (labels, embeddings, identity)** ran through NVIDIA's hosted embedder (ADR 0066).
  Configuring a key _is_ the consent for footage to leave the machine, so with no key there
  were no labels, no visual search, and no duplicate detection.
- **Tier 2 (descriptions)** ran through whichever vision provider the user had configured,
  emitting FREE TEXT from a single prompt (`CAPTION_INSTRUCTION`). Free text cannot be
  filtered, cannot be compared with a label, and cannot drive a solver.

Both are the same problem in different clothes: the agent's understanding of footage
depended on the user having pasted an API key, and on frames leaving their machine.

## Decision

**Local perception ships as on-demand capability packs, under the ADR 0114 machinery that
already exists. The hosted arms stay as optional producers of the same shapes, never as the
only producer.**

Two packs:

| Pack                         | Tier | Runtime                                                   | Produces                                            |
| ---------------------------- | ---- | --------------------------------------------------------- | --------------------------------------------------- |
| `framepilot.visual-embed`    | 1    | onnxruntime (SigLIP 2 export) + OpenCV DNN (YuNet, SFace) | image/text vectors, zero-shot labels, face identity |
| `framepilot.visual-describe` | 2    | llama.cpp (`llama-mtmd-cli`) + a small GGUF VLM           | one structured description per shot                 |

Four rules make this more than "add two workers":

1. **One schema, every producer.** Tier 2's structured object is canonical in
   `brain/described.py`. The local pack, the hosted captioner and the TwelveLabs arm all
   emit it. `CAPTION_INSTRUCTION` and the free-text path are **deleted** — a second shape
   would mean every reader has to know which producer wrote a row.
2. **The local arm wins when present** — not on cost, but because it needs no key, no frame
   leaves the machine, and its query vectors live in the same space as its stored vectors.
   Mixing spaces is why `visual_vectors` is keyed by model id.
3. **Weights are pinned and verified, and a placeholder is refused BY NAME.** Every digest
   ships as a sentinel that `resolve_model` rejects with an explanatory error, so a pack
   cannot half-work: the health check fails until a real digest is recorded. This is
   deliberate — a silently-degraded perception layer is worse than an absent one, because
   the agent would act on labels nothing produced.
4. **The engine gains no default dependency.** onnxruntime, OpenCV and llama.cpp live in the
   packs. The frozen sidecar keeps no ML runtime, no torch, no GPU matrix.

The hosted NVIDIA arm is **not** removed in this ADR, though the plan names it as a
deprecation. Removing it before the local pack has verified weights would leave the product
with no tier-1 producer at all — worse than the duplication it removes. It goes when
`framepilot.visual-embed` is measured against real footage, and that decision is recorded in
`plan/visual-understanding/08-REMOVE-DEFER-RISKS.md` rather than left implicit.

## Consequences

- With both packs installed, the agent's entire understanding of footage is produced on the
  user's machine. Nothing about their footage reaches a third party unless they configure a
  hosted arm.
- Tier 2 no longer depends on tier 1. A keyless machine with only the describe pack still
  gets descriptions; a machine with a vision key and no embedding key does too.
- Two segmentations now coexist (sampler spans, shot ledger), so captions are joined to
  spans by **time overlap** rather than by index. Index equality across two different
  segmentations was a confident, invisible lie waiting to be told.
- Install size grows only for users who ask: ~370 MB for tier 1, ~1.5 GB for tier 2.
- The licence surface grows in a way `pnpm license:scan` **cannot see** — it walks
  `node_modules` manifests and cannot read a GGUF, a wheel or a native binary. Each pack
  carries a hand-reviewed `LICENSES.md` with per-artifact verification status, and the
  prebuilt llama.cpp binary is treated as a larger trust decision than the weights it loads,
  because it executes over customer footage.
- Qwen2.5-VL (research terms) and Gemma 3 (Gemma terms) are excluded on licence grounds and
  may not be defaults or options.

## Status of the implementation, stated plainly

Both packs are **structure without weights**. No model file or binary has been fetched;
`llama_backend.py` and `onnx_backend.py` have never executed, and their preprocessing
constants are transcribed from model cards rather than observed. Every test in both packs
runs against an injected fake. **No accuracy is claimed** — not shot size, not subject kind,
not identity clustering, not caption quality. The plan carries the exact remaining steps.

## Rejected alternatives

- **Bundle the models in the installer.** ADR 0114 settled this: first install and every
  update would pay for capabilities many editors never use.
- **Keep hosted-only and require a key.** That is the status quo ADR 0175 was written to
  end; it makes the agent's competence a function of the user's billing relationships.
- **Put onnxruntime/llama.cpp in the frozen sidecar.** PyInstaller size and the GPU matrix,
  for a capability most projects will not use on a given day.
- **A single "understanding" pack.** The tiers fail independently and are useful
  independently; one pack would make a 1.5 GB VLM the price of a shot-size label.
