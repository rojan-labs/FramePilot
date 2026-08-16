"""Real models, real pixels.

The unit suite proves the policy. It cannot prove that this pack detects
anything, because a scripted backend will happily "detect" whatever the test
scripted. Only inference on a real photograph can distinguish a working detector
from one whose pre-processing is subtly wrong — the exact failure that produces
plausible boxes in the wrong place.

So these tests run the pinned models over the pinned photograph and require:

* the detector to find the people and faces that are actually in it;
* the boxes to land on them, not merely to exist;
* faces to be inside people, which a broken coordinate transform breaks;
* a segmentation mask to cover the prompted subject and not the sky;
* identical bytes across runs;
* an honest loss on media with no subject at all, rather than an invented one.

Requires the `cv` extra and `tools/fetch_models.py`. Excluded from the default
suite, and run by the pack build job.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from framepilot_subject_intelligence.geometry import decode_run_lengths
from framepilot_subject_intelligence.policy import (
    build_mask_sample,
    resolve_prompt_region,
    run_detection,
    select_detections,
)
from framepilot_subject_intelligence.protocol import NormalizedPoint, SubjectRequest

pytestmark = pytest.mark.decoded_media

PACK_ROOT = Path(__file__).resolve().parent.parent
MODELS = PACK_ROOT / "models"
PHOTO = MODELS / "largest_selfie.jpg"

pytest.importorskip("cv2", reason="the decoded-media tier needs the cv extra")


def _require_assets() -> None:
    if not PHOTO.is_file():
        pytest.skip("run tools/fetch_models.py first")


@pytest.fixture(scope="module")
def backend() -> object:
    _require_assets()
    from framepilot_subject_intelligence.opencv_backend import OpenCvBackend

    return OpenCvBackend(MODELS)


@pytest.fixture(scope="module")
def photo(backend: object) -> object:
    import cv2

    image = cv2.imread(str(PHOTO))
    assert image is not None, "the pinned proof photograph did not decode"
    return image


def _request(**overrides: object) -> SubjectRequest:
    from framepilot_subject_intelligence.protocol import MediaHandle

    base: dict[str, object] = {
        "request_id": "decoded-1",
        "project_revision": 1,
        "capability": "subject.detect",
        "media": MediaHandle(
            handle_id="h",
            asset_id="a",
            absolute_path=str(PHOTO),
            source_start_seconds=0.0,
            source_end_seconds=1.0,
            fps=30.0,
            first_frame=0,
            last_frame_exclusive=1,
        ),
        "labels": ("face",),
        "max_detections": 100,
    }
    base.update(overrides)
    return SubjectRequest(**base)  # type: ignore[arg-type]


def test_faces_are_actually_found_in_a_real_photograph(backend: object, photo: object) -> None:
    raw = backend.detect_faces(photo)  # type: ignore[attr-defined]

    # The pinned photo is a large group shot. Finding a handful would mean the
    # detector is running but mis-scaled; finding none would mean it is broken.
    assert len(raw) >= 20, f"only {len(raw)} faces found in a group photograph"
    assert all(0.0 <= item.confidence <= 1.0 for item in raw)


def test_people_are_found_and_labelled_as_people(backend: object, photo: object) -> None:
    raw = backend.detect_objects(photo)  # type: ignore[attr-defined]
    people = [item for item in raw if item.label == "person"]

    # Deliberately not "one person per face". In a dense group shot the bodies
    # overlap heavily and non-maximum suppression merges them, so this photograph
    # yields far fewer people than faces — that is the detector working, not
    # failing. What a broken detector yields is zero.
    assert len(people) >= 5, f"only {len(people)} people found in a group photograph"
    assert all(item.label == "person" for item in raw), "a group photo is people, not props"


def test_detected_faces_land_inside_detected_people(backend: object, photo: object) -> None:
    """The proof that coordinates are right, not merely present.

    A letterbox or scale bug still produces confident boxes — they just sit in the
    wrong place. Faces belonging inside torsos is a relationship that only holds
    when both transforms are correct.
    """
    height, width = photo.shape[:2]  # type: ignore[attr-defined]
    faces = select_detections(
        list(backend.detect_faces(photo)),  # type: ignore[attr-defined]
        frame=0,
        width=width,
        height=height,
        labels=("face",),
        max_detections=100,
    )
    people = select_detections(
        list(backend.detect_objects(photo)),  # type: ignore[attr-defined]
        frame=0,
        width=width,
        height=height,
        labels=("person",),
        max_detections=100,
    )
    assert faces and people

    def centre(box: object) -> tuple[float, float]:
        return (box.x + box.width / 2, box.y + box.height / 2)  # type: ignore[attr-defined]

    def holds(offset: float) -> int:
        """How many detected people contain the centre of at least one face."""
        found = 0
        for person in people:
            box = person.box
            for face in faces:
                fx, fy = centre(face.box)
                if (
                    box.x <= fx + offset <= box.x + box.width
                    and box.y <= fy <= box.y + box.height
                ):
                    found += 1
                    break
        return found

    # Every person the detector found has a face in them. This is asserted in
    # this direction on purpose: suppression means not every face keeps its own
    # person box, but a person box with nobody's face in it would mean the two
    # models disagree about where things are.
    assert holds(0.0) == len(people)

    # The control that gives the assertion teeth: slide the faces a third of a
    # frame sideways and the same relationship must break. Without this, a test
    # that merely counts overlaps would pass on almost any pair of boxes.
    assert holds(1 / 3) < len(people), "mis-registered detections still satisfied the check"


def test_a_point_prompt_segments_the_person_under_it(backend: object, photo: object) -> None:
    height, width = photo.shape[:2]  # type: ignore[attr-defined]
    people = [
        item
        for item in backend.detect_objects(photo)  # type: ignore[attr-defined]
        if item.label == "person" and item.confidence >= 0.5
    ]
    assert people
    target = max(people, key=lambda item: item.box[2] * item.box[3])
    point = NormalizedPoint(
        x=(target.box[0] + target.box[2] / 2) / width,
        y=(target.box[1] + target.box[3] / 2) / height,
    )

    region = resolve_prompt_region(
        _request(capability="subject.segment", labels=(), region=None, point=point),
        photo,
        backend,  # type: ignore[arg-type]
        width,
        height,
    )
    mask = backend.segment_subject(photo, region)  # type: ignore[attr-defined]
    sample = build_mask_sample(0, mask.width, mask.height, list(mask.values), mask.confidence)

    values = decode_run_lengths(sample.counts, mask.width * mask.height)
    assert sum(values) > 0
    assert 0.0 < sample.confidence <= 1.0

    # The mask must sit inside the prompted person, not spill across the frame.
    lit_rows = [index // mask.width for index, value in enumerate(values) if value]
    lit_columns = [index % mask.width for index, value in enumerate(values) if value]
    left = min(lit_columns) / mask.width * width
    right = max(lit_columns) / mask.width * width
    top = min(lit_rows) / mask.height * height
    bottom = max(lit_rows) / mask.height * height
    tolerance = 0.1 * max(width, height)
    assert left >= region[0] - tolerance
    assert top >= region[1] - tolerance
    assert right <= region[0] + region[2] + tolerance
    assert bottom <= region[1] + region[3] + tolerance


def test_segmenting_empty_sky_is_reported_as_no_subject(backend: object, photo: object) -> None:
    """Negative control: a region with no person in it must not produce a matte."""
    from framepilot_subject_intelligence.policy import SubjectNotFoundError

    height, width = photo.shape[:2]  # type: ignore[attr-defined]
    # The top-left corner of this photograph is background.
    corner = (0.0, 0.0, width * 0.12, height * 0.12)

    mask = backend.segment_subject(photo, corner)  # type: ignore[attr-defined]

    with pytest.raises(SubjectNotFoundError):
        build_mask_sample(0, mask.width, mask.height, list(mask.values), mask.confidence)


def test_the_same_photograph_detects_identically_twice(backend: object, photo: object) -> None:
    first = [
        (item.label, tuple(round(value, 4) for value in item.box), round(item.confidence, 6))
        for item in backend.detect_faces(photo)  # type: ignore[attr-defined]
    ]
    second = [
        (item.label, tuple(round(value, 4) for value in item.box), round(item.confidence, 6))
        for item in backend.detect_faces(photo)  # type: ignore[attr-defined]
    ]

    assert first == second, "the same media produced different detections across runs"


def test_detection_runs_end_to_end_through_the_policy(backend: object) -> None:
    request = _request(labels=("face", "person"))
    source = backend.open_frames(str(PHOTO), 0, 1)  # type: ignore[attr-defined]
    try:
        frames = list(run_detection(request, source, backend, should_cancel=lambda: False))  # type: ignore[arg-type]
    finally:
        source.close()

    assert len(frames) == 1
    detections = frames[0]
    assert detections, "the end-to-end path found nothing in a photograph full of people"
    assert {item.label for item in detections} <= {"face", "person"}
    for item in detections:
        assert 0.0 <= item.box.x <= 1.0
        assert item.box.x + item.box.width <= 1.0 + 1e-9


def test_a_swapped_weight_file_is_refused(tmp_path: Path) -> None:
    """A pack whose weights were replaced must refuse to run, not infer anyway."""
    from framepilot_subject_intelligence.backend import ModelUnavailableError
    from framepilot_subject_intelligence.models import resolve_model

    tampered = tmp_path / "face_detection_yunet_2023mar.onnx"
    tampered.write_bytes(b"not a model")

    with pytest.raises(ModelUnavailableError, match="hashes to"):
        resolve_model("face", tmp_path)


def test_the_worker_process_answers_a_real_request() -> None:
    """The whole binary: stdin request in, one protocol result line out."""
    _require_assets()
    request = {
        "type": "request",
        "protocolVersion": 1,
        "requestId": "proc-1",
        "projectRevision": 3,
        "capability": "subject.detect",
        "media": {
            "handleId": "h",
            "assetId": "a",
            "absolutePath": str(PHOTO),
            "sourceStartSeconds": 0.0,
            "sourceEndSeconds": 1.0,
            "fps": 30.0,
            "firstFrame": 0,
            "lastFrameExclusive": 1,
        },
        "parameters": {"labels": ["face"], "maxDetections": 50},
    }
    completed = subprocess.run(
        [sys.executable, "-m", "framepilot_subject_intelligence", "--framepilot-worker-runtime"],
        input=json.dumps(request) + "\n",
        capture_output=True,
        text=True,
        cwd=PACK_ROOT,
        env={
            "PATH": "/usr/bin:/bin",
            "PYTHONPATH": str(PACK_ROOT / "src"),
            "FRAMEPILOT_CAPABILITY_PACK_ROOT": str(PACK_ROOT),
        },
        timeout=600,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    lines = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
    terminal = [line for line in lines if line["type"] in {"result", "failure"}]

    assert len(terminal) == 1, "a worker must emit exactly one terminal message"
    result = terminal[0]
    assert result["type"] == "result", result
    assert result["capability"] == "subject.detect"
    assert result["projectRevision"] == 3
    assert result["detections"], "the worker process found no faces in a group photograph"
    # Evidence lineage: the exact weights that produced this are named.
    assert set(result["modelDigests"]) >= {"face_detection_yunet_2023mar.onnx"}
