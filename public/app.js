import { EngineClient, EngineError } from "/engine-client.js";

const state = {
  items: [],
  engine: { state: "checking", health: null, error: null },
  submitting: false,
  pollTimer: null,
};

const engine = new EngineClient();
const $ = (selector) => document.querySelector(selector);
const queueEl = $("#queue");
const inputEl = $("#url-input");
const batchButton = $("#batch-button");
const retryButton = $("#retry-button");

boot();

async function boot() {
  bindEvents();
  render();
  await connectEngine();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}

function bindEvents() {
  $("#add-button").addEventListener("click", addFromInput);
  $("#paste-button").addEventListener("click", async () => {
    try {
      inputEl.value = await navigator.clipboard.readText();
      await addFromInput();
    } catch {
      toast("클립보드 권한이 없어요. 직접 붙여넣어 주세요.");
    }
  });
  inputEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      addFromInput();
    }
  });
  document.querySelectorAll("[data-bulk]").forEach((button) => {
    button.addEventListener("click", () => applyBulk(button.dataset.bulk));
  });
  batchButton.addEventListener("click", submitBatch);
  retryButton.addEventListener("click", retryFailed);
  $("#refresh-history").addEventListener("click", loadHistory);
  $("#number-prefix").addEventListener("change", () => renderBatchBar());
  $("#retry-engine").addEventListener("click", connectEngine);
  $("#pair-button").addEventListener("click", pairEngine);
  $("#pair-code").addEventListener("keydown", (event) => {
    if (event.key === "Enter") pairEngine();
  });
}

async function connectEngine() {
  state.engine = { state: "checking", health: null, error: null };
  renderEngine();
  try {
    const result = await engine.discover();
    state.engine = { state: result.state, health: result.health, error: null };
    renderEngine();
    if (result.state === "ready") {
      await Promise.allSettled([loadHistory(), inspectWaitingItems()]);
      startPolling();
    }
  } catch (error) {
    const code = error instanceof EngineError ? error.code : "ENGINE_ERROR";
    state.engine = { state: code === "PROTOCOL_MISMATCH" ? "mismatch" : "offline", health: null, error: error.message };
    renderEngine();
    render();
  }
}

async function pairEngine() {
  const input = $("#pair-code");
  const code = input.value.trim();
  if (!/^\d{6}$/.test(code)) {
    toast("Engine 화면의 6자리 코드를 입력해 주세요.");
    return;
  }
  $("#pair-button").disabled = true;
  try {
    await engine.pair(code);
    input.value = "";
    toast("이 브라우저와 Local Engine을 연결했어요.");
    await connectEngine();
  } catch (error) {
    toast(error.message);
  } finally {
    $("#pair-button").disabled = false;
  }
}

function engineReady() {
  return state.engine.state === "ready";
}

async function addFromInput() {
  const urls = [...new Set(inputEl.value.split(/\s+/).map((x) => x.trim()).filter(Boolean))];
  if (!urls.length) return;
  inputEl.value = "";
  for (const url of urls) {
    const localId = crypto.randomUUID();
    state.items.push({
      localId,
      url,
      inspectStatus: engineReady() ? "loading" : "waiting",
      mediaType: "mp3",
      quality: 256,
      jobStatus: "idle",
    });
    render();
    if (engineReady()) inspectItem(localId);
  }
}

async function inspectWaitingItems() {
  const items = state.items.filter((item) => ["waiting", "failed"].includes(item.inspectStatus) && !item.jobId);
  for (const item of items) {
    item.inspectStatus = "loading";
    renderItem(item.localId);
    await inspectItem(item.localId);
  }
}

async function inspectItem(localId) {
  const item = findItem(localId);
  if (!item || !engineReady()) return;
  try {
    const data = await engine.inspect(item.url);
    Object.assign(item, {
      inspectStatus: "ready",
      videoId: data.videoId,
      title: data.title,
      duration: data.duration,
      thumbnail: data.thumbnail,
      channel: data.channel,
      mp4Qualities: data.mp4Qualities || [],
      mp3Qualities: data.mp3Qualities || [128, 192, 256, 320],
      quality: 256,
      error: null,
    });
  } catch (error) {
    Object.assign(item, { inspectStatus: "failed", error: friendlyError(error) });
  }
  renderItem(localId);
}

function applyBulk(type) {
  for (const item of state.items) {
    if (item.inspectStatus !== "ready" || ["queued", "processing", "submitting"].includes(item.jobStatus)) continue;
    item.mediaType = type;
    if (type === "mp3") item.quality = 256;
    else item.quality = nearestQuality(item.mp4Qualities || [], 1080);
    resetJob(item);
  }
  render();
}

async function submitBatch() {
  if (!engineReady()) {
    toast("먼저 이 기기의 Y2Y2 Engine을 실행하고 연결해 주세요.");
    return;
  }
  if (state.submitting) return;
  const candidates = state.items.filter(
    (item) => item.inspectStatus === "ready" && !["queued", "processing", "ready"].includes(item.jobStatus),
  );
  if (!candidates.length) return;
  state.submitting = true;
  for (const item of candidates) item.jobStatus = "submitting";
  render();
  const numbered = $("#number-prefix").checked;
  const payload = candidates.map((item) => {
    const queueIndex = state.items.indexOf(item);
    return {
      url: item.url,
      videoId: item.videoId,
      title: item.title,
      mediaType: item.mediaType,
      quality: item.quality,
      filenamePrefix: numbered ? `${String(queueIndex + 1).padStart(2, "0")} - ` : "",
    };
  });
  try {
    const data = await engine.createBatch(payload);
    data.items.forEach((job, index) => applyJob(candidates[index], job));
    toast(`${data.items.length}개 작업을 이 기기의 Engine에 넘겼어요.`);
  } catch (error) {
    candidates.forEach((item) => {
      item.jobStatus = "failed";
      item.jobError = friendlyError(error);
    });
  } finally {
    state.submitting = false;
    render();
    startPolling();
  }
}

async function retryFailed() {
  if (!engineReady()) return;
  const retryable = state.items.filter((item) => item.jobId && ["failed", "canceled"].includes(item.jobStatus));
  for (const item of retryable) {
    try {
      applyJob(item, await engine.retry(item.jobId));
    } catch (error) {
      item.jobError = friendlyError(error);
    }
  }
  render();
  startPolling();
}

function startPolling() {
  clearInterval(state.pollTimer);
  if (!engineReady()) return;
  const tick = async () => {
    const active = state.items.filter((item) => item.jobId && ["queued", "processing", "submitting"].includes(item.jobStatus));
    if (!active.length) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
      render();
      await loadHistory();
      return;
    }
    await mapLimit(active, 6, async (item) => {
      try {
        applyJob(item, await engine.job(item.jobId));
      } catch (error) {
        if (error instanceof EngineError && error.code === "ENGINE_OFFLINE") {
          state.engine.state = "offline";
          state.engine.error = error.message;
          renderEngine();
        }
      }
    });
    render();
  };
  tick();
  state.pollTimer = setInterval(tick, 1500);
}

function resetJob(item) {
  item.jobId = null;
  item.jobStatus = "idle";
  item.jobStage = null;
  item.jobError = null;
  item.outputPath = null;
  item.filename = null;
  item.sizeBytes = null;
}

function applyJob(item, job) {
  if (!item || !job) return;
  item.jobId = job.id;
  item.jobStatus = job.status;
  item.jobStage = job.stage;
  item.jobError = job.error;
  item.outputPath = job.outputPath;
  item.filename = job.filename;
  item.sizeBytes = job.sizeBytes;
  item.progress = Number(job.progress || 0);
}

function render() {
  $("#queue-count").textContent = state.items.length;
  $("#empty-state").classList.toggle("hidden", state.items.length > 0);
  $("#batch-bar").classList.toggle("hidden", state.items.length === 0);
  queueEl.innerHTML = state.items.map(itemTemplate).join("");
  bindQueueEvents();
  renderBatchBar();
  renderEngine();
}

function renderEngine() {
  const { state: engineState, health, error } = state.engine;
  const badge = $("#engine-badge");
  const detail = $("#engine-detail");
  const name = $("#engine-name");
  const healthEl = $("#health");
  const pairBox = $("#pair-box");
  const actions = $("#engine-actions");
  pairBox.classList.toggle("hidden", engineState !== "pairing");
  actions.classList.toggle("hidden", !["offline", "mismatch"].includes(engineState));
  badge.className = `engine-badge ${engineState}`;

  if (engineState === "ready") {
    name.textContent = health?.engineName || "This Device";
    badge.textContent = `${health?.platform || "local"} · ready`;
    detail.textContent = `${health?.outputDirectory || "Local Downloads"} · protocol v${health?.protocolVersion}`;
    healthEl.textContent = "ENGINE · ONLINE";
    healthEl.classList.add("ok");
  } else if (engineState === "pairing") {
    name.textContent = health?.engineName || "Local Engine 발견";
    badge.textContent = "pairing required";
    detail.textContent = "Engine 창/앱에 표시된 6자리 코드를 입력하면 이 브라우저만 제어 권한을 얻습니다.";
    healthEl.textContent = "ENGINE · PAIR";
    healthEl.classList.remove("ok");
  } else if (engineState === "mismatch") {
    name.textContent = "Engine 업데이트 필요";
    badge.textContent = "version mismatch";
    detail.textContent = error || "Web과 Engine protocol 버전이 맞지 않습니다.";
    healthEl.textContent = "ENGINE · UPDATE";
    healthEl.classList.remove("ok");
  } else if (engineState === "offline") {
    name.textContent = "Local Engine을 찾지 못했어요";
    badge.textContent = "offline";
    detail.textContent = "Windows에서는 Y2Y2 Engine을 실행하고, Android에서는 Y2Y2 Engine 앱을 열어 주세요.";
    const openEngine = $("#open-engine");
    const isAndroid = /Android/i.test(navigator.userAgent);
    openEngine.href = isAndroid ? "y2y2://engine/start" : "http://127.0.0.1:49272/";
    openEngine.target = isAndroid ? "_self" : "_blank";
    openEngine.textContent = isAndroid ? "Android Engine 열기" : "Windows Engine 열기";
    healthEl.textContent = "ENGINE · OFFLINE";
    healthEl.classList.remove("ok");
  } else {
    name.textContent = "이 기기의 Engine을 찾는 중…";
    badge.textContent = "checking";
    detail.textContent = "MP3/MP4는 Vercel이 아니라 지금 이 기기에서 직접 처리합니다.";
    healthEl.textContent = "ENGINE · CHECKING";
    healthEl.classList.remove("ok");
  }
}

function renderItem(localId) {
  const node = queueEl.querySelector(`[data-id="${localId}"]`);
  const item = findItem(localId);
  if (!node || !item) return render();
  const holder = document.createElement("div");
  holder.innerHTML = itemTemplate(item);
  node.replaceWith(holder.firstElementChild);
  bindQueueEvents();
  renderBatchBar();
}

function itemTemplate(item, index = state.items.indexOf(item)) {
  const locked = ["queued", "processing", "submitting"].includes(item.jobStatus);
  const title = item.inspectStatus === "loading" ? "분석 중…" : item.inspectStatus === "waiting" ? "Engine 연결 대기" : item.title || "분석 실패";
  const subtitle = item.inspectStatus === "loading" || item.inspectStatus === "waiting"
    ? item.url
    : item.inspectStatus === "failed"
      ? item.error || "분석 실패"
      : `${formatDuration(item.duration)}${item.channel ? ` · ${escapeHtml(item.channel)}` : ""}`;
  const status = statusLabel(item);
  const qualities = item.mediaType === "mp3" ? item.mp3Qualities || [128, 192, 256, 320] : item.mp4Qualities || [];
  const suffix = item.mediaType === "mp3" ? "k" : "p";
  const progress = item.jobStatus === "processing" && item.progress ? ` · ${Math.floor(item.progress)}%` : "";

  return `<article class="queue-item panel" data-id="${item.localId}">
    <div class="order">${String(index + 1).padStart(2, "0")}</div>
    <div class="thumb-wrap">${item.thumbnail ? `<img src="${escapeAttr(item.thumbnail)}" alt="" loading="lazy" />` : `<div class="thumb-placeholder">Y2</div>`}</div>
    <div class="item-main">
      <div class="item-title" title="${escapeAttr(title)}">${escapeHtml(title)}</div>
      <div class="item-subtitle">${escapeHtml(subtitle)}</div>
      <div class="item-controls">
        <select data-action="type" ${locked || item.inspectStatus !== "ready" ? "disabled" : ""}>
          <option value="mp3" ${item.mediaType === "mp3" ? "selected" : ""}>MP3</option>
          <option value="mp4" ${item.mediaType === "mp4" ? "selected" : ""}>MP4</option>
        </select>
        <select data-action="quality" ${locked || item.inspectStatus !== "ready" ? "disabled" : ""}>
          ${qualities.map((q) => `<option value="${q}" ${Number(item.quality) === Number(q) ? "selected" : ""}>${q}${suffix}</option>`).join("")}
        </select>
        <span class="status ${item.jobStatus === "failed" || item.inspectStatus === "failed" ? "bad" : ""}">${escapeHtml(status + progress)}</span>
      </div>
      ${item.jobError ? `<div class="error-line">${escapeHtml(item.jobError)}</div>` : ""}
      ${item.outputPath ? `<div class="saved-line">${escapeHtml(item.outputPath)}</div>` : ""}
    </div>
    <div class="item-actions">
      <button data-action="up" class="icon-button" title="위로" ${index === 0 || locked ? "disabled" : ""}>↑</button>
      <button data-action="down" class="icon-button" title="아래로" ${index === state.items.length - 1 || locked ? "disabled" : ""}>↓</button>
      ${item.jobStatus === "ready" ? `<button data-action="reveal" class="icon-button" title="파일 위치 열기">⌕</button>` : ""}
      <button data-action="remove" class="icon-button danger" title="목록에서 삭제" ${locked ? "disabled" : ""}>×</button>
    </div>
  </article>`;
}

function bindQueueEvents() {
  queueEl.querySelectorAll(".queue-item").forEach((node) => {
    const item = findItem(node.dataset.id);
    if (!item) return;
    node.querySelector('[data-action="type"]')?.addEventListener("change", (event) => {
      item.mediaType = event.target.value;
      item.quality = item.mediaType === "mp3" ? 256 : nearestQuality(item.mp4Qualities || [], 1080);
      resetJob(item);
      renderItem(item.localId);
    });
    node.querySelector('[data-action="quality"]')?.addEventListener("change", (event) => {
      item.quality = Number(event.target.value);
      resetJob(item);
      renderItem(item.localId);
    });
    node.querySelector('[data-action="remove"]')?.addEventListener("click", async () => {
      if (item.jobId && ["queued", "processing"].includes(item.jobStatus) && engineReady()) {
        try { await engine.cancel(item.jobId); } catch {}
      }
      state.items = state.items.filter((x) => x.localId !== item.localId);
      render();
    });
    node.querySelector('[data-action="up"]')?.addEventListener("click", () => moveItem(item.localId, -1));
    node.querySelector('[data-action="down"]')?.addEventListener("click", () => moveItem(item.localId, 1));
    node.querySelector('[data-action="reveal"]')?.addEventListener("click", async () => {
      try { await engine.reveal(item.jobId); } catch (error) { toast(friendlyError(error)); }
    });
  });
}

function moveItem(id, delta) {
  const index = state.items.findIndex((item) => item.localId === id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= state.items.length) return;
  [state.items[index], state.items[target]] = [state.items[target], state.items[index]];
  render();
}

function renderBatchBar() {
  if (!state.items.length) return;
  const inspected = state.items.filter((i) => i.inspectStatus === "ready");
  const ready = state.items.filter((i) => i.jobStatus === "ready");
  const failed = state.items.filter((i) => i.inspectStatus === "failed" || i.jobStatus === "failed" || i.jobStatus === "canceled");
  const active = state.items.filter((i) => ["submitting", "queued", "processing"].includes(i.jobStatus));
  const totalBytes = ready.reduce((sum, item) => sum + Number(item.sizeBytes || 0), 0);
  $("#batch-summary").textContent = `${ready.length}/${inspected.length} 저장`;
  $("#batch-detail").textContent = active.length
    ? `${active.length}개 이 기기에서 처리 중`
    : failed.length
      ? `${failed.length}개 실패`
      : ready.length && ready.length === inspected.length
        ? `${formatBytes(totalBytes)} · 로컬 저장 완료`
        : engineReady() ? "다운로드 준비" : "Engine 연결 필요";
  retryButton.classList.toggle("hidden", !failed.some((item) => item.jobId && ["failed", "canceled"].includes(item.jobStatus)));
  $("#batch-progress-wrap").classList.toggle("hidden", !active.length);
  $("#batch-progress").classList.toggle("indeterminate", !!active.length);
  if (active.length || state.submitting) {
    batchButton.textContent = `이 기기에서 처리 중 · ${active.length}`;
    batchButton.disabled = true;
  } else {
    const candidates = inspected.filter((item) => !["ready", "queued", "processing"].includes(item.jobStatus));
    batchButton.textContent = ready.length === inspected.length && inspected.length
      ? `이 기기에 저장 완료 · ${ready.length}`
      : `이 기기에서 모두 다운로드 · ${candidates.length}`;
    batchButton.disabled = !engineReady() || candidates.length === 0;
  }
}

async function loadHistory() {
  const root = $("#history");
  if (!engineReady()) {
    root.innerHTML = '<span class="muted">Local Engine을 연결하면 이 기기의 기록을 불러옵니다.</span>';
    return;
  }
  try {
    const data = await engine.jobs();
    if (!data.items?.length) {
      root.innerHTML = '<span class="muted">이 기기에는 아직 기록이 없어.</span>';
      return;
    }
    root.innerHTML = data.items.slice(0, 24).map((item) => `
      <div class="history-row">
        <div class="history-main"><strong>${escapeHtml(item.title)}</strong><span>${item.mediaType.toUpperCase()} · ${item.quality}${item.mediaType === "mp3" ? "k" : "p"} · ${escapeHtml(item.stage)}</span></div>
        <div class="history-side">${item.status === "ready" ? `<button class="text-button" data-reveal="${item.id}">파일 위치</button>` : `<span class="muted">${escapeHtml(item.status)}</span>`}</div>
      </div>`).join("");
    root.querySelectorAll("[data-reveal]").forEach((button) => button.addEventListener("click", async () => {
      try { await engine.reveal(button.dataset.reveal); } catch (error) { toast(friendlyError(error)); }
    }));
  } catch (error) {
    root.innerHTML = `<span class="error-line">${escapeHtml(friendlyError(error))}</span>`;
  }
}

function findItem(id) { return state.items.find((item) => item.localId === id); }
function nearestQuality(values, target) {
  if (!values.length) return target;
  return values.reduce((best, value) => Math.abs(value - target) < Math.abs(best - target) ? value : best, values[0]);
}
function statusLabel(item) {
  if (item.inspectStatus === "waiting") return "Engine 대기";
  if (item.inspectStatus === "loading") return "분석 중";
  if (item.inspectStatus === "failed") return "분석 실패";
  return ({ idle: "준비", submitting: "전송 중", queued: "대기열", processing: item.jobStage || "처리 중", ready: "저장됨", failed: "실패", canceled: "취소됨" })[item.jobStatus] || item.jobStatus;
}
function friendlyError(error) {
  if (error instanceof EngineError && error.code === "ENGINE_OFFLINE") return "Local Engine 연결이 끊겼습니다.";
  if (error instanceof EngineError && error.code === "PAIRING_REQUIRED") return "Engine 연결 코드가 필요합니다.";
  return error?.message || String(error);
}
async function mapLimit(items, limit, fn) {
  const rest = [...items];
  const workers = Array.from({ length: Math.min(limit, rest.length) }, async () => {
    while (rest.length) await fn(rest.shift());
  });
  await Promise.all(workers);
}
function formatDuration(seconds) {
  const value = Number(seconds || 0);
  const mins = Math.floor(value / 60);
  const secs = value % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}
function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
function escapeAttr(value) { return escapeHtml(value); }
let toastTimer;
function toast(message, duration = 3200) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), duration);
}
