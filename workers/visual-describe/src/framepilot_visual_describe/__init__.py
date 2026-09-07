"""FramePilot Visual Describe Capability Pack worker.

Tier 2 of the shot ledger (ADR 0175): one STRUCTURED description per shot — summary,
subject, action, setting, camera, mood, verbatim on-screen text and a closed-vocabulary
quality list — produced locally by a small GGUF vision-language model under llama.cpp,
with no key and no network. The compiled-in identity below is what health mode checks the
installer's signed roster against: a mispackaged artifact is refused rather than blessed.
"""

from __future__ import annotations

from typing import Final

PACK_ID: Final = "framepilot.visual-describe"
PACK_VERSION: Final = "1.0.0"
#: Sorted, and exactly what this worker can actually do. One capability: describing a
#: shot is the whole job, and a pack that claimed more would have to be trusted for more.
PACK_CAPABILITIES: Final = ("visual.describe",)
#: The producing model id, stored on every ``shots.described`` row so a hosted description
#: and a local one are never read as the same producer.
MODEL_ID: Final = "framepilot/smolvlm2-2.2b-instruct-q4-k-m"
#: The low-RAM alternative the pack ships alongside the default (VU6.1). Selected by the
#: backend when the machine cannot hold the default; recorded under its own model id, so a
#: row always names the weights that produced it.
SMALL_MODEL_ID: Final = "framepilot/smolvlm2-500m-instruct-q8-0"

__all__ = ["MODEL_ID", "PACK_CAPABILITIES", "PACK_ID", "PACK_VERSION", "SMALL_MODEL_ID"]
