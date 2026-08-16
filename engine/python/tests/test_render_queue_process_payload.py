from __future__ import annotations

from framepilot_engine.render.pipeline import RenderOptions
from framepilot_engine.render.queue import RenderProcessRequest, RenderRequest
from framepilot_engine.timeline.models import Project


def _heavy_project() -> Project:
    return Project.model_validate(
        {
            "id": "project-heavy",
            "name": "Heavy",
            "assets": [
                {
                    "id": "asset-1",
                    "path": "media/video.mp4",
                    "kind": "video",
                    "durationSeconds": 10,
                    "media": {
                        "peaks": [0.5] * 50_000,
                        "thumbnailPaths": [f"thumb-{index}.jpg" for index in range(1000)],
                        "proxyPath": "proxy.mp4",
                    },
                    "folderId": "folder-1",
                }
            ],
            "folders": [{"id": "folder-1", "name": "Footage"}],
            "timeline": {"tracks": []},
            "transcript": [{"word": "hello", "start": 0, "end": 0.5}],
            "markers": [{"id": "marker-1", "time": 1}],
            "aiMemory": {"sentinel": "agent-only"},
            "history": [{"sentinel": "undo"}] * 10_000,
        }
    )


def test_process_payload_size_is_independent_of_derived_media_and_history() -> None:
    project = _heavy_project()
    request = RenderRequest(project=project, opts=RenderOptions(), base_dir="/project")

    payload = request.process_payload_json()
    parsed = RenderProcessRequest.model_validate_json(payload)

    assert len(payload) < 10_000
    assert parsed.project.assets[0].media is None
    assert parsed.project.assets[0].folder_id is None
    assert parsed.project.folders == []
    assert parsed.project.markers == []
    assert parsed.project.ai_memory == {}
    assert parsed.project.history == []
    assert parsed.project.transcript == []


def test_burned_caption_worker_payload_keeps_transcript() -> None:
    project = _heavy_project()
    request = RenderRequest(
        project=project,
        opts=RenderOptions(burn_captions=True),
        base_dir="/project",
    )

    parsed = RenderProcessRequest.model_validate_json(request.process_payload_json())

    assert [word.word for word in parsed.project.transcript] == ["hello"]
    assert parsed.project.assets[0].media is None
