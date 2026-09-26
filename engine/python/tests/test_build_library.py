"""The sticker library build (plan/elements EL6a.1): the parts that decide what ships.

``scripts/elements/build_library.py`` needs the network only to fill its cache, so the
decisions it makes — a sticker's id, the transparent margin every file carries, which upstream
PNG is the default tone, and refusing a byte that does not match its pin — are tested here
without it. The committed catalogue is checked against the committed files by
``sticker-catalog.test.ts``.
"""

from __future__ import annotations

import hashlib
import importlib.util
import re
import sys
from pathlib import Path
from types import ModuleType

import pytest
from PIL import Image

REPO = Path(__file__).resolve().parents[3]
SCRIPT = REPO / "scripts" / "elements" / "build_library.py"
#: The id pattern the IPC and the agent accept (``STICKER_ID_PATTERN`` in ai-sdk).
STICKER_ID = re.compile(r"^[a-z0-9_]{1,96}$")


@pytest.fixture(scope="module")
def library() -> ModuleType:
    spec = importlib.util.spec_from_file_location("build_library", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["build_library"] = module
    spec.loader.exec_module(module)
    return module


def test_a_sticker_id_is_its_cldr_name_in_snake_case(library: ModuleType) -> None:
    assert library.item_id("thumbs up") == "thumbs_up"
    assert library.item_id("Flag: United States") == "flag_united_states"
    assert library.item_id("  face with tears of joy  ") == "face_with_tears_of_joy"
    for name in ("thumbs up", "Flag: United States", "keycap: #", "woman\u2019s hat"):
        assert STICKER_ID.match(library.item_id(name)), name


def test_every_file_carries_the_margin_an_edge_style_draws_into(library: ModuleType) -> None:
    art = Image.new("RGBA", (256, 256), (255, 0, 0, 255))
    padded = library._padded(art)
    assert padded.size == (318, 318)
    assert padded.getpixel((0, 0)) == (0, 0, 0, 0)
    assert padded.getpixel((159, 159)) == (255, 0, 0, 255)
    # Centred: the margin is the same on every side.
    box = padded.getchannel("A").getbbox()
    assert box == (31, 31, 287, 287)


def test_the_default_tone_is_preferred_and_a_missing_one_is_none(library: ModuleType) -> None:
    paths = [
        "assets/Waving hand/Dark/3D/waving_hand_3d_dark.png",
        "assets/Waving hand/Default/3D/waving_hand_3d_default.png",
        "assets/Fire/3D/fire_3d.png",
        "assets/Fire/Flat/fire_flat.svg",
    ]
    assert library._default_png(paths, "Waving hand") == (
        "assets/Waving hand/Default/3D/waving_hand_3d_default.png"
    )
    assert library._default_png(paths, "Fire") == "assets/Fire/3D/fire_3d.png"
    assert library._default_png(paths, "Rocket") is None


def test_an_input_is_checked_against_the_commits_tree(library: ModuleType) -> None:
    # git's own blob id for "hello\n", so a pin is verified exactly as GitHub lists it.
    assert library._git_blob_id(b"hello\n") == "ce013625030ba8dba906f756967f9e9ca394464a"


def test_a_byte_that_does_not_match_its_pin_is_refused(
    library: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(library, "_cached", lambda path: b"tampered")
    good = {"inputs": {"a.png": {"sha256": hashlib.sha256(b"tampered").hexdigest()}}}
    assert library._pinned(good, "a.png") == b"tampered"
    bad = {"inputs": {"a.png": {"sha256": hashlib.sha256(b"original").hexdigest()}}}
    with pytest.raises(SystemExit, match="does not match its pin"):
        library._pinned(bad, "a.png")
