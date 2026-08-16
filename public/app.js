const state = {
  items: [],
  preparing: false,
  sentDownloads: new Set(),
  pollTimer: null,
};

const $ = (selector) => document.querySelector(selector);
const queueEl = $("#queue");
const inputEl = $("#url-input");
const batchButton = $("#batch-button");
const retryButton = $("#retry-button");

boot();

async function boot() {
  bindEvents();
  render();
  await Promise.allSettled([checkHealth(), loadHistory()]);
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

  batchButton.addEventListener("click", onBatchAction);
  retryButton.addEventListener("click", retryFailed);
  $("#refresh-history").addEventListener("click", loadHistory);
  $("#number-prefix").addEventListener("change", renderBatchBar);
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
      inspectStatus: "loading",
      mediaType: "mp3",
      quality: 256,
      jobStatus: "idle",
    });
    render();
    inspectItem(localId);
  }
}

async function inspectItem(localId) {
  const item = findItem(localId);
  if (!item) return;
  try {
    const data = await api("/api/inspect", {
      method: "POST",
      body: { url: item.url },
    });
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
    Object.assign(item, { inspectStatus: "failed", error: error.message });
  }
  render();
}

function applyBulk(type) {
  for (const item of state.items) {
    if (item.inspectStatus !== "ready" || ["queued", "processing"].includes(item.jobStatus)) continue;
    item.mediaType = type;
    if (type === "mp3") item.quality = 256;
    else item.quality = nearestQuality(item.mp4Qualities || [], 1080);
    resetJob(item);
  }
  render();
}

async function onBatchAction() {
  const readyForDownload = downloadableItems();
  const allTerminal = terminalCount() === state.items.filter((i) => i.inspectStatus === "ready").length;
  const noPending = state.items.every((i) => !["queued", "processing"].includes(i.jobStatus));

  if (readyForDownload.length && allTerminal && noPending) {
    sendDownloads(readyForDownload);
    return;
  }
  await prepareAll();
}

async function prepareAll() {
  if (state.preparing) return;
  const candidates = state.items.filter(
    (item) => item.inspectStatus === "ready" && !["queued", "processing", "ready"].includes(item.jobStatus),
  );
  if (!candidates.length) {
    if (state.items.some((i) => ["queued", "processing"].includes(i.jobStatus))) startPolling();
    return;
  }

  state.preparing = true;
  renderBatchBar();
  await mapLimit(candidates, 4, async (item) => {
    item.jobStatus = "submitting";
    renderItem(item.localId);
    try {
      const job = await api("/api/jobs", {
        method: "POST",
        body: {
          url: item.url,
          videoId: item.videoId,
          title: item.title,
          mediaType: item.mediaType,
          quality: item.quality,
        },
      });
      applyJob(item, job);
    } catch (error) {
      item.jobStatus = "failed";
      item.jobError = error.message;
    }
    renderItem(item.localId);
  });
  state.preparing = false;
  render();
  startPolling();
}

function startPolling() {
  clearInterval(state.pollTimer);
  const tick = async () => {
    const active = state.items.filter((i) => i.jobId && ["queued", "processing"].includes(i.jobStatus));
    if (!active.length) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
      render();
      await loadHistory();
      return;
    }
    await mapLimit(active, 6, async (item) => {
      try {
        const job = await api(`/api/jobs/${item.jobId}`);
        applyJob(item, job);
      } catch {}
    });
    render();
  };
  tick();
  state.pollTimer = setInterval(tick, 1600);
}

async function retryFailed() {
  for (const item of state.items) {
    if (item.jobStatus === "failed") resetJob(item);
  }
  render();
  await prepareAll();
}

function sendDownloads(items) {
  const numbered = $("#number-prefix").checked;
  state.sentDownloads.clear();
  items.forEach((item, index) => {
    setTimeout(() => {
      const link = document.createElement("a");
      const baseUrl = item.downloadUrl || `/api/download/${item.jobId}`;
      const prefix = numbered ? `${String(index + 1).padStart(2, "0")} - ` : "";
      link.href = prefix ? `${baseUrl}?prefix=${encodeURIComponent(prefix)}` : baseUrl;
      if (item.filename) link.download = `${prefix}${item.filename}`;
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      link.remove();
      state.sentDownloads.add(item.localId);
      renderBatchBar();
    }, index * 450);
  });
  toast(`${items.length}개 파일을 브라우저로 보냅니다. 여러 다운로드 허용 팝업이 뜨면 허용해 주세요.`, 5000);
}

function resetJob(item) {
  item.jobId = null;
  item.jobStatus = "idle";
  item.jobStage = null;
  item.jobError = null;
  item.downloadUrl = null;
  item.filename = null;
  item.sizeBytes = null;
}

function applyJob(item, job) {
  item.jobId = job.id;
  item.jobStatus = job.status;
  item.jobStage = job.stage;
  item.jobError = job.error;
  item.downloadUrl = job.downloadUrl;
  item.filename = job.filename;
  item.sizeBytes = job.sizeBytes;
}

function render() {
  $("#queue-count").textContent = state.items.length;
  $("#empty-state").classList.toggle("hidden", state.items.length > 0);
  $("#batch-bar").classList.toggle("hidden", state.items.length === 0);
  queueEl.innerHTML = state.items.map(itemTemplate).join("");
  bindQueueEvents();
  renderBatchBar();
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
  const title = item.inspectStatus === "loading" ? "분석 중…" : item.title || "분석 실패";
  const subtitle = item.inspectStatus === "loading"
    ? item.url
    : item.inspectStatus === "failed"
      ? item.error || "분석 실패"
      : `${formatDuration(item.duration)}${item.channel ? ` · ${escapeHtml(item.channel)}` : ""}`;
  const status = statusLabel(item);
  const qualities = item.mediaType === "mp3" ? item.mp3Qualities || [128,192,256,320] : item.mp4Qualities || [];
  const qualitySuffix = item.mediaType === "mp3" ? "k" : "p";

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
          ${qualities.map((q) => `<option value="${q}" ${Number(item.quality) === Number(q) ? "selected" : ""}>${q}${qualitySuffix}</option>`).join("")}
        </select>
        <span class="status ${item.jobStatus === "failed" || item.inspectStatus === "failed" ? "bad" : ""}">${escapeHtml(status)}</span>
      </div>
      ${item.jobError ? `<div class="error-line">${escapeHtml(item.jobError)}</div>` : ""}
    </div>
    <div class="item-actions">
      <button data-action="up" class="icon-button" title="위로" ${index === 0 || locked ? "disabled" : ""}>↑</button>
      <button data-action="down" class="icon-button" title="아래로" ${index === state.items.length - 1 || locked ? "disabled" : ""}>↓</button>
      ${item.jobStatus === "ready" ? `<a class="icon-button download-one" href="${item.downloadUrl}" title="다운로드">↓</a>` : ""}
      <button data-action="remove" class="icon-button danger" title="삭제" ${locked ? "disabled" : ""}>×</button>
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
    node.querySelector('[data-action="remove"]')?.addEventListener("click", () => {
      state.items = state.items.filter((x) => x.localId !== item.localId);
      render();
    });
    node.querySelector('[data-action="up"]')?.addEventListener("click", () => moveItem(item.localId, -1));
    node.querySelector('[data-action="down"]')?.addEventListener("click", () => moveItem(item.localId, 1));
  });
}

function moveItem(id, delta) {
  const index = state.items.findIndex((i) => i.localId === id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= state.items.length) return;
  [state.items[index], state.items[target]] = [state.items[target], state.items[index]];
  render();
}

function renderBatchBar() {
  if (!state.items.length) return;
  const inspected = state.items.filter((i) => i.inspectStatus === "ready");
  const ready = downloadableItems();
  const failed = state.items.filter((i) => i.inspectStatus === "failed" || i.jobStatus === "failed");
  const active = state.items.filter((i) => ["submitting", "queued", "processing"].includes(i.jobStatus));
  const totalBytes = ready.reduce((sum, i) => sum + Number(i.sizeBytes || 0), 0);

  $("#batch-summary").textContent = `${ready.length}/${inspected.length} 준비`;
  $("#batch-detail").textContent = active.length
    ? `${active.length}개 처리 중`
    : failed.length
      ? `${failed.length}개 실패`
      : ready.length === inspected.length && inspected.length
        ? `${formatBytes(totalBytes)} · 다운로드 가능`
        : "준비 전";

  retryButton.classList.toggle("hidden", !failed.some((i) => i.jobStatus === "failed"));
  const progressWrap = $("#batch-progress-wrap");
  progressWrap.classList.toggle("hidden", !active.length);
  $("#batch-progress").classList.toggle("indeterminate", !!active.length);

  const allDone = inspected.length > 0 && ready.length + failed.filter((i) => i.jobStatus === "failed").length === inspected.length && !active.length;
  if (allDone && ready.length) {
    batchButton.textContent = `와다다 다운로드 · ${ready.length}`;
    batchButton.disabled = false;
  } else if (active.length || state.preparing) {
    batchButton.textContent = `준비 중 · ${active.length}`;
    batchButton.disabled = true;
  } else {
    batchButton.textContent = `모두 준비 · ${inspected.length}`;
    batchButton.disabled = inspected.length === 0;
  }

  if (state.sentDownloads.size) {
    $("#batch-detail").textContent = `${state.sentDownloads.size}/${ready.length}개 다운로드 요청 전송`;
  }
}

async function loadHistory() {
  const root = $("#history");
  try {
    const data = await api("/api/history");
    if (!data.items.length) {
      root.innerHTML = '<span class="muted">아직 기록이 없어.</span>';
      return;
    }
    root.innerHTML = data.items.slice(0, 24).map((item) => `
      <div class="history-row">
        <div class="history-main"><strong>${escapeHtml(item.title)}</strong><span>${item.media_type.toUpperCase()} · ${item.quality}${item.media_type === "mp3" ? "k" : "p"} · ${escapeHtml(item.stage)}</span></div>
        <div class="history-side">${item.status === "ready" ? `<a href="/api/download/${item.id}" class="text-button">다운로드</a>` : `<span class="muted">${escapeHtml(item.status)}</span>`}</div>
      </div>`).join("");
  } catch (error) {
    root.innerHTML = `<span class="error-line">${escapeHtml(error.message)}</span>`;
  }
}

async function checkHealth() {
  try {
    await api("/api/health");
    $("#health").textContent = "online";
    $("#health").classList.add("ok");
  } catch {
    $("#health").textContent = "offline";
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

async function mapLimit(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

function findItem(id) { return state.items.find((item) => item.localId === id); }
function downloadableItems() { return state.items.filter((i) => i.jobStatus === "ready" && i.jobId); }
function terminalCount() { return state.items.filter((i) => ["ready", "failed"].includes(i.jobStatus)).length; }
function nearestQuality(list, target) {
  if (!list?.length) return 720;
  return [...list].sort((a,b) => Math.abs(a-target) - Math.abs(b-target))[0];
}
function statusLabel(item) {
  if (item.inspectStatus === "loading") return "분석 중";
  if (item.inspectStatus === "failed") return "분석 실패";
  if (item.jobStatus === "idle") return "준비 전";
  if (item.jobStatus === "submitting") return "등록 중";
  if (item.jobStatus === "queued") return "대기 중";
  if (item.jobStatus === "processing") return "처리 중";
  if (item.jobStatus === "ready") return item.jobStage === "reused" ? "캐시 준비" : "준비 완료";
  if (item.jobStatus === "failed") return "실패";
  return item.jobStatus;
}
function formatDuration(seconds) {
  if (!seconds) return "--:--";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h ? `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}` : `${m}:${String(s).padStart(2,"0")}`;
}
function formatBytes(bytes) {
  if (!bytes) return "용량 계산 중";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
}
function escapeAttr(value) { return escapeHtml(value); }
function toast(message, timeout = 3200) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), timeout);
}
