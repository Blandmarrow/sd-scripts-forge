"""In-memory job store with JSON persistence."""
from __future__ import annotations
import json
import time
import uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional

from .schemas import TrainingConfig


@dataclass
class Job:
    id: str
    config: dict  # Stored as plain dict for JSON serialisability
    status: str   # queued | starting | running | completed | failed | cancelled | interrupted
    created_at: float
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    pid: Optional[int] = None
    step: int = 0
    total_steps: int = 0
    loss: Optional[float] = None
    lr: Optional[float] = None
    throughput: Optional[float] = None
    return_code: Optional[int] = None
    log_buffer: list[str] = field(default_factory=list)
    loss_history: list[float] = field(default_factory=list)

    @property
    def training_config(self) -> TrainingConfig:
        return TrainingConfig(**self.config)

    def to_status_dict(self) -> dict:
        return {
            "id": self.id,
            "status": self.status,
            "output_name": self.config.get("output_name", ""),
            "architecture": self.config.get("architecture", ""),
            "mode": self.config.get("mode", ""),
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "pid": self.pid,
            "step": self.step,
            "total_steps": self.total_steps,
            "max_train_epochs": self.config.get("max_train_epochs"),
            "loss": self.loss,
            "lr": self.lr,
            "throughput": self.throughput,
            "return_code": self.return_code,
        }


class JobStore:
    def __init__(self, jobs_file: Path):
        self.jobs_file = jobs_file
        self._jobs: dict[str, Job] = {}
        self._queue: list[str] = []
        self._load()

    def _load(self):
        if not self.jobs_file.exists():
            return
        try:
            data = json.loads(self.jobs_file.read_text())
        except Exception:
            return
        for jd in data.get("jobs", []):
            j = Job(
                id=jd["id"],
                config=jd["config"],
                status=jd["status"],
                created_at=jd["created_at"],
                started_at=jd.get("started_at"),
                finished_at=jd.get("finished_at"),
                pid=jd.get("pid"),
                step=jd.get("step", 0),
                total_steps=jd.get("total_steps", 0),
                loss=jd.get("loss"),
                lr=jd.get("lr"),
                throughput=jd.get("throughput"),
                return_code=jd.get("return_code"),
                loss_history=jd.get("loss_history", []),
                log_buffer=jd.get("log_buffer", []),
            )
            # Mark anything mid-run as interrupted
            if j.status in ("running", "starting"):
                j.status = "interrupted"
            self._jobs[j.id] = j
        self._queue = [jid for jid in data.get("queue", []) if jid in self._jobs]

    def save(self):
        data = {
            "jobs": [
                {
                    "id": j.id,
                    "config": j.config,
                    "status": j.status,
                    "created_at": j.created_at,
                    "started_at": j.started_at,
                    "finished_at": j.finished_at,
                    "pid": j.pid,
                    "step": j.step,
                    "total_steps": j.total_steps,
                    "loss": j.loss,
                    "lr": j.lr,
                    "throughput": j.throughput,
                    "return_code": j.return_code,
                    "loss_history": j.loss_history[-500:],  # keep last 500 points
                    "log_buffer": j.log_buffer[-500:],
                }
                for j in self._jobs.values()
            ],
            "queue": self._queue,
        }
        self.jobs_file.write_text(json.dumps(data, indent=2))

    # ── Public API ────────────────────────────────────────────────────────────

    def create(self, config: TrainingConfig) -> Job:
        jid = str(uuid.uuid4())[:8]
        job = Job(
            id=jid,
            config=config.model_dump(),
            status="queued",
            created_at=time.time(),
        )
        self._jobs[jid] = job
        self._queue.append(jid)
        self.save()
        return job

    def get(self, job_id: str) -> Optional[Job]:
        return self._jobs.get(job_id)

    def all(self) -> list[Job]:
        return list(self._jobs.values())

    def queued(self) -> list[Job]:
        return [self._jobs[jid] for jid in self._queue if jid in self._jobs]

    def pop_next(self) -> Optional[Job]:
        while self._queue:
            jid = self._queue[0]
            if jid in self._jobs and self._jobs[jid].status == "queued":
                self._queue.pop(0)
                return self._jobs[jid]
            self._queue.pop(0)
        return None

    def remove_from_queue(self, job_id: str):
        self._queue = [jid for jid in self._queue if jid != job_id]

    def update(self, job: Job, **kwargs):
        for k, v in kwargs.items():
            setattr(job, k, v)
        self.save()

    def append_log(self, job: Job, line: str):
        job.log_buffer.append(line)
        if len(job.log_buffer) > 2000:
            job.log_buffer = job.log_buffer[-2000:]
