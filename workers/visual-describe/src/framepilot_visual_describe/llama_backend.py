"""The real inference backend: llama.cpp's multimodal CLI over a small GGUF VLM.

**NOTHING IN THIS MODULE HAS EVER RUN.** No llama.cpp binary and no weight has been
fetched for this pack (see :mod:`framepilot_visual_describe.models`), so every path here
is unexercised: the argument names, the stdout shape and the OpenCV decode are transcribed
from upstream documentation, not observed. It is imported lazily and only by a worker that
has already passed a health check, which cannot pass while the pins are placeholders — so
this code is unreachable until the pack is made live, and the first run of
``pytest -m decoded_media`` is the first evidence any of it is correct.

WHY A SUBPROCESS AND NOT A PYTHON BINDING
    The ASR path already ships ``whisper-cli`` exactly this way, and it is the same ggml
    family. A binding would put a native extension inside the wheel and make the pack's
    build matrix a compilation matrix; a binary is a file the installer can hash, sign and
    verify — which is precisely what :mod:`framepilot_visual_describe.models` does to it.

WHY THE SCHEMA IS PASSED ON THE COMMAND LINE
    llama.cpp converts a JSON schema into a GBNF grammar and constrains sampling with it.
    That is the mechanism the whole tier depends on: a 2 B model asked politely for JSON
    returns prose about a third of the time; a 2 B model that is *unable* to emit anything
    but the schema returns the schema. Structure is enforced at generation, not repaired
    afterwards.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Final

from . import MODEL_ID, SMALL_MODEL_ID
from .backend import (
    BackendUnavailableError,
    DescribeFailedError,
    Frame,
    MediaUnreadableError,
)
from .models import MODELS_BY_ID, models_directory, verify_needed
from .schema import DESCRIBE_INSTRUCTION

_log = logging.getLogger(__name__)

#: Free memory under which the 500 M model is loaded instead of the 2.2 B one (VU6.1).
#: The governor refuses tier 2 outright below its own headroom; this is the softer step
#: above it — a 10 GB laptop should describe its footage slightly worse, not not at all.
LOW_MEMORY_BYTES: Final = 12 * 1024**3

#: Longest side a keyframe is scaled to before it is handed to the projector. SmolVLM2
#: tiles large images, and a 4K frame costs many times a 768 px one for detail the model
#: cannot use at this size.
MAX_FRAME_EDGE: Final = 768
#: JPEG quality for the frames written to the scratch directory. High enough that
#: on-screen text stays legible, which is the one field that fails first under compression.
JPEG_QUALITY: Final = 92

#: Generation ceiling. The schema bounds the shape; this bounds a model that loops.
MAX_TOKENS: Final = 512
#: Seconds one shot's generation may take before the process is killed.
DESCRIBE_TIMEOUT_SECONDS: Final = 180.0


#: Threads handed to llama.cpp. Tier 2 is the LOWEST-priority tier (VU6.4) and shares the
#: machine with an editor; half the cores is the polite half of that bargain.
def _thread_count() -> int:
    return max(1, (os.cpu_count() or 2) // 2)


def _free_memory_bytes() -> int | None:
    """Bytes available for a new allocation, or ``None`` if unknowable.

    The same two readings the engine's governor takes, and for the same reason: no new
    dependency for one number, and an unknown must never be treated as "not enough".
    """
    meminfo = Path("/proc/meminfo")
    try:
        if meminfo.exists():
            for line in meminfo.read_text(encoding="utf-8").splitlines():
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        return None
    try:
        return int(os.sysconf("SC_AVPHYS_PAGES")) * int(os.sysconf("SC_PAGE_SIZE"))
    except (ValueError, OSError, AttributeError):
        return None


class LlamaDescribeBackend:
    """Describes shots by running ``llama-mtmd-cli`` once per shot.

    One process per shot rather than a resident ``llama-server``: tier 2 yields to the
    editor (VU6.4), and a resident 1.5 GB server that is idle between slices is exactly
    what "yields" must not mean. The model load is the cost; it is paid per shot and it is
    the reason this tier is measured in seconds per shot rather than milliseconds.
    """

    def __init__(self, directory: Path | None = None) -> None:
        self._directory = directory if directory is not None else models_directory()
        free = _free_memory_bytes()
        self._small = free is not None and free < LOW_MEMORY_BYTES
        # Every artifact THIS run will load is hashed here, before anything is executed:
        # a pack whose binary does not match its pin must not run even once. Only the
        # size class this process resolved to (`self._small`) is verified — the other
        # class's ~0.6-1.9 GiB of never-loaded weights would otherwise be hashed on every
        # single describe request (VU6.4/R4.2); the health check still verifies both.
        # `verify_needed` hands back the already-resolved paths so they are never hashed
        # a second time here just to recover the `Path` (the original bug this replaces).
        suffix = "-small" if self._small else ""
        paths = verify_needed(self._directory, small=self._small)
        self._digests = {
            path.name: MODELS_BY_ID[model_id].sha256 for model_id, path in paths.items()
        }
        self._runtime = paths["runtime"]
        self._model_path = paths[f"vlm{suffix}"]
        self._mmproj_path = paths[f"mmproj{suffix}"]
        self._model_id = SMALL_MODEL_ID if self._small else MODEL_ID
        try:
            import cv2  # noqa: F401
        except ImportError as error:  # pragma: no cover - the cv extra is a build concern
            raise BackendUnavailableError(
                "OpenCV is not installed in this pack; keyframes cannot be decoded."
            ) from error

    @property
    def name(self) -> str:
        return f"llama.cpp/{'smolvlm2-500m' if self._small else 'smolvlm2-2.2b'}"

    @property
    def model_id(self) -> str:
        return self._model_id

    @property
    def model_digests(self) -> dict[str, str]:
        return dict(self._digests)

    def decode_keyframes(self, path: str, timestamps: Sequence[float]) -> Sequence[Frame]:
        """Decode one frame per timestamp as JPEG bytes, in the order given."""
        import cv2

        capture = cv2.VideoCapture(path)
        if not capture.isOpened():
            raise MediaUnreadableError(f"could not open {path} for decoding.")
        try:
            frames: list[bytes] = []
            for timestamp in timestamps:
                capture.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000.0)
                ok, frame = capture.read()
                if not ok or frame is None:
                    # Never substituted by a neighbour: the description would then be of a
                    # picture the host did not ask about, and nothing downstream could tell.
                    raise MediaUnreadableError(
                        f"could not decode a frame at {timestamp:.3f}s of {path}."
                    )
                frames.append(self._encode(cv2, frame))
            return frames
        finally:
            capture.release()

    @staticmethod
    def _encode(cv2: Any, frame: Any) -> bytes:
        height, width = frame.shape[:2]
        longest = max(height, width)
        if longest > MAX_FRAME_EDGE:
            scale = MAX_FRAME_EDGE / longest
            frame = cv2.resize(
                frame,
                (max(1, int(width * scale)), max(1, int(height * scale))),
                interpolation=cv2.INTER_AREA,
            )
        ok, buffer = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY])
        if not ok:
            raise MediaUnreadableError("could not JPEG-encode a decoded keyframe.")
        return bytes(buffer.tobytes())

    def describe(self, frames: Sequence[Frame], schema: Mapping[str, Any]) -> Mapping[str, Any]:
        """Run one constrained generation over this shot's frames."""
        if not frames:
            raise DescribeFailedError("describe requires at least one frame.")
        with tempfile.TemporaryDirectory(prefix="fp-describe-") as scratch:
            root = Path(scratch)
            image_paths: list[str] = []
            for index, frame in enumerate(frames):
                image_path = root / f"frame-{index}.jpg"
                image_path.write_bytes(bytes(frame))
                image_paths.append(str(image_path))
            # ONE `--image`, comma-separated: passing the flag once per frame is deprecated
            # by this CLI version and silently keeps only the LAST value, so a 2-3 keyframe
            # shot was being described from its last frame alone — the other frame(s) paid
            # their JPEG-encode cost for nothing, and "man at a desk" and "man stands up and
            # leaves" (the exact case multi-frame sampling exists for) read identically.
            image_arguments = ["--image", ",".join(image_paths)] if image_paths else []
            schema_path = root / "schema.json"
            schema_path.write_text(json.dumps(schema), encoding="utf-8")
            command = [
                str(self._runtime),
                "--model",
                str(self._model_path),
                "--mmproj",
                str(self._mmproj_path),
                *image_arguments,
                "--prompt",
                DESCRIBE_INSTRUCTION,
                "--json-schema-file",
                str(schema_path),
                "--temp",
                "0",
                "--n-predict",
                str(MAX_TOKENS),
                "--threads",
                str(_thread_count()),
            ]
            # NOT `--no-display-prompt`: llama-mtmd-cli rejects it outright ("error:
            # invalid argument"), so every describe call would have failed with a
            # returncode nobody could read. It does not echo the prompt on stdout anyway,
            # and `_parse_object` takes the first balanced object regardless.
            try:
                completed = subprocess.run(
                    command,
                    capture_output=True,
                    text=True,
                    timeout=DESCRIBE_TIMEOUT_SECONDS,
                    check=False,
                )
            except subprocess.TimeoutExpired as error:
                raise DescribeFailedError(
                    f"the model did not answer within {DESCRIBE_TIMEOUT_SECONDS:.0f}s."
                ) from error
            except OSError as error:
                raise BackendUnavailableError(
                    f"could not execute the pinned llama.cpp runtime: {error}"
                ) from error
        if completed.returncode != 0:
            raise DescribeFailedError(
                f"llama-mtmd-cli exited {completed.returncode}: "
                f"{(completed.stderr or '').strip()[:300]}"
            )
        return _parse_object(completed.stdout)


def _parse_object(stdout: str) -> Mapping[str, Any]:
    """Read the one JSON object out of a CLI's stdout.

    Grammar-constrained output IS the object, but the CLI may still print a timing line
    around it, so the first balanced ``{...}`` span is taken rather than the whole stream.
    """
    start = stdout.find("{")
    end = stdout.rfind("}")
    if start < 0 or end <= start:
        raise DescribeFailedError("the model printed no JSON object.")
    try:
        payload = json.loads(stdout[start : end + 1])
    except ValueError as error:
        raise DescribeFailedError(f"the model's output is not valid JSON: {error}") from error
    if not isinstance(payload, dict):
        raise DescribeFailedError("the model's output is not a JSON object.")
    return payload
