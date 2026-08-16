"""Work-bound guards for heavy RenderQueue request retention."""

from __future__ import annotations

import time

from framepilot_engine.render.pipeline import RenderJob, RenderOptions, RenderState
from framepilot_engine.render.queue import JobStatus, RenderQueue, RenderRequest
from framepilot_engine.timeline.models import Project


def _request(project_id: str) -> RenderRequest:
    project = Project.model_validate(
        {"id": project_id, "name": project_id, "assets": [], "timeline": {}}
    )
    return RenderRequest(project=project, opts=RenderOptions(), base_dir="/tmp")


def _wait_terminal(queue: RenderQueue, task_id: str, timeout: float = 3.0) -> JobStatus:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        task = queue.get(task_id)
        if task is not None and task.status in {
            JobStatus.COMPLETED,
            JobStatus.FAILED,
            JobStatus.CANCELLED,
        }:
            return task.status
        time.sleep(0.01)
    raise AssertionError(f"task did not settle: {queue.get(task_id)}")


def test_completed_jobs_release_every_full_request() -> None:
    def complete(request: RenderRequest, _cancel: object, _timeout: float | None) -> RenderJob:
        return RenderJob(
            id=f"job-{request.project.id}",
            project_id=request.project.id,
            state=RenderState.COMPLETED,
            progress=1.0,
        )

    queue = RenderQueue(executor=complete)
    try:
        ids = [queue.submit(_request(f"project-{index}")) for index in range(40)]
        for task_id in ids:
            assert _wait_terminal(queue, task_id) == JobStatus.COMPLETED
        assert queue.retained_request_count() == 0
        assert len(queue.list()) == 40  # lightweight history remains visible
    finally:
        queue.shutdown()


def test_failed_retry_payloads_are_bounded_and_recent_jobs_remain_retryable() -> None:
    def fail(request: RenderRequest, _cancel: object, _timeout: float | None) -> RenderJob:
        return RenderJob(
            id=f"job-{request.project.id}",
            project_id=request.project.id,
            state=RenderState.FAILED,
            error="expected failure",
        )

    queue = RenderQueue(executor=fail, retry_payload_limit=2)
    try:
        ids = [queue.submit(_request(f"project-{index}")) for index in range(5)]
        for task_id in ids:
            assert _wait_terminal(queue, task_id) == JobStatus.FAILED

        assert queue.retained_request_count() == 2
        assert queue.retry(ids[0]) is False  # heavy request was evicted, history was not
        assert queue.retry(ids[-1]) is True
    finally:
        queue.shutdown()
