"""Tests for the TwelveLabs media-understanding client (brain.twelvelabs).

Deterministic: every request is respx-mocked — no test tier ever calls the live
TwelveLabs API. Covers index create, upload+index task, task polling, text/image
search, clip parsing (including skipped malformed rows), and honest failures
(auth vs generic vs transport), plus the capability gate.
"""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
import respx

from framepilot_engine.brain.twelvelabs import (
    DEFAULT_BASE_URL,
    NO_API_KEY_REASON,
    TLClip,
    TLWord,
    TwelveLabsAuthError,
    TwelveLabsClient,
    TwelveLabsError,
    TwelveLabsIndexNotGenerativeError,
    resolve_twelvelabs,
)

KEY = "tlk_secret_1234"
INDEX_ID = "6298d673f1090f1100476d4c"
TASK_ID = "task_abc123"
ASSET_ID = "asset_abc123"
VIDEO_ID = "639963a1ce36463e0199c8c7"


def make_client() -> TwelveLabsClient:
    """A client over a real httpx client (respx intercepts) with the test key."""
    return TwelveLabsClient(KEY, http=httpx.Client())


def url(path: str) -> str:
    return f"{DEFAULT_BASE_URL}{path}"


# --- capability gate -------------------------------------------------------------


def test_resolve_no_key_is_honest_unavailable() -> None:
    resolution = resolve_twelvelabs(None)
    assert resolution.client is None
    assert resolution.reason == NO_API_KEY_REASON


def test_resolve_blank_key_is_honest_unavailable() -> None:
    assert resolve_twelvelabs("   ").client is None


def test_resolve_with_key_builds_client() -> None:
    resolution = resolve_twelvelabs(KEY, http=httpx.Client())
    assert resolution.client is not None
    assert resolution.reason is None


def test_resolve_uses_http_factory_when_no_client_given() -> None:
    made: list[httpx.Client] = []

    def factory() -> httpx.Client:
        client = httpx.Client()
        made.append(client)
        return client

    resolution = resolve_twelvelabs(KEY, http_factory=factory)
    assert resolution.client is not None
    assert len(made) == 1


# --- index create ----------------------------------------------------------------


@respx.mock
def test_create_index_returns_id() -> None:
    respx.post(url("/indexes")).respond(200, json={"_id": INDEX_ID})
    assert make_client().create_index("proj-123") == INDEX_ID


@respx.mock
def test_create_index_sends_marengo_only() -> None:
    """Index creation must ask for Marengo and nothing else.

    Regression: asking for ``pegasus1.2`` here is rejected outright (HTTP 400
    ``parameter_invalid`` — the model is sunset for indexing), which failed the FIRST
    index a project ever created. Nothing then indexed, so every footage map reported
    ``not_indexed`` forever. Generative understanding needs no index at all now.
    """
    route = respx.post(url("/indexes")).respond(200, json={"_id": INDEX_ID})
    make_client().create_index("proj-123")
    import json as _json

    body = _json.loads(route.calls[0].request.content)
    assert [m["model_name"] for m in body["models"]] == ["marengo3.0"]
    assert body["models"][0]["model_options"] == ["visual", "audio"]


@respx.mock
def test_create_index_missing_id_raises() -> None:
    respx.post(url("/indexes")).respond(200, json={"nope": True})
    with pytest.raises(TwelveLabsError):
        make_client().create_index("proj-123")


# --- indexing tasks --------------------------------------------------------------


@respx.mock
def test_create_index_task_uploads_asset_and_returns_resumable_token(tmp_path: Path) -> None:
    media = tmp_path / "clip.mp4"
    media.write_bytes(b"\x00\x00fake-mp4\x00\x00")
    route = respx.post(url("/assets")).respond(
        201, json={"_id": ASSET_ID, "method": "direct", "status": "processing"}
    )
    assert make_client().create_index_task(INDEX_ID, media) == f"asset-v1:{INDEX_ID}:{ASSET_ID}"
    # The current asset API receives the original bytes and correct media type;
    # indexing is a separate, paced step.
    sent = route.calls[0].request.content
    assert b"fake-mp4" in sent
    assert b"video/mp4" in sent


@respx.mock
def test_mp3_upload_uses_audio_asset_workflow_end_to_end(tmp_path: Path) -> None:
    media = tmp_path / "speech.mp3"
    media.write_bytes(b"ID3-fake-mp3")
    upload = respx.post(url("/assets")).respond(
        201, json={"_id": ASSET_ID, "method": "direct", "status": "processing"}
    )
    respx.get(url(f"/assets/{ASSET_ID}")).respond(
        200, json={"_id": ASSET_ID, "method": "direct", "status": "ready"}
    )
    attach = respx.post(url(f"/indexes/{INDEX_ID}/indexed-assets")).respond(
        201, json={"_id": VIDEO_ID, "asset_id": ASSET_ID}
    )
    respx.get(url(f"/indexes/{INDEX_ID}/indexed-assets/{VIDEO_ID}")).respond(
        200, json={"_id": VIDEO_ID, "asset_id": ASSET_ID, "status": "ready"}
    )

    client = make_client()
    upload_token = client.create_index_task(INDEX_ID, media)
    indexing = client.get_task(upload_token)
    ready = client.get_task(indexing.task_id)

    assert b"audio/mpeg" in upload.calls[0].request.content
    assert ASSET_ID.encode() in attach.calls[0].request.content
    assert indexing.task_id == f"indexed-asset-v1:{INDEX_ID}:{VIDEO_ID}"
    assert indexing.status == "indexing"
    assert ready.ready and ready.video_id == VIDEO_ID


@respx.mock
def test_get_task_pending_has_no_video(tmp_path: Path) -> None:
    respx.get(url(f"/tasks/{TASK_ID}")).respond(200, json={"status": "indexing"})
    status = make_client().get_task(TASK_ID)
    assert status.status == "indexing"
    assert status.video_id is None
    assert not status.ready
    assert not status.failed
    assert not status.done


@respx.mock
def test_get_task_ready_exposes_video_id() -> None:
    respx.get(url(f"/tasks/{TASK_ID}")).respond(200, json={"status": "ready", "video_id": VIDEO_ID})
    status = make_client().get_task(TASK_ID)
    assert status.ready
    assert status.done
    assert status.video_id == VIDEO_ID


@respx.mock
def test_get_task_failed_is_terminal() -> None:
    respx.get(url(f"/tasks/{TASK_ID}")).respond(200, json={"status": "failed"})
    status = make_client().get_task(TASK_ID)
    assert status.failed
    assert status.done
    assert not status.ready


@respx.mock
def test_get_task_missing_status_raises() -> None:
    respx.get(url(f"/tasks/{TASK_ID}")).respond(200, json={"video_id": VIDEO_ID})
    with pytest.raises(TwelveLabsError):
        make_client().get_task(TASK_ID)


# --- search ----------------------------------------------------------------------


def _search_body(clips: list[dict[str, object]]) -> dict[str, object]:
    return {"data": clips, "page_info": {"limit_per_page": 10, "total_results": len(clips)}}


@respx.mock
def test_search_parses_ranked_clips() -> None:
    respx.post(url("/search")).respond(
        200,
        json=_search_body(
            [
                {
                    "video_id": VIDEO_ID,
                    "start": 12.5,
                    "end": 18.0,
                    "rank": 1,
                    "transcription": "hello there",
                }
            ]
        ),
    )
    clips = make_client().search(INDEX_ID, "someone waves")
    # The SDK's SearchItem carries ``rank`` but no ``score``/``confidence`` (Marengo
    # 3.0), so score is derived as ``1/rank`` and confidence is always None.
    assert clips == [
        TLClip(
            video_id=VIDEO_ID,
            start=12.5,
            end=18.0,
            score=1.0,
            confidence=None,
            transcription="hello there",
            rank=1,
        )
    ]


@respx.mock
def test_search_derives_score_from_rank_when_api_omits_score() -> None:
    # The real Marengo 3.0 shape: ``rank`` present, NO ``score``/``confidence``.
    # Regression guard for the "every packet score=0 → agent loops" bug.
    respx.post(url("/search")).respond(
        200,
        json=_search_body(
            [
                {"rank": 2, "video_id": VIDEO_ID, "start": 5.0, "end": 6.0},
                {"rank": 1, "video_id": VIDEO_ID, "start": 1.0, "end": 2.0},
            ]
        ),
    )
    clips = make_client().search(INDEX_ID, "yellow jerseys")
    # Sorted best-first by rank, with a strictly descending derived score.
    assert [(c.rank, c.start, c.score) for c in clips] == [
        (1, 1.0, 1.0),
        (2, 5.0, 0.5),
    ]
    assert clips[0].score > clips[1].score > 0.0


@respx.mock
def test_search_sends_multipart_repeated_modalities_and_query() -> None:
    route = respx.post(url("/search")).respond(200, json=_search_body([]))
    make_client().search(INDEX_ID, "a dog runs")
    request = route.calls[0].request
    # TwelveLabs /search rejects urlencoded — the body MUST be multipart/form-data.
    assert request.headers["content-type"].startswith("multipart/form-data")
    body = request.content
    assert b'name="query_text"' in body and b"a dog runs" in body
    assert b'name="index_id"' in body and INDEX_ID.encode() in body
    assert b'name="group_by"' in body and b"clip" in body
    # Visual, audio AND transcription modalities are requested (repeated parts),
    # matching the TwelveLabs dashboard's known-good config.
    assert body.count(b'name="search_options"') == 3
    assert b"visual" in body and b"audio" in body and b"transcription" in body
    # transcription_options (lexical + semantic) ride along when transcription is on.
    assert body.count(b'name="transcription_options"') == 2
    assert b"lexical" in body and b"semantic" in body


@respx.mock
def test_search_skips_malformed_rows() -> None:
    respx.post(url("/search")).respond(
        200,
        json=_search_body(
            [
                {"start": 1.0, "end": 2.0},  # no video_id → skipped
                {"video_id": VIDEO_ID, "end": 2.0},  # no start → skipped
                {"video_id": VIDEO_ID, "start": 3.0, "end": 4.0},  # kept
            ]
        ),
    )
    clips = make_client().search(INDEX_ID, "q")
    assert len(clips) == 1
    # No numeric score in the row → derived from its 1-based position (rank 3 here).
    assert clips[0].rank == 3
    assert clips[0].score == pytest.approx(1.0 / 3.0)
    assert clips[0].transcription is None


@respx.mock
def test_get_transcription_parses_words() -> None:
    respx.get(url(f"/indexes/{INDEX_ID}/indexed-assets/{VIDEO_ID}")).respond(
        200,
        json={
            "_id": VIDEO_ID,
            "transcription": [
                {"start": 0.0, "end": 0.4, "value": "World"},
                {"start": 0.4, "end": 0.8, "value": "Cup"},
            ],
        },
    )
    words = make_client().get_transcription(INDEX_ID, VIDEO_ID)
    assert words == [
        TLWord(start=0.0, end=0.4, value="World"),
        TLWord(start=0.4, end=0.8, value="Cup"),
    ]


@respx.mock
def test_get_transcription_sends_transcription_flag() -> None:
    route = respx.get(url(f"/indexes/{INDEX_ID}/indexed-assets/{VIDEO_ID}")).respond(
        200, json={"transcription": []}
    )
    assert make_client().get_transcription(INDEX_ID, VIDEO_ID) == []
    assert route.calls[0].request.url.params["transcription"] == "true"


@respx.mock
def test_get_transcription_skips_malformed_and_missing() -> None:
    respx.get(url(f"/indexes/{INDEX_ID}/indexed-assets/{VIDEO_ID}")).respond(
        200,
        json={
            "transcription": [
                {"start": 0.0, "end": 0.4},  # no value → skipped
                {"end": 0.8, "value": "x"},  # no start → skipped
                {"start": 1.0, "end": 1.4, "value": "kept"},
            ]
        },
    )
    words = make_client().get_transcription(INDEX_ID, VIDEO_ID)
    assert words == [TLWord(start=1.0, end=1.4, value="kept")]


@respx.mock
def test_get_transcription_missing_field_is_empty() -> None:
    respx.get(url(f"/indexes/{INDEX_ID}/indexed-assets/{VIDEO_ID}")).respond(
        200, json={"_id": VIDEO_ID}
    )
    assert make_client().get_transcription(INDEX_ID, VIDEO_ID) == []


@respx.mock
def test_search_by_image_sends_media_type_and_file() -> None:
    route = respx.post(url("/search")).respond(200, json=_search_body([]))
    make_client().search_by_image(INDEX_ID, b"\xff\xd8jpeg\xff\xd9")
    body = route.calls[0].request.content
    assert b"image" in body
    assert b"jpeg" in body


# --- Pegasus generative understanding (chapters / highlights / summary) ----------
#
# These migrated from the sunset /summarize endpoint to /analyze with a
# response_format JSON schema (TwelveLabs release note 2026-01-07). /analyze
# returns the schema-conforming output as a JSON *string* in "data".


def _analyze_body(obj: object) -> dict[str, object]:
    """A stream=False /analyze response: the structured output as a JSON string."""
    import json as _json

    return {"id": "gen_1", "data": _json.dumps(obj), "finish_reason": "stop"}


@respx.mock
def test_summarize_chapters_posts_to_analyze_with_schema() -> None:
    route = respx.post(url("/analyze")).respond(
        200,
        json=_analyze_body(
            {
                "chapters": [
                    {
                        "start_sec": 5.0,
                        "end_sec": 10.0,
                        "chapter_title": "Intro",
                        "chapter_summary": "opening",
                    },
                    {"start_sec": 0.0, "end_sec": 5.0, "chapter_title": "Setup"},
                ]
            }
        ),
    )
    chapters = make_client().summarize_chapters(ASSET_ID)
    # Parsed and re-sorted by start time (0..5 before 5..10).
    assert [c.start for c in chapters] == [0.0, 5.0]
    assert chapters[0].title == "Setup"
    assert chapters[1].summary == "opening"
    # The request hits /analyze (not the deprecated /summarize) with a json_schema,
    # against the UPLOADED asset: pegasus1.5 rejects `video_id` outright.
    import json as _json

    body = _json.loads(route.calls[0].request.content)
    assert body["model_name"] == "pegasus1.5"
    assert body["video"] == {"type": "asset_id", "asset_id": ASSET_ID}
    assert "video_id" not in body
    assert body["stream"] is False
    assert body["response_format"]["type"] == "json_schema"
    assert "chapters" in body["response_format"]["json_schema"]["properties"]


@respx.mock
def test_summarize_highlights_parses_analyze_output() -> None:
    respx.post(url("/analyze")).respond(
        200,
        json=_analyze_body(
            {
                "highlights": [
                    {"start_sec": 2.0, "end_sec": 4.0, "highlight": "the jump"},
                ]
            }
        ),
    )
    highlights = make_client().summarize_highlights(VIDEO_ID)
    assert len(highlights) == 1
    assert highlights[0].label == "the jump"
    assert highlights[0].start == 2.0


@respx.mock
def test_summarize_gist_parses_analyze_output() -> None:
    respx.post(url("/analyze")).respond(
        200, json=_analyze_body({"summary": "  A short clip of a dog.  "})
    )
    gist = make_client().summarize_gist(VIDEO_ID)
    assert gist.summary == "A short clip of a dog."


@respx.mock
def test_summarize_chapters_recovers_from_pegasus_mis_escaped_json() -> None:
    """Pegasus' own escaping bug must not blank the footage map.

    Observed on the live API: with more than one string field in the schema, the
    ``data`` body comes back with back-slash-escaped inner quotes and a tail that
    repeats forever. A strict decode throws there and the whole map goes dark, so the
    decoder unescapes and reads the valid object at the head of the body.
    """
    mangled = (
        '{"chapters":[{"chapter_title":"Forest","end_sec":21.8,"start_sec":0.0,'
        '"chapter_summary\\":\\"Camera moves through forest.\\"}]}'
        '\\"}]}\\"}]}\\"}]}'
    )
    respx.post(url("/analyze")).respond(200, json={"data": mangled, "finish_reason": "stop"})
    chapters = make_client().summarize_chapters(ASSET_ID)
    assert [(c.start, c.end, c.title) for c in chapters] == [(0.0, 21.8, "Forest")]
    assert chapters[0].summary == "Camera moves through forest."


@respx.mock
def test_summarize_chapters_retries_once_without_response_format() -> None:
    """An unreadable structured body is retried ONCE with the schema in the prompt.

    Pegasus can also emit a body that no amount of unescaping repairs. Rather than
    report footage we understood as unmappable, ask again in plain-prompt form (which
    it answers cleanly) — and stop there, so a broken model can't spin.
    """
    import json as _json

    route = respx.post(url("/analyze")).mock(
        side_effect=[
            httpx.Response(200, json={"data": '{"chapters":[{"chapter_title:"broken'}),
            httpx.Response(
                200,
                json=_analyze_body(
                    {"chapters": [{"start_sec": 0.0, "end_sec": 4.0, "chapter_title": "Intro"}]}
                ),
            ),
        ]
    )
    chapters = make_client().summarize_chapters(ASSET_ID)
    assert [c.title for c in chapters] == ["Intro"]
    assert len(route.calls) == 2
    retry_body = _json.loads(route.calls[1].request.content)
    assert "response_format" not in retry_body or retry_body["response_format"] is None
    assert "JSON Schema" in retry_body["prompt"]


@respx.mock
def test_source_asset_id_reads_the_uploaded_asset_behind_a_video() -> None:
    """Mappings written before the uploaded asset id was persisted still map.

    Pegasus 1.5 generates from the uploaded asset, so an older mapping that knows only
    its ``video_id`` would be unmappable without this lookup — and re-uploading the
    footage to recover it would be both slow and billable.
    """
    respx.get(url(f"/indexes/{INDEX_ID}/indexed-assets/{VIDEO_ID}")).respond(
        200, json={"_id": VIDEO_ID, "asset_id": ASSET_ID, "status": "ready"}
    )
    assert make_client().source_asset_id(INDEX_ID, VIDEO_ID) == ASSET_ID


@respx.mock
def test_summarize_chapters_non_json_data_is_empty() -> None:
    # A "data" that is not valid JSON degrades to no chapters (honest), not a crash.
    respx.post(url("/analyze")).respond(200, json={"data": "not json at all"})
    assert make_client().summarize_chapters(VIDEO_ID) == []


@respx.mock
def test_summarize_gist_missing_data_is_empty() -> None:
    respx.post(url("/analyze")).respond(200, json={"finish_reason": "stop"})
    assert make_client().summarize_gist(VIDEO_ID).summary == ""


@respx.mock
def test_analyze_on_marengo_only_index_raises_not_generative() -> None:
    # A generate call against an index with no Pegasus model → typed error the map
    # route catches to degrade to the built-in map (not a raw HTTP 400).
    respx.post(url("/analyze")).respond(
        400,
        json={
            "code": "index_not_supported_for_generate",
            "message": "The index does not support generate.",
        },
    )
    with pytest.raises(TwelveLabsIndexNotGenerativeError):
        make_client().summarize_chapters(VIDEO_ID)


@respx.mock
def test_other_400_stays_generic_error() -> None:
    # A different 400 code is still a plain TwelveLabsError (not misclassified).
    respx.post(url("/analyze")).respond(400, json={"code": "something_else", "message": "nope"})
    with pytest.raises(TwelveLabsError) as excinfo:
        make_client().summarize_chapters(VIDEO_ID)
    assert not isinstance(excinfo.value, TwelveLabsIndexNotGenerativeError)


# --- honest failures -------------------------------------------------------------


@respx.mock
def test_auth_error_is_typed() -> None:
    respx.post(url("/indexes")).respond(401, text="bad key")
    with pytest.raises(TwelveLabsAuthError):
        make_client().create_index("p")


@respx.mock
def test_403_is_auth_error() -> None:
    respx.get(url(f"/tasks/{TASK_ID}")).respond(403, text="forbidden")
    with pytest.raises(TwelveLabsAuthError):
        make_client().get_task(TASK_ID)


@respx.mock
def test_generic_http_error_raises_with_snippet() -> None:
    respx.post(url("/search")).respond(500, text="server exploded")
    with pytest.raises(TwelveLabsError) as excinfo:
        make_client().search(INDEX_ID, "q")
    assert "500" in str(excinfo.value)


@respx.mock
def test_transport_error_is_wrapped() -> None:
    respx.post(url("/indexes")).mock(side_effect=httpx.ConnectError("no route"))
    with pytest.raises(TwelveLabsError):
        make_client().create_index("p")


@respx.mock
def test_non_json_body_raises() -> None:
    respx.get(url(f"/tasks/{TASK_ID}")).respond(200, text="not json")
    with pytest.raises(TwelveLabsError):
        make_client().get_task(TASK_ID)


@respx.mock
def test_api_key_never_appears_in_error_message() -> None:
    respx.post(url("/indexes")).respond(500, text=f"leak {KEY}?")
    with pytest.raises(TwelveLabsError) as excinfo:
        make_client().create_index("p")
    # The route snippet may echo the body, but our own message must not add the key.
    # (Body echo is TwelveLabs' text, not ours — assert we never inject the header value.)
    assert "x-api-key" not in str(excinfo.value)
