This file provides the overview and guidance for developers working with the codebase, including setup instructions, architecture details, and common commands.

## Project Architecture

### Core Training Framework
The codebase is built around a **strategy pattern architecture** that supports multiple diffusion model families:

- **`library/strategy_base.py`**: Base classes for tokenization, text encoding, latent caching, and training strategies
- **`library/strategy_*.py`**: Model-specific implementations for SD, SDXL, SD3, FLUX, etc.
- **`library/train_util.py`**: Core training utilities shared across all model types
- **`library/config_util.py`**: Configuration management with TOML support

### Model Support Structure
Each supported model family has a consistent structure:
- **Training script**: `{model}_train.py` (full fine-tuning), `{model}_train_network.py` (LoRA/network training)
- **Model utilities**: `library/{model}_models.py`, `library/{model}_train_utils.py`, `library/{model}_utils.py`
- **Networks**: `networks/lora_{model}.py`, `networks/oft_{model}.py` for adapter training

### Supported Models
- **Stable Diffusion 1.x**: `train*.py`, `library/train_util.py`, `train_db.py` (for DreamBooth)
- **SDXL**: `sdxl_train*.py`, `library/sdxl_*`
- **SD3**: `sd3_train*.py`, `library/sd3_*`
- **FLUX.1**: `flux_train*.py`, `library/flux_*`
- **Lumina Image 2.0**: `lumina_train*.py`, `library/lumina_*`
- **HunyuanImage-2.1**: `hunyuan_image_train*.py`, `library/hunyuan_image_*`
- **Anima-Preview**:  `anima_train*.py`, `library/anima_*`

### Key Components

#### Memory Management
- **Block swapping**: CPU-GPU memory optimization via `--blocks_to_swap` parameter, works with custom offloading. Only available for models with transformer architectures like SD3 and FLUX.1.
- **Custom offloading**: `library/custom_offloading_utils.py` for advanced memory management
- **Gradient checkpointing**: Memory reduction during training

#### Training Features
- **LoRA training**: Low-rank adaptation networks in `networks/lora*.py`
- **ControlNet training**: Conditional generation control
- **Textual Inversion**: Custom embedding training
- **Multi-resolution training**: Bucket-based aspect ratio handling
- **Validation loss**: Real-time training monitoring, only for LoRA training

#### Configuration System
Dataset configuration uses TOML files with structured validation:
```toml
[datasets.sample_dataset]
  resolution = 1024
  batch_size = 2
  
  [[datasets.sample_dataset.subsets]]
    image_dir = "path/to/images"
    caption_extension = ".txt"
```

## Common Development Commands

### Web UI (Forge)
A browser-based training interface is available:
```bash
start.bat                          # Windows shortcut — activates venv and starts server
python forge.py                    # start at http://localhost:28471
python forge.py --port 8080 --reload  # custom port, dev auto-reload
```
`start.bat` activates `venv\Scripts\activate.bat` and passes any extra arguments through to `forge.py`.

No frontend rebuild is ever needed — the SPA is plain JS/CSS with no build step. Changes to `forge.js` or `forge.css` take effect on the next browser refresh. Python/server changes require a restart (or run with `--reload` during development).

Server config is in `forge_config.json` (created automatically on first run).

### Training Commands Pattern
All training scripts follow this general pattern:
```bash
accelerate launch --mixed_precision bf16 {script_name}.py \
  --pretrained_model_name_or_path model.safetensors \
  --dataset_config config.toml \
  --output_dir output \
  --output_name model_name \
  [model-specific options]
```

### Memory Optimization
For low VRAM environments, use block swapping:
```bash
# Add to any training command for memory reduction
--blocks_to_swap 10  # Swap 10 blocks to CPU (adjust number as needed)
```

### Utility Scripts
- `networks/merge_lora.py`, `networks/flux_merge_lora.py`: Merge LoRA adapters (SD/SDXL and FLUX variants)
- `networks/resize_lora.py`: Resize LoRA rank
- `networks/extract_lora_from_models.py`, `networks/flux_extract_lora.py`: Extract LoRA from model diff
- `tools/merge_models.py`: Full model merging
- `tools/cache_latents.py`: Pre-cache VAE latents for faster training
- `tools/cache_text_encoder_outputs.py`: Pre-cache text encoder outputs

## Forge Web UI Architecture

The web UI is a FastAPI server (`forge_server/`) that wraps the CLI training scripts:

- **`forge.py`**: Entry point — runs uvicorn
- **`forge_server/main.py`**: FastAPI app, lifespan (job queue + GPU stats push)
- **`forge_server/schemas.py`**: `TrainingConfig` Pydantic model covering all training parameters
- **`forge_server/command_builder.py`**: Maps `TrainingConfig` → `accelerate launch` argv. `SCRIPT_MAP` dict controls the `(architecture, mode) → script` routing. **Update this when adding new model support.** `cache_text_encoder_outputs` / `cache_text_encoder_outputs_to_disk` are automatically suppressed when `text_encoder_lr` is set (the two options are mutually exclusive in sd-scripts). When `cfg.dataset_config` is set (written by `job_runner` for multi-resolution jobs), the builder uses `--dataset_config` instead of `--train_data_dir` + `--resolution`; otherwise it uses `cfg.resolutions[0]` as the single `--resolution` value.
- **`forge_server/job_store.py`**: In-memory job store with `forge_jobs.json` persistence
- **`forge_server/job_runner.py`**: Async subprocess runner, tqdm parsing, Windows process-tree kill. Reads stdout in 4 KB chunks and normalises `\r` to `\n` so tqdm per-step progress lines are captured (not just epoch-end newlines); `job_status` broadcasts are throttled to 0.5 s. Also handles pre-launch setup — two helpers run before the subprocess starts: `_prepare_sample_prompts()` writes inline `sample_prompts_text` to `{output_dir}/sample_prompts.txt`; `_prepare_dataset_config()` is called when `len(cfg.resolutions) > 1` — it scans `train_data_dir` for `{N}_{name}` repeat subdirectories, generates a multi-`[[datasets]]` TOML at `{output_dir}/dataset_config.toml` (one block per resolution, each with the discovered subsets), and patches the config so the command builder picks up `--dataset_config` instead of `--train_data_dir` + `--resolution`.
- **`forge_server/routes/`**: REST API + WebSocket `/ws`
  - `jobs.py` — `/api/jobs` CRUD + queue management; `GET /api/jobs/image?path=` serves sample images by absolute path (registered before `/{job_id}` to avoid route shadowing); `GET /{id}/log` returns the log buffer as plain text; `GET /{id}/samples` returns absolute paths of generated sample images grouped by step
  - `cli.py` — `/api/cli-preview` (dry-run argv preview)
  - `files.py` — `/api/models`, `/api/loras`, `/api/datasets` (filesystem scanning). Dataset scanner detects sd-scripts roots recursively: a directory is a dataset root if it contains `{N}_{name}` repeat-named subdirectories.
  - `system.py` — `/api/system/stats` (GPU via nvidia-smi, disk usage)
  - `settings_route.py` — `/api/settings` GET/POST (reads/writes `forge_config.json`)
  - `utilities.py` — `/api/utilities/run` (one-shot subprocess runner for merge/resize/extract scripts); `/api/utilities/tools` lists available tools
  - `ws.py` — WebSocket `/ws` with `ConnectionManager`; broadcasts `queue_update`, `system_stats` (GPU/disk, ~2 s interval), `job_status` (step/loss/lr/throughput/total_steps, throttled to 0.5 s during training), and `log_line` (individual log lines, tqdm progress lines excluded)
- **`forge.css`** / **`forge.js`**: SPA frontend (no build step, vanilla JS + custom CSS)
- **`forge_config.json`**: User-editable server config (`sd_scripts_root`, `python_executable`, `models_dir`, `datasets_dir`, `output_dir`, `server_host`, `server_port`, `cpu_threads`, `default_mixed_precision`)

### Adding a New Model to the Web UI
When a new model family is added to sd-scripts, also update:
1. `forge_server/command_builder.py` — add entries to `SCRIPT_MAP` for the new `(arch, mode)` combinations; add an `elif cfg.architecture == "<arch>":` block for any model-specific CLI flags (see the `anima` block as an example)
2. `forge_server/schemas.py` — add any model-specific fields to `TrainingConfig`
3. `Forge.html` — add the architecture pill to the arch-strip in the Basics tab; add a hidden `<div id="{arch}-extras">` for model-specific inputs if needed
4. `forge.js` — show/hide the extras div in `updateArchExtras()`; collect the new fields in `collectFormState()`; restore them in `_applyConfigToForm()`

**Model-specific network modules**: if a model requires a non-default LoRA module (e.g. Anima uses `networks.lora_anima` instead of `networks.lora`), override it in both `collectFormState()` and the `command_builder.py` network block to prevent "empty parameter list" errors.

**accelerate invocation**: `_accelerate_launch_base()` in `command_builder.py` resolves the accelerate executable — it prefers `accelerate.exe` from the venv's `Scripts/` directory and falls back to `python -m accelerate.commands.launch` (no extra `launch` token). `forge_config.json` `python_executable` must point to the venv Python, not the system Python.

### Forge Frontend SPA Conventions
- Page templates live as `<template id="tpl-{page}">` elements; the JS router clones them into `#page` on navigation.
- Each page has a corresponding `mount{Page}()` function registered in `pageControllers` in `forge.js`.
- `sock.on(type, handler)` supports **multiple handlers per type** — each call pushes a new handler into an array; all are called on each matching message. Global handlers (e.g. `system_stats` for the sidebar GPU meter) are registered at module level; page-specific handlers are registered inside the `mount*()` function.
- `collectFormState()` reads the train form into a `TrainingConfig`-shaped object; always update it when adding new form fields.
- `_applyConfigToForm(cfg)` is the inverse of `collectFormState()` — it restores all form fields from a config object, covering every tab (basics, network, schedule, memory, sampling, advanced). When adding new model-specific fields, update **both** functions. Use the internal `setActiveBtn`, `setByLabel`, and `setCheckbox` helpers rather than direct querySelector where possible.
- **Resolution multi-select**: `#resolution-btns` carries `data-multiselect="true"`, which causes the general `.row-flex` single-select handler to skip it. A dedicated handler in `mountTrain()` instead toggles individual buttons (at least one must remain active). `collectFormState()` collects all active preset buttons plus the optional custom `W×H` entry into `resolutions: string[]` (schema field). `_applyConfigToForm()` restores the multi-selection from `cfg.resolutions`; it also accepts the old `cfg.resolution` string for backward compatibility with stored jobs.
- **DiT weighting scheme**: the Advanced tab's "Noise & loss" panel shows a `weighting_scheme` button group (uniform / sigma_sqrt / logit_normal / mode / cosmap / none) for DiT architectures (FLUX, SD3, Lumina, HunyuanImage, Anima). The row is hidden for SD 1.5 / SDXL via `updateArchExtras()`. Selecting `logit_normal` reveals `logit_mean` / `logit_std` inputs; selecting `mode` reveals `mode_scale`. All four values are round-tripped through `collectFormState()` / `_applyConfigToForm()`.
- **`getCheckbox(spanText)` / `setCheckbox(spanText, checked)`** match by the text content of the `<span>` inside the `<label>`, not by element ID. Pass the visible label text (e.g. `'train text encoder'`), not an `id` string. `network_train_unet_only` and `network_train_text_encoder_only` are derived in `collectFormState()` from the "train UNet" / "train text encoder" checkbox pair: if only UNet is checked → `network_train_unet_only`; if only TE is checked → `network_train_text_encoder_only`; both checked → neither flag (train both, the default).
- `_pendingEdit` (module-level) passes a job config from the Jobs page → `mountTrain()` for pre-population.
- Utility scripts are invoked via `POST /api/utilities/run` with `{tool, args}` — no job queue; result returned inline.
- **User presets** are stored in `localStorage` under key `forge_presets` (object keyed by preset name). The preset popover calls `collectFormState()` on save and `_applyConfigToForm()` on load. The VAE override checkbox requires `dispatchEvent(new Event('change'))` after setting `.checked` so the `mountTrain` listener can update the input's `disabled` state.
- **Sample prompts**: users type prompts inline in `#sample-prompts-textarea` (one per line). Width/height/steps/guidance/negative inputs provide defaults that `collectFormState()` appends as `--w --h --s --l --n` directives. The combined text is sent as `sample_prompts_text`; `job_runner.py` writes it to a file. `collectFormState()` also stores the raw textarea text as `sample_prompts_raw` and the individual dimension/step/guidance/negative values separately so `_applyConfigToForm()` can round-trip them correctly. If the textarea is empty, `sample_every_n_steps` and `sample_every_n_epochs` are not sent — omitting these when `--sample_prompts` is absent would crash the training script.
- **Live monitor** (`mountLogs`): on mount it loads loss history, the log buffer, and sample images; polls samples every 30 s while on the page. Module-level state: `_lossHistory`, `_sampleGroups` (images grouped by step parsed from the sd-scripts filename pattern `_s{step:06d}_`), `_sampleGroupIdx` (current group), `_sampleEveryNSteps` (from `activeJob.config.sample_every_n_steps`, used to calculate "next sample at step N"). The `job_status` WebSocket handler updates the loss chart, stat cards, subtitle, sample-panel header step counter, and next-sample label. Serving sample images uses `GET /api/jobs/image?path=<absolute>` rather than the static mount so paths outside `sd_scripts_root` work correctly.

## Development Notes

### Strategy Pattern Implementation
When adding support for new models, implement the four core strategies:
1. `TokenizeStrategy`: Text tokenization handling
2. `TextEncodingStrategy`: Text encoder forward pass
3. `LatentsCachingStrategy`: VAE encoding/caching
4. `TextEncoderOutputsCachingStrategy`: Text encoder output caching

### Testing Approach
- Unit tests focus on utility functions and model loading
- Integration tests validate training script syntax and basic execution
- Most tests use mocks to avoid requiring actual model files
- Add tests for new model support in `tests/test_{model}_*.py`

### Configuration System
- Use `config_util.py` dataclasses for type-safe configuration
- Support both command-line arguments and TOML file configuration
- Validate configuration early in training scripts to prevent runtime errors

### Memory Management
- Always consider VRAM limitations when implementing features
- Use gradient checkpointing for large models
- Implement block swapping for models with transformer architectures
- Cache intermediate results (latents, text embeddings) when possible