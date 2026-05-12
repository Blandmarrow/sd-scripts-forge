/* ─────────────────────────────────────────────────────────────
   Forge UI — forge.js
   Vanilla ES2022 SPA: router, WebSocket, form, CLI preview.
   ───────────────────────────────────────────────────────────── */
'use strict';

// ═══════════════════════════════════════════════════════════════
// API helpers
// ═══════════════════════════════════════════════════════════════
const api = {
  async get(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`POST ${path} → ${r.status}`);
    return r.json();
  },
  jobs:        () => api.get('/api/jobs'),
  getJob:      (id) => api.get(`/api/jobs/${id}`),
  startJob:    (cfg) => api.post('/api/jobs', { config: cfg }),
  cancelJob:   (id) => api.post(`/api/jobs/${id}/cancel`, {}),
  models:      () => api.get('/api/models'),
  datasets:    () => api.get('/api/datasets'),
  loras:       () => api.get('/api/loras'),
  systemStats: () => api.get('/api/system/stats'),
  settings:    () => api.get('/api/settings'),
  saveSettings:(d) => api.post('/api/settings', d),
  cliPreview:  (cfg) => api.post('/api/cli-preview', { config: cfg }),
  runUtility:  (tool, args) => api.post('/api/utilities/run', { tool, args }),
};

// ═══════════════════════════════════════════════════════════════
// Toast notifications
// ═══════════════════════════════════════════════════════════════
function toast(msg, type = 'info') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ═══════════════════════════════════════════════════════════════
// WebSocket manager
// ═══════════════════════════════════════════════════════════════
class ForgeSocket {
  constructor() {
    this._handlers = {};
    this._ws = null;
    this._connect();
  }
  _connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this._ws = new WebSocket(`${proto}://${location.host}/ws`);
    this._ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        (this._handlers[msg.type] ?? []).forEach((h) => h(msg));
      } catch {}
    };
    this._ws.onclose = () => setTimeout(() => this._connect(), 2000);
    this._ws.onerror = () => {};
  }
  on(type, fn) {
    if (!this._handlers[type]) this._handlers[type] = [];
    this._handlers[type].push(fn);
    return this;
  }
}
const sock = new ForgeSocket();

// ═══════════════════════════════════════════════════════════════
// Router
// ═══════════════════════════════════════════════════════════════
const router = {
  current: null,

  navigate(page) {
    const tpl = document.getElementById(`tpl-${page}`);
    if (!tpl) return;
    const pageEl = document.getElementById('page');
    pageEl.innerHTML = '';
    pageEl.appendChild(tpl.content.cloneNode(true));

    // Nav highlight
    document.querySelectorAll('.nav-item').forEach((el) =>
      el.classList.toggle('active', el.dataset.page === page)
    );

    // Breadcrumb
    const crumbs = document.getElementById('crumbs');
    if (crumbs) {
      const section = tpl.content.querySelector('[data-screen-label]');
      const label = section?.dataset.screenLabel ?? page;
      crumbs.innerHTML = `<a href="#" data-go="train">Forge</a><span class="sep">/</span><a class="here">${label}</a>`;
      crumbs.querySelectorAll('[data-go]').forEach((el) =>
        el.addEventListener('click', (e) => { e.preventDefault(); router.navigate(el.dataset.go); })
      );
    }

    this.current = page;
    // Wire any data-go links inside the newly injected content
    pageEl.querySelectorAll('[data-go]').forEach((el) =>
      el.addEventListener('click', (e) => { e.preventDefault(); router.navigate(el.dataset.go); })
    );

    pageControllers[page]?.onMount();
  },
};

// Sidebar nav clicks
document.getElementById('nav').addEventListener('click', (e) => {
  const item = e.target.closest('[data-page]');
  if (item) router.navigate(item.dataset.page);
});

// ═══════════════════════════════════════════════════════════════
// GPU meter (sidebar, always present)
// ═══════════════════════════════════════════════════════════════
const gpuFill = document.getElementById('gpu-fill');
const gpuPct  = document.getElementById('gpu-pct');

sock.on('system_stats', (msg) => {
  const gpu = msg.gpu;
  if (gpu?.available) {
    const pct = gpu.total_gb > 0 ? (gpu.used_gb / gpu.total_gb) : 0;
    if (gpuFill) {
      gpuFill.style.width = `${Math.min(pct * 100, 100)}%`;
      gpuFill.className = `fill${pct > 0.9 ? ' danger' : pct > 0.75 ? ' warn' : ''}`;
    }
    if (gpuPct) gpuPct.textContent = `${gpu.used_gb} / ${gpu.total_gb} GB`;
    // GPU name — update all named slots
    if (gpu.name) {
      ['gpu-name', 'jobs-gpu-name'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.textContent = gpu.name;
      });
    }
  }
  if (router.current === 'dashboard') _updateDashGpu(gpu);
});

sock.on('system_stats', (msg) => {
  if (router.current !== 'logs') return;
  const gpu = msg.gpu;
  if (gpu?.available) {
    const el = document.getElementById('logs-vram-val');
    if (el) el.innerHTML = `${gpu.used_gb}<small>/ ${gpu.total_gb} GB</small>`;
  }
});

// ═══════════════════════════════════════════════════════════════
// Progress pill (topbar, always present)
// ═══════════════════════════════════════════════════════════════
const progFill  = document.getElementById('prog-fill');
const progLabel = document.getElementById('prog-label');
const progNum   = document.getElementById('prog-num');
const progPill  = document.getElementById('progress-pill');

sock.on('job_status', (msg) => {
  if (msg.status === 'running') {
    if (progPill) progPill.style.display = '';
    const pct = msg.total_steps > 0 ? (msg.step / msg.total_steps) * 100 : 0;
    if (progFill)  progFill.style.width = `${pct}%`;
    if (progLabel) progLabel.textContent = `${fmtStep(msg.step, msg.total_steps)} · loss ${msg.loss?.toFixed(4) ?? '—'}`;
    if (progNum)   progNum.textContent = fmtStep(msg.step, msg.total_steps);
  } else {
    if (progPill && msg.status !== 'running') progPill.style.display = 'none';
  }
});

// Hide pill on load
if (progPill) progPill.style.display = 'none';

// Global stop button
document.querySelector('.icon-btn.danger')?.addEventListener('click', async () => {
  try {
    const { jobs, active_job_id } = await api.jobs();
    if (active_job_id) {
      await api.cancelJob(active_job_id);
      toast('Training stopped', 'success');
    }
  } catch (e) { toast('Could not stop job', 'error'); }
});

// ═══════════════════════════════════════════════════════════════
// Utility helpers
// ═══════════════════════════════════════════════════════════════
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function initButtonGroup(container, getValue, onChange) {
  container?.querySelectorAll('.btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.btn').forEach((b) => b.classList.remove('primary'));
      btn.classList.add('primary');
      onChange(btn.textContent.trim());
    });
  });
}

function initPillGroup(container, onChange) {
  container?.querySelectorAll('.arch-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      container.querySelectorAll('.arch-pill').forEach((p) => p.classList.remove('sel'));
      pill.classList.add('sel');
      onChange(pill.textContent.trim());
    });
  });
}

// ═══════════════════════════════════════════════════════════════
// Shared state
// ═══════════════════════════════════════════════════════════════
let _pendingEdit = null; // TrainingConfig dict to restore on next mountTrain()

// ═══════════════════════════════════════════════════════════════
// Form state & CLI preview (Train page)
// ═══════════════════════════════════════════════════════════════

// Mapping from arch pill label → config key
const ARCH_MAP = {
  'SD 1.5': 'sd15', 'SDXL': 'sdxl', 'SD 3.5': 'sd3',
  'FLUX.1': 'flux', 'LUMINA': 'lumina',
  'HunyuanImage 2.1': 'hunyuan', 'Anima preview': 'anima',
};
const OPTIMIZER_MAP = { 'AdamW':'AdamW','AdamW8bit':'AdamW8bit','Lion':'Lion','Lion8bit':'Lion8bit','DAdaptation':'DAdaptation','Prodigy':'Prodigy','SGDNesterov':'SGDNesterov','AdaFactor':'AdaFactor' };
const SCHEDULER_MAP = { 'constant':'constant','constant_with_warmup':'constant_with_warmup','linear':'linear','cosine':'cosine','cosine_with_restarts':'cosine_with_restarts','polynomial':'polynomial','adafactor':'adafactor' };

function collectFormState() {
  const form = document.getElementById('train-form');
  if (!form) return {};

  const v = (sel, def = '') => form.querySelector(sel)?.value ?? def;
  const checked = (sel) => !!form.querySelector(sel)?.checked;
  const activeBtn = (groupSel) => {
    const b = form.querySelector(`${groupSel} .btn.primary`);
    return b?.textContent?.trim() ?? '';
  };
  const activePill = (groupSel) => {
    const b = form.querySelector(`${groupSel} .arch-pill.sel`);
    return b?.textContent?.trim() ?? '';
  };
  const activeRadio = () => {
    const r = form.querySelector('.mode-card:has(input:checked) b');
    if (r) return r.textContent.trim();
    const sel = form.querySelector('.mode-card.sel b');
    return sel?.textContent?.trim() ?? 'LoRA';
  };

  const archLabel = activePill('.arch-strip') || 'SDXL';
  const arch = ARCH_MAP[archLabel] ?? 'sdxl';

  const modeLabel = activeRadio();
  const modeMap = { 'LoRA':'lora','Fine-tune':'finetune','DreamBooth':'dreambooth','Textual Inversion':'ti','ControlNet-LLLite':'controlnet','Inpainting':'inpainting' };
  const mode = modeMap[modeLabel] ?? 'lora';

  // Inputs by placeholder/label heuristic — use data-field when present, else positional
  const inputs = [...form.querySelectorAll('.input:not(textarea)')];
  const getByLabel = (labelText) => {
    for (const el of form.querySelectorAll('.kv')) {
      const lbl = el.querySelector('span')?.textContent?.toUpperCase() ?? '';
      if (lbl.includes(labelText.toUpperCase())) return el.querySelector('input')?.value ?? '';
    }
    return '';
  };

  const getCheckbox = (spanText) => {
    for (const el of form.querySelectorAll('label')) {
      for (const s of el.querySelectorAll('span')) {
        if (s.textContent.trim() === spanText) {
          const cb = el.querySelector('input[type=checkbox]');
          if (cb) return cb.checked;
        }
      }
    }
    return false;
  };

  const outputNameEl = document.getElementById('output-name-input') ?? inputs[0];
  const outputName = outputNameEl?.value?.trim() || 'my_lora';
  const vaeOverride = form.querySelector('[name="use_vae_override"]')?.checked;
  const vaeVal = document.getElementById('vae-input')?.value || undefined;

  // Custom resolution: use custom-res-w/h inputs if visible
  const customResDiv = document.getElementById('custom-res-inputs');
  const useCustomRes = customResDiv && customResDiv.style.display !== 'none';
  const customW = document.getElementById('custom-res-w')?.value?.trim();
  const customH = document.getElementById('custom-res-h')?.value?.trim();
  const resValue = useCustomRes && customW && customH
    ? `${customW},${customH}`
    : (activeBtn('.form-row:has(.bucket-strip)').match(/^\d+$/)
        ? `${activeBtn('.form-row:has(.bucket-strip)')},${ activeBtn('.form-row:has(.bucket-strip)')}`
        : '1024,1024');

  return {
    output_name: outputName,
    output_dir: `output/${outputName}`,
    architecture: arch,
    mode,
    checkpoint: form.querySelector('#ckpt-select')?.value ?? '',
    vae: vaeOverride ? vaeVal : undefined,
    train_data_dir: document.getElementById('ds-select')?.value ?? '',
    resolution: resValue,
    enable_bucket: checked('[name="enable_bucket"], input[type=checkbox][class=checkbox]:nth-of-type(1)'),
    bucket_no_upscale: true,
    shuffle_caption: checked('[name="shuffle_caption"]'),
    network_module: (() => {
      if (arch === 'anima') return 'networks.lora_anima';
      const b = form.querySelector('.form-row:has([data-tab]) .btn.primary, [data-pane="network"] .btn.primary');
      const t = b?.textContent?.trim() ?? 'networks.lora';
      const modMap = { 'networks.lora':'networks.lora','networks.lora_fa':'networks.lora_fa','networks.dylora':'networks.dylora','lycoris.kohya · LoHa':'lycoris.kohya','lycoris.kohya · LoKr':'lycoris.kohya','lycoris.kohya · DyLoRA':'lycoris.kohya' };
      return modMap[t] ?? 'networks.lora';
    })(),
    network_dim: parseInt(getByLabel('network_dim') || '32') || 32,
    network_alpha: parseFloat(getByLabel('network_alpha') || '16') || 16,
    optimizer_type: activeBtn('[data-pane="schedule"] .form-row:first-child .row-flex') || 'AdamW8bit',
    learning_rate: parseFloat(getByLabel('learning_rate') || '1e-4') || 1e-4,
    unet_lr: parseFloat(getByLabel('unet_lr')) || undefined,
    text_encoder_lr: parseFloat(getByLabel('text_encoder_lr')) || undefined,
    lr_scheduler: activeBtn('[data-pane="schedule"] .form-row:nth-child(3) .row-flex') || 'cosine_with_restarts',
    lr_warmup_steps: parseInt(getByLabel('lr_warmup_steps') || '0') || 0,
    lr_scheduler_num_cycles: parseInt(getByLabel('num_cycles') || '1') || 1,
    max_train_epochs: parseInt(getByLabel('max_train_epochs') || '10') || undefined,
    max_train_steps: parseInt(getByLabel('max_train_steps') || '') || undefined,
    train_batch_size: parseInt(getByLabel('train_batch_size') || '1') || 1,
    gradient_accumulation_steps: parseInt(getByLabel('grad_accum_steps') || '1') || 1,
    mixed_precision: activeBtn('[data-pane="memory"] .form-row:first-child .row-flex') || 'bf16',
    full_fp16: getCheckbox('full_fp16'),
    full_bf16: getCheckbox('full_bf16'),
    fp8_base: getCheckbox('fp8_base'),
    gradient_checkpointing: getCheckbox('gradient_checkpointing'),
    xformers: getCheckbox('xformers'),
    sdpa: getCheckbox('sdpa'),
    mem_eff_attn: getCheckbox('mem_eff_attn'),
    lowram: getCheckbox('lowram'),
    highvram: getCheckbox('highvram'),
    cache_latents: getCheckbox('cache_latents'),
    cache_latents_to_disk: getCheckbox('cache_latents_to_disk'),
    cache_text_encoder_outputs: getCheckbox('cache_text_encoder_outputs'),
    cache_text_encoder_outputs_to_disk: getCheckbox('cache_text_encoder_outputs_to_disk'),
    vae_batch_size: parseInt(getByLabel('vae_batch_size') || '1') || 1,
    save_every_n_steps: parseInt(getByLabel('save_every_n_steps') || '500') || undefined,
    save_every_n_epochs: parseInt(getByLabel('save_every_n_epochs') || '') || undefined,
    save_model_as: 'safetensors',
    save_precision: 'fp16',
    ...(() => {
      const sampleRaw = (document.getElementById('sample-prompts-textarea')?.value || '').trim();
      if (!sampleRaw) return {};
      const sw = document.getElementById('sample-width')?.value?.trim() || '';
      const sh = document.getElementById('sample-height')?.value?.trim() || '';
      const ss = document.getElementById('sample-steps')?.value?.trim() || '';
      const sl = document.getElementById('sample-guidance')?.value?.trim() || '';
      const sn = document.getElementById('sample-negative')?.value?.trim() || '';
      const suffix = [sw && `--w ${sw}`, sh && `--h ${sh}`, ss && `--s ${ss}`, sl && `--l ${sl}`, sn && `--n ${sn}`].filter(Boolean).join(' ');
      return {
        sample_every_n_steps: parseInt(getByLabel('every_n_steps') || '') || undefined,
        sample_every_n_epochs: parseInt(getByLabel('every_n_epochs') || '') || undefined,
        sample_sampler: activeBtn('[data-pane="sampling"] .form-row:nth-child(2) .row-flex') || 'euler_a',
        sample_prompts_text: sampleRaw.split('\n').map(l => l.trim()).filter(Boolean).map(l => suffix ? `${l} ${suffix}` : l).join('\n'),
        sample_prompts_raw: sampleRaw,
        sample_width: sw || undefined,
        sample_height: sh || undefined,
        sample_steps: ss || undefined,
        sample_guidance: sl || undefined,
        sample_negative: sn || undefined,
      };
    })(),
    min_snr_gamma: parseFloat(getByLabel('min_snr_gamma') || '') || undefined,
    noise_offset: parseFloat(getByLabel('noise_offset') || '0') || undefined,
    seed: parseInt(getByLabel('seed') || '') || undefined,
    log_with: activeBtn('[data-pane="advanced"] .form-row:nth-child(2) .row-flex') || undefined,
    // Anima-specific
    qwen3: arch === 'anima' ? (document.getElementById('qwen3-input')?.value || undefined) : undefined,
    t5_tokenizer_path: arch === 'anima' ? (document.getElementById('t5-tokenizer-input')?.value || undefined) : undefined,
  };
}

function renderCli(cliStr) {
  const pre = document.getElementById('cli');
  if (!pre) return;
  // Syntax-highlight the CLI string
  const escaped = cliStr
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Colour scheme: command words, flags, values
  const highlighted = escaped
    .replace(/^(accelerate launch[^\\]*\\?\n?\s*\S+\.py)/m, '<span class="cli-cmd">$1</span>')
    .replace(/(--[\w-]+)/g, '<span class="cli-flag">$1</span>')
    .replace(/=("(?:[^"]|\\.)+" |[\w./\\:@%-]+)/g, '=<span class="cli-val">$1</span>');
  pre.innerHTML = highlighted;
}

const refreshCliPreview = debounce(async () => {
  try {
    const cfg = collectFormState();
    const result = await api.cliPreview(cfg);
    renderCli(result.cli);
  } catch (e) {
    console.warn('CLI preview failed:', e.message);
  }
}, 400);

// ═══════════════════════════════════════════════════════════════
// Tab controller (Train page)
// ═══════════════════════════════════════════════════════════════
function initTabs(container) {
  container?.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      container.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const pane = tab.dataset.tab;
      document.querySelectorAll('.tab-pane').forEach((p) =>
        p.classList.toggle('active', p.dataset.pane === pane)
      );
      refreshCliPreview();
    });
  });
}

// ═══════════════════════════════════════════════════════════════
// Loss chart renderer
// ═══════════════════════════════════════════════════════════════
function renderLossChart(svgId, fillId, lineId, points) {
  if (!points.length) return;
  const line = document.getElementById(lineId);
  const fill = document.getElementById(fillId);
  if (!line || !fill) return;
  const svg = line.closest('svg');
  const vw = parseFloat(svg.getAttribute('viewBox').split(' ')[2]) || 600;
  const vh = parseFloat(svg.getAttribute('viewBox').split(' ')[3]) || 140;
  const pad = vh * 0.1;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const xs = points.map((_, i) => (i / Math.max(points.length - 1, 1)) * vw);
  const ys = points.map((v) => vh - pad - ((v - min) / range) * (vh - pad * 2));
  const d = xs.map((x, i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${ys[i].toFixed(1)}`).join('');
  line.setAttribute('d', d);
  fill.setAttribute('d', `${d}L${vw},${vh}L0,${vh}Z`);
}

// ═══════════════════════════════════════════════════════════════
// Nav badge counts
// ═══════════════════════════════════════════════════════════════
async function refreshNavCounts() {
  try {
    const [{ jobs, active_job_id }, { models }, { loras }] = await Promise.all([
      api.jobs(), api.models(), api.loras(),
    ]);
    const jobCount = jobs.filter((j) => j.status === 'queued').length + (active_job_id ? 1 : 0);
    const jobBadge = document.getElementById('nav-badge-jobs');
    const modelBadge = document.getElementById('nav-badge-models');
    const loraBadge = document.getElementById('nav-badge-loras');
    if (jobBadge) jobBadge.textContent = jobCount || '';
    if (modelBadge) modelBadge.textContent = models.length || '';
    if (loraBadge) loraBadge.textContent = loras.length || '';
  } catch {}
}

function fmtDuration(secs) {
  secs = Math.round(secs);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

function fmtStep(step, totalSteps) {
  step = step || 0;
  totalSteps = totalSteps || 0;
  return totalSteps ? `${step.toLocaleString()} / ${totalSteps.toLocaleString()}` : `${step.toLocaleString()}`;
}

// ═══════════════════════════════════════════════════════════════
// Page: Dashboard
// ═══════════════════════════════════════════════════════════════
async function mountDashboard() {
  try {
    const { jobs, active_job_id } = await api.jobs();
    const activeJob = active_job_id ? jobs.find((j) => j.id === active_job_id) : null;
    const queued = jobs.filter((j) => j.status === 'queued');
    const finished = jobs.filter((j) => ['completed','failed','cancelled','interrupted'].includes(j.status));

    // Summary line
    const summary = document.getElementById('dash-summary');
    if (summary) {
      const parts = [];
      if (activeJob) parts.push(`1 job training`);
      if (queued.length) parts.push(`${queued.length} queued`);
      if (finished.length) parts.push(`${finished.length} completed`);
      summary.textContent = parts.length ? parts.join(' · ') : 'No active jobs.';
    }

    // Stat card: active job
    const pct = activeJob && activeJob.total_steps > 0
      ? Math.round(activeJob.step / activeJob.total_steps * 100) : 0;
    const elPct = document.getElementById('dash-active-pct');
    const elSteps = document.getElementById('dash-active-steps');
    if (elPct) elPct.innerHTML = activeJob ? `${pct}<small>%</small>` : '—';
    if (elSteps) elSteps.textContent = activeJob
      ? fmtStep(activeJob.step, activeJob.total_steps, activeJob.max_train_epochs)
      : 'no active job';

    // Stat card: queue
    const elQ = document.getElementById('dash-queue-count');
    const elQW = document.getElementById('dash-queue-wait');
    if (elQ) elQ.innerHTML = `${queued.length}<small>jobs</small>`;
    if (elQW) elQW.textContent = queued.length ? `${queued.length} waiting` : 'queue empty';

    // Active run panel
    _renderDashActiveRun(activeJob);

    // Recent runs table
    const tbody = document.getElementById('dash-recent-runs');
    if (tbody) {
      const rows = finished.slice(0, 6);
      tbody.innerHTML = rows.length
        ? rows.map((j) => `
          <tr>
            <td class="mono" style="max-width:120px;overflow:hidden;text-overflow:ellipsis">${esc(j.output_name)}</td>
            <td class="mono">${esc(j.mode)}</td>
            <td class="mono">${j.loss?.toFixed(4) ?? '—'}</td>
            <td><span class="badge dot ${statusColor(j.status)}">${esc(j.status)}</span></td>
          </tr>`).join('')
        : `<tr><td colspan="4" class="empty">No completed runs yet</td></tr>`;
    }
  } catch (e) { console.error('mountDashboard:', e); }

  // One-shot system stats for disk/VRAM
  try {
    const { gpu, disk } = await api.systemStats();
    _updateDashGpu(gpu);
    _updateDashDisk(disk);
  } catch {}
}

function _updateDashGpu(gpu) {
  if (!gpu?.available) return;
  const free = (gpu.total_gb - gpu.used_gb).toFixed(1);
  const elV = document.getElementById('dash-vram-val');
  const elD = document.getElementById('dash-vram-delta');
  if (elV) elV.innerHTML = `${free}<small>GB free</small>`;
  if (elD) elD.textContent = `${gpu.used_gb} / ${gpu.total_gb} GB · ${gpu.utilization}%`;
  // In-panel GPU stat
  const elRunGpu = document.getElementById('dash-run-gpu');
  if (elRunGpu) elRunGpu.textContent = `${gpu.used_gb} / ${gpu.total_gb} GB`;
}

function _updateDashDisk(disk) {
  if (!disk) return;
  const elV = document.getElementById('dash-disk-val');
  const elD = document.getElementById('dash-disk-delta');
  if (elV) elV.innerHTML = `${disk.free_gb}<small>GB free</small>`;
  if (elD) elD.textContent = `${disk.percent}% used`;
}

function _renderDashActiveRun(job) {
  const empty = document.getElementById('dash-run-empty');
  const content = document.getElementById('dash-run-content');
  const badge = document.getElementById('dash-run-badge');
  const pid = document.getElementById('dash-run-pid');

  if (!job) {
    if (empty) empty.style.display = '';
    if (content) content.style.display = 'none';
    if (badge) badge.style.display = 'none';
    if (pid) pid.textContent = '';
    return;
  }

  if (empty) empty.style.display = 'none';
  if (content) content.style.display = '';
  if (badge) badge.style.display = '';
  if (pid) pid.textContent = `PID ${job.pid ?? '—'} · ${fmtStep(job.step, job.total_steps, job.max_train_epochs)}`;

  const pct = job.total_steps > 0 ? (job.step / job.total_steps * 100).toFixed(1) : 0;
  const el = (id) => document.getElementById(id);
  if (el('dash-run-name')) el('dash-run-name').textContent = job.output_name;
  if (el('dash-run-meta')) el('dash-run-meta').textContent =
    `${job.architecture?.toUpperCase()} · ${job.mode}`;
  if (el('dash-run-loss')) el('dash-run-loss').textContent = job.loss?.toFixed(4) ?? '—';
  if (el('dash-run-bar'))  el('dash-run-bar').style.width = `${pct}%`;
  if (el('dash-run-step')) el('dash-run-step').textContent =
    fmtStep(job.step, job.total_steps, job.max_train_epochs);
  if (el('dash-run-thru')) el('dash-run-thru').textContent =
    `${job.throughput?.toFixed(2) ?? '—'} it/s`;

  // ETA
  if (el('dash-run-eta') && job.throughput && job.total_steps > job.step) {
    const etaSec = Math.round((job.total_steps - job.step) / job.throughput);
    const h = Math.floor(etaSec / 3600);
    const m = Math.floor((etaSec % 3600) / 60);
    const s = etaSec % 60;
    el('dash-run-eta').textContent = h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
  }

  // Draw loss chart from history
  if (job.loss_history?.length) {
    renderLossChart('loss-chart', 'loss-fill', 'loss-line', job.loss_history);
  }
}

sock.on('queue_update', () => {
  refreshNavCounts();
  if (router.current === 'dashboard') mountDashboard();
});

// ═══════════════════════════════════════════════════════════════
// Summary panel updater (Train page right column)
// ═══════════════════════════════════════════════════════════════
function updateSummary() {
  const s = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val ?? '—'; };
  try {
    const cfg = collectFormState();
    if (!cfg.architecture) return;
    const archLabel = Object.entries(ARCH_MAP).find(([, v]) => v === cfg.architecture)?.[0] ?? cfg.architecture;
    const modeLabels = { lora:'LoRA', finetune:'Fine-tune', dreambooth:'DreamBooth', ti:'Textual Inversion', controlnet:'ControlNet-LLLite', inpainting:'Inpainting' };
    s('sum-mode', `${archLabel} · ${modeLabels[cfg.mode] ?? cfg.mode}`);
    s('sum-network', `rank ${cfg.network_dim} · α ${cfg.network_alpha}`);
    s('sum-optimizer', cfg.optimizer_type);
    const lrParts = [];
    if (cfg.unet_lr) lrParts.push(`unet ${cfg.unet_lr}`);
    if (cfg.text_encoder_lr) lrParts.push(`TE ${cfg.text_encoder_lr}`);
    if (!lrParts.length) lrParts.push(String(cfg.learning_rate));
    s('sum-lr', lrParts.join(' · '));
    const warmup = cfg.lr_warmup_steps ? ` · warmup ${cfg.lr_warmup_steps}` : '';
    s('sum-schedule', `${cfg.lr_scheduler}${warmup}`);
    const effBatch = cfg.train_batch_size * (cfg.gradient_accumulation_steps || 1);
    s('sum-batch', `${cfg.train_batch_size} × grad_acc ${cfg.gradient_accumulation_steps} = ${effBatch}`);
    const stepsStr = cfg.max_train_steps
      ? `${cfg.max_train_steps} steps`
      : cfg.max_train_epochs
        ? `${cfg.max_train_epochs} epochs`
        : '—';
    s('sum-steps', stepsStr);
    const precParts = [cfg.mixed_precision];
    if (cfg.fp8_base) precParts.push('fp8 base');
    s('sum-precision', precParts.join(' + '));
    const memParts = [];
    if (cfg.gradient_checkpointing) memParts.push('grad_ckpt');
    if (cfg.xformers) memParts.push('xformers');
    if (cfg.sdpa) memParts.push('sdpa');
    s('sum-memory', memParts.join(' · ') || '—');
    s('sum-output', `${cfg.output_name || 'my_lora'}.safetensors`);
  } catch {}
}

// ═══════════════════════════════════════════════════════════════
// Page: Train
// ═══════════════════════════════════════════════════════════════
async function mountTrain() {
  const form = document.getElementById('train-form');
  if (!form) return;

  // Tabs
  initTabs(document.getElementById('train-tabs'));

  // Architecture pills
  const archStrip = form.querySelector('.arch-strip');
  const updateArchExtras = () => {
    const archLabel = archStrip?.querySelector('.arch-pill.sel')?.textContent?.trim() ?? '';
    const arch = ARCH_MAP[archLabel] ?? 'sdxl';
    const animaExtras = document.getElementById('anima-extras');
    if (animaExtras) animaExtras.style.display = arch === 'anima' ? 'block' : 'none';
  };
  archStrip?.querySelectorAll('.arch-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      archStrip.querySelectorAll('.arch-pill').forEach((p) => p.classList.remove('sel'));
      pill.classList.add('sel');
      updateArchExtras();
      updateSummary();
      refreshCliPreview();
    });
  });
  updateArchExtras();

  // Mode cards
  form.querySelectorAll('.mode-card').forEach((card) => {
    card.addEventListener('click', () => {
      form.querySelectorAll('.mode-card').forEach((c) => c.classList.remove('sel'));
      card.classList.add('sel');
      updateSummary();
      refreshCliPreview();
    });
  });

  // All btn groups (optimizer, scheduler, etc.)
  form.querySelectorAll('.row-flex').forEach((group) => {
    group.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn');
      if (!btn || !group.contains(btn)) return;
      const siblings = [...group.querySelectorAll('.btn:not(.ghost):not(.danger)')];
      if (siblings.includes(btn) && siblings.length > 1 && !btn.dataset.go) {
        siblings.forEach((b) => b.classList.remove('primary'));
        btn.classList.add('primary');
        refreshCliPreview();
        updateSummary();
      }
    });
  });

  // Any input/checkbox/select change
  form.addEventListener('change', refreshCliPreview);
  form.addEventListener('input', refreshCliPreview);

  // ── Populate model dropdown from API ──────────────────────────
  try {
    const { models } = await api.models();
    const select = document.getElementById('ckpt-select');
    if (select) {
      if (models.length) {
        const byArch = {};
        for (const m of models) {
          const a = m.arch ?? 'other';
          (byArch[a] = byArch[a] ?? []).push(m);
        }
        select.innerHTML = Object.entries(byArch).map(([arch, items]) =>
          `<optgroup label="Local · ${arch.toUpperCase()}">${
            items.map((m) => `<option value="${esc(m.path)}">${esc(m.name)} · ${m.size_human}</option>`).join('')
          }</optgroup>`
        ).join('');
        // Show path of currently selected model
        select.addEventListener('change', () => {
          const info = document.getElementById('ckpt-info');
          if (info) info.textContent = select.value || '';
          refreshCliPreview();
        });
      } else {
        select.innerHTML = '<option value="">No models found — check models_dir in Settings</option>';
      }
    }
  } catch {}

  // ── Populate dataset dropdown from API ────────────────────────
  try {
    const { datasets, directory } = await api.datasets();
    const sel = document.getElementById('ds-select');
    if (sel) {
      if (datasets.length) {
        datasets.forEach((ds) => {
          const opt = document.createElement('option');
          opt.value = ds.path;
          opt.textContent = `${ds.name}  (${ds.image_count} imgs)`;
          sel.appendChild(opt);
        });
        sel.addEventListener('change', () => {
          const ds = datasets.find((d) => d.path === sel.value);
          const meta = document.getElementById('ds-meta');
          if (meta) meta.textContent = ds
            ? `${ds.image_count} images · ${ds.captioned ? 'captioned' : 'no captions'} · ${ds.path}`
            : '';
          refreshCliPreview();
        });
      } else {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = `No datasets found — add folders to ${directory}`;
        sel.appendChild(opt);
      }
    }
  } catch {}

  // ── VAE override checkbox ─────────────────────────────────────
  const vaeChk = form.querySelector('[name="use_vae_override"]');
  const vaeInput = document.getElementById('vae-input');
  if (vaeChk && vaeInput) {
    vaeInput.disabled = !vaeChk.checked;
    vaeChk.addEventListener('change', () => {
      vaeInput.disabled = !vaeChk.checked;
      refreshCliPreview();
    });
  }

  // ── Validate button ───────────────────────────────────────────
  const page = document.getElementById('page');
  page?.querySelectorAll('.btn').forEach((btn) => {
    if (btn.textContent.trim() === 'Validate') {
      btn.addEventListener('click', () => {
        const cfg = collectFormState();
        const errors = [];
        if (!cfg.checkpoint) errors.push('No base model selected');
        if (!cfg.train_data_dir) errors.push('No dataset selected');
        if (!cfg.output_name) errors.push('Output name is empty');
        if (errors.length) {
          errors.forEach((e) => toast(e, 'warn'));
        } else {
          toast('Config looks valid', 'success');
        }
      });
    }
  });

  // ── Load Preset button ────────────────────────────────────────
  page?.querySelectorAll('.btn').forEach((btn) => {
    if (btn.textContent.trim().includes('Load preset')) {
      btn.addEventListener('click', () => _showPresetPopover(btn));
    }
  });

  // ── Copy CLI button ───────────────────────────────────────────
  document.getElementById('copy-cli')?.addEventListener('click', () => {
    const pre = document.getElementById('cli');
    if (pre) {
      navigator.clipboard.writeText(pre.textContent).then(() => toast('Copied to clipboard', 'success'));
    }
  });

  // ── Start training button ─────────────────────────────────────
  page?.querySelectorAll('.btn').forEach((btn) => {
    if (btn.textContent.trim().includes('Start training')) {
      btn.addEventListener('click', startTraining);
    }
  });

  // ── Output path preview ───────────────────────────────────────
  let _outputDir = 'output';
  api.settings().then((s) => {
    _outputDir = s.output_dir ?? 'output';
    const nameEl = document.getElementById('output-name-input');
    const preview = document.getElementById('output-path-preview');
    if (preview && nameEl) preview.textContent = `→ ${_outputDir}/${nameEl.value || 'my_lora'}/`;
  }).catch(() => {});

  const nameInputEl = document.getElementById('output-name-input');
  nameInputEl?.addEventListener('input', () => {
    const preview = document.getElementById('output-path-preview');
    if (preview) preview.textContent = `→ ${_outputDir}/${nameInputEl.value || 'my_lora'}/`;
    updateSummary();
    refreshCliPreview();
  });

  // ── Custom resolution ─────────────────────────────────────────
  document.getElementById('custom-res-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const inp = document.getElementById('custom-res-inputs');
    if (!inp) return;
    const visible = inp.style.display !== 'none';
    inp.style.display = visible ? 'none' : '';
    // Deselect preset buttons when custom is shown
    if (!visible) {
      document.querySelectorAll('#resolution-btns .btn:not(#custom-res-btn)').forEach((b) => b.classList.remove('primary'));
      document.getElementById('custom-res-btn').classList.add('primary');
    }
    refreshCliPreview();
  });
  document.getElementById('custom-res-w')?.addEventListener('input', refreshCliPreview);
  document.getElementById('custom-res-h')?.addEventListener('input', refreshCliPreview);

  // ── Summary panel ─────────────────────────────────────────────
  updateSummary();
  // Hook summary into existing refresh chain
  const _origRefreshCli = refreshCliPreview;
  form.addEventListener('change', updateSummary);
  form.addEventListener('input', updateSummary);

  // ── Apply pending edit (from Jobs "Edit" button) ──────────────
  if (_pendingEdit) {
    _applyConfigToForm(_pendingEdit);
    _pendingEdit = null;
  }

  refreshCliPreview();
}

// ── Preset helpers ────────────────────────────────────────────
function _showPresetPopover(anchorBtn) {
  // Remove any existing popover
  document.getElementById('preset-popover')?.remove();

  const presets = JSON.parse(localStorage.getItem('forge_presets') || '{}');
  const names = Object.keys(presets);

  const pop = document.createElement('div');
  pop.id = 'preset-popover';
  pop.style.cssText = 'position:absolute;z-index:200;background:var(--surface-1);border:1px solid var(--line);border-radius:var(--r);padding:10px;min-width:220px;box-shadow:0 4px 16px rgba(0,0,0,.3)';

  const saveRow = document.createElement('div');
  saveRow.style.cssText = 'display:flex;gap:6px;margin-bottom:8px';
  const saveInput = document.createElement('input');
  saveInput.className = 'input mono';
  saveInput.placeholder = 'Preset name…';
  saveInput.style.flex = '1';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn sm';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', () => {
    const name = saveInput.value.trim();
    if (!name) return;
    const p = JSON.parse(localStorage.getItem('forge_presets') || '{}');
    p[name] = collectFormState();
    localStorage.setItem('forge_presets', JSON.stringify(p));
    toast(`Preset "${name}" saved`, 'success');
    pop.remove();
  });
  saveRow.appendChild(saveInput);
  saveRow.appendChild(saveBtn);
  pop.appendChild(saveRow);

  if (names.length) {
    const divider = document.createElement('div');
    divider.className = 'divider';
    pop.appendChild(divider);
    names.forEach((name) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:3px 0';
      const loadBtn = document.createElement('button');
      loadBtn.className = 'btn ghost sm';
      loadBtn.textContent = name;
      loadBtn.style.flex = '1';
      loadBtn.addEventListener('click', () => {
        _pendingEdit = presets[name];
        mountTrain();
        pop.remove();
        toast(`Preset "${name}" loaded`, 'success');
      });
      const delBtn = document.createElement('button');
      delBtn.className = 'btn ghost sm danger';
      delBtn.textContent = '×';
      delBtn.addEventListener('click', () => {
        const p = JSON.parse(localStorage.getItem('forge_presets') || '{}');
        delete p[name];
        localStorage.setItem('forge_presets', JSON.stringify(p));
        row.remove();
      });
      row.appendChild(loadBtn);
      row.appendChild(delBtn);
      pop.appendChild(row);
    });
  } else {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.style.fontSize = '12px';
    empty.textContent = 'No saved presets yet';
    pop.appendChild(empty);
  }

  // Position near the button
  const rect = anchorBtn.getBoundingClientRect();
  pop.style.top = `${rect.bottom + window.scrollY + 4}px`;
  pop.style.left = `${rect.left + window.scrollX}px`;
  document.body.appendChild(pop);

  // Click-outside closes
  const closeOnBlur = (e) => {
    if (!pop.contains(e.target) && e.target !== anchorBtn) {
      pop.remove();
      document.removeEventListener('click', closeOnBlur, true);
    }
  };
  setTimeout(() => document.addEventListener('click', closeOnBlur, true), 10);
}

// ── Apply a saved config dict to the train form ───────────────
function _applyConfigToForm(cfg) {
  const form = document.getElementById('train-form');
  if (!form) return;

  const setActiveBtn = (groupSel, value) => {
    if (!value) return;
    const row = form.querySelector(groupSel);
    if (!row) return;
    row.querySelectorAll('.btn').forEach((b) => {
      b.classList.toggle('primary', b.textContent.trim() === value);
    });
  };

  const setByLabel = (labelText, value) => {
    if (value === undefined || value === null) return;
    for (const el of form.querySelectorAll('.kv')) {
      const lbl = el.querySelector('span')?.textContent?.toUpperCase() ?? '';
      if (lbl.includes(labelText.toUpperCase())) {
        const inp = el.querySelector('input');
        if (inp) { inp.value = value; return; }
      }
    }
  };

  const setCheckbox = (spanText, checked) => {
    if (checked === undefined) return;
    for (const el of form.querySelectorAll('label')) {
      for (const s of el.querySelectorAll('span')) {
        if (s.textContent.trim() === spanText) {
          const cb = el.querySelector('input[type=checkbox]');
          if (cb) { cb.checked = !!checked; return; }
        }
      }
    }
  };

  // ── Basics ────────────────────────────────────────────────────
  const nameInput = document.getElementById('output-name-input') ?? form.querySelector('.input.mono');
  if (nameInput) nameInput.value = cfg.output_name ?? '';

  const archLabel = Object.entries(ARCH_MAP).find(([, v]) => v === cfg.architecture)?.[0];
  if (archLabel) {
    form.querySelectorAll('.arch-pill').forEach((p) => {
      p.classList.toggle('sel', p.textContent.trim() === archLabel);
    });
  }

  const modeLabels = { lora:'LoRA', finetune:'Fine-tune', dreambooth:'DreamBooth', ti:'Textual Inversion', controlnet:'ControlNet-LLLite', inpainting:'Inpainting' };
  const modeLabel = modeLabels[cfg.mode];
  if (modeLabel) {
    form.querySelectorAll('.mode-card').forEach((c) => {
      c.classList.toggle('sel', c.querySelector('b')?.textContent?.trim() === modeLabel);
    });
  }

  const ckpt = document.getElementById('ckpt-select');
  if (ckpt && cfg.checkpoint) ckpt.value = cfg.checkpoint;

  const ds = document.getElementById('ds-select');
  if (ds && cfg.train_data_dir) ds.value = cfg.train_data_dir;

  // VAE override — dispatch change so the mountTrain listener updates disabled state
  const vaeChk = document.querySelector('[name="use_vae_override"]');
  const vaeInp = document.getElementById('vae-input');
  if (vaeChk) {
    vaeChk.checked = !!cfg.vae;
    vaeChk.dispatchEvent(new Event('change', { bubbles: false }));
    if (vaeInp) vaeInp.value = cfg.vae || '';
  }

  // Resolution buttons — try preset first, fall back to custom inputs
  if (cfg.resolution) {
    const [w, h] = cfg.resolution.split(',');
    const presetMatch = ['512', '768', '1024'].includes(w) && w === h;
    if (presetMatch) {
      setActiveBtn('#resolution-btns', w);
      const customDiv = document.getElementById('custom-res-inputs');
      if (customDiv) customDiv.style.display = 'none';
    } else {
      // Custom resolution
      ['512', '768', '1024'].forEach((v) => {
        const btns = form.querySelectorAll('#resolution-btns .btn:not(#custom-res-btn)');
        btns.forEach((b) => b.classList.remove('primary'));
      });
      const customBtn = document.getElementById('custom-res-btn');
      if (customBtn) customBtn.classList.add('primary');
      const customDiv = document.getElementById('custom-res-inputs');
      if (customDiv) customDiv.style.display = '';
      const wEl = document.getElementById('custom-res-w');
      const hEl = document.getElementById('custom-res-h');
      if (wEl) wEl.value = w ?? '';
      if (hEl) hEl.value = h ?? '';
    }
  }

  setCheckbox('enable_bucket', cfg.enable_bucket);
  setCheckbox('bucket_no_upscale', cfg.bucket_no_upscale);

  // Anima extras
  const animaExtras = document.getElementById('anima-extras');
  if (animaExtras) animaExtras.style.display = cfg.architecture === 'anima' ? 'block' : 'none';
  const qwen3Input = document.getElementById('qwen3-input');
  if (qwen3Input && cfg.qwen3) qwen3Input.value = cfg.qwen3;
  const t5Input = document.getElementById('t5-tokenizer-input');
  if (t5Input && cfg.t5_tokenizer_path) t5Input.value = cfg.t5_tokenizer_path;

  // ── Network ───────────────────────────────────────────────────
  if (cfg.network_module) {
    const modLabelMap = { 'networks.lora':'networks.lora', 'networks.lora_fa':'networks.lora_fa', 'networks.dylora':'networks.dylora' };
    setActiveBtn('[data-pane="network"] .form-row:first-child .row-flex', modLabelMap[cfg.network_module] ?? cfg.network_module);
  }
  setByLabel('network_dim', cfg.network_dim);
  setByLabel('network_alpha', cfg.network_alpha);

  // ── Schedule ──────────────────────────────────────────────────
  setActiveBtn('[data-pane="schedule"] .form-row:first-child .row-flex', cfg.optimizer_type);
  setByLabel('learning_rate', cfg.learning_rate);
  setByLabel('unet_lr', cfg.unet_lr);
  setByLabel('text_encoder_lr', cfg.text_encoder_lr);
  setActiveBtn('[data-pane="schedule"] .form-row:nth-child(3) .row-flex', cfg.lr_scheduler);
  setByLabel('lr_warmup_steps', cfg.lr_warmup_steps);
  setByLabel('num_cycles', cfg.lr_scheduler_num_cycles);
  setByLabel('max_train_epochs', cfg.max_train_epochs);
  setByLabel('max_train_steps', cfg.max_train_steps);
  setByLabel('train_batch_size', cfg.train_batch_size);
  setByLabel('grad_accum_steps', cfg.gradient_accumulation_steps);

  // ── Memory ────────────────────────────────────────────────────
  setActiveBtn('[data-pane="memory"] .form-row:first-child .row-flex', cfg.mixed_precision);
  setCheckbox('full_fp16', cfg.full_fp16);
  setCheckbox('full_bf16', cfg.full_bf16);
  setCheckbox('fp8_base', cfg.fp8_base ?? false);
  setCheckbox('gradient_checkpointing', cfg.gradient_checkpointing);
  setCheckbox('xformers', cfg.xformers ?? false);
  setCheckbox('sdpa', cfg.sdpa);
  setCheckbox('mem_eff_attn', cfg.mem_eff_attn);
  setCheckbox('lowram', cfg.lowram);
  setCheckbox('highvram', cfg.highvram);
  setCheckbox('cache_latents', cfg.cache_latents);
  setCheckbox('cache_latents_to_disk', cfg.cache_latents_to_disk);
  setCheckbox('cache_text_encoder_outputs', cfg.cache_text_encoder_outputs);
  setCheckbox('cache_text_encoder_outputs_to_disk', cfg.cache_text_encoder_outputs_to_disk);
  setByLabel('vae_batch_size', cfg.vae_batch_size);

  // ── Sampling ──────────────────────────────────────────────────
  setByLabel('every_n_steps', cfg.sample_every_n_steps);
  setByLabel('every_n_epochs', cfg.sample_every_n_epochs);
  setActiveBtn('[data-pane="sampling"] .form-row:nth-child(2) .row-flex', cfg.sample_sampler);
  setByLabel('save_every_n_steps', cfg.save_every_n_steps);
  setByLabel('save_every_n_epochs', cfg.save_every_n_epochs);

  const sampleTA = document.getElementById('sample-prompts-textarea');
  if (sampleTA) sampleTA.value = cfg.sample_prompts_raw ?? cfg.sample_prompts_text ?? '';
  const swEl = document.getElementById('sample-width');    if (swEl && cfg.sample_width !== undefined) swEl.value = cfg.sample_width;
  const shEl = document.getElementById('sample-height');   if (shEl && cfg.sample_height !== undefined) shEl.value = cfg.sample_height;
  const ssEl = document.getElementById('sample-steps');    if (ssEl && cfg.sample_steps !== undefined) ssEl.value = cfg.sample_steps;
  const slEl = document.getElementById('sample-guidance'); if (slEl && cfg.sample_guidance !== undefined) slEl.value = cfg.sample_guidance;
  const snEl = document.getElementById('sample-negative'); if (snEl && cfg.sample_negative !== undefined) snEl.value = cfg.sample_negative;

  // ── Advanced ──────────────────────────────────────────────────
  setByLabel('min_snr_gamma', cfg.min_snr_gamma);
  setByLabel('noise_offset', cfg.noise_offset);
  setActiveBtn('[data-pane="advanced"] .form-row:nth-child(2) .row-flex', cfg.log_with);

  refreshCliPreview();
}

async function startTraining() {
  try {
    const cfg = collectFormState();
    if (!cfg.checkpoint) { toast('Select a base model first', 'warn'); return; }
    if (!cfg.train_data_dir && !cfg.output_name) { toast('Set output name and dataset', 'warn'); return; }
    const result = await api.startJob(cfg);
    toast(`Job ${result.job_id} queued`, 'success');
    router.navigate('jobs');
  } catch (e) { toast(`Failed to start: ${e.message}`, 'error'); }
}

// ═══════════════════════════════════════════════════════════════
// Page: Jobs
// ═══════════════════════════════════════════════════════════════
let _jobsData = null;

async function mountJobs() {
  await renderJobs();
}

async function renderJobs() {
  try {
    // Clear placeholder immediately so stale template data doesn't flash
    const jobNow = document.querySelector('.job-now');
    if (jobNow) jobNow.innerHTML = '<div class="empty">Loading…</div>';

    _jobsData = await api.jobs();
    const { jobs, active_job_id } = _jobsData;

    // Now-training panel
    const activeJob = jobs.find((j) => j.id === active_job_id);
    if (jobNow && activeJob) {
      const pct = activeJob.total_steps > 0 ? (activeJob.step / activeJob.total_steps) * 100 : 0;
      const remaining = activeJob.throughput && activeJob.total_steps > activeJob.step
        ? (activeJob.total_steps - activeJob.step) / activeJob.throughput : null;
      const etaStr = remaining ? fmtDuration(remaining) : '—';
      const startedStr = activeJob.started_at
        ? new Date(activeJob.started_at * 1000).toLocaleTimeString() : '—';
      jobNow.innerHTML = `
        <div>
          <div class="job-title">${esc(activeJob.output_name)}</div>
          <div class="mono job-meta">${esc(activeJob.architecture?.toUpperCase())} · ${esc(activeJob.mode)} · started ${startedStr} · PID ${activeJob.pid ?? '—'}</div>
          <div class="job-progress">
            <div class="bar"><div class="fill" style="width:${pct}%"></div></div>
            <div class="job-steps mono">
              <span><b>${fmtStep(activeJob.step, activeJob.total_steps, activeJob.max_train_epochs)}</b></span>
              <span>loss <b>${activeJob.loss?.toFixed(4) ?? '—'}</b></span>
              <span>${activeJob.throughput?.toFixed(2) ?? '—'} it/s</span>
              <span>ETA ${etaStr}</span>
            </div>
          </div>
        </div>`;
    } else if (jobNow) {
      jobNow.innerHTML = `<div class="empty">No job currently running</div>`;
    }

    // Wire jobs-page Stop button
    const jobsStopBtn = document.getElementById('jobs-stop-btn');
    if (jobsStopBtn) {
      jobsStopBtn.onclick = null;
      if (active_job_id) {
        jobsStopBtn.disabled = false;
        jobsStopBtn.addEventListener('click', async () => {
          await api.cancelJob(active_job_id);
          toast('Training stopped', 'success');
          await renderJobs();
        });
      } else {
        jobsStopBtn.disabled = true;
      }
    }

    // Queued jobs
    const queuePanel = document.getElementById('queued-panel-body');
    const queuedJobs = jobs.filter((j) => j.status === 'queued');
    // Update queued badge
    const queueBadge = document.getElementById('queued-panel-badge');
    if (queueBadge) queueBadge.textContent = queuedJobs.length || '';
    if (queuePanel) {
      if (queuedJobs.length) {
        queuePanel.innerHTML = queuedJobs.map((j, i) => `
          <div class="job-row">
            <div class="job-handle">⋮⋮</div>
            <div class="job-num mono">#${i + 1}</div>
            <div>
              <div class="job-title">${esc(j.output_name)}</div>
              <div class="mono job-meta">${esc(j.architecture?.toUpperCase())} · ${esc(j.mode)}</div>
            </div>
            <div class="job-actions">
              <button class="btn ghost sm" data-edit="${j.id}">Edit</button>
              <button class="btn ghost sm danger" data-cancel="${j.id}">Remove</button>
            </div>
          </div>`).join('');
        queuePanel.querySelectorAll('[data-edit]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            try {
              const full = await api.getJob(btn.dataset.edit);
              _pendingEdit = full.config ?? full;
            } catch {
              _pendingEdit = jobs.find((j) => j.id === btn.dataset.edit) ?? null;
            }
            router.navigate('train');
          });
        });
        queuePanel.querySelectorAll('[data-cancel]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            await api.cancelJob(btn.dataset.cancel);
            await renderJobs();
          });
        });
      } else {
        queuePanel.innerHTML = `<div class="empty">Queue is empty</div>`;
      }
    }

    // Recent runs table
    const tbody = document.getElementById('recent-runs');
    const history = jobs.filter((j) => ['completed','failed','cancelled','interrupted'].includes(j.status));
    if (tbody) {
      tbody.innerHTML = history.length
        ? history.map((j) => `
          <tr>
            <td class="mono">${esc(j.output_name)}</td>
            <td>${esc(j.architecture?.toUpperCase())}</td>
            <td>${esc(j.mode)}</td>
            <td class="mono">${j.step?.toLocaleString() ?? '—'}</td>
            <td class="mono">${j.loss?.toFixed(4) ?? '—'}</td>
            <td class="mono">${wallTime(j)}</td>
            <td></td>
            <td><span class="badge dot ${statusColor(j.status)}">${esc(j.status)}</span></td>
            <td><button class="btn ghost sm" onclick="showLog('${j.id}')">Log</button></td>
          </tr>`).join('')
        : `<tr><td colspan="9" class="empty">No completed runs</td></tr>`;
    }
  } catch (e) { console.error('renderJobs:', e); }
}

sock.on('queue_update', () => { if (router.current === 'jobs') renderJobs(); });


// ═══════════════════════════════════════════════════════════════
// Page: Live Monitor
// ═══════════════════════════════════════════════════════════════
let _autoScroll = true;
const _lossHistory = [];

let _sampleInterval = null;
let _sampleGroups = [];   // [{step: N|null, paths: [...]}], sorted ascending by step
let _sampleGroupIdx = 0; // which group is currently shown
let _sampleEveryNSteps = 0; // from active job config, used by job_status handler

function _parseSampleStep(filename) {
  // sd-scripts naming: {name}_e000001_s000500_00.png
  const m = filename.match(/_s(\d+)_\d+\.\w+$/i);
  if (m) return parseInt(m[1], 10);
  // fallback: any 6-digit number before extension
  const m2 = filename.match(/_(\d{6})\.\w+$/);
  if (m2) return parseInt(m2[1], 10);
  return null;
}

function _renderSampleGroup() {
  const grid = document.getElementById('sample-grid-big');
  const stepLabel = document.getElementById('samples-step-label');
  const prevBtn = document.getElementById('samples-prev-btn');
  const nextBtn = document.getElementById('samples-next-btn');
  if (!grid) return;
  if (!_sampleGroups.length) {
    grid.innerHTML = '<div class="empty" style="padding:24px">No samples yet</div>';
    if (stepLabel) stepLabel.textContent = '—';
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
    return;
  }
  const group = _sampleGroups[_sampleGroupIdx];
  grid.innerHTML = group.paths.map((p) =>
    `<img src="/api/jobs/image?path=${encodeURIComponent(p)}" class="sample-thumb" loading="lazy" style="max-width:100%;border-radius:4px;"/>`
  ).join('');
  if (stepLabel) {
    stepLabel.textContent = group.step != null
      ? `step ${group.step.toLocaleString()} (${_sampleGroupIdx + 1} / ${_sampleGroups.length})`
      : `batch ${_sampleGroupIdx + 1} / ${_sampleGroups.length}`;
  }
  if (prevBtn) prevBtn.disabled = _sampleGroupIdx <= 0;
  if (nextBtn) nextBtn.disabled = _sampleGroupIdx >= _sampleGroups.length - 1;
}

async function mountLogs() {
  // Clear any previous sample polling
  if (_sampleInterval) { clearInterval(_sampleInterval); _sampleInterval = null; }
  _sampleGroups = [];
  _sampleGroupIdx = 0;
  _sampleEveryNSteps = 0;
  _lossHistory.length = 0;

  try {
    const { jobs, active_job_id } = await api.jobs();
    const activeJob = active_job_id
      ? jobs.find((j) => j.id === active_job_id)
      : jobs.find((j) => ['running', 'starting', 'completed', 'failed', 'interrupted'].includes(j.status));

    const page = document.getElementById('page');

    // Header
    const titleEl = document.getElementById('logs-title');
    if (titleEl && activeJob) {
      titleEl.innerHTML = `Live monitor · <span class="mono" style="color:var(--accent)">${esc(activeJob.output_name)}</span>`;
    }

    // Stop button
    page?.querySelectorAll('.btn.danger').forEach((btn) => {
      if (btn.textContent.trim() === 'Stop') {
        btn.addEventListener('click', async () => {
          if (active_job_id) {
            await api.cancelJob(active_job_id);
            toast('Training stopped', 'success');
          }
        });
      }
    });

    // TensorBoard button
    page?.querySelectorAll('.btn').forEach((btn) => {
      if (btn.textContent.includes('TensorBoard') && activeJob) {
        btn.addEventListener('click', async () => {
          try {
            btn.disabled = true;
            btn.textContent = 'Starting…';
            const cfg = activeJob.config ?? {};
            const logDir = `${cfg.output_dir ?? 'output'}/${activeJob.output_name}/logs`;
            const { url } = await api.post('/api/utilities/tensorboard/start', { logdir: logDir });
            window.open(url, '_blank');
          } catch (e) {
            toast('TensorBoard failed to start', 'error');
          } finally {
            btn.disabled = false;
            btn.textContent = 'Open TensorBoard';
          }
        });
      }
    });

    // Auto-scroll checkbox
    const autoScrollChk = page?.querySelector('input[type=checkbox]');
    if (autoScrollChk) {
      autoScrollChk.addEventListener('change', () => { _autoScroll = autoScrollChk.checked; });
    }

    // Download log button
    page?.querySelectorAll('.btn').forEach((btn) => {
      if (btn.textContent.includes('Download log') && activeJob) {
        btn.addEventListener('click', () => window.open(`/api/jobs/${activeJob.id}/log`, '_blank'));
      }
      if (btn.textContent.trim() === 'Wrap') {
        btn.addEventListener('click', () => {
          const con = document.getElementById('console');
          if (!con) return;
          const isWrapped = con.style.whiteSpace === 'pre-wrap';
          con.style.whiteSpace = isWrapped ? 'pre' : 'pre-wrap';
          btn.classList.toggle('primary', !isWrapped);
        });
      }
    });

    if (activeJob) {
      _sampleEveryNSteps = activeJob.config?.sample_every_n_steps ?? 0;

      // Wire prev/next sample group buttons
      document.getElementById('samples-prev-btn')?.addEventListener('click', () => {
        if (_sampleGroupIdx > 0) { _sampleGroupIdx--; _renderSampleGroup(); }
      });
      document.getElementById('samples-next-btn')?.addEventListener('click', () => {
        if (_sampleGroupIdx < _sampleGroups.length - 1) { _sampleGroupIdx++; _renderSampleGroup(); }
      });

      // Load loss history
      const full = await api.getJob(activeJob.id);
      if (full.loss_history?.length) {
        _lossHistory.push(...full.loss_history);
        renderLossChart('loss-chart-big', 'loss-fill2', 'loss-line2', _lossHistory);
      }

      // Load historical log buffer
      try {
        const logText = await fetch(`/api/jobs/${activeJob.id}/log`).then((r) => r.text());
        const console_ = document.getElementById('console');
        if (console_ && logText.trim()) {
          logText.split('\n').forEach((line) => {
            if (!line) return;
            const div = document.createElement('div');
            div.textContent = line;
            if (/error|exception/i.test(line)) div.style.color = 'var(--danger)';
            else if (/warning/i.test(line)) div.style.color = 'var(--warn)';
            console_.appendChild(div);
          });
          console_.scrollTop = console_.scrollHeight;
        }
      } catch {}

      // Load sample images
      await _refreshSamples(activeJob.id);

      // Poll samples every 30s while on logs page
      _sampleInterval = setInterval(() => {
        if (router.current === 'logs') _refreshSamples(activeJob.id);
        else { clearInterval(_sampleInterval); _sampleInterval = null; }
      }, 30000);
    }
  } catch (e) { console.error('mountLogs:', e); }
}

async function _refreshSamples(jobId) {
  try {
    const { samples } = await api.get(`/api/jobs/${jobId}/samples`);
    // Group images by step parsed from filename
    const byStep = new Map();
    for (const p of samples) {
      const filename = p.replace(/\\/g, '/').split('/').pop() ?? '';
      const step = _parseSampleStep(filename);
      const key = step ?? '__unknown__';
      if (!byStep.has(key)) byStep.set(key, []);
      byStep.get(key).push(p);
    }
    const wasAtEnd = !_sampleGroups.length || _sampleGroupIdx >= _sampleGroups.length - 1;
    _sampleGroups = [...byStep.entries()]
      .sort(([a], [b]) => {
        if (a === '__unknown__') return 1;
        if (b === '__unknown__') return -1;
        return Number(a) - Number(b);
      })
      .map(([key, paths]) => ({ step: key === '__unknown__' ? null : Number(key), paths }));
    // Auto-advance to newest group if user was already at the end
    if (wasAtEnd && _sampleGroups.length > 0) _sampleGroupIdx = _sampleGroups.length - 1;
    _sampleGroupIdx = Math.max(0, Math.min(_sampleGroupIdx, _sampleGroups.length - 1));
    _renderSampleGroup();
  } catch {}
}

sock.on('log_line', (msg) => {
  if (router.current !== 'logs') return;
  const console_ = document.getElementById('console');
  if (!console_) return;
  const line = document.createElement('div');
  line.textContent = msg.line;
  // Color tqdm/error lines
  if (/error|exception/i.test(msg.line)) line.style.color = 'var(--danger)';
  else if (/warning/i.test(msg.line)) line.style.color = 'var(--warn)';
  console_.appendChild(line);
  if (_autoScroll) console_.scrollTop = console_.scrollHeight;
  // Cap console lines
  while (console_.children.length > 2000) console_.removeChild(console_.firstChild);
});

sock.on('job_status', (msg) => {
  if (router.current !== 'logs') return;
  if (msg.loss != null) {
    _lossHistory.push(msg.loss);
    if (_lossHistory.length > 2000) _lossHistory.shift();
    renderLossChart('loss-chart-big', 'loss-fill2', 'loss-line2', _lossHistory);
  }
  // Update named stat card elements
  const lossEl = document.getElementById('logs-loss-val');
  const lrEl = document.getElementById('logs-lr-val');
  const thruEl = document.getElementById('logs-thru-val');
  if (lossEl) lossEl.innerHTML = `${msg.loss?.toFixed(3) ?? '—'}<small>↓</small>`;
  if (lrEl) lrEl.innerHTML = `<span class="mono" style="font-size:18px">${msg.lr?.toExponential(2) ?? '—'}</span>`;
  if (thruEl) thruEl.innerHTML = `${msg.throughput?.toFixed(2) ?? '—'}<small>it/s</small>`;
  // Update subtitle
  const sub = document.getElementById('logs-subtitle');
  if (sub && msg.total_steps > 0) {
    const remaining = msg.throughput && msg.total_steps > msg.step
      ? (msg.total_steps - msg.step) / msg.throughput : null;
    const etaStr = remaining ? fmtDuration(remaining) : '—';
    sub.textContent = `${fmtStep(msg.step, msg.total_steps, msg.max_train_epochs)} · ${msg.throughput?.toFixed(2) ?? '—'} it/s · ETA ${etaStr}`;
  }
  // Sample panel header: training progress
  const samplesStep = document.getElementById('logs-samples-step');
  if (samplesStep && msg.total_steps > 0) {
    samplesStep.textContent = `step ${(msg.step ?? 0).toLocaleString()} / ${msg.total_steps.toLocaleString()}`;
  }
  // "next sample at step N"
  const nextLabel = document.getElementById('samples-next-label');
  if (nextLabel) {
    if (_sampleEveryNSteps > 0 && msg.step != null) {
      const next = Math.ceil((msg.step + 1) / _sampleEveryNSteps) * _sampleEveryNSteps;
      nextLabel.textContent = `next sample at step ${next.toLocaleString()}`;
    } else {
      nextLabel.textContent = '—';
    }
  }
});

// ═══════════════════════════════════════════════════════════════
// Page: Models
// ═══════════════════════════════════════════════════════════════
async function mountModels() {
  try {
    const { models, directory } = await api.models();
    const container = document.getElementById('model-cards');
    if (!container) return;

    // Dynamic header stats
    const totalGb = (models.reduce((s, m) => s + m.size, 0) / 1e9).toFixed(1);
    const header = document.querySelector('#page h1 + p');
    if (header) header.textContent = `${models.length} base checkpoints · ${totalGb} GB on disk`;

    let _filtered = [...models];

    function renderCards(list) {
      if (!list.length) {
        container.innerHTML = `<div class="empty"><p>No models found in ${esc(directory)}</p><p>Add models or update the models_dir in Settings.</p></div>`;
        return;
      }
      container.innerHTML = list.map((m) => `
        <div class="model-card">
          <div class="model-card-name">${esc(m.name)}</div>
          <div class="model-card-meta mono">${esc(m.arch?.toUpperCase())} · ${m.size_human}</div>
          <div class="model-card-actions">
            <button class="btn sm" onclick="router.navigate('train')">Use for training</button>
          </div>
        </div>`).join('');
    }

    // Populate filter pill counts
    const archCounts = {};
    models.forEach((m) => { const a = m.arch ?? 'sd15'; archCounts[a] = (archCounts[a] ?? 0) + 1; });
    document.querySelectorAll('#model-filter-pills .btn[data-filter]').forEach((btn) => {
      const f = btn.dataset.filter;
      const count = f === 'all' ? models.length : (archCounts[f] ?? 0);
      const span = btn.querySelector('.model-count');
      if (span) span.textContent = count;
    });

    // Filter buttons (arch pills)
    document.querySelectorAll('#model-filter-pills .btn[data-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#model-filter-pills .btn').forEach((b) => b.classList.remove('primary'));
        btn.classList.add('primary');
        const f = btn.dataset.filter;
        _filtered = f === 'all' ? models : models.filter((m) => (m.arch ?? 'sd15').toLowerCase() === f);
        const q = document.querySelector('#page .search-wrap .input')?.value?.toLowerCase() ?? '';
        renderCards(q ? _filtered.filter((m) => m.name.toLowerCase().includes(q)) : _filtered);
      });
    });

    // Search
    document.querySelector('#page .search-wrap .input')?.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      renderCards(q ? _filtered.filter((m) => m.name.toLowerCase().includes(q)) : _filtered);
    });

    // "Pull from HuggingFace" / "+ Add local" toasts
    document.querySelectorAll('#page .actions .btn').forEach((btn) => {
      if (!btn.dataset.go) {
        btn.addEventListener('click', () => toast(`Add model files to: ${directory}`, 'info'));
      }
    });

    renderCards(models);
  } catch (e) { console.error('mountModels:', e); }
}

// ═══════════════════════════════════════════════════════════════
// Page: LoRAs
// ═══════════════════════════════════════════════════════════════
async function mountLoras() {
  try {
    const { loras, directory } = await api.loras();
    const container = document.getElementById('lora-grid');
    if (!container) return;

    // Dynamic header stats
    const totalMb = (loras.reduce((s, m) => s + m.size, 0) / 1e6).toFixed(0);
    const header = document.querySelector('#page h1 + p');
    if (header) header.textContent = `${loras.length} adapters · ${totalMb} MB on disk`;

    let _all = [...loras];

    function renderGrid(list) {
      container.innerHTML = list.length
        ? list.map((m) => `
          <div class="lora-card">
            <div class="lora-card-name">${esc(m.name)}</div>
            <div class="lora-card-meta mono">${m.size_human}</div>
          </div>`).join('')
        : `<div class="empty"><p>No LoRAs found in ${esc(directory)}</p><p>Train a new LoRA to get started.</p></div>`;
    }

    // Search
    document.querySelector('#page .search-wrap .input')?.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      renderGrid(q ? _all.filter((m) => m.name.toLowerCase().includes(q)) : _all);
    });

    // "Merge selected" / "Resize" → utilities
    document.querySelectorAll('#page .actions .btn').forEach((btn) => {
      if (btn.textContent.includes('Merge') || btn.textContent.includes('Resize')) {
        btn.addEventListener('click', () => router.navigate('utilities'));
      }
    });

    renderGrid(loras);
  } catch {}
}

// ═══════════════════════════════════════════════════════════════
// Page: Datasets
// ═══════════════════════════════════════════════════════════════
async function mountDatasets() {
  try {
    const { datasets, directory } = await api.datasets();
    const tbody = document.getElementById('ds-rows');
    if (!tbody) return;

    // Dynamic header stats
    const totalImgs = datasets.reduce((s, d) => s + d.image_count, 0);
    const panelStat = document.querySelector('#page .panel-h .mono');
    if (panelStat) panelStat.textContent =
      `${datasets.length} sets · ${totalImgs.toLocaleString()} imgs`;

    if (!datasets.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty">No datasets found in ${esc(directory)}</td></tr>`;
    } else {
      tbody.innerHTML = datasets.map((ds) => `
        <tr>
          <td>${esc(ds.name)}</td>
          <td class="mono">${ds.image_count}</td>
          <td><span class="badge dot ${ds.captioned ? 'good' : 'warn'}">${ds.captioned ? 'yes' : 'partial'}</span></td>
          <td>—</td>
          <td>—</td>
          <td>—</td>
          <td><button class="btn ghost sm" onclick="router.navigate('train')">Use</button></td>
        </tr>`).join('');
    }

    // "Import dataset" button — guide user to add folders
    document.querySelector('#page .actions .btn.primary')?.addEventListener('click', () => {
      toast(`Add dataset folders to: ${directory}`, 'info');
    });
  } catch {}
}

// ═══════════════════════════════════════════════════════════════
// Page: Settings
// ═══════════════════════════════════════════════════════════════
async function mountSettings() {
  try {
    const cfg = await api.settings();
    const page = document.getElementById('page');
    if (!page) return;

    // Populate all known fields
    const fieldMap = {
      'cfg-scripts-root': cfg.sd_scripts_root ?? '',
      'cfg-python':        cfg.python_executable ?? '',
      'cfg-models-dir':    cfg.models_dir ?? '',
      'cfg-datasets-dir':  cfg.datasets_dir ?? '',
      'cfg-output-dir':    cfg.output_dir ?? '',
      'cfg-cpu-threads':   cfg.cpu_threads ?? 8,
    };
    for (const [id, val] of Object.entries(fieldMap)) {
      const el = document.getElementById(id);
      if (el) el.value = val;
    }

    // Precision toggle buttons
    const precBtns = document.getElementById('cfg-precision-btns');
    if (precBtns) {
      const currentPrec = cfg.default_mixed_precision ?? 'bf16';
      precBtns.querySelectorAll('.btn').forEach((btn) => {
        btn.classList.toggle('primary', btn.dataset.prec === currentPrec);
        btn.addEventListener('click', () => {
          precBtns.querySelectorAll('.btn').forEach((b) => b.classList.remove('primary'));
          btn.classList.add('primary');
          save();
        });
      });
    }

    // Debounced save
    const save = debounce(async () => {
      const activePrecBtn = precBtns?.querySelector('.btn.primary');
      const data = {
        sd_scripts_root:      document.getElementById('cfg-scripts-root')?.value ?? cfg.sd_scripts_root,
        python_executable:    document.getElementById('cfg-python')?.value ?? cfg.python_executable,
        models_dir:           document.getElementById('cfg-models-dir')?.value ?? cfg.models_dir,
        datasets_dir:         document.getElementById('cfg-datasets-dir')?.value ?? cfg.datasets_dir,
        output_dir:           document.getElementById('cfg-output-dir')?.value ?? cfg.output_dir,
        cpu_threads:          parseInt(document.getElementById('cfg-cpu-threads')?.value) || cfg.cpu_threads,
        default_mixed_precision: activePrecBtn?.dataset.prec ?? cfg.default_mixed_precision,
      };
      try {
        await api.saveSettings(data);
        toast('Settings saved', 'success');
      } catch { toast('Failed to save settings', 'error'); }
    }, 800);

    page.querySelectorAll('.input').forEach((inp) => inp.addEventListener('change', save));

    // Palette picker
    page.querySelectorAll('.palette-swatch').forEach((sw) => {
      sw.addEventListener('click', () => {
        page.querySelectorAll('.palette-swatch').forEach((s) => s.classList.remove('sel'));
        sw.classList.add('sel');
        document.documentElement.dataset.palette = sw.dataset.palette;
      });
    });
  } catch (e) { console.error('mountSettings:', e); }
}

// ═══════════════════════════════════════════════════════════════
// Page: Utilities
// ═══════════════════════════════════════════════════════════════
function mountUtilities() {
  // Each util-card[data-tool] is interactive; others are "coming soon"
  document.querySelectorAll('#page .util-card[data-tool]').forEach((card) => {
    const tool = card.dataset.tool;

    // Toggle form on header click
    card.querySelector('.util-card-hd')?.addEventListener('click', () => {
      const form = card.querySelector('.util-form');
      if (form) form.hidden = !form.hidden;
    });

    // Arch selector buttons inside the card (for merge/extract)
    card.querySelectorAll('[data-arch]').forEach((btn) => {
      btn.addEventListener('click', () => {
        card.querySelectorAll('[data-arch]').forEach((b) => b.classList.remove('primary'));
        btn.classList.add('primary');
        // Switch tool based on arch for extract/merge
        if (tool === 'merge_lora' || tool === 'merge_lora_flux') {
          card.dataset.tool = btn.dataset.arch === 'flux' ? 'merge_lora_flux' : 'merge_lora';
        }
        if (tool === 'extract_lora' || tool === 'extract_lora_flux') {
          card.dataset.tool = btn.dataset.arch === 'flux' ? 'extract_lora_flux' : 'extract_lora';
          // FLUX extract doesn't take --sdxl flag, SD/SDXL does
          const sdxlField = card.querySelector('[data-arg="sdxl"]');
          if (sdxlField) sdxlField.value = btn.dataset.arch === 'sdxl' ? 'true' : '';
        }
      });
    });

    // Run button
    card.querySelector('.util-run')?.addEventListener('click', async () => {
      const currentTool = card.dataset.tool;
      const args = _collectUtilArgs(card);
      const out = card.querySelector('.util-output');
      const runBtn = card.querySelector('.util-run');

      if (out) { out.hidden = false; out.textContent = 'Running…'; }
      if (runBtn) runBtn.disabled = true;

      try {
        const result = await api.runUtility(currentTool, args);
        if (out) out.textContent = result.output || '(no output)';
        toast(
          result.returncode === 0 ? 'Done' : `Script exited with code ${result.returncode}`,
          result.returncode === 0 ? 'success' : 'error'
        );
      } catch (e) {
        if (out) out.textContent = `Error: ${e.message}`;
        toast('Utility failed', 'error');
      } finally {
        if (runBtn) runBtn.disabled = false;
      }
    });
  });
}

function _collectUtilArgs(card) {
  const args = {};
  // Inputs/selects with data-arg — multi-value args (e.g. --models) collected as array
  card.querySelectorAll('[data-arg]').forEach((el) => {
    if (!el.value && el.value !== 0) return;
    const key = el.dataset.arg;
    if (key in args) {
      // Already exists → make array or push
      if (Array.isArray(args[key])) {
        args[key].push(el.value);
      } else {
        args[key] = [args[key], el.value];
      }
    } else {
      args[key] = el.value;
    }
  });
  return args;
}

// ═══════════════════════════════════════════════════════════════
// Page controllers registry
// ═══════════════════════════════════════════════════════════════
const pageControllers = {
  dashboard: { onMount: mountDashboard },
  train:     { onMount: mountTrain },
  jobs:      { onMount: mountJobs },
  logs:      { onMount: mountLogs },
  models:    { onMount: mountModels },
  loras:     { onMount: mountLoras },
  datasets:  { onMount: mountDatasets },
  utilities: { onMount: mountUtilities },
  settings:  { onMount: mountSettings },
};

// ═══════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════
function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function statusColor(s) {
  return { running:'good', completed:'good', failed:'danger', cancelled:'warn', queued:'info', interrupted:'warn' }[s] ?? '';
}
function wallTime(j) {
  if (!j.started_at) return '—';
  const end = j.finished_at ?? Date.now() / 1000;
  const secs = Math.round(end - j.started_at);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}
async function showLog(jobId) {
  window.open(`/api/jobs/${jobId}/log`, '_blank');
}

// Expose router globally for onclick handlers
window.router = router;
window.showLog = showLog;

// ═══════════════════════════════════════════════════════════════
// Boot
// ═══════════════════════════════════════════════════════════════
refreshNavCounts();
router.navigate('train');
