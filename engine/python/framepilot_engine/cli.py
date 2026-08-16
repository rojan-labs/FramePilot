"""Command-line entrypoint for the FramePilot engine.

WHY: the desktop shell and power users drive renders, validation, and media
inspection through a stable CLI (PRD §15.2, plan 2.4). This module wires the
``framepilot`` console script declared in ``pyproject.toml``.

Subcommands:

* ``render <project.fp.json>`` — compile + export a timeline (PRD §9.3).
* ``validate-render <output.mp4>`` — run render validation (PRD §9.4).
* ``inspect-media <input>`` — probe duration/fps/resolution/streams (plan 2.1).
* ``serve`` — start the FastAPI sidecar (plan 2.4).

Structured results (inspect-media, validate-render, render job) are printed as
JSON so the desktop shell / scripts can parse them; the exit code reflects
success (0) or failure (1).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from framepilot_engine import __version__
from framepilot_engine.audio.asr import (
    DEFAULT_ASR_MODEL,
    AsrError,
    get_status,
    setup_model,
)
from framepilot_engine.media.ffmpeg import FFmpegError
from framepilot_engine.media.probe import inspect_media
from framepilot_engine.render.pipeline import RenderOptions, RenderState, render
from framepilot_engine.timeline.models import ProjectFile, ProjectFileError
from framepilot_engine.validation.render_validation import ExpectedRender, validate_render


def _cmd_render(args: argparse.Namespace) -> int:
    """``framepilot render`` — load a project, render it, print the job (plan 2.2)."""
    project_path = Path(args.project)
    try:
        project = ProjectFile.load(project_path)
    except ProjectFileError as exc:
        print(f"error: {exc}")
        return 1

    opts = RenderOptions(
        preset_id=args.preset,
        output_path=args.output,
        preview=args.preview,
        burn_captions=args.burn_captions,
        denoise=args.denoise,
        loudness=args.loudness,
        limiter=args.limiter,
    )
    job = render(project, opts, base_dir=project_path.parent)
    print(job.model_dump_json(indent=2))
    return 0 if job.state == RenderState.COMPLETED else 1


def _cmd_validate_render(args: argparse.Namespace) -> int:
    """``framepilot validate-render`` — validate an output file (PRD §9.4)."""
    expected = ExpectedRender(
        duration_seconds=args.duration,
        expect_audio=not args.no_audio,
        expect_video=not args.no_video,
    )
    report = validate_render(Path(args.output), expected)
    print(report.model_dump_json(indent=2))
    return 0 if report.ok else 1


def _cmd_inspect_media(args: argparse.Namespace) -> int:
    """``framepilot inspect-media`` — probe a media file (plan 2.1)."""
    try:
        info = inspect_media(Path(args.input))
    except (FileNotFoundError, FFmpegError) as exc:
        print(f"error: {exc}")
        return 1
    print(info.model_dump_json(indent=2))
    return 0


def _print_download_progress(downloaded: int, total: int | None) -> None:
    """Overwrite a single stderr line with the real download figures.

    stderr so that piping this command's stdout still yields clean JSON, and a
    carriage return so a multi-minute download reports itself without scrolling.
    """
    megabytes = downloaded / (1 << 20)
    suffix = f" of {total / (1 << 20):.1f} MiB ({downloaded * 100 // total}%)" if total else ""
    print(f"\rdownloading: {megabytes:.1f} MiB{suffix}", end="", file=sys.stderr, flush=True)


def _cmd_setup_asr(args: argparse.Namespace) -> int:
    """``framepilot setup-asr`` — download + SHA256-verify the local ASR model
    (plan H0.1). Explicit, never implicit: transcription refuses to run against
    a missing model rather than triggering this itself."""
    try:
        path = setup_model(args.model, on_progress=_print_download_progress)
    except AsrError as exc:
        print(f"error: {exc}")
        return 1
    finally:
        print(file=sys.stderr)
    print(json.dumps({"model": args.model, "path": str(path)}, indent=2))
    return 0


def _cmd_asr_status(args: argparse.Namespace) -> int:
    """``framepilot asr-status`` — report local whisper-cli + model readiness."""
    status = get_status(args.model)
    print(
        json.dumps(
            {
                "binaryAvailable": status.binary_available,
                "binaryPath": status.binary_path,
                "model": status.model,
                "modelPresent": status.model_present,
                "modelPath": status.model_path,
                "downloadSizeBytes": status.download_size_bytes,
            },
            indent=2,
        )
    )
    return 0


def _cmd_serve(args: argparse.Namespace) -> int:
    """``framepilot serve`` — start the FastAPI sidecar (plan 2.4)."""
    # Imported lazily so the render/inspect paths and --help stay fast and don't
    # pull in uvicorn/fastapi unnecessarily.
    from framepilot_engine.service import serve

    serve(host=args.host, port=args.port)
    return 0


def build_parser() -> argparse.ArgumentParser:
    """Construct the top-level argument parser and all subcommands.

    Exposed separately so tests can assert the CLI contract without invoking
    :func:`main`.

    :returns: The configured :class:`argparse.ArgumentParser`.
    """
    parser = argparse.ArgumentParser(
        prog="framepilot",
        description="FramePilot deterministic render + media engine.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")

    subparsers = parser.add_subparsers(dest="command", metavar="<command>")

    render_cmd = subparsers.add_parser("render", help="Render/export a project timeline.")
    render_cmd.add_argument("project", help="Path to a project.fp.json file.")
    render_cmd.add_argument(
        "--preset", default=None, help="Export preset id (default: reels)."
    )
    render_cmd.add_argument("--output", default=None, help="Output path (within the project dir).")
    render_cmd.add_argument(
        "--preview", action="store_true", help="Fast, downscaled preview render."
    )
    render_cmd.add_argument(
        "--burn-captions",
        action="store_true",
        help="Burn caption-track text into the output (otherwise captions are soft/preview-only).",
    )
    render_cmd.add_argument(
        "--denoise", action="store_true", help="Master-bus broadband de-noise (ffmpeg afftdn)."
    )
    render_cmd.add_argument(
        "--loudness",
        default=None,
        choices=["social", "podcast", "broadcast"],
        help="Loudness normalization preset (ffmpeg loudnorm).",
    )
    render_cmd.add_argument(
        "--limiter", action="store_true", help="Master-bus brick-wall limiter (ffmpeg alimiter)."
    )
    render_cmd.set_defaults(func=_cmd_render)

    validate = subparsers.add_parser(
        "validate-render", help="Validate a rendered output file (PRD §9.4)."
    )
    validate.add_argument("output", help="Path to a rendered output (e.g. output.mp4).")
    validate.add_argument(
        "--duration",
        type=float,
        default=None,
        help="Expected duration in seconds (tolerance check).",
    )
    validate.add_argument("--no-audio", action="store_true", help="Do not expect an audio stream.")
    validate.add_argument("--no-video", action="store_true", help="Do not expect a video stream.")
    validate.set_defaults(func=_cmd_validate_render)

    inspect = subparsers.add_parser(
        "inspect-media", help="Probe a media file: duration/fps/resolution/streams."
    )
    inspect.add_argument("input", help="Path to an input media file.")
    inspect.set_defaults(func=_cmd_inspect_media)

    setup_asr = subparsers.add_parser(
        "setup-asr", help="Download + SHA256-verify the local ASR (whisper.cpp) model."
    )
    setup_asr.add_argument(
        "--model", default=DEFAULT_ASR_MODEL, help=f"Model name (default: {DEFAULT_ASR_MODEL})."
    )
    setup_asr.set_defaults(func=_cmd_setup_asr)

    asr_status = subparsers.add_parser(
        "asr-status", help="Report local whisper-cli binary + model readiness."
    )
    asr_status.add_argument(
        "--model", default=DEFAULT_ASR_MODEL, help=f"Model name (default: {DEFAULT_ASR_MODEL})."
    )
    asr_status.set_defaults(func=_cmd_asr_status)

    serve = subparsers.add_parser("serve", help="Start the FastAPI sidecar service.")
    serve.add_argument("--host", default=None, help="Bind host (defaults to config).")
    serve.add_argument("--port", type=int, default=None, help="Bind port (defaults to config).")
    serve.set_defaults(func=_cmd_serve)

    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI entrypoint.

    :param argv: Argument vector (excluding the program name). Defaults to
        ``sys.argv[1:]`` when ``None``.
    :returns: Process exit code (0 on success/help, 1 on failure).
    """
    from framepilot_engine.service import configure_logging

    configure_logging()
    parser = build_parser()
    args = parser.parse_args(argv)

    # No subcommand: print help and exit cleanly rather than erroring.
    if getattr(args, "func", None) is None:
        parser.print_help()
        return 0

    return int(args.func(args))


if __name__ == "__main__":  # pragma: no cover - exercised via console script
    raise SystemExit(main())
