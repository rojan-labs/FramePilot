"""PyInstaller entry point for the bundled FramePilot engine.

WHY: PyInstaller needs a real script file to analyze, not the ``framepilot``
console-script shim that setuptools/hatchling generate at install time. This
module is that script — it delegates straight to the same
:func:`framepilot_engine.cli.main` the console script wraps, so the bundled
binary (``framepilot-engine``) and the dev CLI (``uv run framepilot``) are the
identical program with identical subcommands (``serve``, ``render``, …).

Used only by ``framepilot-engine.spec`` (desktop packaging); never imported by
the engine itself.
"""

from __future__ import annotations

import multiprocessing
import sys

from framepilot_engine.cli import main

if __name__ == "__main__":
    # Frozen-app guard: without this, any multiprocessing spawn inside the
    # bundle (e.g. a future uvicorn/moviepy worker) re-executes the binary's
    # main and fork-bombs the sidecar.
    multiprocessing.freeze_support()
    sys.exit(main())
