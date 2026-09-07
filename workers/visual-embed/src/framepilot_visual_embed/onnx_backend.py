"""The real inference backend: onnxruntime for the two SigLIP 2 towers, OpenCV for pixels.

**Unverified against weights.** No model file has been fetched, so nothing in this module
has ever produced a vector. Every number it depends on — the preprocessing constants, the
tower input names, the tokenizer's padded length — is transcribed from the model card and
must be confirmed against the exported artifacts before this pack is released. That
confirmation is the ``decoded_media`` suite, which is skipped by default and only runs in
the pack build job where the weights exist. Treat this file as *wiring*, not as evidence.

The layering is deliberate: everything above (:mod:`framepilot_visual_embed.policy`,
:mod:`framepilot_visual_embed.protocol`, :mod:`framepilot_visual_embed.runtime`) is pure
and fully tested against a scripted backend, so when the weights land the only thing left
to prove is this module.

Runtime notes:

- **onnxruntime CPU by default, CoreML where it exists.** The CoreML EP is requested first
  and onnxruntime silently falls back to CPU when it is not built in, which is the correct
  behaviour: a pack that refused to run on an Intel Mac would be worse than a slow one.
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
#: Execution providers in preference order; missing ones are dropped by onnxruntime.
EXECUTION_PROVIDERS: Final = ("CoreMLExecutionProvider", "CPUExecutionProvider")


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
        models = directory if directory is not None else models_directory()
        # Verify EVERY pinned file before loading ANY of them: a pack with one swapped
        # weight must not get as far as producing a vector with the four that matched.
        self._digests = verify_all(models)
        providers = list(EXECUTION_PROVIDERS)
        self._vision = onnxruntime.InferenceSession(
            str(resolve_model("image", models)), providers=providers
        )
        self._text = onnxruntime.InferenceSession(
            str(resolve_model("text", models)), providers=providers
        )
        self._tokenizer = Tokenizer.from_file(str(resolve_model("tokenizer", models)))
        self._tokenizer.enable_truncation(max_length=TEXT_CONTEXT_LENGTH)
        self._tokenizer.enable_padding(length=TEXT_CONTEXT_LENGTH)
        self._faces = cv2.FaceDetectorYN.create(
            str(resolve_model("face", models)),
            "",
            (320, 320),
            FACE_SCORE_THRESHOLD,
            FACE_NMS_THRESHOLD,
        )
        self._identity = cv2.FaceRecognizerSF.create(str(resolve_model("identity", models)), "")
        self._vision_output = _embedding_output(self._vision, "vision")
        self._text_output = _embedding_output(self._text, "text")
        self._image_dim = int(
            next(
                output
                for output in self._vision.get_outputs()
                if output.name == self._vision_output
            ).shape[-1]
        )
        self._face_dim = 128

    @property
    def name(self) -> str:
        return f"onnxruntime-{self._vision.get_providers()[0]}"

    @property
    def model_digests(self) -> dict[str, str]:
        return dict(self._digests)

    @property
    def image_dim(self) -> int:
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
                [self._vision_output], {name: numpy.expand_dims(self._preprocess(frame), 0)}
            )[0]
            for frame in frames
        ]
        return self._normalize(numpy.concatenate(pooled, axis=0))

    def encode_texts(self, texts: Sequence[str]) -> Sequence[Vector]:
        if not texts:
            return []
        numpy = self._numpy
        encodings = self._tokenizer.encode_batch(list(texts))
        ids = numpy.array([encoding.ids for encoding in encodings], dtype=numpy.int64)
        name = self._text.get_inputs()[0].name
        output = self._text.run([self._text_output], {name: ids})[0]
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
