"""The export folds caption words exactly as the web preview does.

``tests/fixtures/captions/bare-token-vectors.json`` is shared with
``apps/web-editor/src/editor/captionPreview.test.ts``: both suites assert the same outputs,
so a keyword accents the same words in the preview and in the render. The Devanagari rows
are why the file exists — ``str.isalnum`` drops combining marks, so the vowel signs vanished
and "की", "का", "के" and "कि" all folded to "क" (desktop run ``001be135``).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from framepilot_engine.render.captions import _accent_indices, _bare_token

_VECTORS = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "captions"
_DOCUMENT: dict[str, Any] = json.loads(
    (_VECTORS / "bare-token-vectors.json").read_text(encoding="utf-8")
)


@pytest.mark.parametrize("case", _DOCUMENT["bare"], ids=lambda case: str(case["token"]))
def test_bare_token_matches_the_preview(case: dict[str, str]) -> None:
    assert _bare_token(case["token"]) == case["bare"]


@pytest.mark.parametrize("case", _DOCUMENT["accent"], ids=lambda case: str(case["name"]))
def test_keyword_accent_matches_the_preview(case: dict[str, Any]) -> None:
    indices = _accent_indices(case["tokens"], "keywords", case["keywords"])
    assert sorted(indices) == case["indices"]
