"""FastAPI application — entry point for the Forge web UI."""
from __future__ import annotations
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import settings
from .job_store import JobStore
from .job_runner import JobRunner
from .routes import jobs, cli, files, system, settings_route, ws, utilities

_ROOT = Path(__file__).parent.parent


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Startup ──────────────────────────────────────────────────────────────
    store = JobStore(settings.jobs_file)

    async def _broadcast(data: dict):
        await ws.manager.broadcast(data)

    runner = JobRunner(settings, store, _broadcast)

    jobs.init(store, runner, settings)
    cli.init(settings)
    files.init(settings)
    system.init(settings)
    settings_route.init(settings)
    utilities.init(settings)

    # Background tasks
    runner_task = asyncio.create_task(runner.run_loop())
    stats_task = asyncio.create_task(_stats_loop())

    yield

    # ── Shutdown ─────────────────────────────────────────────────────────────
    runner_task.cancel()
    stats_task.cancel()


async def _stats_loop():
    """Push system stats over WebSocket every 2 seconds."""
    from .routes.system import _nvidia_smi

    while True:
        await asyncio.sleep(2)
        try:
            gpu = await _nvidia_smi()
            await ws.manager.broadcast({"type": "system_stats", "gpu": gpu})
        except Exception:
            pass


app = FastAPI(title="Forge", lifespan=lifespan)

# ── Static files ──────────────────────────────────────────────────────────────
app.mount("/static", StaticFiles(directory=str(_ROOT)), name="static")

# ── Routes ────────────────────────────────────────────────────────────────────
app.include_router(ws.router)
app.include_router(jobs.router)
app.include_router(cli.router)
app.include_router(files.router)
app.include_router(system.router)
app.include_router(settings_route.router)
app.include_router(utilities.router)


@app.get("/forge.css")
async def serve_css():
    return FileResponse(_ROOT / "forge.css", media_type="text/css")


@app.get("/forge.js")
async def serve_js():
    return FileResponse(_ROOT / "forge.js", media_type="application/javascript")


@app.get("/")
async def index():
    return FileResponse(_ROOT / "Forge.html")
