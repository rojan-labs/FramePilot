"""The real inference backend: onnxruntime for the two SigLIP 2 towers, OpenCV for pixels.

**Run once against fetched weights, and no accuracy is claimed.** The digests in
``pack/models.lock.toml`` are real, the towers load, and this module has produced vectors
from decoded video. That first run is what confirmed the numbers transcribed from the model
card — the preprocessing constants, the tower input names, the tokenizer's padded length —
and it found two things no scripted backend could:

- ``run(None, ...)[0]`` was reading ``last_hidden_state``, a ``(batch, 196, 768)`` patch
  grid, not the embedding. The output is selected BY NAME now, and an export without
  ``pooler_output`` is refused rather than silently averaged.
- CoreML cannot execute the vision graph for any batch above one, so a request carrying up
  to 64 keyframes failed while the health check — which embeds nothing — passed.

What that run does NOT establish is whether the vectors are any *good*: no retrieval
accuracy, no shot-size or subject figure, has been measured. The ``decoded_media`` suite is
the confirmation, and it is skipped unless the weights are present. Treat this file as
wiring that has been proven to execute, not as evidence about label quality.

The layering is deliberate: everything above (:mod:`framepilot_visual_embed.policy`,
:mod:`framepilot_visual_embed.protocol`, :mod:`framepilot_visual_embed.runtime`) is pure
and fully tested against a scripted backend, so when the weights land the only thing left
to prove is this module.

Runtime notes:

- **onnxruntime's CPU provider, for both towers (AM2.6).** CoreML was requested first until it
  was measured on the M1 Pro: the text tower took 13.2 s to load on CoreML at a 6.95 GiB
  footprint (0.55 s and 1.24 GiB on CPU) and ran 12 prompts in 0.65 s (0.34 s on CPU); the
  vision tower took 3.5 s to load (0.29 s) and 180 ms per image (95 ms). Loading both on
  CoreML reached 7.4 GiB and grew swap past the local watchdog's limit, twice. CPU vectors
  match CoreML's to a cosine of 0.99992 or better on 144 real crops (vision); the CoreML text
  load could not be run to completion under that watchdog.
- **Each tower loads when first used.** Every pinned file is still hashed before anything
  loads; a crop request whose prompt-bank vectors are cached never loads the text tower, and a
  ``visual.text`` request never loads the vision tower.
- **OpenCV is already a licence-audited dependency of the pack family** (Subject
  Intelligence's ``cv`` extra), and it runs YuNet and SFace on its own ``dnn`` module, so
  face detection and identity add no third runtime.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from typing import Any, Final

from .backend import (
    BackendUnavailableError,
    Frame,
    MediaUnreadableError,
    Vector,
)
from .models import models_directory, resolve_model, verify_all
from .protocol import NormalizedBox

#: SigLIP 2 base patch16-224 preprocessing. Transcribed from the model card: square
#: resize to 224, [0, 1] rescale, then mean/std 0.5 — NOT the ImageNet statistics CLIP
#: uses. Getting this wrong degrades labels silently rather than failing, which is exactly
#: why it is named here and asserted in the decoded-media suite.
IMAGE_SIZE: Final = 224
IMAGE_MEAN: Final = 0.5
IMAGE_STD: Final = 0.5
#: The text tower's fixed context length for this checkpoint.
TEXT_CONTEXT_LENGTH: Final = 64
#: The graph output that IS the embedding.
#:
#: Both towers publish two outputs, and `pooler_output` is the second. Taking `run(...)[0]`
#: silently returns `last_hidden_state` — the per-patch tokens, `(batch, 196, 768)` for the
#: vision tower — which is not a vector at all. Selecting by name means a re-export that
#: reorders its outputs cannot quietly change what this pack embeds.
EMBEDDING_OUTPUT: Final = "pooler_output"
#: YuNet's own score floor. Below this a "face" is texture, and counting it would put a
#: phantom person in the ledger.
FACE_SCORE_THRESHOLD: Final = 0.9
FACE_NMS_THRESHOLD: Final = 0.3
#: Execution providers in preference order. CPU only: see the module notes (AM2.6).
EXECUTION_PROVIDERS: Final = ("CPUExecutionProvider",)


def _embedding_output(session: Any, tower: str) -> str:
    """The name of the tower's pooled-embedding output, or refuse to load.

    An export that does not publish :data:`EMBEDDING_OUTPUT` is not one this pack can use,
    and finding that out here — rather than by silently embedding per-patch tokens — is
    the difference between a failed load and a shot ledger full of meaningless vectors.
    """
    names = [output.name for output in session.get_outputs()]
    if EMBEDDING_OUTPUT not in names:
        raise BackendUnavailableError(
            f"the {tower} tower publishes {names}, with no '{EMBEDDING_OUTPUT}'; "
            "this export cannot be used for embeddings."
        )
    return EMBEDDING_OUTPUT


class OnnxVisualEmbedBackend:
    """Runs the pinned SigLIP 2 towers and the OpenCV face models.

    Constructed lazily by ``__main__.create_backend`` so a protocol failure never needs
    onnxruntime installed, and so the health check's model verification is the first thing
    that touches a weight file.

    :raises BackendUnavailableError: If onnxruntime, tokenizers, OpenCV or NumPy is
        missing from this environment (the ``cv`` extra was not installed).
    :raises ModelUnavailableError: If any pinned weight is absent or fails its digest.
    """

    def __init__(self, directory: Path | None = None) -> None:
        try:
            import cv2
            import numpy
            import onnxruntime
            from tokenizers import Tokenizer
        except ImportError as error:  # pragma: no cover - requires the cv extra
            raise BackendUnavailableError(
                "Visual Embed needs onnxruntime, tokenizers, OpenCV and NumPy "
                f"(install the 'cv' extra): {error}"
            ) from error
        self._cv2 = cv2
        self._numpy = numpy
        self._onnxruntime = onnxruntime
        self._tokenizer_type = Tokenizer
        models = directory if directory is not None else models_directory()
        self._models = models
        # Verify EVERY pinned file before loading ANY of them: a pack with one swapped
        # weight must not get as far as producing a vector with the four that matched.
        self._digests = verify_all(models)
        self._vision_session: Any = None
        self._text_session: Any = None
        self._tokenizer: Any = None
        self._image_dim: int | None = None
        self._faces = cv2.FaceDetectorYN.create(
            str(resolve_model("face", models)),
            "",
            (320, 320),
            FACE_SCORE_THRESHOLD,
            FACE_NMS_THRESHOLD,
        )
        self._identity = cv2.FaceRecognizerSF.create(str(resolve_model("identity", models)), "")
        self._face_dim = 128

    def _session(self, model_id: str) -> Any:
        session = self._onnxruntime.InferenceSession(
            str(resolve_model(model_id, self._models)), providers=list(EXECUTION_PROVIDERS)
        )
        _embedding_output(session, "vision" if model_id == "image" else "text")
        return session

    @property
    def _vision(self) -> Any:
        if self._vision_session is None:
            self._vision_session = self._session("image")
        return self._vision_session

    @property
    def _text(self) -> Any:
        if self._text_session is None:
            self._text_session = self._session("text")
            tokenizer = self._tokenizer_type.from_file(
                str(resolve_model("tokenizer", self._models))
            )
            tokenizer.enable_truncation(max_length=TEXT_CONTEXT_LENGTH)
            tokenizer.enable_padding(length=TEXT_CONTEXT_LENGTH)
            self._tokenizer = tokenizer
        return self._text_session

    def load_towers(self) -> None:
        """Load both towers now. The health check calls this, so an installed pack has proved
        that each tower loads and publishes its embedding, even though requests load lazily."""
        _ = (self._vision, self._text)

    @property
    def name(self) -> str:
        return f"onnxruntime-{EXECUTION_PROVIDERS[0]}"

    @property
    def model_digests(self) -> dict[str, str]:
        return dict(self._digests)

    @property
    def image_dim(self) -> int:
        """The embedding width, read from whichever tower is loaded (both share one space)."""
        if self._image_dim is None:
            session = self._vision_session or self._text_session or self._vision
            self._image_dim = int(
                next(o for o in session.get_outputs() if o.name == EMBEDDING_OUTPUT).shape[-1]
            )
        return self._image_dim

    @property
    def face_dim(self) -> int:
        return self._face_dim

    def decode_keyframes(self, path: str, timestamps: Sequence[float]) -> Sequence[Frame]:
        """Seek to each timestamp and grab exactly one frame.

        Seeking rather than streaming because a shot list is sparse: a two-hour asset with
        400 shots would otherwise decode two hours of video to read 400 frames.
        """
        capture = self._cv2.VideoCapture(path)
        if not capture.isOpened():
            raise MediaUnreadableError(f"could not open approved media at {path}.")
        try:
            frames: list[Frame] = []
            for timestamp in timestamps:
                capture.set(self._cv2.CAP_PROP_POS_MSEC, timestamp * 1000.0)
                ok, frame = capture.read()
                if not ok or frame is None:
                    raise MediaUnreadableError(f"no frame could be decoded at {timestamp:.3f}s.")
                frames.append(frame)
            return frames
        finally:
            capture.release()

    def crop(self, frame: Frame, region: NormalizedBox) -> Frame:
        """Slice the region out of the decoded BGR frame, at the frame's own resolution.

        SigLIP's own preprocessing then squares it to 224, exactly as it does a whole frame. A
        contiguous copy, because OpenCV's face detector is handed the same pixels.
        """
        height, width = frame.shape[:2]
        left = min(max(int(region.x * width), 0), width - 1)
        top = min(max(int(region.y * height), 0), height - 1)
        right = min(max(round((region.x + region.width) * width), left + 1), width)
        bottom = min(max(round((region.y + region.height) * height), top + 1), height)
        return self._numpy.ascontiguousarray(frame[top:bottom, left:right])

    def _preprocess(self, frame: Frame) -> Any:
        numpy = self._numpy
        resized = self._cv2.resize(
            frame, (IMAGE_SIZE, IMAGE_SIZE), interpolation=self._cv2.INTER_AREA
        )
        rgb = self._cv2.cvtColor(resized, self._cv2.COLOR_BGR2RGB)
        scaled = rgb.astype(numpy.float32) / 255.0
        normalized = (scaled - IMAGE_MEAN) / IMAGE_STD
        return numpy.transpose(normalized, (2, 0, 1))

    def encode_images(self, frames: Sequence[Frame]) -> Sequence[Vector]:
        """Embed each keyframe, ONE AT A TIME.

        WHY NOT ONE BATCHED RUN: this export's vision output shape is expressed as
        ``floor(batch_size * floor(height/16) * floor(width/16) / 196)``, and CoreML
        cannot execute that graph for any batch above one — measured on macOS/arm64, it
        fails the whole run with "Unable to compute the prediction using a neural network
        model". A request carries up to 64 keyframes, so batching here meant every real
        indexing call failed while the health check, which embeds nothing, passed.

        The cost of looping is small and the cost of being wrong is total: ~186 ms per
        frame on an M-series laptop, and CoreML has no batch speed-up to give up here
        because it could not run a batch at all. The text tower still batches — it is a
        different graph and it works.
        """
        if not frames:
            return []
        numpy = self._numpy
        name = self._vision.get_inputs()[0].name
        pooled = [
            self._vision.run(
                [EMBEDDING_OUTPUT], {name: numpy.expand_dims(self._preprocess(frame), 0)}
            )[0]
            for frame in frames
        ]
        return self._normalize(numpy.concatenate(pooled, axis=0))

    def encode_texts(self, texts: Sequence[str]) -> Sequence[Vector]:
        if not texts:
            return []
        numpy = self._numpy
        text = self._text  # loads the tower and its tokenizer on first use
        encodings = self._tokenizer.encode_batch(list(texts))
        ids = numpy.array([encoding.ids for encoding in encodings], dtype=numpy.int64)
        name = text.get_inputs()[0].name
        output = text.run([EMBEDDING_OUTPUT], {name: ids})[0]
        return self._normalize(output)

    def _normalize(self, matrix: Any) -> list[list[float]]:
        """L2-normalise each row, so the policy layer's cosines are dot products.

        A zero row (which a broken export can produce) is left alone rather than divided
        by zero; :func:`~framepilot_visual_embed.policy.cosine` reports 0.0 for it, which
        is a visibly wrong similarity rather than a NaN that spreads.
        """
        numpy = self._numpy
        norms = numpy.linalg.norm(matrix, axis=1, keepdims=True)
        norms[norms == 0.0] = 1.0
        return [[float(value) for value in row] for row in (matrix / norms)]

    def detect_and_embed_faces(self, frame: Frame) -> Sequence[Vector]:
        height, width = frame.shape[:2]
        self._faces.setInputSize((width, height))
        _, detections = self._faces.detect(frame)
        if detections is None:
            return []
        vectors: list[Vector] = []
        for detection in detections:
            aligned = self._identity.alignCrop(frame, detection)
            feature = self._identity.feature(aligned)
            vectors.append([float(value) for value in feature.flatten()])
        return vectors
