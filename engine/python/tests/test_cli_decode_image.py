"""``framepilot decode-image`` (plan/elements EL6a.6b): the export's own loader decodes a shipped
sticker — WebP with alpha — and says so; the release smoke runs the same command on the frozen
engine for each platform."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from PIL import Image

from framepilot_engine.cli import main

REPO = Path(__file__).resolve().parents[3]
STICKER = REPO / "apps" / "web-editor" / "public" / "elements" / "stickers" / "full" / "fire.webp"


def test_decodes_a_shipped_sticker_with_its_transparency(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert main(["decode-image", str(STICKER), "--expect-alpha"]) == 0
    report = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert report == {"width": 318, "height": 318, "alpha": True}


def test_fails_when_transparency_is_expected_but_missing(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    opaque = tmp_path / "opaque.jpg"
    Image.new("RGB", (8, 8), (200, 10, 10)).save(opaque)
    assert main(["decode-image", str(opaque), "--expect-alpha"]) == 1
    assert "transparency" in capsys.readouterr().out


def test_fails_with_the_file_name_when_it_cannot_decode(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    broken = tmp_path / "broken.webp"
    broken.write_bytes(b"not an image")
    assert main(["decode-image", str(broken)]) == 1
    assert "broken.webp" in capsys.readouterr().out
