"""Job CRUD endpoints and CLI preview."""
from __future__ import annotations
from pathlib import Path
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import PlainTextResponse, FileResponse

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


@router.get("/image")
async def serve_job_image(path: str = Query(...)):
    """Serve a sample image by absolute path (image files only)."""
    p = Path(path)
    if not p.exists() or not p.is_file():
        raise HTTPException(404, "Image not found")
    if p.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp"):
        raise HTTPException(403, "Not an image file")
    return FileResponse(str(p))


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


@router.get("/{job_id}/samples")
async def get_job_samples(job_id: str):
    job = _store.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")

    cfg = job.config if isinstance(job.config, dict) else {}
    output_dir = Path(cfg.get("output_dir", "output"))
    # output_dir is already the per-run directory (e.g. output/my_lora); don't append output_name
    if not output_dir.is_absolute():
        output_dir = _settings.scripts_root / output_dir

    images: list[Path] = []
    if output_dir.exists():
        for ext in ("*.png", "*.jpg", "*.jpeg", "*.webp"):
            images.extend(output_dir.rglob(ext))
    images.sort(key=lambda p: p.stat().st_mtime)
    images = images[:100]

    # Return absolute paths — frontend uses /api/jobs/image?path=... to serve them
    return {"samples": [str(img).replace("\\", "/") for img in images]}
