"""Job CRUD endpoints and CLI preview."""
from __future__ import annotations
from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse

from ..schemas import JobCreate

router = APIRouter(prefix="/api/jobs")

# Injected at app startup
_store = None
_runner = None
_settings = None


def init(store, runner, settings):
    global _store, _runner, _settings
    _store = store
    _runner = runner
    _settings = settings


@router.get("")
async def list_jobs():
    jobs = _store.all()
    queued = [j.id for j in _store.queued()]
    active = _runner.active_job()
    return {
        "jobs": [j.to_status_dict() for j in sorted(jobs, key=lambda j: j.created_at, reverse=True)],
        "queue": queued,
        "active_job_id": active.id if active else None,
    }


@router.post("")
async def create_job(body: JobCreate):
    job = _store.create(body.config)
    from .ws import manager
    await manager.broadcast({"type": "queue_update"})
    return {"job_id": job.id, "status": job.status}


@router.get("/{job_id}")
async def get_job(job_id: str):
    job = _store.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    d = job.to_status_dict()
    d["loss_history"] = job.loss_history[-200:]
    return d


@router.post("/{job_id}/cancel")
async def cancel_job(job_id: str):
    job = _store.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")

    active = _runner.active_job()
    if active and active.id == job_id:
        await _runner.cancel_active()
        return {"status": "cancelled"}

    if job.status == "queued":
        _store.remove_from_queue(job_id)
        _store.update(job, status="cancelled")
        from .ws import manager
        await manager.broadcast({"type": "queue_update"})
        return {"status": "cancelled"}

    return {"status": job.status}


@router.get("/{job_id}/log", response_class=PlainTextResponse)
async def get_log(job_id: str):
    job = _store.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return "\n".join(job.log_buffer)
