"""Async subprocess job runner with real-time log streaming."""
from __future__ import annotations
import asyncio
import os
import re
import time
from pathlib import Path
from typing import TYPE_CHECKING, Callable, Awaitable

from . import command_builder
from .job_store import Job, JobStore

if TYPE_CHECKING:
    from .config import ForgeSettings

# Matches tqdm lines: "  100/4000 [01:23<12:34,  2.06it/s, loss=0.1142]"
_TQDM_RE = re.compile(
    r"(?P<step>\d+)/(?P<total>\d+).*?(?P<rate>[\d.]+)it/s"
    r"(?:.*?loss=(?P<loss>[\d.]+))?(?:.*?lr=(?P<lr>[\d.e+\-]+))?",
    re.IGNORECASE,
)
# Broader loss-only pattern for non-tqdm log lines
_LOSS_RE  = re.compile(r"\bloss[=:\s]+([0-9]+\.[0-9]+)", re.IGNORECASE)
_LR_RE    = re.compile(r"\blr[=:\s]+([0-9]+\.?[0-9]*(?:e[+-]?[0-9]+)?)", re.IGNORECASE)


class JobRunner:
    def __init__(
        self,
        settings: "ForgeSettings",
        store: JobStore,
        broadcast: Callable[[dict], Awaitable[None]],
    ):
        self._settings = settings
        self._store = store
        self._broadcast = broadcast
        self._proc: asyncio.subprocess.Process | None = None
        self._active: Job | None = None

    async def run_loop(self):
        """Long-running task that drains the job queue one job at a time."""
        while True:
            job = self._store.pop_next()
            if job is None:
                await asyncio.sleep(2)
                continue
            await self._execute(job)

    async def cancel_active(self):
        if self._proc and self._active:
            try:
                await _kill_tree(self._proc.pid)
            except Exception:
                pass
            self._store.update(self._active, status="cancelled", finished_at=time.time())
            await self._broadcast({
                "type": "job_status",
                "job_id": self._active.id,
                "status": "cancelled",
            })
            await self._broadcast({"type": "queue_update"})
            self._proc = None
            self._active = None

    def active_job(self) -> Job | None:
        return self._active

    # ── Internal ─────────────────────────────────────────────────────────────

    def _prepare_sample_prompts(self, job: Job):
        """Write sample_prompts_text to a file; return updated TrainingConfig."""
        cfg = job.training_config
        if not cfg.sample_prompts_text:
            return cfg
        out_dir = Path(cfg.output_dir)
        try:
            out_dir.mkdir(parents=True, exist_ok=True)
        except Exception:
            pass
        prompts_file = out_dir / "sample_prompts.txt"
        try:
            prompts_file.write_text(cfg.sample_prompts_text, encoding="utf-8")
        except Exception as exc:
            self._store.append_log(job, f"[Forge] Could not write sample prompts file: {exc}")
            return cfg
        return cfg.model_copy(update={"sample_prompts": str(prompts_file), "sample_prompts_text": None})

    async def _execute(self, job: Job):
        self._active = job
        self._store.update(job, status="starting", started_at=time.time())
        await self._broadcast({"type": "queue_update"})

        try:
            cfg = self._prepare_sample_prompts(job)
            script_args = command_builder.build(cfg, self._settings)
            prefix = command_builder.build_accelerate_prefix(self._settings)
            full_cmd = prefix + script_args

            env = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONUTF8": "1"}
            self._proc = await asyncio.create_subprocess_exec(
                *full_cmd,
                cwd=str(self._settings.scripts_root),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                env=env,
            )
            proc = self._proc  # local ref so cancel_active() nulling _proc doesn't break us
            self._store.update(job, status="running", pid=proc.pid)
            await self._broadcast({"type": "queue_update"})
            await self._stream(job)
            # proc may already be dead if cancelled; wait() returns immediately in that case
            await proc.wait()
            rc = proc.returncode
            # Don't overwrite a status already set by cancel_active()
            if job.status == "running":
                final_status = "completed" if rc == 0 else "failed"
                self._store.update(
                    job,
                    status=final_status,
                    return_code=rc,
                    finished_at=time.time(),
                )
        except Exception as exc:
            self._store.update(job, status="failed", finished_at=time.time())
            self._store.append_log(job, f"[Forge error] {exc}")
        finally:
            self._proc = None
            self._active = None
            await self._broadcast({"type": "queue_update"})

    async def _stream(self, job: Job):
        assert self._proc and self._proc.stdout
        buf = b""
        _last_status = 0.0

        while True:
            chunk = await self._proc.stdout.read(4096)
            if not chunk:
                break
            buf += chunk
            # Treat \r as a line separator so tqdm step updates are processed individually
            normalized = buf.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
            parts = normalized.split(b"\n")
            buf = parts[-1]  # incomplete trailing segment — keep for next chunk
            for raw in parts[:-1]:
                line = raw.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                self._parse_progress(job, line)
                # Only send tqdm progress lines to the console log buffer
                # if they are epoch-completion lines (not per-step noise)
                is_tqdm = bool(_TQDM_RE.search(line))
                if not is_tqdm:
                    self._store.append_log(job, line)
                    await self._broadcast({"type": "log_line", "job_id": job.id, "line": line})
                now = time.time()
                if now - _last_status >= 0.5:
                    _last_status = now
                    await self._broadcast({
                        "type": "job_status",
                        "job_id": job.id,
                        "status": job.status,
                        "step": job.step,
                        "total_steps": job.total_steps,
                        "max_train_epochs": job.config.get("max_train_epochs"),
                        "loss": job.loss,
                        "lr": job.lr,
                        "throughput": job.throughput,
                    })

        # Flush any remaining buffer content
        if buf.strip():
            line = buf.decode("utf-8", errors="replace").strip()
            if line:
                self._store.append_log(job, line)
                await self._broadcast({"type": "log_line", "job_id": job.id, "line": line})

        # Always emit a final status so the UI reflects completion state
        await self._broadcast({
            "type": "job_status",
            "job_id": job.id,
            "status": job.status,
            "step": job.step,
            "total_steps": job.total_steps,
            "loss": job.loss,
            "lr": job.lr,
            "throughput": job.throughput,
        })

    def _parse_progress(self, job: Job, line: str):
        m = _TQDM_RE.search(line)
        if m:
            job.step = int(m.group("step"))
            job.total_steps = int(m.group("total"))
            rate = m.group("rate")
            if rate:
                job.throughput = float(rate)
            loss_val = m.group("loss")
            if loss_val:
                job.loss = float(loss_val)
                job.loss_history.append(job.loss)
            lr_val = m.group("lr")
            if lr_val:
                try:
                    job.lr = float(lr_val)
                except ValueError:
                    pass
            return

        loss_m = _LOSS_RE.search(line)
        if loss_m:
            job.loss = float(loss_m.group(1))
            job.loss_history.append(job.loss)

        lr_m = _LR_RE.search(line)
        if lr_m:
            try:
                job.lr = float(lr_m.group(1))
            except ValueError:
                pass


async def _kill_tree(pid: int):
    """Kill a process and all its children (Windows-safe)."""
    try:
        import psutil
        parent = psutil.Process(pid)
        children = parent.children(recursive=True)
        for child in children:
            try:
                child.kill()
            except Exception:
                pass
        parent.kill()
    except ImportError:
        # Fallback: just kill the direct process
        import signal
        try:
            os.kill(pid, signal.SIGTERM)
        except Exception:
            pass
    except Exception:
        pass
