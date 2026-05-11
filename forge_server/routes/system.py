"""System stats: GPU, disk."""
from __future__ import annotations
import asyncio
import shutil
from fastapi import APIRouter

router = APIRouter(prefix="/api/system")

_settings = None


def init(settings):
    global _settings
    _settings = settings


async def _nvidia_smi() -> dict:
    """Query nvidia-smi for VRAM info."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "nvidia-smi",
            "--query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu",
            "--format=csv,noheader,nounits",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=4)
        line = stdout.decode().strip().split("\n")[0]
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 4:
            name = parts[0]
            used_mb = int(parts[1])
            total_mb = int(parts[2])
            util = int(parts[3])
            temp = int(parts[4]) if len(parts) > 4 else 0
            return {
                "name": name,
                "used_gb": round(used_mb / 1024, 1),
                "total_gb": round(total_mb / 1024, 1),
                "utilization": util,
                "temperature": temp,
                "available": True,
            }
    except Exception:
        pass
    return {"available": False, "used_gb": 0, "total_gb": 0, "utilization": 0}


def _disk_stats(path: str) -> dict:
    try:
        usage = shutil.disk_usage(path)
        return {
            "total_gb": round(usage.total / 1e9, 1),
            "used_gb": round(usage.used / 1e9, 1),
            "free_gb": round(usage.free / 1e9, 1),
            "percent": round(usage.used / usage.total * 100, 1),
        }
    except Exception:
        return {"total_gb": 0, "used_gb": 0, "free_gb": 0, "percent": 0}


@router.get("/stats")
async def system_stats():
    gpu = await _nvidia_smi()
    disk = _disk_stats(_settings.output_dir)
    return {"gpu": gpu, "disk": disk}
