"""Settings GET/POST — reads and writes forge_config.json."""
from __future__ import annotations
from typing import Optional
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/api/settings")

_settings = None


def init(settings):
    global _settings
    _settings = settings


class SettingsUpdate(BaseModel):
    sd_scripts_root: Optional[str] = None
    python_executable: Optional[str] = None
    models_dir: Optional[str] = None
    datasets_dir: Optional[str] = None
    output_dir: Optional[str] = None
    cpu_threads: Optional[int] = None
    default_mixed_precision: Optional[str] = None


@router.get("")
async def get_settings():
    return _settings.to_dict()


@router.post("")
async def update_settings(data: SettingsUpdate):
    _settings.save(data.model_dump(exclude_none=True))
    return _settings.to_dict()
