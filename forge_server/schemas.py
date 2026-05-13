from __future__ import annotations
from typing import List, Literal, Optional
from pydantic import BaseModel, Field, model_validator


class TrainingConfig(BaseModel):
    # ── Identity ────────────────────────────────────────────────────────────
    output_name: str = "my_lora"
    output_dir: str = "output"

    # ── Mode ────────────────────────────────────────────────────────────────
    architecture: Literal["sd15", "sdxl", "sd3", "flux", "lumina", "hunyuan", "anima"] = "sdxl"
    mode: Literal["lora", "finetune", "dreambooth", "ti", "controlnet", "inpainting"] = "lora"

    # ── Model paths ─────────────────────────────────────────────────────────
    checkpoint: str = ""
    vae: Optional[str] = None
    # FLUX / SD3 extra encoders
    clip_l: Optional[str] = None
    t5xxl: Optional[str] = None
    clip_g: Optional[str] = None  # SD3
    ae: Optional[str] = None      # FLUX VAE
    model_type: str = "flux"      # "flux" | "chroma"

    # ── Dataset ─────────────────────────────────────────────────────────────
    train_data_dir: str = ""
    resolutions: List[str] = ["1024,1024"]
    dataset_config: Optional[str] = None  # internal: path to generated TOML for multi-resolution
    enable_bucket: bool = True
    bucket_no_upscale: bool = True
    min_bucket_reso: int = 256
    max_bucket_reso: int = 2048
    caption_extension: str = ".txt"
    shuffle_caption: bool = False
    caption_dropout_rate: float = 0.0
    caption_tag_dropout_rate: float = 0.0
    keep_tokens: int = 0
    dataset_repeats: int = 1

    # ── Network / LoRA ───────────────────────────────────────────────────────
    network_module: str = "networks.lora"
    network_dim: int = 32
    network_alpha: float = 16.0
    conv_dim: Optional[int] = None
    conv_alpha: Optional[float] = None
    network_dropout: Optional[float] = None
    rank_dropout: Optional[float] = None
    module_dropout: Optional[float] = None
    network_args: Optional[dict[str, str]] = None
    network_weights: Optional[str] = None
    dim_from_weights: bool = False
    network_train_unet_only: bool = False
    network_train_text_encoder_only: bool = False

    # ── Schedule ─────────────────────────────────────────────────────────────
    max_train_epochs: Optional[int] = 10
    max_train_steps: Optional[int] = None
    train_batch_size: int = 1
    gradient_accumulation_steps: int = 1
    optimizer_type: str = "AdamW8bit"
    optimizer_args: Optional[str] = None
    learning_rate: float = 1e-4
    unet_lr: Optional[float] = None
    text_encoder_lr: Optional[float] = None
    lr_scheduler: str = "cosine_with_restarts"
    lr_warmup_steps: int = 0
    lr_scheduler_num_cycles: int = 1
    lr_scheduler_power: float = 1.0
    max_grad_norm: float = 1.0

    # ── Precision & memory ───────────────────────────────────────────────────
    mixed_precision: Literal["no", "fp16", "bf16"] = "bf16"
    full_fp16: bool = False
    full_bf16: bool = False
    fp8_base: bool = False
    gradient_checkpointing: bool = True
    xformers: bool = False
    sdpa: bool = False
    mem_eff_attn: bool = False
    cache_latents: bool = True
    cache_latents_to_disk: bool = False
    cache_text_encoder_outputs: bool = False
    cache_text_encoder_outputs_to_disk: bool = False
    vae_batch_size: int = 1
    blocks_to_swap: Optional[int] = None
    lowram: bool = False
    highvram: bool = False

    # ── DiT-specific (FLUX / SD3 / Lumina / HunyuanImage / Anima) ───────────
    weighting_scheme: str = "uniform"
    logit_mean: float = 0.0
    logit_std: float = 1.0
    mode_scale: float = 1.29
    timestep_sampling: str = "sigma"
    guidance_scale: float = 3.5
    t5xxl_max_token_length: Optional[int] = None

    # ── Anima-specific ───────────────────────────────────────────────────────
    qwen3: Optional[str] = None              # path to Qwen3-0.6B text encoder
    t5_tokenizer_path: Optional[str] = None  # override T5 tokenizer dir (default: configs/t5_old/)
    vae_chunk_size: Optional[int] = None
    vae_disable_cache: bool = False

    # ── Sampling ─────────────────────────────────────────────────────────────
    sample_every_n_steps: Optional[int] = None
    sample_every_n_epochs: Optional[int] = None
    sample_at_first: bool = False
    sample_sampler: str = "euler_a"
    sample_prompts: Optional[str] = None
    sample_prompts_text: Optional[str] = None  # inline text; written to file by job runner

    # ── Saving ───────────────────────────────────────────────────────────────
    save_every_n_epochs: Optional[int] = None
    save_every_n_steps: Optional[int] = None
    save_last_n_epochs: Optional[int] = None
    save_last_n_steps: Optional[int] = None
    save_model_as: str = "safetensors"
    save_precision: Optional[Literal["float", "fp16", "bf16"]] = "fp16"
    save_state: bool = False

    # ── Loss / noise ─────────────────────────────────────────────────────────
    min_snr_gamma: Optional[float] = None
    noise_offset: Optional[float] = None
    noise_offset_random_strength: bool = False
    ip_noise_gamma: Optional[float] = None
    adaptive_noise_scale: Optional[float] = None
    multires_noise_iterations: Optional[int] = None
    multires_noise_discount: float = 0.3
    zero_terminal_snr: bool = False
    debiased_estimation_loss: bool = False
    v_parameterization: bool = False
    masked_loss: bool = False
    prior_loss_weight: float = 1.0

    # ── Tokens ───────────────────────────────────────────────────────────────
    max_token_length: Optional[Literal[75, 150, 225]] = None
    clip_skip: Optional[int] = None

    # ── Logging ──────────────────────────────────────────────────────────────
    log_with: Optional[str] = None
    logging_dir: Optional[str] = None
    log_prefix: Optional[str] = None
    wandb_api_key: Optional[str] = None

    # ── HuggingFace ──────────────────────────────────────────────────────────
    huggingface_repo_id: Optional[str] = None
    huggingface_token: Optional[str] = None
    huggingface_repo_visibility: Optional[str] = None
    async_upload: bool = False

    # ── Misc ─────────────────────────────────────────────────────────────────
    seed: Optional[int] = None
    training_comment: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def _migrate_resolution(cls, data: dict) -> dict:
        """Migrate old single-resolution jobs to the new resolutions list."""
        if isinstance(data, dict) and "resolution" in data and "resolutions" not in data:
            data = dict(data)
            data["resolutions"] = [data.pop("resolution")]
        return data


class JobCreate(BaseModel):
    config: TrainingConfig


class JobStatus(BaseModel):
    id: str
    status: str
    output_name: str
    architecture: str
    mode: str
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


class CliPreviewRequest(BaseModel):
    config: TrainingConfig


class CliPreviewResponse(BaseModel):
    cli: str
    script: str
    args: list[str]
