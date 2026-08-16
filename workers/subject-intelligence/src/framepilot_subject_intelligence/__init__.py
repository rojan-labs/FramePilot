"""FramePilot Subject Intelligence Capability Pack worker.

Detects faces, people and objects, and produces subject segmentation masks, as a
signed on-demand pack. The compiled-in identity below is what health mode checks
the installer's signed roster against: a mispackaged artifact is refused rather
than blessed.
"""

from __future__ import annotations

from typing import Final

PACK_ID: Final = "framepilot.subject-intelligence"
PACK_VERSION: Final = "1.0.0"
#: Sorted, and exactly what this worker can actually do.
PACK_CAPABILITIES: Final = ("subject.detect", "subject.segment")

__all__ = ["PACK_CAPABILITIES", "PACK_ID", "PACK_VERSION"]
