"""One-shot utility script runner."""
from __future__ import annotations
import asyncio
import subprocess
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Any

router = APIRouter(prefix="/api/utilities")
_settings = None
_tensorboard_proc: subprocess.Popen | None = None


def init(settings):
    global _settings
    _settings = settings


TOOL_MAP: dict[str, str] = {
    "merge_lora":        "networks/merge_lora.py",
    "merge_lora_flux":   "networks/flux_merge_lora.py",
    "resize_lora":       "networks/resize_lora.py",
    "extract_lora":      "networks/extract_lora_from_models.py",
    "extract_lora_flux": "networks/flux_extract_lora.py",
    "merge_models":      "tools/merge_models.py",
}


class UtilityRequest(BaseModel):
    tool: str
    args: dict[str, Any]


@router.get("/tools")
async def list_tools():
    return {"tools": list(TOOL_MAP.keys())}


class TensorboardRequest(BaseModel):
    logdir: str = "output"
    port: int = 6006


@router.post("/tensorboard/start")
async def start_tensorboard(body: TensorboardRequest):
    global _tensorboard_proc
    port = body.port

    # Reuse if already running on the same port
    if _tensorboard_proc is not None and _tensorboard_proc.poll() is None:
        return {"url": f"http://localhost:{port}", "status": "already_running"}

    try:
        _tensorboard_proc = subprocess.Popen(
            [_settings.python_executable, "-m", "tensorboard.main",
             "--logdir", body.logdir, "--port", str(port)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except FileNotFoundError:
        raise HTTPException(500, "tensorboard not found — install it with: pip install tensorboard")
    except Exception as exc:
        raise HTTPException(500, f"Failed to launch TensorBoard: {exc}")

    await asyncio.sleep(1.5)
    if _tensorboard_proc.poll() is not None:
        raise HTTPException(500, "TensorBoard exited immediately — check logdir path")

    return {"url": f"http://localhost:{port}", "status": "started"}


def stop_tensorboard():
    global _tensorboard_proc
    if _tensorboard_proc is not None:
        try:
            _tensorboard_proc.terminate()
        except Exception:
            pass
        _tensorboard_proc = None


@router.post("/run")
async def run_utility(body: UtilityRequest):
    if body.tool not in TOOL_MAP:
        raise HTTPException(400, f"Unknown tool: {body.tool!r}. Valid: {list(TOOL_MAP)}")

    script = TOOL_MAP[body.tool]
    script_path = _settings.scripts_root / script
    if not script_path.exists():
        raise HTTPException(404, f"Script not found: {script}")

    argv = [_settings.python_executable, str(script_path)]
    argv += _dict_to_argv(body.args)

    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            cwd=str(_settings.scripts_root),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=300)
        output = stdout.decode("utf-8", errors="replace")
        return {"returncode": proc.returncode, "output": output, "tool": body.tool}
    except asyncio.TimeoutError:
        raise HTTPException(504, "Utility timed out (5 min limit)")
    except Exception as exc:
        raise HTTPException(500, f"Failed to launch utility: {exc}")


def _dict_to_argv(args: dict[str, Any]) -> list[str]:
    """Convert {flag: value} dict to --flag value argv list."""
    out: list[str] = []
    for k, v in args.items():
        if v is None or v == "":
            continue
        flag = f"--{k}"
        if isinstance(v, bool):
            if v:
                out.append(flag)
        elif isinstance(v, list):
            for item in v:
                if item not in (None, ""):
                    out += [flag, str(item)]
        else:
            out += [flag, str(v)]
    return out
