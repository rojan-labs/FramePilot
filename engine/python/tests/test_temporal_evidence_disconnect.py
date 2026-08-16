"""Regression coverage for temporal-evidence request lifecycle cancellation."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.routing import APIRoute

import framepilot_engine.service as service
from framepilot_engine.render.queue import RenderQueue
from framepilot_engine.validation.temporal_evidence import TemporalEvidenceCancelled


class _DisconnectedRequest:
    async def is_disconnected(self) -> bool:
        return True


def _temporal_route(app: FastAPI) -> APIRoute:
    for route in app.routes:
        if isinstance(route, APIRoute) and route.path == "/review/temporal-evidence":
            return route
    raise AssertionError("temporal-evidence route is not registered")


@pytest.mark.asyncio
async def test_temporal_evidence_disconnect_reaches_threadpool_cancel_predicate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A dropped HTTP request must cooperatively stop the synchronous evidence worker."""
    worker_saw_cancel = threading.Event()

    def fake_acquire(
        _project: object,
        _base_dir: object,
        _requests: object,
        cancelled: Callable[[], bool] | None = None,
    ) -> None:
        assert cancelled is not None
        deadline = time.monotonic() + 1.0
        while not cancelled():
            if time.monotonic() >= deadline:
                raise AssertionError("HTTP disconnect never reached the evidence worker")
            time.sleep(0.005)
        worker_saw_cancel.set()
        raise TemporalEvidenceCancelled("request disconnected")

    monkeypatch.setattr(service, "acquire_temporal_evidence", fake_acquire)
    render_queue = RenderQueue()
    app = service.create_app(render_queue=render_queue)
    request_body = service.TemporalEvidenceBatchRequest.model_validate(
        {
            "project": {
                "id": "project-disconnect",
                "name": "Disconnect test",
                "fps": 30,
                "resolution": {"width": 1920, "height": 1080},
                "timeline": {"revision": 0, "tracks": []},
            },
            "requests": [
                {
                    "schemaVersion": 1,
                    "requestId": "frame-0",
                    "projectRevision": 0,
                    "reason": "disconnect regression",
                    "kind": "frame",
                    "atFrame": 0,
                    "metrics": ["luma"],
                }
            ],
        }
    )

    try:
        with pytest.raises(HTTPException) as caught:
            await _temporal_route(app).endpoint(request_body, _DisconnectedRequest())
        assert caught.value.status_code == 422
        assert worker_saw_cancel.is_set()
    finally:
        render_queue.shutdown(wait=True)
