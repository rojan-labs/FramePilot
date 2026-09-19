"""The Smart Mask worker for the masking end-to-end specs: the REAL pipeline, scripted models.

E2E.6 (plan/background-removal-ai/07) needs a background removal that runs in windows, stops
mid-job the way a crash stops it, and resumes from its finished windows. That is the worker's own
code (``framepilot_smart_mask``: the one-shot JSON-line runtime, ``MatteJob``'s windows,
``windows/<i>/done.json`` checkpoints, the encoders), so this entrypoint runs exactly that, with
two things swapped for CI:

- **The models.** No weights exist in CI (MO-1..MO-5), so the pipeline gets the worker test
  suite's scripted provider (``tests/pipeline_harness.py``: a fake SAM 2.1 that follows red, a
  matting model that reads redness). Every other stage is the pack's.
- **Small windows** (16 frames, 6 overlap) so a two-second clip has several windows.

It is launched by the desktop's real ``runCapabilityPackWorker`` from a fake install root
(``masking/smart-mask-pack.ts``). A control file beside the entrypoint, written by the spec,
scripts one crash: ``{"crashAtWindow": 2}`` exits the process with 137 the moment window 2 starts
decoding, after window 1's checkpoint is on disk, which is what a killed app leaves behind. Every
progress event (with the worker's own detail text) is appended to ``eventsLog`` so the spec can
see which windows a run decoded and which it restored.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[4]
WORKER = REPO / "workers" / "smart-mask"
sys.path[:0] = [str(WORKER / "src"), str(WORKER / "tests")]

from framepilot_smart_mask.runtime import CancellationFlag, run_worker  # noqa: E402
from framepilot_smart_mask.sandbox import configure_determinism, disable_network  # noqa: E402

CONTROL_FILE = "e2e-control.json"
#: What an OS reports for a process killed by SIGKILL; the host sees the same exit.
KILLED = 137


def _control() -> dict[str, Any]:
    root = os.environ.get("FRAMEPILOT_CAPABILITY_PACK_ROOT", "")
    path = Path(root) / CONTROL_FILE
    try:
        return dict(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return {}


class ScriptedServices:
    """The pack's services with the worker suite's scripted models (see the module note)."""

    backend_label = "scripted-models:e2e"

    def __init__(self, control: dict[str, Any]) -> None:
        self.control = control

    @property
    def model_digests(self) -> dict[str, str]:
        return {"scripted.onnx": "0" * 63 + "1"}

    def run_matte(self, request: Any, progress: Any, cancellation: CancellationFlag) -> Any:
        from pipeline_harness import FakeProvider

        from framepilot_smart_mask.media import FfmpegTools, verify_tools
        from framepilot_smart_mask.pipeline import MatteJob, PipelineConfig, ToolPaths

        # The runner's PATH ffmpeg (a pack bundles an approved build; CI has the distro's).
        env = {**os.environ, "FRAMEPILOT_SMART_MASK_ALLOW_UNAPPROVED_FFMPEG": "1"}
        env.pop("FRAMEPILOT_CAPABILITY_PACK_ROOT", None)
        ffmpeg, ffprobe, report = verify_tools(env)
        log_path = self.control.get("eventsLog")
        crash_at = self.control.get("crashAtWindow")
        windows_started = 0

        def sink(
            phase: str,
            completed: int,
            total: int,
            *,
            round_number: int | None = None,
            detail: str | None = None,
        ) -> None:
            nonlocal windows_started
            if phase == "decode" and completed == 1:
                windows_started += 1
            if log_path:
                with Path(log_path).open("a", encoding="utf-8") as handle:
                    handle.write(
                        json.dumps(
                            {
                                "phase": phase,
                                "completed": completed,
                                "total": total,
                                "detail": detail,
                            }
                        )
                        + "\n"
                    )
            if crash_at is not None and windows_started >= int(crash_at):
                # A killed app: no cleanup, no result line, the checkpoints stay where they are.
                os._exit(KILLED)
            progress(phase, completed, total, round_number=round_number, detail=detail)

        job = MatteJob(
            request,
            provider=FakeProvider(),
            media=FfmpegTools(ffmpeg, ffprobe, report),
            tools=ToolPaths(
                str(ffmpeg), str(ffprobe), {"licence": report.licence, "approved": report.approved}
            ),
            config=PipelineConfig(
                window_frames=16, window_overlap=6, embedding_ram_bytes=64 * 2**20, matting_tile=64
            ),
            progress=sink,
            cancellation=cancellation,
        )
        return job.run()

    def segment_frame(self, request: Any, cancellation: CancellationFlag) -> Any:
        raise NotImplementedError("The masking e2e worker only removes backgrounds.")


def main() -> int:
    if sys.argv[1:] != ["--framepilot-worker-runtime"]:
        sys.stderr.write("scripted_smart_mask_worker only speaks --framepilot-worker-runtime.\n")
        return 2
    disable_network()
    configure_determinism()
    control = _control()
    return run_worker(sys.stdin, sys.stdout, lambda: ScriptedServices(control), CancellationFlag())


if __name__ == "__main__":
    raise SystemExit(main())
