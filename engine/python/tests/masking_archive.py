"""E2E.7: a project with masks, mattes and tracks moves between machines (plan 07, E2E.7).

A FramePilot project is a folder: ``project.fp.json`` with media paths relative to it, the media,
and the project-owned derived artifacts under ``.framepilot-derived/`` (mattes, MD-4; tracks,
MK7.1), each pinned by digest. "Archiving" it is copying that folder (zip, drive, sync). This
module is the engine half of the check that such a folder reopens and exports the same on
another machine::

    cd engine/python
    uv run python -m tests.masking_archive create <dir>   # build it, export it, record reference
    uv run python -m tests.masking_archive reopen <dir>   # the folder was moved: export, compare

``create`` writes ``<dir>/project/`` (two sentinel videos; a background-removal matte; an
ellipse tracked with a perspective track that limits the clip blur; a keyframed rectangle) and
``<dir>/reference/`` (the export's probe and sha256, and lossless frames at fixed times as PNG
plus the sha256 of their pixels, with the platform they were made on). ``reopen`` renders the
folder wherever it now is and compares: the probe exactly, the frames with the PX4 oracle's
gates (PSNR >= 40 dB and >= 99.5% of pixels within 8/255), and it reports whether the frames and
the export file are also bit-identical (they are expected to be on the same platform; across
platforms the decoder builds differ, so only the gates are required). The desktop half — the
project file layer and full matte validation on open — is ``tests/e2e/scripts/
masking-archive-open.mjs``.

Exit status 0 means the reopened folder passed; the report is printed as one JSON line.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import platform
import sys
from pathlib import Path
from typing import Any

WIDTH, HEIGHT, FPS, SECONDS = 640, 360, 30.0, 2.0
TIMES = (0.25, 0.9, 1.6)
PSNR_MIN_DB = 40.0
CHANNEL_TOLERANCE = 8
WITHIN_MIN_FRACTION = 0.995
TRACK_PERSPECTIVE = 1.5e-6


def _write_track(project_dir: Path, subject: Path) -> dict[str, str]:
    """A perspective track over every frame of ``subject`` (identity at 1 s, a slow drift)."""
    from framepilot_engine.render.pts_reader import video_timing
    from framepilot_engine.render.tracks import TRACKS_DIR

    timing = video_timing(subject)
    seconds = timing.relative_seconds()
    reference = min(range(len(seconds)), key=lambda index: abs(seconds[index] - 1.0))
    transforms: list[float] = []
    for index in range(len(seconds)):
        step = index - reference
        transforms += [1, 0, 2 * step, 0, 1, 0.5 * step, TRACK_PERSPECTIVE * step, 0, 1]
    document = {
        "version": 1,
        "method": "perspective",
        "timeBase": [timing.time_base.numerator, timing.time_base.denominator],
        "originPts": timing.pts[0],
        "firstFrame": 0,
        "pts": list(timing.pts),
        "transforms": transforms,
        "confidence": [0.95] * len(seconds),
    }
    text = json.dumps(document) + "\n"
    sha256 = hashlib.sha256(text.encode("utf-8")).hexdigest()
    key = hashlib.sha256(f"track:{sha256}".encode()).hexdigest()
    directory = project_dir / TRACKS_DIR / key
    directory.mkdir(parents=True, exist_ok=True)
    # Bytes, not text mode: a platform newline would change the pinned digest.
    (directory / "track.json").write_bytes(text.encode("utf-8"))
    return {"key": key, "sha256": sha256}


def _project(matte: dict[str, Any], track: dict[str, str]) -> dict[str, Any]:
    from framepilot_engine.timeline.models import SCHEMA_VERSION

    def clip(track_id: str, clip_id: str, asset: str, **extra: Any) -> dict[str, Any]:
        return {
            "id": clip_id,
            "assetId": asset,
            "trackId": track_id,
            "start": 0.0,
            "end": SECONDS,
            "sourceStart": 0.0,
            "sourceEnd": SECONDS,
            "effects": [],
            "keyframes": [],
            **extra,
        }

    subject = clip(
        "video_2",
        "clip_subject",
        "subject",
        effects=[
            {
                "id": "clip_subject__blur",
                "type": "blur",
                "params": {"amount": 0.05},
                "keyframes": [],
            }
        ],
        masks=[
            {
                "id": "clip_subject__matte",
                "name": "Background removal",
                "kind": "matte",
                "artifact": matte,
                "prompts": [],
                "review": {"flagged": [], "approved": [], "locked": []},
            },
            {
                "id": "clip_subject__face",
                "name": "Face blur",
                "kind": "ellipse",
                "cx": 330.0,
                "cy": 170.0,
                "rx": 60.0,
                "ry": 80.0,
                "featherOuterPx": 6.0,
                "target": {"kind": "effect", "effectId": "clip_subject__blur"},
                "tracking": {
                    "artifact": track,
                    "method": "perspective",
                    "referenceSourceTime": 1.0,
                    "constraints": [],
                    "review": {"flagged": [], "approved": [], "locked": []},
                },
            },
        ],
    )
    background = clip(
        "video_1",
        "clip_bg",
        "bg",
        masks=[
            {
                "id": "clip_bg__window",
                "name": "Window",
                "kind": "rectangle",
                "cx": 320.0,
                "cy": 180.0,
                "width": 420.0,
                "height": 260.0,
                "featherOuterPx": 12.0,
                "keyframes": [
                    {"id": "w0", "sourceTime": 0.0, "property": "cx", "value": 260.0},
                    {"id": "w1", "sourceTime": 2.0, "property": "cx", "value": 380.0},
                ],
            }
        ],
    )
    return {
        "schemaVersion": SCHEMA_VERSION,
        "id": "e2e7_archive",
        "name": "E2E.7 Archive",
        "version": 1,
        "fps": FPS,
        "resolution": {"width": WIDTH, "height": HEIGHT},
        "assets": [
            {
                "id": name,
                "path": f"media/{name}.mp4",
                "kind": "video",
                "durationSeconds": SECONDS,
                "media": {"width": WIDTH, "height": HEIGHT},
            }
            for name in ("subject", "bg")
        ],
        "timeline": {
            "revision": 1,
            "tracks": [
                {"id": "video_2", "type": "video", "clips": [subject]},
                {"id": "video_1", "type": "video", "clips": [background]},
            ],
        },
        "transcript": [],
        "markers": [],
        "aiMemory": {},
        "history": [],
    }


def _frames(project_path: Path) -> list[tuple[float, bytes, int, int]]:
    from PIL import Image

    from tests.masking_e2e_engine import _grab

    frames = []
    for time, frame in _grab(project_path, list(TIMES), False):
        with Image.open(io.BytesIO(frame.data)) as image:
            frames.append((time, image.convert("RGB").tobytes(), frame.width, frame.height))
    return frames


def _export(project_path: Path, output: Path) -> dict[str, Any]:
    from tests.masking_e2e_engine import cmd_export

    return cmd_export({"projectPath": str(project_path), "output": str(output)})


def _platform() -> dict[str, str]:
    from framepilot_engine.media.ffmpeg import find_export_ffmpeg

    return {
        "system": platform.system(),
        "machine": platform.machine(),
        "python": platform.python_version(),
        "exportFfmpeg": Path(str(find_export_ffmpeg())).name,
    }


def create(root: Path) -> dict[str, Any]:
    """Build the project folder, export it, and record the reference beside it."""
    from PIL import Image

    from framepilot_engine.media.ffmpeg import find_ffmpeg
    from tests.masking_e2e_engine import cmd_matte
    from tests.px4_parity_frames import VideoSpec, encode_video

    project_dir = root / "project"
    reference = root / "reference"
    project_dir.mkdir(parents=True, exist_ok=True)
    reference.mkdir(parents=True, exist_ok=True)
    ffmpeg = find_ffmpeg()
    for name, primary, secondary in (
        ("subject", (236, 44, 44), (140, 44, 44)),
        ("bg", (44, 44, 236), (44, 44, 140)),
    ):
        encode_video(
            ffmpeg,
            project_dir,
            VideoSpec(f"media/{name}.mp4", WIDTH, HEIGHT, FPS, SECONDS, primary, secondary),
        )
    written = cmd_matte(
        {
            "projectDir": str(project_dir),
            "assetPath": "media/subject.mp4",
            "fps": FPS,
            "width": WIDTH,
            "height": HEIGHT,
            "foreground": [236, 44, 44],
            "shape": "disc",
            "sourceStart": 0.0,
            "sourceEnd": SECONDS,
        }
    )
    matte = {
        "key": written["key"],
        "files": written["files"],
        "width": written["width"],
        "height": written["height"],
        "coverage": written["coverage"],
        "packId": "framepilot.smart-mask",
        "packVersion": "1.0.0",
        "modelDigests": [],
    }
    track = _write_track(project_dir, project_dir / "media" / "subject.mp4")
    project_path = project_dir / "project.fp.json"
    project_path.write_bytes((json.dumps(_project(matte, track), indent=2) + "\n").encode("utf-8"))

    exported = _export(project_path, project_dir / "exports" / "reference.mp4")
    frames = []
    for index, (time, pixels, width, height) in enumerate(_frames(project_path)):
        name = f"frame-{index}.png"
        Image.frombytes("RGB", (width, height), pixels).save(reference / name)
        frames.append(
            {
                "time": time,
                "png": name,
                "width": width,
                "height": height,
                "sha256": hashlib.sha256(pixels).hexdigest(),
            }
        )
    manifest = {
        "platform": _platform(),
        "export": {
            "state": exported.get("state"),
            "error": exported.get("error"),
            "validationOk": (exported.get("validation") or {}).get("ok"),
            "probe": exported.get("probe"),
            "sha256": exported.get("sha256"),
        },
        "frames": frames,
    }
    (reference / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", "utf-8")
    validation = exported.get("validation") or {}
    ok = exported.get("state") == "completed" and validation.get("ok") is True
    return {"ok": ok, "manifest": manifest}


def _compare(reference: bytes, reopened: bytes) -> dict[str, float | None]:
    """PSNR (``None`` when identical: infinite, and not JSON), share within tolerance, max error."""
    import numpy as np

    a = np.frombuffer(reference, dtype=np.uint8).astype(np.int16)
    b = np.frombuffer(reopened, dtype=np.uint8).astype(np.int16)
    if a.shape != b.shape:
        return {"psnr": 0.0, "within": 0.0, "maxError": 255.0}
    difference = np.abs(a - b)
    mse = float(np.mean(difference.astype(np.float64) ** 2))
    psnr = None if mse == 0 else 10 * float(np.log10(255.0**2 / mse))
    pixels = difference.reshape(-1, 3).max(axis=1)
    return {
        "psnr": psnr,
        "within": float(np.mean(pixels <= CHANNEL_TOLERANCE)),
        "maxError": float(difference.max()),
    }


def reopen(root: Path) -> dict[str, Any]:
    """Render the moved folder and compare it with the reference it carries."""
    from PIL import Image

    project_path = root / "project" / "project.fp.json"
    manifest = json.loads((root / "reference" / "manifest.json").read_text("utf-8"))
    exported = _export(project_path, project_path.parent / "exports" / "reopened.mp4")
    failures: list[str] = []
    if exported.get("state") != "completed":
        failures.append(f"export: {exported.get('state')} {exported.get('error')}")
    if (exported.get("validation") or {}).get("ok") is not True:
        failures.append("export validation failed")
    reference_probe = manifest["export"]["probe"] or {}
    probe = exported.get("probe") or {}
    if [s["codecType"] for s in probe.get("streams", [])] != [
        s["codecType"] for s in reference_probe.get("streams", [])
    ]:
        failures.append("export streams differ")
    if abs((probe.get("durationSeconds") or 0) - (reference_probe.get("durationSeconds") or 0)) > (
        1 / FPS
    ):
        failures.append("export duration differs")
    samples: list[dict[str, Any]] = []
    try:
        reopened = _frames(project_path)
    except Exception as exc:  # a refused frame is a failed reopen, reported like one
        failures.append(f"frames: {exc}")
        reopened = []
    for recorded, (time, pixels, width, height) in zip(
        manifest["frames"][: len(reopened)], reopened, strict=True
    ):
        with Image.open(root / "reference" / recorded["png"]) as image:
            reference = image.convert("RGB").tobytes()
        numbers = _compare(reference, pixels)
        identical = hashlib.sha256(pixels).hexdigest() == recorded["sha256"]
        samples.append({"time": time, "identical": identical, **numbers})
        if (width, height) != (recorded["width"], recorded["height"]):
            failures.append(f"t={time}: size {width}x{height}")
        elif (numbers["psnr"] is not None and numbers["psnr"] < PSNR_MIN_DB) or (
            numbers["within"] or 0.0
        ) < WITHIN_MIN_FRACTION:
            within = (numbers["within"] or 0.0) * 100
            failures.append(f"t={time}: PSNR {numbers['psnr']} dB, {within:.3f}% within")
    return {
        "ok": not failures,
        "failures": failures,
        "from": manifest["platform"],
        "on": _platform(),
        "exportIdentical": exported.get("sha256") == manifest["export"]["sha256"],
        "frames": samples,
    }


def main(argv: list[str] | None = None) -> int:
    # Software encode: a hardware encoder is not bit-reproducible (as in masking_e2e_engine).
    os.environ.setdefault("FRAMEPILOT_HW_ENCODE", "0")
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 2 or args[0] not in ("create", "reopen"):
        sys.stderr.write("usage: masking_archive {create,reopen} <dir>\n")
        return 2
    root = Path(args[1])
    report = create(root) if args[0] == "create" else reopen(root)
    sys.stdout.write(json.dumps(report, default=str) + "\n")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
