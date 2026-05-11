"""Settings GET/POST — reads and writes forge_config.json."""
from __future__ import annotations
from fastapi import APIRouter

router = APIRouter(prefix="/api/settings")

_settings = None


def init(settings):
    global _settings
    _settings = settings


@router.get("")
async def get_settings():
    return _settings.to_dict()


@router.post("")
async def update_settings(data: dict):
    _settings.save(data)
    return _settings.to_dict()
