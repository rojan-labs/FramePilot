"""FramePilot Smart Mask Capability Pack worker.

Follows one subject through a clip and writes a lossless alpha matte plus a foreground colour
estimate (``subject.matte``), and answers interactive single-frame segmentation
(``subject.segment_frame``). The compiled-in identity below is what health mode checks the
installer's signed roster against: a mispackaged artifact is refused rather than blessed.
"""

from __future__ import annotations

from typing import Final

PACK_ID: Final = "framepilot.smart-mask"
PACK_VERSION: Final = "1.0.0"
#: Sorted, and exactly what this worker can actually do.
PACK_CAPABILITIES: Final = ("subject.matte", "subject.segment_frame")
#: Bumped when the pipeline changes what an artifact's pixels mean (recorded in report.json).
MATTE_PIPELINE_VERSION: Final = 2

__all__ = ["MATTE_PIPELINE_VERSION", "PACK_CAPABILITIES", "PACK_ID", "PACK_VERSION"]
