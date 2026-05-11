"""CLI preview endpoint — stateless, no side effects."""
from __future__ import annotations
from fastapi import APIRouter
from ..schemas import CliPreviewRequest, CliPreviewResponse
from .. import command_builder

router = APIRouter(prefix="/api")

_settings = None


def init(settings):
    global _settings
    _settings = settings


@router.post("/cli-preview", response_model=CliPreviewResponse)
async def cli_preview(body: CliPreviewRequest):
    script_args = command_builder.build(body.config, _settings)
    script = script_args[0] if script_args else ""
    cli_str = command_builder.to_cli_string(body.config, _settings)
    return CliPreviewResponse(cli=cli_str, script=script, args=script_args)
