import json
from pathlib import Path

_ROOT = Path(__file__).parent.parent

DEFAULT_CONFIG = {
    "sd_scripts_root": str(_ROOT),
    "python_executable": "python",
    "models_dir": str(_ROOT / "models"),
    "datasets_dir": str(_ROOT / "datasets"),
    "output_dir": str(_ROOT / "output"),
    "server_host": "0.0.0.0",
    "server_port": 28471,
    "cpu_threads": 8,
    "default_mixed_precision": "bf16",
}

CONFIG_PATH = _ROOT / "forge_config.json"


class ForgeSettings:
    def __init__(self, config_path: Path = CONFIG_PATH):
        self.config_path = config_path
        if not config_path.exists():
            config_path.write_text(json.dumps(DEFAULT_CONFIG, indent=2))
            print(f"[Forge] Created default config at {config_path}")
        self._load()

    def _load(self):
        try:
            data = json.loads(self.config_path.read_text())
        except Exception:
            data = {}
        merged = {**DEFAULT_CONFIG, **data}
        for k, v in merged.items():
            setattr(self, k, v)

    def reload(self):
        self._load()

    def save(self, data: dict):
        current = self.to_dict()
        current.update(data)
        self.config_path.write_text(json.dumps(current, indent=2))
        self._load()

    def to_dict(self) -> dict:
        return {k: getattr(self, k, v) for k, v in DEFAULT_CONFIG.items()}

    @property
    def scripts_root(self) -> Path:
        return Path(self.sd_scripts_root)

    @property
    def jobs_file(self) -> Path:
        return self.scripts_root / "forge_jobs.json"


settings = ForgeSettings()
