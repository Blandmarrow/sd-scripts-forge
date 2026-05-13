"""Maps a TrainingConfig into an argv list for `accelerate launch`."""
from __future__ import annotations
import subprocess
import sys
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .schemas import TrainingConfig
    from .config import ForgeSettings

# (architecture, mode) → training script filename
SCRIPT_MAP: dict[tuple[str, str], str] = {
    ("sd15",    "lora"):       "train_network.py",
    ("sd15",    "dreambooth"): "train_db.py",
    ("sd15",    "finetune"):   "fine_tune.py",
    ("sd15",    "ti"):         "train_textual_inversion.py",
    ("sd15",    "controlnet"): "train_control_net.py",
    ("sd15",    "inpainting"): "train_network.py",
    ("sdxl",    "lora"):       "sdxl_train_network.py",
    ("sdxl",    "dreambooth"): "sdxl_train.py",
    ("sdxl",    "finetune"):   "sdxl_train.py",
    ("sdxl",    "ti"):         "sdxl_train_network.py",
    ("sdxl",    "controlnet"): "sdxl_train_control_net_lllite.py",
    ("sdxl",    "inpainting"): "sdxl_train_network.py",
    ("sd3",     "lora"):       "sd3_train_network.py",
    ("sd3",     "finetune"):   "sd3_train.py",
    ("flux",    "lora"):       "flux_train_network.py",
    ("flux",    "finetune"):   "flux_train.py",
    ("lumina",  "lora"):       "lumina_train_network.py",
    ("lumina",  "finetune"):   "lumina_train.py",
    ("hunyuan", "lora"):       "hunyuan_image_train_network.py",
    ("anima",   "lora"):       "anima_train_network.py",
    ("anima",   "controlnet"): "anima_train_control_net_lllite.py",
    ("anima",   "finetune"):   "anima_train.py",
}

_DIT_ARCHS = {"flux", "sd3", "lumina", "hunyuan", "anima"}
_NETWORK_MODES = {"lora", "controlnet", "inpainting", "ti"}


def get_script(cfg: "TrainingConfig") -> str:
    key = (cfg.architecture, cfg.mode)
    if key not in SCRIPT_MAP:
        # Fall back to closest available
        for mode_fallback in ("lora", "finetune"):
            fallback = (cfg.architecture, mode_fallback)
            if fallback in SCRIPT_MAP:
                return SCRIPT_MAP[fallback]
        return "train_network.py"
    return SCRIPT_MAP[key]


def build(cfg: "TrainingConfig", settings: "ForgeSettings") -> list[str]:
    """Return the full argv starting with the script name (not including accelerate launch)."""
    args: list[str] = []
    script = get_script(cfg)
    args.append(script)

    # ── Model paths ──────────────────────────────────────────────────────────
    if cfg.checkpoint:
        args += ["--pretrained_model_name_or_path", cfg.checkpoint]

    if cfg.architecture == "flux":
        if cfg.clip_l:       args += ["--clip_l", cfg.clip_l]
        if cfg.t5xxl:        args += ["--t5xxl", cfg.t5xxl]
        if cfg.ae:           args += ["--ae", cfg.ae]
        args += ["--model_type", cfg.model_type or "flux"]
        if cfg.t5xxl_max_token_length:
            args += ["--t5xxl_max_token_length", str(cfg.t5xxl_max_token_length)]

    elif cfg.architecture == "sd3":
        if cfg.clip_l:       args += ["--clip_l", cfg.clip_l]
        if cfg.clip_g:       args += ["--clip_g", cfg.clip_g]
        if cfg.t5xxl:        args += ["--t5xxl", cfg.t5xxl]

    elif cfg.architecture == "anima":
        if cfg.qwen3:
            args += ["--qwen3", cfg.qwen3]
        if cfg.t5_tokenizer_path:
            args += ["--t5_tokenizer_path", cfg.t5_tokenizer_path]
        if cfg.vae_chunk_size:
            args += ["--vae_chunk_size", str(cfg.vae_chunk_size)]
        if cfg.vae_disable_cache:
            args.append("--vae_disable_cache")

    if cfg.vae and cfg.architecture not in ("flux",):
        args += ["--vae", cfg.vae]

    # ── Output ────────────────────────────────────────────────────────────────
    args += ["--output_dir", cfg.output_dir]
    args += ["--output_name", cfg.output_name]

    # ── Dataset ───────────────────────────────────────────────────────────────
    if cfg.dataset_config:
        # Multi-resolution path: pre-generated TOML carries train_data_dir + per-dataset resolution
        args += ["--dataset_config", cfg.dataset_config]
    else:
        if cfg.train_data_dir:
            args += ["--train_data_dir", cfg.train_data_dir]
        resolution = cfg.resolutions[0] if cfg.resolutions else "1024,1024"
        args += ["--resolution", resolution]

        if cfg.enable_bucket:
            args.append("--enable_bucket")
            if cfg.bucket_no_upscale:
                args.append("--bucket_no_upscale")
            args += ["--min_bucket_reso", str(cfg.min_bucket_reso)]
            args += ["--max_bucket_reso", str(cfg.max_bucket_reso)]

    if cfg.caption_extension and cfg.caption_extension != ".txt":
        args += ["--caption_extension", cfg.caption_extension]

    if cfg.shuffle_caption:
        args.append("--shuffle_caption")

    if cfg.caption_dropout_rate and cfg.caption_dropout_rate > 0:
        args += ["--caption_dropout_rate", str(cfg.caption_dropout_rate)]

    if cfg.caption_tag_dropout_rate and cfg.caption_tag_dropout_rate > 0:
        args += ["--caption_tag_dropout_rate", str(cfg.caption_tag_dropout_rate)]

    if cfg.keep_tokens and cfg.keep_tokens > 0:
        args += ["--keep_tokens", str(cfg.keep_tokens)]

    if cfg.dataset_repeats and cfg.dataset_repeats != 1:
        args += ["--dataset_repeats", str(cfg.dataset_repeats)]

    # ── Network (LoRA modes) ──────────────────────────────────────────────────
    if cfg.mode in _NETWORK_MODES and cfg.mode not in ("dreambooth", "finetune"):
        network_module = cfg.network_module
        if cfg.architecture == "anima" and network_module == "networks.lora":
            network_module = "networks.lora_anima"
        args += ["--network_module", network_module]
        args += ["--network_dim", str(cfg.network_dim)]
        args += ["--network_alpha", str(cfg.network_alpha)]

        if cfg.conv_dim:
            args += ["--network_args", f"conv_dim={cfg.conv_dim}"]
            if cfg.conv_alpha:
                args += ["--network_args", f"conv_alpha={cfg.conv_alpha}"]

        if cfg.network_dropout and cfg.network_dropout > 0:
            args += ["--network_dropout", str(cfg.network_dropout)]

        if cfg.rank_dropout and cfg.rank_dropout > 0:
            args += ["--network_args", f"rank_dropout={cfg.rank_dropout}"]

        if cfg.module_dropout and cfg.module_dropout > 0:
            args += ["--network_args", f"module_dropout={cfg.module_dropout}"]

        if cfg.network_args:
            for k, v in cfg.network_args.items():
                args += ["--network_args", f"{k}={v}"]

        if cfg.network_weights:
            args += ["--network_weights", cfg.network_weights]

        if cfg.dim_from_weights:
            args.append("--dim_from_weights")

        if cfg.network_train_unet_only:
            args.append("--network_train_unet_only")
        elif cfg.network_train_text_encoder_only:
            args.append("--network_train_text_encoder_only")

    # ── Schedule ─────────────────────────────────────────────────────────────
    args += ["--train_batch_size", str(cfg.train_batch_size)]

    if cfg.gradient_accumulation_steps > 1:
        args += ["--gradient_accumulation_steps", str(cfg.gradient_accumulation_steps)]

    if cfg.max_train_epochs:
        args += ["--max_train_epochs", str(cfg.max_train_epochs)]
    elif cfg.max_train_steps:
        args += ["--max_train_steps", str(cfg.max_train_steps)]

    args += ["--optimizer_type", cfg.optimizer_type]

    if cfg.optimizer_args:
        for part in cfg.optimizer_args.split():
            args += ["--optimizer_args", part]

    args += ["--learning_rate", str(cfg.learning_rate)]

    if cfg.unet_lr is not None and cfg.unet_lr != cfg.learning_rate:
        args += ["--unet_lr", str(cfg.unet_lr)]

    if cfg.text_encoder_lr is not None:
        args += ["--text_encoder_lr", str(cfg.text_encoder_lr)]

    args += ["--lr_scheduler", cfg.lr_scheduler]

    if cfg.lr_warmup_steps > 0:
        args += ["--lr_warmup_steps", str(cfg.lr_warmup_steps)]

    if cfg.lr_scheduler_num_cycles > 1:
        args += ["--lr_scheduler_num_cycles", str(cfg.lr_scheduler_num_cycles)]

    if cfg.max_grad_norm != 1.0:
        args += ["--max_grad_norm", str(cfg.max_grad_norm)]

    # ── Precision & memory ────────────────────────────────────────────────────
    args += ["--mixed_precision", cfg.mixed_precision]

    if cfg.full_fp16:    args.append("--full_fp16")
    if cfg.full_bf16:    args.append("--full_bf16")
    if cfg.fp8_base:     args.append("--fp8_base")
    if cfg.gradient_checkpointing: args.append("--gradient_checkpointing")
    if cfg.xformers:     args.append("--xformers")
    elif cfg.sdpa:       args.append("--sdpa")
    elif cfg.mem_eff_attn: args.append("--mem_eff_attn")
    if cfg.lowram:       args.append("--lowram")
    if cfg.highvram:     args.append("--highvram")

    if cfg.cache_latents:
        args.append("--cache_latents")
    if cfg.cache_latents_to_disk:
        args.append("--cache_latents_to_disk")

    # Caching TE outputs is incompatible with training the TE — suppress silently when TE LR is set
    training_te = cfg.text_encoder_lr is not None and not cfg.network_train_unet_only
    if cfg.cache_text_encoder_outputs and not training_te:
        args.append("--cache_text_encoder_outputs")
    if cfg.cache_text_encoder_outputs_to_disk and not training_te:
        args.append("--cache_text_encoder_outputs_to_disk")

    if cfg.vae_batch_size > 1:
        args += ["--vae_batch_size", str(cfg.vae_batch_size)]

    if cfg.blocks_to_swap and cfg.blocks_to_swap > 0:
        args += ["--blocks_to_swap", str(cfg.blocks_to_swap)]

    # ── DiT-specific ──────────────────────────────────────────────────────────
    if cfg.architecture in _DIT_ARCHS:
        args += ["--weighting_scheme", cfg.weighting_scheme]
        if cfg.weighting_scheme == "logit_normal":
            args += ["--logit_mean", str(cfg.logit_mean), "--logit_std", str(cfg.logit_std)]
        elif cfg.weighting_scheme == "mode":
            args += ["--mode_scale", str(cfg.mode_scale)]

        if cfg.architecture == "flux":
            args += ["--timestep_sampling", cfg.timestep_sampling]
            args += ["--guidance_scale", str(cfg.guidance_scale)]

    # ── Sampling ──────────────────────────────────────────────────────────────
    if cfg.sample_every_n_steps:
        args += ["--sample_every_n_steps", str(cfg.sample_every_n_steps)]
    if cfg.sample_every_n_epochs:
        args += ["--sample_every_n_epochs", str(cfg.sample_every_n_epochs)]
    if cfg.sample_at_first:
        args.append("--sample_at_first")
    if cfg.sample_prompts:
        args += ["--sample_prompts", cfg.sample_prompts]
        args += ["--sample_sampler", cfg.sample_sampler]

    # ── Saving ────────────────────────────────────────────────────────────────
    if cfg.save_every_n_epochs:
        args += ["--save_every_n_epochs", str(cfg.save_every_n_epochs)]
    if cfg.save_every_n_steps:
        args += ["--save_every_n_steps", str(cfg.save_every_n_steps)]
    if cfg.save_last_n_epochs:
        args += ["--save_last_n_epochs", str(cfg.save_last_n_epochs)]
    if cfg.save_last_n_steps:
        args += ["--save_last_n_steps", str(cfg.save_last_n_steps)]

    args += ["--save_model_as", cfg.save_model_as]

    if cfg.save_precision:
        args += ["--save_precision", cfg.save_precision]

    if cfg.save_state:
        args.append("--save_state")

    # ── Loss / noise ──────────────────────────────────────────────────────────
    if cfg.min_snr_gamma:
        args += ["--min_snr_gamma", str(cfg.min_snr_gamma)]

    if cfg.noise_offset and cfg.noise_offset > 0:
        args += ["--noise_offset", str(cfg.noise_offset)]
        if cfg.noise_offset_random_strength:
            args.append("--noise_offset_random_strength")
        if cfg.adaptive_noise_scale:
            args += ["--adaptive_noise_scale", str(cfg.adaptive_noise_scale)]

    if cfg.ip_noise_gamma and cfg.ip_noise_gamma > 0:
        args += ["--ip_noise_gamma", str(cfg.ip_noise_gamma)]

    if cfg.multires_noise_iterations and cfg.multires_noise_iterations > 0:
        args += ["--multires_noise_iterations", str(cfg.multires_noise_iterations)]
        args += ["--multires_noise_discount", str(cfg.multires_noise_discount)]

    if cfg.zero_terminal_snr:    args.append("--zero_terminal_snr")
    if cfg.debiased_estimation_loss: args.append("--debiased_estimation_loss")
    if cfg.v_parameterization:   args.append("--v_parameterization")
    if cfg.masked_loss:          args.append("--masked_loss")

    if cfg.prior_loss_weight != 1.0:
        args += ["--prior_loss_weight", str(cfg.prior_loss_weight)]

    # ── Tokens ────────────────────────────────────────────────────────────────
    if cfg.max_token_length:
        args += ["--max_token_length", str(cfg.max_token_length)]
    if cfg.clip_skip:
        args += ["--clip_skip", str(cfg.clip_skip)]

    # ── Logging ───────────────────────────────────────────────────────────────
    if cfg.log_with and cfg.log_with != "off":
        args += ["--log_with", cfg.log_with]
        log_dir = cfg.logging_dir or str(Path(cfg.output_dir) / "logs")
        args += ["--logging_dir", log_dir]
        if cfg.log_prefix:
            args += ["--log_prefix", cfg.log_prefix]
        if cfg.log_with in ("wandb", "all") and cfg.wandb_api_key:
            args += ["--wandb_api_key", cfg.wandb_api_key]

    # ── HuggingFace ───────────────────────────────────────────────────────────
    if cfg.huggingface_repo_id:
        args += ["--huggingface_repo_id", cfg.huggingface_repo_id]
        if cfg.huggingface_token:
            args += ["--huggingface_token", cfg.huggingface_token]
        if cfg.huggingface_repo_visibility:
            args += ["--huggingface_repo_visibility", cfg.huggingface_repo_visibility]
        if cfg.async_upload:
            args.append("--async_upload")

    # ── Misc ──────────────────────────────────────────────────────────────────
    if cfg.seed is not None:
        args += ["--seed", str(cfg.seed)]

    if cfg.training_comment:
        args += ["--training_comment", cfg.training_comment]

    return args


def _accelerate_launch_base(python_exe: str) -> list[str]:
    """Return the argv base for `accelerate launch`, including the 'launch' sub-command."""
    py = Path(python_exe)
    # On Windows scripts live in Scripts/, on POSIX in the same bin/ dir
    candidates = [
        py.parent / "Scripts" / "accelerate.exe",
        py.parent / "Scripts" / "accelerate",
        py.parent / "accelerate",
    ]
    for c in candidates:
        if c.exists():
            return [str(c), "launch"]
    # accelerate.commands.launch IS the launch sub-command — no extra "launch" token
    return [python_exe, "-m", "accelerate.commands.launch"]


def build_accelerate_prefix(settings: "ForgeSettings") -> list[str]:
    return [
        *_accelerate_launch_base(settings.python_executable),
        "--num_cpu_threads_per_process", str(settings.cpu_threads),
    ]


def to_cli_string(cfg: "TrainingConfig", settings: "ForgeSettings") -> str:
    """Return a human-readable CLI string for the preview panel."""
    script_args = build(cfg, settings)
    prefix = build_accelerate_prefix(settings)
    full_argv = prefix + script_args
    return subprocess.list2cmdline(full_argv)
