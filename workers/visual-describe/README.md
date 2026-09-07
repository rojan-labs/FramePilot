# FramePilot Visual Describe Capability Pack

Tier 2 of the shot ledger (ADR 0175): one **structured** description per shot — summary,
subject, action, setting, camera (shot size / angle / movement), mood, verbatim on-screen
text and a closed-vocabulary quality list — produced locally by a small GGUF
vision-language model under llama.cpp, with **no key and no network**. Shipped as a signed
on-demand Capability Pack (ADR 0114). **Not** part of the base installer, not a member of
the root workspace, and never imported by `framepilot_engine`.

Capability: `visual.describe`.

## Status: live, and no caption quality is claimed

The artifacts are pinned, the pack registers and passes its health check, and
`llama_backend.py` has been run end to end against the real runtime and weights: one
keyframe in, one complete schema-conformant object out.

Getting there cost two fixes that only a real run could have surfaced, both recorded here
because they are the shape of bug this pack invites:

- **`--no-display-prompt` is not a `llama-mtmd-cli` flag.** It had been transcribed from
  `llama-cli`'s options. The CLI rejects it outright, so every describe call would have
  failed with an unreadable returncode.
- **An unbounded array in the JSON schema is a decoder trap.** With no `maxItems`, the
  grammar always permits another item, and SmolVLM2-2.2B filled `onScreenText` with empty
  strings until `--n-predict` ran out — leaving the object unterminated and every call
  failing as "not valid JSON". Both arrays are bounded now, and `onScreenText` items
  require `minLength: 1`.

One honest consequence remains:

- **No caption-quality figure in `plan/visual-understanding/05` §VU6.5 has been measured.**
  Those targets need human labels; nothing here asserts them. That one run proves the
  plumbing carries a valid object, not that the description is any good.

The artifacts are pinned and this pack registers and passes its health check. Every
licence row in `LICENSES.md` is verified against the artifact itself.

```sh
uv sync --extra cv
python tools/fetch_models.py     # ~2.6 GiB on the first run; verifies every file after
```

`bash scripts/dev-register-visual-describe.sh` from the repo root does that and registers
the pack into the desktop store.

**How the runtime arrives.** llama.cpp publishes no bare `llama-mtmd-cli`; each release
ships one platform tarball. That tarball is pinned by a single digest — one artifact, one
licence, one approval — and the CLI plus the nine dylibs it links against are extracted
from it and pinned individually. The unversioned `libfoo.0.dylib` names the loader asks
for are recreated as symlinks, because the CLI's only `LC_RPATH` is `@loader_path` and
everything must be its directory sibling.

**Re-pinning to a newer release or revision** is a deliberate, human-run step:

1. Re-verify each licence in `LICENSES.md` — the SmolVLM2 **GGUF quantisation and mmproj
   export** (not only the upstream model card), and the `LICENSE` inside the llama.cpp
   **release tarball**.
2. `python tools/fetch_models.py --record` — resolves any `PENDING` release or revision,
   downloads each artifact, prints its SHA-256 and byte count, and writes all of it back
   into `pack/models.lock.toml`.
3. Copy the same digests into `src/framepilot_visual_describe/models.py`. That copy is the
   one the **signed wheel** enforces at load time; the lock file is the human record.
4. `pytest -m decoded_media`, which is the evidence the new artifacts produce a description.

`models.py` refuses a placeholder pin by name and the health check fails while any remains.
A pack that cannot say which model it is about to run over a customer's footage must not
pass its own health check.

## What it returns

One `visual.describe` request carries a media handle and up to 16 `(shotIndex, t0, t1)`
spans plus the tier-2 version. Per shot it returns one object:

| Field | What it is |
| --- | --- |
| `summary` | ≤ 2 sentences, only what is visible. This is what `visual_captions.text` stores and FTS indexes. |
| `subject` / `action` / `setting` / `mood` | Free text, capped; `""` when the model said nothing |
| `camera` | `shotSize` / `angle` / `movement`, each from a closed list or `"unknown"` |
| `onScreenText` | Every legible string, **verbatim** |
| `quality` | Zero or more words from a closed vocabulary |
| `confidence` | `low` / `medium` / `high`; the engine maps it to `p` = 0.5 / 0.7 / 0.9 |

The batch is 16, not 64: a VLM call is seconds, not milliseconds. Tier 2 is the slow tier
by design (VU6.4) and the bound says so in the contract.

## Why the schema is the contract

`schema.py` is a mirror of the engine's `framepilot_engine/brain/described.py`;
`engine/python/tests/test_described_drift.py` fails if the two disagree. The schema is
handed to llama.cpp, which converts it to a GBNF grammar and constrains **generation** with
it — a 2 B model that is *unable* to emit anything but the schema returns the schema, where
a 2 B model asked politely for JSON returns prose about a third of the time. Structure is
enforced at generation, not repaired afterwards.

The same schema is what the hosted captioner sends as an Anthropic tool `input_schema` or
an OpenAI `response_format: json_schema`. One schema, three producers — the third being
TwelveLabs, which can only fill `summary` and leaves everything else empty rather than
inventing it.

## Honesty rules

The pack refuses to return something that merely looks like an answer:

- a shot with no summary **fails the request**; it is never dropped, because a short answer
  would be written as coverage for shots nobody looked at;
- a free-text field the model left blank is `""`, never a plausible sentence;
- a camera angle or quality word outside the closed list is **dropped**, never mapped to
  its nearest neighbour;
- `onScreenText` is verbatim — whitespace collapsed and length capped, nothing else;
- `confidence` is a three-way bucket the model self-rates, and the worker does **not** gate
  on it: the printing threshold lives in the engine, so "we did not look" and "we looked
  and were unsure" stay distinguishable;
- a span outside the approved media handle is refused, never clamped;
- a keyframe that cannot be decoded fails the request rather than being substituted by its
  neighbour;
- every pinned artifact — the runtime binary included — is hashed before loading and its
  digest is reported in the handshake and in every result.

## Layout

```
pack/models.lock.toml     pinned URLs, sha256 digests, licences (weights AND runtime)
tools/fetch_models.py     downloads + verifies artifacts (never committed)
src/…/protocol.py         dependency-free mirror of the frozen worker protocol
src/…/schema.py           mirror of the engine's structured description contract
src/…/policy.py           keyframe choice + normalisation (pure)
src/…/llama_backend.py    the real backend — UNVERIFIED until the artifacts exist
```

## Tests

Two tiers, deliberately separate:

```bash
uv run pytest                                   # protocol/schema/policy/runtime; no ML stack
uv run --extra cv pytest -m decoded_media       # the real model on real pixels
```
