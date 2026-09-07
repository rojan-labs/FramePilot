# FramePilot Visual Embed Capability Pack

Tier 1 of the shot ledger (ADR 0175): one embedding per shot, zero-shot shot-size /
subject / setting / screen-content labels from a versioned prompt bank, and face identity
vectors for the host's person clustering — locally, with **no key and no network**.
Shipped as a signed on-demand Capability Pack (ADR 0114). **Not** part of the base
installer, not a member of the root workspace, and never imported by `framepilot_engine`.

Capabilities: `visual.embed`, `visual.text`.

## Status: live

The weights are pinned and this pack registers and passes its health check. One licence
row is still open, in the open: the SigLIP 2 ONNX export declares no licence of its own —
see `LICENSES.md`, which records where that stands and what replaces it if the answer
comes back negative.

```sh
uv sync --extra cv
python tools/fetch_models.py     # ~1.5 GiB on the first run; verifies every file after
```

`bash scripts/dev-register-visual-embed.sh` from the repo root does that and registers the
pack into the desktop store.

**Re-pinning to a newer export or revision** is a deliberate, human-run step, not something
a build job does:

1. Re-verify each licence in `LICENSES.md` for the new artifacts.
2. `python tools/fetch_models.py --record` — resolves any `PENDING` revision to the commit
   it currently points at, downloads each artifact, prints its SHA-256 and byte count, and
   writes all of it back into `pack/models.lock.toml`.
3. Copy the same digests into `src/framepilot_visual_embed/models.py`. That copy is the
   one the **signed wheel** enforces at load time; the lock file is the human record.
4. `pytest -m decoded_media`, which is the evidence the new weights produce a vector.

`models.py` refuses a placeholder pin by name and the health check fails while any remains.
A pack that cannot say which weights it loads must not pass its own health check.

The health check hashes all ~1.5 GiB and lets CoreML compile both towers: ~48 s cold, ~21 s
warm on an M-series laptop. That is why `healthCheckCapabilityPackWorker` carries a much
larger bound than a probe command's.

## What it returns

One `visual.embed` request carries a media handle and up to 64 `(shotIndex, keyframeT)`
pairs plus the prompt bank version. Per shot it returns:

| Field | What it is |
| --- | --- |
| `vector` | base64 fp16, `dim` from the model — never hardcoded |
| `labels` | `shotSize`, `subjectKind`, `setting`, `screenContent`, each `{value, p}` |
| `faces` | the detector's count; zero when nobody is there |
| `faceVectors` | one identity vector per counted face, for `person_NN` clustering |

`visual.text` embeds up to 64 query strings into the same space and is the **one
capability with no media handle at all** — a query has no frames.

## Honesty rules

The pack refuses to return something that merely looks like an answer:

- a label group that could not be scored is **absent**, never a zero-probability guess;
- `p` is a softmax within ONE group, so "close-up" never competes with "kitchen";
- the worker does **not** gate on `p` — the printing threshold lives in the engine, so
  "we did not look" and "we looked and were unsure" stay distinguishable;
- a keyframe outside the approved media handle is refused, never clamped to a nearby one;
- a shot whose keyframe cannot be decoded fails the request rather than being dropped, so
  a short answer can never read as coverage;
- every pinned model is hashed before loading and its digest is reported in the handshake
  and in every result, so an edit's lineage names the exact weights.

## The prompt bank

`src/framepilot_visual_embed/prompt_bank.py` is a mirror of the engine's
`framepilot_engine/analysis/prompt_bank.py`; `engine/python/tests/test_prompt_bank.py`
fails if the two disagree. A request naming another `promptBankVersion` is refused before
any decoding: labelling a hundred shots against sentences the host did not choose, and
discovering the mismatch afterwards, would cost the whole batch and write facts nobody can
interpret.

## Layout

```
pack/models.lock.toml   pinned model URLs, sha256 digests, licences
tools/fetch_models.py   downloads + verifies weights (never committed)
src/…/protocol.py       dependency-free mirror of the frozen worker protocol
src/…/prompt_bank.py    mirror of the engine's versioned prompt bank
src/…/policy.py         what the pack will and will not claim (pure)
src/…/onnx_backend.py   the real inference backend — unverified until weights exist
```

## Tests

Two tiers, deliberately separate:

```bash
uv run pytest                                   # protocol/bank/policy/runtime; no ML stack
uv run --extra cv pytest -m decoded_media       # real models on real pixels
```
