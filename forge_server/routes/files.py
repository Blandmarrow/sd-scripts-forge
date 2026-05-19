"""File system scanning: models, datasets, LoRAs."""
from __future__ import annotations
import os
import re
from pathlib import Path
from fastapi import APIRouter

_REPEAT_RE = re.compile(r'^\d+_')

router = APIRouter(prefix="/api")

_settings = None


def init(settings):
    global _settings
    _settings = settings


def _human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def _scan_checkpoints(directory: str) -> list[dict]:
    results = []
    root = Path(directory)
    if not root.exists():
        return results
    for p in sorted(root.rglob("*")):
        if p.suffix.lower() in (".safetensors", ".ckpt", ".pt"):
            try:
                size = p.stat().st_size
            except OSError:
                size = 0
            results.append({
                "name": p.name,
                "path": str(p),
                "size": size,
                "size_human": _human_size(size),
                "arch": _guess_arch(p.name),
                "relative": str(p.relative_to(root)),
            })
    return results


def _guess_arch(name: str) -> str:
    lower = name.lower()
    if "flux" in lower:   return "flux"
    if "sdxl" in lower or "xl" in lower: return "sdxl"
    if "sd3" in lower or "stable-diffusion-3" in lower: return "sd3"
    if "lumina" in lower: return "lumina"
    if "hunyuan" in lower: return "hunyuan"
    if "anima" in lower:  return "anima"
    return "sd15"


def _is_dataset_root(path: Path) -> bool:
    """A directory is a dataset root if it directly contains repeat-named subfolders ({N}_{name})."""
    try:
        return any(_REPEAT_RE.match(c.name) for c in path.iterdir() if c.is_dir())
    except PermissionError:
        return False


def _count_media(path: Path) -> tuple[int, int]:
    imgs = sum(1 for f in path.rglob("*") if f.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp", ".bmp"))
    caps = sum(1 for f in path.rglob("*") if f.suffix.lower() in (".txt", ".caption"))
    return imgs, caps


def _scan_datasets(directory: str) -> list[dict]:
    """Recursively find sd-scripts dataset roots (dirs containing {N}_{name} repeat subfolders)."""
    results = []
    root = Path(directory)
    if not root.exists():
        return results

    def _collect(path: Path, depth: int = 0):
        if depth > 5:
            return
        if _is_dataset_root(path):
            imgs, caps = _count_media(path)
            try:
                rel = str(path.relative_to(root))
            except ValueError:
                rel = path.name
            results.append({
                "name": rel if rel != "." else path.name,
                "path": str(path),
                "image_count": imgs,
                "caption_count": caps,
                "captioned": caps >= imgs and imgs > 0,
            })
            return  # don't recurse further — repeat subfolders aren't dataset roots
        try:
            for child in sorted(path.iterdir()):
                if child.is_dir() and not _REPEAT_RE.match(child.name):
                    _collect(child, depth + 1)
        except PermissionError:
            pass

    _collect(root)
    return results


@router.get("/models")
async def list_models():
    items = _scan_checkpoints(_settings.models_dir)
    return {"models": items, "directory": _settings.models_dir}


@router.get("/datasets")
async def list_datasets():
    items = _scan_datasets(_settings.datasets_dir)
    return {"datasets": items, "directory": _settings.datasets_dir}


@router.get("/browse-folder")
async def browse_folder():
    """Open a native OS folder-picker dialog and return the chosen path."""
    import subprocess, sys
    script = (
        "import tkinter as tk;"
        "from tkinter import filedialog;"
        "root = tk.Tk();"
        "root.withdraw();"
        "root.wm_attributes('-topmost', True);"
        "path = filedialog.askdirectory();"
        "print(path, end='')"
    )
    try:
        result = subprocess.run(
            [sys.executable, "-c", script],
            capture_output=True, text=True, timeout=120,
        )
        return {"path": result.stdout.strip()}
    except Exception as exc:
        return {"path": "", "error": str(exc)}


@router.get("/loras")
async def list_loras():
    items = _scan_checkpoints(_settings.output_dir)
    # Only return small files (LoRAs are typically < 1 GB)
    loras = [m for m in items if m["size"] < 1_200_000_000]
    return {"loras": loras, "directory": _settings.output_dir}
