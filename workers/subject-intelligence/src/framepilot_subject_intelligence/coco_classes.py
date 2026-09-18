"""The COCO-80 class names, in the pinned YOLOX-S model's output order (AM2.5).

The object detector (``object_detection_yolox_2022nov.onnx``, pinned in
``pack/models.lock.toml``) scores 80 classes per box; column ``i`` of its class
scores is ``COCO_CLASSES[i]``. The index order is load-bearing: a list in another
order would report every class as a different one, confidently.

Provenance, recorded in ``LICENSES.md``:

- The names and their contiguous 0..79 order are the ``COCO_CLASSES`` tuple of
  YOLOX (``yolox/data/datasets/coco_classes.py``, Megvii, Apache-2.0), which is
  also the ``classes`` tuple of OpenCV Zoo's ``object_detection_yolox/demo.py``
  (Apache-2.0) — the reference implementation this pack's post-processing follows.
- The names themselves are the 80 "thing" categories of the COCO 2017 detection
  annotations (cocodataset.org; annotations CC BY 4.0). A list of category names
  is a fact about the model's output layout, not a copy of the dataset.

The same list is mirrored host-side as ``COCO_CLASS_NAMES`` in
``packages/capability-packs/src/worker-protocol.ts``; the host schema refuses a
class that is not on it.
"""

from __future__ import annotations

from typing import Final

COCO_CLASSES: Final = (
    "person",
    "bicycle",
    "car",
    "motorcycle",
    "airplane",
    "bus",
    "train",
    "truck",
    "boat",
    "traffic light",
    "fire hydrant",
    "stop sign",
    "parking meter",
    "bench",
    "bird",
    "cat",
    "dog",
    "horse",
    "sheep",
    "cow",
    "elephant",
    "bear",
    "zebra",
    "giraffe",
    "backpack",
    "umbrella",
    "handbag",
    "tie",
    "suitcase",
    "frisbee",
    "skis",
    "snowboard",
    "sports ball",
    "kite",
    "baseball bat",
    "baseball glove",
    "skateboard",
    "surfboard",
    "tennis racket",
    "bottle",
    "wine glass",
    "cup",
    "fork",
    "knife",
    "spoon",
    "bowl",
    "banana",
    "apple",
    "sandwich",
    "orange",
    "broccoli",
    "carrot",
    "hot dog",
    "pizza",
    "donut",
    "cake",
    "chair",
    "couch",
    "potted plant",
    "bed",
    "dining table",
    "toilet",
    "tv",
    "laptop",
    "mouse",
    "remote",
    "keyboard",
    "cell phone",
    "microwave",
    "oven",
    "toaster",
    "sink",
    "refrigerator",
    "book",
    "clock",
    "vase",
    "scissors",
    "teddy bear",
    "hair drier",
    "toothbrush",
)

#: COCO class 0. Reported with the protocol label ``person``; every other class
#: keeps the label ``object`` and, when the host asks, names itself in ``class``.
COCO_PERSON_CLASS: Final = 0


def coco_class_name(index: int) -> str:
    """The class name for one column of the detector's class scores.

    :raises ValueError: If ``index`` is outside the model's 80 columns — a model
        with another head is not the one this pack pinned, and naming its classes
        from this list would be a confident lie.
    """
    if not 0 <= index < len(COCO_CLASSES):
        raise ValueError(f"class index {index} is outside the pinned model's 80 COCO classes.")
    return COCO_CLASSES[index]
