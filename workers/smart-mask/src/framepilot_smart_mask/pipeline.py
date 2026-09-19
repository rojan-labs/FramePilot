"""The ``subject.matte`` job: every stage of plan 02, window by window, resumable.

Per processing window (300 frames, 60 overlap):

  decode → SAM passes A/B/C (prompts, locks, brush-corrected frames, the previous window's
  alpha as seed) → BiRefNet refine → consensus → self-correction (K=3) → re-refine accepted
  frames → band alpha at source resolution → hard constraints (locks, brush) → band-only
  stabilisation → foreground colour → verify → encode this window's committed frames as
  segments under ``windows/<i>/`` → checkpoint.

Only one model family is loaded at a time. Everything frame-sized lives in memory maps in the
job's ``scratch/`` directory. After the last window the segments are joined into the declared
files, ``frames.json`` and ``report.json`` are written, private directories are removed, and the
byte ceiling is checked again.

**Partial re-run** (``previousArtifact``): a new prompt *affects* a frame only if the previous
matte does not already satisfy it (an include point on background, an exclude point on the
subject, a box whose selection differs, a lock or brush the previous alpha does not match).
Frames within ``AFFECT_RADIUS`` of an affecting prompt are recomputed, seeded at the edges from
the previous alpha; every other frame keeps the previous alpha bit for bit.

**Resume**: a window that finished before a crash is recorded in ``windows/<i>/done.json`` with a
fingerprint of the request and the pipeline. A restart with the same fingerprint reuses it.
"""

from __future__ import annotations

import hashlib
import json
import logging
import shutil
import time
from collections import OrderedDict
from collections.abc import Callable, Iterator
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path
from typing import Any, Final

import numpy as np
import numpy.typing as npt

from . import MATTE_PIPELINE_VERSION, PACK_VERSION
from .backend import MattingModel, MediaUnreadableError, ModelProvider, SamModules, VideoInfo
from .consensus import consensus, edge_radius, iou, snap_to_image, soft_edge
from .embeddings import EmbeddingCache
from .encode import concat_segments, decode_gray_frames, encode_stream, packet_count
from .flow import flow as dis_flow
from .flow import gray, warp
from .foreground import foreground_frame
from .frames import FrameStore, decode_into
from .matting import band_alpha
from .media import encode_frames_json, frames_document
from .memory import WINDOW_SECONDS_PER_FRAME
from .models import result_provider
from .prompts import (
    FramePrompts,
    ResolvedPrompts,
    apply_constraints,
    constrained_pixels,
    edge_band,
    resolve_prompts,
)
from .protocol import (
    MAX_SIDE,
    ArtifactFile,
    ExecutionProvider,
    MatteArtifact,
    MatteOutcome,
    MatteRequest,
    MatteSummary,
    ProtocolError,
    ReviewRange,
)
from .refine import RefineRecord, TileChoice, choose_tile, refine_frame
from .report import build_report, write_report
from .runtime import CancellationFlag, ProgressSink
from .sandbox import (
    SCRATCH_DIRECTORY,
    WINDOWS_DIRECTORY,
    InputDirectory,
    OutputDirectory,
    sha256_file,
)
from .segment import (
    WINDOW_FRAMES,
    WINDOW_OVERLAP,
    Segmentation,
    WindowPlan,
    plan_windows,
    segment_window,
)
from .self_correct import CorrectionReport, Run, self_correct
from .stabilise import stabilise
from .tracker import CondPrompt, MaskPrompt, PointPrompt, SamTracker, preprocess, video_logits
from .verify import Thresholds, flag_frames, frame_signals, review_ranges

_log = logging.getLogger(__name__)

GIB: Final = 1024**3
AFFECT_RADIUS: Final = 60
BOX_SATISFIED_IOU: Final = 0.9
FLOW_CACHE_ENTRIES: Final = 8
CHECKPOINT_VERSION: Final = 1
SEGMENT_KINDS: Final = {
    "matte.mkv": "matte",
    "foreground.mkv": "foreground",
    "preview.webm": "preview",
    "foreground.preview.webm": "foreground_preview",
}

Bool = npt.NDArray[np.bool_]
U8 = npt.NDArray[np.uint8]


@dataclass(frozen=True, slots=True)
class PipelineConfig:
    memory_ceiling_bytes: int = 8 * GIB
    matting_tile: int | None = None
    window_frames: int = WINDOW_FRAMES
    window_overlap: int = WINDOW_OVERLAP
    thresholds: Thresholds = field(default_factory=Thresholds)
    embedding_ram_bytes: int = 512 * 1024 * 1024
    embedding_spill_bytes: int = 8 * GIB
    self_correction_rounds: int = 3
    affect_radius: int = AFFECT_RADIUS
    #: Eval ablations (06 gates compare against them): False gives the binary refined edge
    #: (no BiRefNet alpha in the band) or skips band-only stabilisation. Always True in a pack.
    band_alpha: bool = True
    stabilise: bool = True
    #: Window watchdog budget per frame (memory.py). Raised only for eval runs on slow CPUs.
    window_seconds_per_frame: float = WINDOW_SECONDS_PER_FRAME
    #: Eval only: write each window's independent estimates here for error attribution.
    eval_dump: Path | None = None


@dataclass
class ToolPaths:
    ffmpeg: str
    ffprobe: str
    report: dict[str, Any]


# --- helpers ------------------------------------------------------------------------------------


class Scratch:
    """Frame-sized arrays as memory maps in the job's scratch directory."""

    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self._paths: list[Path] = []

    def array(self, name: str, shape: tuple[int, ...], dtype: Any) -> Any:
        path = self.directory / f"{name}.npy"
        self._paths.append(path)
        return np.lib.format.open_memmap(path, mode="w+", dtype=dtype, shape=shape)

    def close(self) -> None:
        for path in self._paths:
            path.unlink(missing_ok=True)
        self._paths.clear()


class FlowCache:
    def __init__(self, grays: list[Any]) -> None:
        self._grays = grays
        self._cache: OrderedDict[tuple[int, int], Any] = OrderedDict()

    def __call__(self, source: int, target: int) -> Any:
        key = (source, target)
        hit = self._cache.get(key)
        if hit is not None:
            self._cache.move_to_end(key)
            return hit
        value = dis_flow(self._grays[source], self._grays[target])
        self._cache[key] = value
        while len(self._cache) > FLOW_CACHE_ENTRIES:
            self._cache.popitem(last=False)
        return value


def fingerprint(
    request: MatteRequest, info: VideoInfo, config: PipelineConfig, digests: dict[str, str]
) -> str:
    """Identity of a job's result, independent of request id and staging location."""
    document = {
        "pack": PACK_VERSION,
        "pipeline": MATTE_PIPELINE_VERSION,
        "media": [
            request.media.asset_id,
            request.media.first_frame,
            request.media.last_frame_exclusive,
        ],
        "timing": [
            list(info.time_base),
            info.pts[request.media.first_frame],
            info.pts[request.media.last_frame_exclusive - 1],
        ],
        "prompts": [asdict(prompt) for prompt in request.prompts],
        "previous": request.previous_artifact,
        "preview": request.preview_height,
        "files": sorted(request.output.allowed_files),
        "config": {**asdict(config), "thresholds": config.thresholds.as_json()},
        "models": sorted(digests.items()),
    }
    return hashlib.sha256(json.dumps(document, sort_keys=True, default=str).encode()).hexdigest()


def _prompt_satisfied(frame: FramePrompts, previous: U8, width: int, height: int) -> bool:
    mask = previous >= 128
    if frame.lock is not None:
        return bool(np.array_equal(frame.lock, previous))
    if frame.keep is not None and bool((previous[frame.keep] != 255).any()):
        return False
    if frame.remove is not None and bool((previous[frame.remove] != 0).any()):
        return False
    # An edge stroke asks for re-matting; the previous alpha cannot already "satisfy" it.
    if edge_band(frame) is not None:
        return False
    points = [(c, lab) for c, lab in zip(frame.coords, frame.labels, strict=True) if lab in (0, 1)]
    for (x, y), label in points:
        px, py = min(int(x * width), width - 1), min(int(y * height), height - 1)
        if bool(mask[py, px]) != (label == 1):
            return False
    if frame.has_box:
        (x0, y0), (x1, y1) = frame.coords[0], frame.coords[1]
        box = np.zeros_like(mask)
        box[
            int(y0 * height) : int(np.ceil(y1 * height)), int(x0 * width) : int(np.ceil(x1 * width))
        ] = True
        ys, xs = np.nonzero(mask)
        if len(xs) == 0:
            return False
        bbox = np.zeros_like(mask)
        bbox[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1] = True
        if iou(box, bbox) < BOX_SATISFIED_IOU:
            return False
    return True


def affected_ranges(
    affecting: list[int], count: int, radius: int = AFFECT_RADIUS
) -> list[tuple[int, int]]:
    """Merged ``[start, end)`` ranges within ``radius`` of an affecting prompt frame."""
    spans = sorted((max(index - radius, 0), min(index + radius + 1, count)) for index in affecting)
    merged: list[list[int]] = []
    for start, end in spans:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return [(start, end) for start, end in merged]


# --- the job ------------------------------------------------------------------------------------


@dataclass
class FrameRecord:
    pts: int
    score: float = float("nan")
    parts: dict[str, float] = field(default_factory=dict)
    checks: list[str] = field(default_factory=list)
    locked: bool = False
    reused: bool = False
    rounds: int = 0
    refine: str = ""
    band_passes: int = 0
    stabilised_pixels: int = 0
    #: Threshold-free verify measurements, so thresholds can be calibrated offline (BR3.15).
    signals: dict[str, Any] = field(default_factory=dict)

    def as_json(self) -> dict[str, Any]:
        return {
            "pts": self.pts,
            "score": self.score,
            "parts": self.parts,
            "checks": self.checks,
            "verified": not self.checks,
            "locked": self.locked,
            "reused": self.reused,
            "selfCorrectionRound": self.rounds,
            "refine": self.refine,
            "bandPasses": self.band_passes,
            "stabilisedPixels": self.stabilised_pixels,
            "signals": self.signals,
        }

    def restore(self, saved: dict[str, Any]) -> None:
        self.score = float("nan") if saved["score"] is None else float(saved["score"])
        self.parts = saved["parts"]
        self.checks = saved["checks"]
        self.rounds = saved["selfCorrectionRound"]
        self.refine = saved["refine"]
        self.band_passes = saved["bandPasses"]
        self.stabilised_pixels = saved["stabilisedPixels"]
        self.signals = saved.get("signals", {})


@dataclass
class JobContext:
    """Everything fixed once the clip is probed; shared by every window."""

    info: VideoInfo
    width: int
    height: int
    pts: list[int]
    document: dict[str, Any]
    resolved: ResolvedPrompts
    previous: dict[int, U8] | None
    fingerprint: str
    records: list[FrameRecord]
    segments: dict[str, list[str]]
    carried: dict[int, U8] = field(default_factory=dict)

    @property
    def count(self) -> int:
        return len(self.pts)


@dataclass
class WindowState:
    """One window's working set; frame-sized arrays are memory maps in scratch."""

    plan: WindowPlan
    start: int  # job frame index of local frame 0
    commit_start: int
    commit_end: int
    directory: Path
    store: FrameStore
    scratch: Scratch

    @property
    def count(self) -> int:
        return len(self.store)

    @property
    def end(self) -> int:
        return self.start + self.count

    @property
    def committed(self) -> range:
        return range(self.commit_start - self.start, self.commit_end - self.start)


class MatteJob:
    """One ``subject.matte`` request. Construct, then :meth:`run`."""

    def __init__(
        self,
        request: MatteRequest,
        *,
        provider: ModelProvider,
        media: Any,
        tools: ToolPaths,
        config: PipelineConfig,
        progress: ProgressSink,
        cancellation: CancellationFlag,
        memory_probe: Callable[[], dict[str, Any]] | None = None,
        on_window: Callable[[int | None], None] | None = None,
    ) -> None:
        self.request = request
        self.provider = provider
        self.media = media
        self.tools = tools
        self.config = config
        self.progress = progress
        self.cancellation = cancellation
        self.memory_probe = memory_probe
        #: Called with a window's frame count when it starts and None when it ends (watchdog).
        self.on_window = on_window or (lambda _frames: None)
        self.output = OutputDirectory(request.output)
        self.inputs = InputDirectory(request.inputs) if request.inputs is not None else None
        self.windows_dir = self.output.private_directory(WINDOWS_DIRECTORY)
        self.scratch_dir = self.output.private_directory(SCRATCH_DIRECTORY)
        self.timings: dict[str, float] = {}
        self.rounds_used = 0
        self._sam: SamModules | None = None
        self._matting: MattingModel | None = None
        self._tile: TileChoice | None = None
        self.click_choices: list[dict[str, Any]] = []

    # model lifetime: one family in memory at a time ---------------------------------------------

    def _use_sam(self) -> SamModules:
        if self._matting is not None:
            self._matting.close()
            self._matting = None
        if self._sam is None:
            self.progress("prepare", 0, 1, detail="loading the segmenter")
            self._sam = self.provider.open_sam()
            self.progress("prepare", 1, 1)
        return self._sam

    def _use_matting(self) -> MattingModel:
        if self._sam is not None:
            self._sam.close()
            self._sam = None
        if self._matting is None:
            assert self._tile is not None
            self.progress("prepare", 0, 1, detail="loading the matting model")
            self._matting = self.provider.open_matting(self._tile.size)
            self.progress("prepare", 1, 1)
        return self._matting

    def _close_models(self) -> None:
        for model in (self._sam, self._matting):
            if model is not None:
                model.close()
        self._sam = None
        self._matting = None

    def _check(self) -> None:
        self.cancellation.raise_if_cancelled()

    def _timed(self, name: str, started: float) -> None:
        self.timings[name] = round(self.timings.get(name, 0.0) + time.monotonic() - started, 3)

    def _wants_foreground(self) -> bool:
        allowed = self.request.output.allowed_files
        return "foreground.mkv" in allowed or "foreground.preview.webm" in allowed

    # run ----------------------------------------------------------------------------------------

    def run(self) -> MatteOutcome:
        try:
            return self._run()
        except OSError as error:
            raise ProtocolError(
                "output_unwritable",
                f"The matte could not be written: {error.strerror}.",
                retryable=True,
            ) from error
        finally:
            self._close_models()

    def _run(self) -> MatteOutcome:
        ctx = self._context()
        work_index = 0
        position = 0
        for start, end in self._compute_ranges(ctx):
            if start > position:
                self._reuse(ctx, position, start, work_index)
                work_index += 1
            self._compute(ctx, start, end, work_index)
            windows = plan_windows(
                end - start, self.config.window_frames, self.config.window_overlap
            )
            work_index += 1 + len(windows)
            position = end
        if position < ctx.count:
            self._reuse(ctx, position, ctx.count, work_index)
        return self._finish(ctx)

    def _context(self) -> JobContext:
        request = self.request
        self.progress("prepare", 0, 1, detail="reading the clip")
        info: VideoInfo = self.media.probe(request.media.absolute_path)
        first, count = request.media.first_frame, request.media.frame_count
        if first + count > len(info.pts):
            raise MediaUnreadableError(
                "The requested frames are beyond the media's decoded frames."
            )
        width, height = info.display_size
        if width > MAX_SIDE or height > MAX_SIDE:
            raise ProtocolError(
                "hardware_unsupported",
                "The clip is larger than 8K, which background removal does not support.",
            )
        document = frames_document(info, first, count)
        pts: list[int] = document["pts"]
        self._tile = choose_tile(
            self.provider.matting_tiles, self.config.memory_ceiling_bytes, self.config.matting_tile
        )
        resolved = resolve_prompts(request, tuple(pts), width, height, self.inputs)
        records = [FrameRecord(pts=value) for value in pts]
        for index in resolved.locked:
            records[index].locked = True
        segments: dict[str, list[str]] = {
            name: [] for name in SEGMENT_KINDS if name in request.output.allowed_files
        }
        return JobContext(
            info=info,
            width=width,
            height=height,
            pts=pts,
            document=document,
            resolved=resolved,
            previous=self._previous_alpha(pts, width, height),
            fingerprint=fingerprint(request, info, self.config, self.provider.model_digests),
            records=records,
            segments=segments,
        )

    # previous artifact -------------------------------------------------------------------------

    def _previous_alpha(self, pts: list[int], width: int, height: int) -> dict[int, U8] | None:
        inputs = self.inputs
        if self.request.previous_artifact is None or inputs is None:
            return None
        if not (inputs.has("previous/matte.mkv") and inputs.has("previous/frames.json")):
            return None
        try:
            previous_pts = [
                int(value) for value in json.loads(inputs.read_bytes("previous/frames.json"))["pts"]
            ]
        except (ValueError, KeyError, TypeError) as error:
            raise ProtocolError(
                "invalid_request", "The previous artifact's frames.json is unreadable."
            ) from error
        wanted = {value: index for index, value in enumerate(pts)}
        alpha: dict[int, U8] = {}
        path = str(inputs.path("previous/matte.mkv"))
        for previous_index, frame in enumerate(
            decode_gray_frames(self.tools.ffmpeg, path, width, height)
        ):
            if previous_index >= len(previous_pts):
                break
            index = wanted.get(previous_pts[previous_index])
            if index is not None:
                alpha[index] = frame.copy()
        return alpha

    def _compute_ranges(self, ctx: JobContext) -> list[tuple[int, int]]:
        previous = ctx.previous
        if previous is None:
            return [(0, ctx.count)]
        affecting = [
            index
            for index, frame in ctx.resolved.frames.items()
            if index not in previous
            or not _prompt_satisfied(frame, previous[index], ctx.width, ctx.height)
        ]
        missing = [(index, index + 1) for index in range(ctx.count) if index not in previous]
        return _merge(affected_ranges(affecting, ctx.count, self.config.affect_radius) + missing)

    # reused frames -----------------------------------------------------------------------------

    def _reuse(self, ctx: JobContext, start: int, end: int, work_index: int) -> None:
        """Frames the new prompts do not affect keep the previous alpha bit for bit."""
        previous = ctx.previous
        assert previous is not None
        directory = self.windows_dir / f"reuse-{work_index}"
        directory.mkdir(exist_ok=True)
        count = end - start
        store = FrameStore(
            self.scratch_dir, count, ctx.height, ctx.width, name=f"reuse-{work_index}"
        )
        try:
            self.progress("decode", 0, count, detail="reusing unaffected frames")
            first = self.request.media.first_frame + start
            decode_into(self.media, self.request.media.absolute_path, ctx.info, first, store)
            alphas = [previous[index] for index in range(start, end)]
            grays = [gray(store[i]) for i in range(count)]
            flows = FlowCache(grays)
            empty_band = np.zeros((ctx.height, ctx.width), bool)
            unmeasured = (float("nan"), float("nan"))
            signals = [
                frame_signals(
                    i, alphas, grays, flows, {"estimates": 0.0}, unmeasured, [empty_band] * count
                )
                for i in range(count)
            ]
            # These frames have no new model estimates, so only the image-based checks can run.
            thresholds = replace(
                self.config.thresholds,
                e_sam_pair_iou=None,
                e_sam_birefnet_iou=None,
                e_hard_disagreement=None,
                e_band_frac=None,
                f_object_score=False,
            )
            locked = {index - start for index in range(start, end) if ctx.records[index].locked}
            for local, checks in enumerate(
                flag_frames(_without_unmeasured(signals), thresholds, locked)
            ):
                ctx.records[start + local].checks = checks
                ctx.records[start + local].reused = True
                ctx.records[start + local].signals = signals[local]
            foregrounds = (
                [foreground_frame(store[i], alphas[i]) for i in range(count)]
                if self._wants_foreground()
                else []
            )
            self._encode_segment(ctx, directory, alphas, foregrounds)
        finally:
            store.close()

    # computed frames ---------------------------------------------------------------------------

    def _compute(self, ctx: JobContext, start: int, end: int, work_index: int) -> None:
        ctx.carried.clear()
        for plan in plan_windows(
            end - start, self.config.window_frames, self.config.window_overlap
        ):
            self._check()
            directory = self.windows_dir / f"{work_index + 1 + plan.index}"
            done = directory / "done.json"
            state = _read_checkpoint(done, ctx.fingerprint) if done.is_file() else None
            if state is not None:
                self._restore(ctx, state, directory)
                continue
            if directory.exists():
                shutil.rmtree(directory)
            directory.mkdir()
            count = plan.count
            window = WindowState(
                plan=plan,
                start=start + plan.start,
                commit_start=start + plan.commit_start,
                commit_end=start + plan.commit_end,
                directory=directory,
                store=FrameStore(
                    self.scratch_dir, count, ctx.height, ctx.width, name=f"window-{plan.index}"
                ),
                scratch=Scratch(self.scratch_dir),
            )
            started = time.monotonic()
            self.on_window(count)
            try:
                self._window(ctx, window)
            finally:
                self.on_window(None)
                window.store.close()
                window.scratch.close()
            self._timed("windows", started)

    def _window(self, ctx: JobContext, window: WindowState) -> None:
        count = window.count
        self._decode(ctx, window)
        prompts = self._window_prompts(ctx, window)
        if not prompts:
            raise ProtocolError(
                "target_lost", "Nothing to follow in this part of the clip: add a click or a box."
            )

        started = time.monotonic()
        self._use_sam()
        spill = self.scratch_dir / f"embeddings-{window.plan.index}"
        spill.mkdir(exist_ok=True)
        store = window.store
        embeddings = EmbeddingCache(
            # The model is reopened after BiRefNet runs; always encode with the open session.
            lambda key: self._use_sam().encode_image(preprocess(store[int(key)])),  # type: ignore[call-overload]
            max_ram_bytes=self.config.embedding_ram_bytes,
            spill_directory=spill,
            max_spill_bytes=self.config.embedding_spill_bytes,
        )
        try:
            # Encode every frame first (RAM + scratch spill), then release the image encoder so it
            # is never resident beside memory attention: the job's peak drops by ~3 GB.
            for index in range(count):
                self._check()
                embeddings.get(index)
                self.progress(
                    "segment",
                    index + 1,
                    3 * count,
                    detail="encoding frames" if index == 0 else None,
                )
            release = getattr(self._use_sam(), "release", None)
            if release is not None:
                release("sam_image_encoder")
            tracker = SamTracker(self._use_sam(), embeddings.get, should_stop=self._check)
            tracked = {"frames": 0}

            def on_tracked(_which: str, _index: int) -> None:
                tracked["frames"] += 1
                self.progress("segment", count + min(tracked["frames"], 2 * count), 3 * count)

            segmentation = segment_window(
                tracker, count, ctx.height, ctx.width, prompts, on_frame=on_tracked
            )
            self.click_choices.extend(tracker.click_choices)
            if self.config.eval_dump is not None:
                for local, candidates in tracker.click_candidates:
                    self.config.eval_dump.mkdir(parents=True, exist_ok=True)
                    np.savez_compressed(
                        self.config.eval_dump / f"click-{window.start + local:06d}.npz",
                        candidates=candidates,
                    )
            self._timed("segment", started)

            birefnet = window.scratch.array("birefnet", (count, ctx.height, ctx.width), np.uint8)
            refine_records = [RefineRecord((0, 0, 0, 0), "empty", 0)] * count
            self._refine(window, segmentation, birefnet, refine_records, list(range(count)))

            scores, parts, masks = self._first_consensus(window, segmentation, birefnet)
            locked = {
                i - window.start for i in ctx.resolved.locked if window.start <= i < window.end
            }
            started = time.monotonic()
            report = self._self_correct(
                ctx, window, tracker, segmentation, birefnet, masks, scores, locked, prompts
            )
            self._timed("self_correct", started)
        finally:
            embeddings.clear()
        if report.accepted:
            self._refine(window, segmentation, birefnet, refine_records, sorted(report.accepted))

        grays = [gray(store[i]) for i in range(count)]
        flows = FlowCache(grays)
        alphas, bands, fixed = self._final_matte(
            ctx, window, segmentation, birefnet, refine_records, flows, parts
        )
        if self.config.eval_dump is not None:
            _dump_estimates(self.config.eval_dump, window, segmentation, birefnet, alphas, bands)
        stabilised = self._stabilise(window, alphas, bands, fixed, flows)
        flags, signals = self._verify(
            window, segmentation, alphas, bands, grays, flows, parts, locked
        )

        ctx.carried.clear()
        for i in range(count):
            if window.start + i >= window.commit_end:
                ctx.carried[window.start + i] = np.array(alphas[i])
        for i in window.committed:
            record = ctx.records[window.start + i]
            record.score = parts[i]["score"]
            record.parts = parts[i]
            record.checks = flags[i]
            record.rounds = report.accepted.get(i, 0)
            record.refine = refine_records[i].mode
            record.stabilised_pixels = stabilised[i]
            record.signals = signals[i]
        self._encode_window(ctx, window, alphas)
        self.rounds_used = max(self.rounds_used, report.rounds)
        _write_checkpoint(
            window.directory,
            ctx.fingerprint,
            records=[ctx.records[window.start + i].as_json() for i in window.committed],
            first=window.commit_start,
            carried=ctx.carried,
            rounds=report.rounds,
        )

    # stages --------------------------------------------------------------------------------------

    def _decode(self, ctx: JobContext, window: WindowState) -> None:
        started = time.monotonic()
        count = window.count
        detail = f"window {window.plan.index + 1}"

        def on_frame(index: int) -> None:
            self._check()
            self.progress("decode", index + 1, count, detail=detail if index == 0 else None)

        first = self.request.media.first_frame + window.start
        decode_into(
            self.media,
            self.request.media.absolute_path,
            ctx.info,
            first,
            window.store,
            on_frame=on_frame,
        )
        self._timed("decode", started)

    def _window_prompts(self, ctx: JobContext, window: WindowState) -> dict[int, CondPrompt]:
        """Editor prompts in the window, plus seeds from the previous window or artifact."""
        prompts: dict[int, CondPrompt] = {}
        previous = ctx.previous
        for index, frame in ctx.resolved.frames.items():
            if not window.start <= index < window.end:
                continue
            local = index - window.start
            if frame.lock is not None:
                prompts[local] = MaskPrompt(frame.lock >= 128)
            elif frame.keep is not None:
                base = ctx.carried.get(index)
                if base is None and previous is not None:
                    base = previous.get(index)
                if base is None:
                    base = np.zeros((ctx.height, ctx.width), np.uint8)
                prompts[local] = MaskPrompt(apply_constraints(base, frame) >= 128)
            elif frame.has_points:
                prompts[local] = PointPrompt(coords=tuple(frame.coords), labels=tuple(frame.labels))
        # Seed from the previous window: its alpha at the earliest overlap frame it committed after.
        carried = sorted(index for index in ctx.carried if window.start <= index < window.end)
        if carried:
            prompts.setdefault(
                carried[0] - window.start, MaskPrompt(ctx.carried[carried[0]] >= 128)
            )
        # A partial re-run is anchored at both edges by the previous matte.
        if previous is not None:
            for local, index in ((0, window.start), (window.count - 1, window.end - 1)):
                if local not in prompts and index in previous and 0 < index < ctx.count - 1:
                    prompts[local] = MaskPrompt(previous[index] >= 128)
        return prompts

    def _refine(
        self,
        window: WindowState,
        segmentation: Segmentation,
        birefnet: Any,
        records: list[RefineRecord],
        indices: list[int],
    ) -> None:
        started = time.monotonic()
        matting = self._use_matting()
        empty = np.zeros((segmentation.height, segmentation.width), bool)
        for position, i in enumerate(indices):
            self._check()
            sam_masks = segmentation.masks(i)
            union = np.logical_or.reduce(sam_masks) if sam_masks else empty
            birefnet[i], records[i] = refine_frame(matting, window.store[i], union)
            self.progress("refine", position + 1, len(indices))
        self._timed("refine", started)

    def _first_consensus(
        self, window: WindowState, segmentation: Segmentation, birefnet: Any
    ) -> tuple[list[float], list[dict[str, float]], list[Bool]]:
        started = time.monotonic()
        radius = edge_radius(segmentation.height)
        scores: list[float] = []
        parts: list[dict[str, float]] = []
        masks: list[Bool] = []
        for i in range(window.count):
            self._check()
            result = consensus(
                snap_to_image(segmentation.masks(i), window.store[i]),
                segmentation.mean_logits(i),
                birefnet[i],
                None,
                radius,
            )
            masks.append(result.majority)
            scores.append(result.score["score"])
            parts.append(result.score)
            self.progress("consensus", i + 1, window.count)
        self._timed("consensus", started)
        return scores, parts, masks

    def _self_correct(
        self,
        ctx: JobContext,
        window: WindowState,
        tracker: SamTracker,
        segmentation: Segmentation,
        birefnet: Any,
        masks: list[Bool],
        scores: list[float],
        locked: set[int],
        prompts: dict[int, CondPrompt],
    ) -> CorrectionReport:
        if self.config.self_correction_rounds <= 0:
            return CorrectionReport()
        binder = _CorrectionBinder(self, ctx, window, tracker, segmentation, birefnet, prompts)
        return self_correct(
            masks,
            scores,
            locked,
            warp=binder.warp,
            resegment=binder.resegment,
            rescore=binder.rescore,
            accept=binder.accept,
            max_rounds=self.config.self_correction_rounds,
            on_round=lambda r, done, total: self.progress(
                "self_correct", done, max(total, 1), round_number=r
            ),
            should_stop=self._check,
        )

    def _final_matte(
        self,
        ctx: JobContext,
        window: WindowState,
        segmentation: Segmentation,
        birefnet: Any,
        refine_records: list[RefineRecord],
        flows: FlowCache,
        parts: list[dict[str, float]],
    ) -> tuple[Any, Any, list[Bool]]:
        """Consensus in frame order with the warped previous alpha, band alpha, hard constraints."""
        started = time.monotonic()
        count = window.count
        radius = edge_radius(ctx.height)
        alphas = window.scratch.array("alpha", (count, ctx.height, ctx.width), np.uint8)
        bands = window.scratch.array("band", (count, ctx.height, ctx.width), np.bool_)
        fixed: list[Bool] = []
        matting = (
            self._use_matting()
            if self.config.band_alpha and any(record.downscaled for record in refine_records)
            else None
        )
        for i in range(count):
            self._check()
            warped = warp(alphas[i - 1].astype(np.float32), flows(i - 1, i)) if i > 0 else None
            frame_prompt = ctx.resolved.frames.get(window.start + i)
            result = consensus(
                snap_to_image(segmentation.masks(i), window.store[i]),
                segmentation.mean_logits(i),
                birefnet[i],
                warped,
                radius,
                extra_band=edge_band(frame_prompt),
            )
            alpha = soft_edge(result, window.store[i], edge_band(frame_prompt))
            if not self.config.band_alpha:
                alpha = np.where(result.majority, 255, 0).astype(np.uint8)
            elif (
                matting is not None and refine_records[i].downscaled and result.score["edgeTrusted"]
            ):
                # A full-resolution band pass is BiRefNet's edge: only where it is trusted.
                alpha, passes = band_alpha(
                    matting, window.store[i], alpha, result.band, refine_records[i]
                )
                ctx.records[window.start + i].band_passes = passes
            alphas[i] = apply_constraints(alpha, frame_prompt)
            bands[i] = result.band
            fixed.append(constrained_pixels(frame_prompt, (ctx.height, ctx.width)))
            parts[i] = result.score
            self.progress("matte", i + 1, count)
        self._close_models()
        self._timed("matte", started)
        return alphas, bands, fixed

    def _stabilise(
        self, window: WindowState, alphas: Any, bands: Any, fixed: list[Bool], flows: FlowCache
    ) -> list[int]:
        started = time.monotonic()
        count = window.count
        if not self.config.stabilise:
            return [0] * count
        self.progress("stabilise", 0, count)
        smoothed, changed = stabilise(
            [alphas[i] for i in range(count)], [bands[i] for i in range(count)], fixed, flows
        )
        for i in range(count):
            alphas[i] = smoothed[i]
        self.progress("stabilise", count, count)
        self._timed("stabilise", started)
        return changed

    def _verify(
        self,
        window: WindowState,
        segmentation: Segmentation,
        alphas: Any,
        bands: Any,
        grays: list[Any],
        flows: FlowCache,
        parts: list[dict[str, float]],
        locked: set[int],
    ) -> tuple[list[list[str]], list[dict[str, Any]]]:
        started = time.monotonic()
        count = window.count
        alpha_list = [alphas[i] for i in range(count)]
        band_list = [bands[i] for i in range(count)]
        signals = []
        for i in range(count):
            self._check()
            sam_scores = (float(segmentation.fwd_score[i]), float(segmentation.bwd_score[i]))
            signals.append(
                frame_signals(i, alpha_list, grays, flows, parts[i], sam_scores, band_list)
            )
            self.progress("verify", i + 1, count)
        flags = flag_frames(signals, self.config.thresholds, locked)
        self._timed("verify", started)
        return flags, signals

    def _encode_window(self, ctx: JobContext, window: WindowState, alphas: Any) -> None:
        committed = window.committed
        started = time.monotonic()
        foregrounds: list[U8] = []
        if self._wants_foreground():
            for position, i in enumerate(committed):
                self._check()
                foregrounds.append(foreground_frame(window.store[i], alphas[i]))
                self.progress("foreground", position + 1, len(committed))
        self._timed("foreground", started)
        started = time.monotonic()
        self._encode_segment(ctx, window.directory, [alphas[i] for i in committed], foregrounds)
        self._timed("encode", started)

    def _encode_segment(
        self, ctx: JobContext, directory: Path, alphas: list[Any], foregrounds: list[U8]
    ) -> None:
        for name, kind in SEGMENT_KINDS.items():
            if name not in ctx.segments:
                continue
            target = directory / name
            source = alphas if kind in ("matte", "preview") else foregrounds
            frames: Iterator[bytes] = (np.ascontiguousarray(frame).tobytes() for frame in source)
            written = encode_stream(
                self.tools.ffmpeg,
                str(target),
                kind,
                ctx.width,
                ctx.height,
                frames,
                self.request.preview_height,
            )
            if written != len(alphas):
                raise ProtocolError("internal_error", "A matte segment is missing frames.")
            ctx.segments[name].append(str(target))
            self.output.enforce_ceiling(pending_bytes=_bytes_in(ctx.segments))
        self.progress("encode", len(alphas), max(len(alphas), 1))

    def _restore(self, ctx: JobContext, state: dict[str, Any], directory: Path) -> None:
        first = int(state["first"])
        for offset, saved in enumerate(state["records"]):
            ctx.records[first + offset].restore(saved)
        ctx.carried.clear()
        carry = directory / "carry.npz"
        if carry.is_file():
            with np.load(carry) as data:
                for key in data.files:
                    ctx.carried[int(key)] = np.array(data[key])
        for name in ctx.segments:
            path = directory / name
            if not path.is_file():
                raise ProtocolError("internal_error", "A resumed window is missing a segment.")
            ctx.segments[name].append(str(path))
        self.rounds_used = max(self.rounds_used, int(state.get("rounds", 0)))
        restored = max(len(state["records"]), 1)
        self.progress("encode", restored, restored, detail="resumed a finished window")

    def _finish(self, ctx: JobContext) -> MatteOutcome:
        count = ctx.count
        self.progress("encode", 0, count, detail="joining windows")
        for name, parts in ctx.segments.items():
            destination = self.output.artifact_path(name)
            if len(parts) == 1:
                shutil.copyfile(parts[0], destination)
            else:
                concat_segments(self.tools.ffmpeg, str(destination), parts, self.scratch_dir)
            if (
                name in ("matte.mkv", "foreground.mkv")
                and packet_count(self.tools.ffprobe, str(destination)) != count
            ):
                raise ProtocolError(
                    "internal_error",
                    "The joined matte does not have one frame per requested frame.",
                )
            self.output.enforce_ceiling()
        self.output.artifact_path("frames.json").write_bytes(encode_frames_json(ctx.document))
        records = ctx.records
        flagged = sum(1 for record in records if record.checks)
        locked = sum(1 for record in records if record.locked)
        ranges: tuple[ReviewRange, ...] = review_ranges(
            [record.checks for record in records], [record.pts for record in records]
        )
        if "report.json" in self.request.output.allowed_files:
            report = build_report(
                frames=[record.as_json() for record in records], job=self._job_report(ctx)
            )
            write_report(self.output.artifact_path("report.json"), report)
        self.output.finalise()
        files = tuple(
            ArtifactFile(name, path.stat().st_size, sha256_file(path))
            for name in self.request.output.allowed_files
            if (path := self.output.artifact_path(name)).is_file()
        )
        return MatteOutcome(
            artifact=MatteArtifact(
                files=files,
                width=ctx.width,
                height=ctx.height,
                frame_count=count,
                first_pts=records[0].pts,
                last_pts=records[-1].pts,
                time_base=ctx.info.time_base,
            ),
            execution_provider=self._execution_provider(),
            summary=MatteSummary(
                verified_frames=count - flagged,
                flagged_frames=flagged,
                locked_frames=locked,
                self_correction_rounds=min(self.rounds_used, 16),
            ),
            needs_review=ranges,
        )

    def _provider_report(self) -> dict[str, Any]:
        report: dict[str, Any] = getattr(self.provider, "provider_report", dict)()
        return report

    def _job_report(self, ctx: JobContext) -> dict[str, Any]:
        records = ctx.records
        return {
            "frameCount": ctx.count,
            "size": [ctx.width, ctx.height],
            "timeBase": list(ctx.info.time_base),
            "providers": self._provider_report(),
            "backend": self.provider.backend_label,
            "tile": self._tile.as_json() if self._tile else None,
            "memoryCeilingBytes": self.config.memory_ceiling_bytes,
            "windows": {"frames": self.config.window_frames, "overlap": self.config.window_overlap},
            "thresholds": self.config.thresholds.as_json(),
            "ablations": [
                name
                for name, enabled in (
                    ("band_alpha", self.config.band_alpha),
                    ("stabilise", self.config.stabilise),
                )
                if not enabled
            ],
            "windowSecondsPerFrame": self.config.window_seconds_per_frame,
            "clickChoices": self.click_choices[:16],
            "selfCorrectionRounds": self.rounds_used,
            "timingsSeconds": self.timings,
            "tools": self.tools.report,
            "memory": self.memory_probe() if self.memory_probe is not None else None,
            "reusedFrames": sum(1 for record in records if record.reused),
            "promptFrames": len(ctx.resolved.frames),
        }

    def _execution_provider(self) -> ExecutionProvider:
        """The least accelerated provider that produced delivered pixels."""
        report = self._provider_report()
        chosen = set(report.get("chosen", {}).values()) or {"cpu"}
        if report.get("fallbacks") or "cpu" in chosen:
            return "cpu"
        return result_provider(sorted(chosen)[0])


def _dump_estimates(
    directory: Path,
    window: WindowState,
    segmentation: Segmentation,
    birefnet: Any,
    alphas: Any,
    bands: Any,
) -> None:
    """Eval only: one window's independent estimates before stabilisation, for attribution.

    ``fwd``/``bwd`` are SAM's binary masks at source size (``hasFwd``/``hasBwd`` say whether the
    pass reached the frame), ``birefnet`` its gated alpha, ``prestab`` the consensus alpha with
    band alpha and constraints applied, ``band`` the unknown band. Frame ``i`` of the arrays is
    job frame ``start + i``.
    """
    directory.mkdir(parents=True, exist_ok=True)
    count, height, width = window.count, segmentation.height, segmentation.width
    fwd = np.zeros((count, height, width), np.bool_)
    bwd = np.zeros((count, height, width), np.bool_)
    for i in range(count):
        if segmentation.has_fwd[i]:
            fwd[i] = segmentation.logits("fwd", i) > 0
        if segmentation.has_bwd[i]:
            bwd[i] = segmentation.logits("bwd", i) > 0
    np.savez_compressed(
        directory / f"window-{window.start:06d}.npz",
        start=np.int64(window.start),
        fwd=fwd,
        bwd=bwd,
        hasFwd=np.array(segmentation.has_fwd),
        hasBwd=np.array(segmentation.has_bwd),
        birefnet=np.array(birefnet),
        prestab=np.array(alphas),
        band=np.array(bands),
    )


class _CorrectionBinder:
    """Binds the self-correction loop's callables to SAM, DIS flow and consensus for one window."""

    def __init__(
        self,
        job: MatteJob,
        ctx: JobContext,
        window: WindowState,
        tracker: SamTracker,
        segmentation: Segmentation,
        birefnet: Any,
        prompts: dict[int, CondPrompt],
    ) -> None:
        self.job = job
        self.ctx = ctx
        self.window = window
        self.tracker = tracker
        self.segmentation = segmentation
        self.birefnet = birefnet
        self.prompts = prompts
        self._grays: dict[int, Any] = {}
        self._pending: dict[int, list[Any]] = {}

    def _gray(self, index: int) -> Any:
        if index not in self._grays:
            self._grays[index] = gray(self.window.store[index])
        return self._grays[index]

    def warp(self, source: int, target: int, mask: Bool) -> Bool:
        motion = dis_flow(self._gray(source), self._gray(target))
        warped: Bool = warp(mask.astype(np.float32), motion) >= 0.5
        return warped

    def resegment(self, run: Run, cond_prompts: dict[int, CondPrompt]) -> dict[int, list[Bool]]:
        # BiRefNet ran since the tracker was built and closed SAM: use the reopened session.
        self.tracker.modules = self.job._use_sam()
        outside = {
            index: prompt
            for index, prompt in self.prompts.items()
            if not run.start <= index <= run.end
        }
        cond = {
            index: self.tracker.condition(index, prompt)
            for index, prompt in {**outside, **cond_prompts}.items()
        }
        before = max((index for index in cond if index < run.start), default=run.start)
        after = min((index for index in cond if index > run.end), default=run.end)
        count = self.window.count
        forward = self.tracker.propagate(cond, count, reverse=False, start=before, stop=after)
        backward = self.tracker.propagate(cond, count, reverse=True, start=after, stop=before)
        estimates: dict[int, list[Bool]] = {}
        for index in range(run.start, run.end + 1):
            found = [
                video_logits(result.low_res[index], self.ctx.height, self.ctx.width) > 0
                for result in (forward, backward)
                if index in result.low_res
            ]
            if found:
                estimates[index] = found
                self._pending[index] = [forward, backward]
        return estimates

    def rescore(self, index: int, candidate: list[Bool]) -> float:
        radius = edge_radius(self.ctx.height)
        return float(consensus(candidate, None, self.birefnet[index], None, radius).score["score"])

    def accept(self, index: int, _candidate: list[Bool]) -> None:
        segmentation = self.segmentation
        forward, backward = self._pending[index]
        for logits, has, scores, result in (
            (segmentation.fwd, segmentation.has_fwd, segmentation.fwd_score, forward),
            (segmentation.bwd, segmentation.has_bwd, segmentation.bwd_score, backward),
        ):
            if index in result.low_res:
                logits[index] = result.low_res[index]
                has[index] = True
                scores[index] = result.scores[index]


def _merge(ranges: list[tuple[int, int]]) -> list[tuple[int, int]]:
    merged: list[list[int]] = []
    for start, end in sorted(ranges):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return [(start, end) for start, end in merged]


def _bytes_in(segments: dict[str, list[str]]) -> int:
    """Segments become the declared files; counting them early refuses a job before the join."""
    return sum(Path(path).stat().st_size for paths in segments.values() for path in paths)


def _without_unmeasured(signals: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Reused frames have no estimate signals; those checks are disabled, not failed."""
    return [{**signal, "samBirefnetIoU": 1.0, "bandFrac": 0.0} for signal in signals]


def _write_checkpoint(
    directory: Path,
    job_fingerprint: str,
    *,
    records: list[dict[str, Any]],
    first: int,
    carried: dict[int, U8],
    rounds: int,
) -> None:
    if carried:
        arrays: dict[str, Any] = {str(key): value for key, value in carried.items()}
        np.savez_compressed(directory / "carry.npz", **arrays)
    state = {
        "version": CHECKPOINT_VERSION,
        "fingerprint": job_fingerprint,
        "first": first,
        "records": records,
        "rounds": rounds,
    }
    temporary = directory / "done.json.partial"
    temporary.write_text(json.dumps(state), encoding="utf-8")
    temporary.replace(directory / "done.json")


def _read_checkpoint(path: Path, job_fingerprint: str) -> dict[str, Any] | None:
    try:
        state: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if state.get("version") != CHECKPOINT_VERSION or state.get("fingerprint") != job_fingerprint:
        return None
    return state


__all__ = [
    "AFFECT_RADIUS",
    "MatteJob",
    "PipelineConfig",
    "ToolPaths",
    "affected_ranges",
    "fingerprint",
]
