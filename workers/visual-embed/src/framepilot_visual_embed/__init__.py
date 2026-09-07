"""FramePilot Visual Embed Capability Pack worker.

Tier 1 of the shot ledger (ADR 0175): one embedding per shot, zero-shot labels from a
versioned prompt bank, and face identity vectors for the host's entity clustering — all
locally, with no key and no network. The compiled-in identity below is what health mode
checks the installer's signed roster against: a mispackaged artifact is refused rather
than blessed.
"""

from __future__ import annotations

from typing import Final

PACK_ID: Final = "framepilot.visual-embed"
PACK_VERSION: Final = "1.0.0"
#: Sorted, and exactly what this worker can actually do.
PACK_CAPABILITIES: Final = ("visual.embed", "visual.text")
#: The vector space this pack produces. Stored on every ``visual_vectors`` row so the
#: local space and the hosted NVIDIA space can never be searched as one.
MODEL_ID: Final = "framepilot/siglip2-base-patch16-224-onnx"

__all__ = ["MODEL_ID", "PACK_CAPABILITIES", "PACK_ID", "PACK_VERSION"]
