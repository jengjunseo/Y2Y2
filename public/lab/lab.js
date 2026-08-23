const ENDPOINTS = [
  { name: 'youtube.com', url: 'https://www.youtube.com/youtubei/v1/player' },
  { name: 'youtubei.googleapis.com', url: 'https://youtubei.googleapis.com/youtubei/v1/player' },
  { name: 'release sandbox', url: 'https://release-youtubei.sandbox.googleapis.com/youtubei/v1/player' },
  { name: 'youtube-nocookie.com', url: 'https://www.youtube-nocookie.com/youtubei/v1/player' }
];

const CLIENTS = [
  { id: 'web_embedded', name: 'WEB_EMBEDDED_PLAYER', version: '2.20260708.00.00', numeric: 56, thirdParty: true },
  { id: 'web', name: 'WEB', version: '2.20260708.00.00', numeric: 1 },
  { id: 'mweb', name: 'MWEB', version: '2.20260708.05.00', numeric: 2 },
  { id: 'android', name: 'ANDROID', version: '21.26.364', numeric: 3, androidSdkVersion: 30 },
  { id: 'android_vr', name: 'ANDROID_VR', version: '1.65.10', numeric: 28, androidSdkVersion: 32 },
  { id: 'ios', name: 'IOS', version: '21.26.4', numeric: 5 },
  { id: 'visionos', name: 'VISIONOS', version: '1.02', numeric: 101 },
  { id: 'tv', name: 'TVHTML5', version: '7.20260707.07.00', numeric: 7 }
];

const SAMPLES = [
  ['Sq5Dj0U06vQ', '실패 재현'],
  ['jNQXAC9IVRw', '짧은 공개'],
  ['dQw4w9WgXcQ', '일반 공개'],
  ['M7lc1UVf-VE', 'IFrame API 샘플']
];

const state = { records: [], highestLevel: 0 };
const byId = function (id) { return document.getElementById(id); };
const slot = function (name) { return document.querySelector('[data-slot="' + name + '"]'); };

function now() {
  return new Date().toISOString();
}

function safeText(value) {
  if (value instanceof Error) return value.name + ': ' + value.message;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function classifyError(error) {
  const text = safeText(error);
  if (/Failed to fetch|NetworkError|Load failed/i.test(text)) {
    return text + '\n브라우저 보안 경계에서 HTTP 응답이 JS에 노출되지 않았습니다. DNS/HTTP/CORS는 no-cors probe와 DevTools에서 분리해야 합니다.';
  }
  return text;
}

function setHighestLevel(level) {
  if (!Number.isFinite(level) || level <= state.highestLevel) return;
  state.highestLevel = level;
  byId('highest-level').textContent = 'L' + level;
  document.querySelectorAll('.level-strip [data-level]').forEach(function (node) {
    node.classList.toggle('reached', Number(node.dataset.level) <= level);
  });
}

function renderRawLog() {
  const log = byId('raw-log');
  if (!state.records.length) {
    log.textContent = '아직 실행하지 않았습니다.';
    return;
  }
  log.textContent = state.records.map(function (item) {
    return '[' + item.time + '] ' + item.status + ' ' + item.name + '\n' + item.detail;
  }).join('\n\n');
  log.scrollTop = log.scrollHeight;
}

function record(slotName, name, status, detail, level, data) {
  const item = { time: now(), slot: slotName, name: name, status: status, detail: safeText(detail), level: level || 0, data: data || null };
  state.records.push(item);
  const host = slot(slotName);
  if (host) {
    const row = document.createElement('div');
    row.className = 'result-row';
    const title = document.createElement('strong');
    title.textContent = name;
    const badge = document.createElement('span');
    badge.className = 'status ' + status.toLowerCase();
    badge.textContent = status;
    const body = document.createElement('p');
    body.textContent = item.detail;
    row.append(title, badge, body);
    host.appendChild(row);
  }
  if (status === 'PASS' && level) setHighestLevel(level);
  renderRawLog();
  return item;
}

function clearSlot(name) {
  const host = slot(name);
  if (host) host.innerHTML = '';
}

function videoId() {
  const raw = byId('video-input').value.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;
  try {
    const url = new URL(raw);
    const watch = url.searchParams.get('v');
    if (/^[A-Za-z0-9_-]{11}$/.test(watch || '')) return watch;
    const parts = url.pathname.split('/').filter(Boolean);
    const candidate = url.hostname === 'youtu.be' ? parts[0] : parts[1];
    if (/^[A-Za-z0-9_-]{11}$/.test(candidate || '')) return candidate;
  } catch {}
  throw new Error('11자리 영상 ID 또는 YouTube URL을 입력하세요.');
}

function payloadFor(client, id) {
  const clientContext = {
    hl: 'ko', gl: 'KR', clientName: client.name, clientVersion: client.version
  };
  if (client.androidSdkVersion) clientContext.androidSdkVersion = client.androidSdkVersion;
  const context = { client: clientContext };
  if (client.thirdParty) context.thirdParty = { embedUrl: location.origin + '/lab/' };
  return { videoId: id, contentCheckOk: true, racyCheckOk: true, context: context };
}

async function runCapabilities() {
  clearSlot('capabilities');
  const checks = [
    ['Service Worker', 'serviceWorker' in navigator],
    ['CacheStorage', 'caches' in window],
    ['ReadableStream', 'ReadableStream' in window],
    ['MediaSource', 'MediaSource' in window],
    ['WebCodecs VideoDecoder', 'VideoDecoder' in window],
    ['WebCodecs AudioDecoder', 'AudioDecoder' in window],
    ['Web Audio', 'AudioContext' in window || 'webkitAudioContext' in window],
    ['MediaRecorder', 'MediaRecorder' in window],
    ['File System Access', 'showSaveFilePicker' in window],
    ['video.captureStream', 'captureStream' in HTMLVideoElement.prototype]
  ];
  checks.forEach(function (check) {
    record('capabilities', check[0], check[1] ? 'PASS' : 'FAIL', check[1] ? 'API가 노출됨 (media bytes 접근 성공과는 별개)' : '이 브라우저에서 API가 노출되지 않음', 0);
  });
  record('capabilities', 'User agent', 'PARTIAL', navigator.userAgent + '\nplatform=' + navigator.platform + ', secureContext=' + window.isSecureContext, 0);
}

async function runEndpoints() {
  clearSlot('endpoints');
  const id = videoId();
  const client = CLIENTS[0];
  for (const endpoint of ENDPOINTS) {
    try {
      const reachability = await fetch(endpoint.url, { mode: 'no-cors', credentials: 'omit', cache: 'no-store' });
      record('endpoints', endpoint.name + ' · no-cors reachability', reachability.type === 'opaque' ? 'PARTIAL' : 'PASS', 'type=' + reachability.type + ', status=' + reachability.status + ', body=' + String(reachability.body) + '\n네트워크 도달 가능성만 뜻하며 body는 읽을 수 없습니다.', 0);
    } catch (error) {
      record('endpoints', endpoint.name + ' · no-cors reachability', 'FAIL', classifyError(error), 0);
    }

    try {
      const response = await fetch(endpoint.url, {
        method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-youtube-client-name': String(client.numeric), 'x-youtube-client-version': client.version },
        body: JSON.stringify(payloadFor(client, id))
      });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      const hasStreaming = Boolean(json && json.streamingData);
      const formats = (json && json.streamingData && json.streamingData.formats || []).length;
      const adaptive = (json && json.streamingData && json.streamingData.adaptiveFormats || []).length;
      record('endpoints', endpoint.name + ' · CORS POST', hasStreaming ? 'PASS' : 'PARTIAL', 'HTTP ' + response.status + '\nACAO=' + response.headers.get('access-control-allow-origin') + '\nplayability=' + (json && json.playabilityStatus && json.playabilityStatus.status || 'n/a') + '\nformats=' + formats + ', adaptiveFormats=' + adaptive + '\n' + text.slice(0, 900), hasStreaming ? 1 : 0, json);
    } catch (error) {
      record('endpoints', endpoint.name + ' · CORS POST', 'FAIL', classifyError(error), 0);
    }
  }
}

async function runServerResolver() {
  clearSlot('server');
  const id = videoId();
  for (const client of CLIENTS) {
    try {
      const response = await fetch('/api/lab-resolve', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ videoId: id, client: client.id })
      });
      const data = await response.json().catch(function () { return {}; });
      const summary = data.summary || {};
      const directFormats = Number(summary.directFormats || 0) + Number(summary.directAdaptiveFormats || 0);
      const hasMetadata = Boolean(data.player && data.player.videoDetails);
      const status = directFormats > 0 ? 'PASS' : hasMetadata || response.ok ? 'PARTIAL' : 'FAIL';
      const level = directFormats > 0 ? 2 : hasMetadata ? 1 : 0;
      record('server', client.id, status, 'HTTP ' + response.status + '\nendpoint=' + (data.endpoint || 'n/a') + '\nupstream=' + (data.upstreamStatus || 'n/a') + '\nplayability=' + (summary.playabilityStatus || data.error || 'n/a') + '\nformats=' + (summary.formats || 0) + ', adaptive=' + (summary.adaptiveFormats || 0) + ', direct=' + directFormats + ', SABR=' + Boolean(summary.serverAbrStreamingUrl) + ', HLS=' + Boolean(summary.hlsManifestUrl) + '\n' + safeText(data.diagnostics || ''), level, data);
      if (directFormats > 0 && data.player && data.player.streamingData) {
        const all = [].concat(data.player.streamingData.formats || [], data.player.streamingData.adaptiveFormats || []);
        const first = all.find(function (format) { return typeof format.url === 'string'; });
        if (first && !byId('gvs-input').value.trim()) byId('gvs-input').value = first.url;
      }
    } catch (error) {
      record('server', client.id, 'FAIL', classifyError(error), 0);
    }
  }
}

async function runIframe() {
  clearSlot('iframe');
  const id = videoId();
  const host = byId('iframe-host');
  host.hidden = false;
  host.innerHTML = '';
  const frame = document.createElement('iframe');
  frame.allow = 'accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture';
  frame.allowFullscreen = true;
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  frame.src = 'https://www.youtube.com/embed/' + encodeURIComponent(id) + '?enablejsapi=1&origin=' + encodeURIComponent(location.origin) + '&playsinline=1';
  const outcome = await new Promise(function (resolve) {
    const timer = setTimeout(function () { resolve('timeout'); }, 12000);
    frame.addEventListener('load', function () { clearTimeout(timer); resolve('load'); }, { once: true });
    frame.addEventListener('error', function () { clearTimeout(timer); resolve('error'); }, { once: true });
    host.appendChild(frame);
  });
  if (outcome === 'load') record('iframe', 'Official embed document', 'PARTIAL', 'iframe load 이벤트 수신. 이는 player 문서 로드만 증명하며 영상 재생, media URL 또는 bytes 접근을 증명하지 않습니다. SOP 때문에 iframe DOM/network state는 Y2Y2에서 읽을 수 없습니다.', 0);
  else record('iframe', 'Official embed document', 'FAIL', 'iframe ' + outcome + '. Referrer/embedding/network 정책을 DevTools에서 확인하세요.', 0);
}

function getGvsUrl() {
  const raw = byId('gvs-input').value.trim();
  const url = new URL(raw);
  if (!url.hostname.endsWith('.googlevideo.com') && url.hostname !== 'googlevideo.com') throw new Error('googlevideo.com signed URL만 허용합니다.');
  return url.toString();
}

async function probeCors(url, name, init) {
  try {
    const response = await fetch(url, Object.assign({ mode: 'cors', credentials: 'omit', cache: 'no-store' }, init || {}));
    let bytes = 0;
    if (response.body) {
      const reader = response.body.getReader();
      const chunk = await reader.read();
      bytes = chunk.value ? chunk.value.byteLength : 0;
      await reader.cancel();
    }
    const ok = response.ok || response.status === 206;
    record('gvs', name, ok && bytes > 0 ? 'PASS' : 'PARTIAL', 'HTTP ' + response.status + ', type=' + response.type + ', firstChunk=' + bytes + '\ncontent-type=' + response.headers.get('content-type') + '\ncontent-length=' + response.headers.get('content-length') + '\ncontent-range=' + response.headers.get('content-range') + '\naccept-ranges=' + response.headers.get('accept-ranges') + '\nACAO=' + response.headers.get('access-control-allow-origin') + '\nExpose=' + response.headers.get('access-control-expose-headers'), bytes > 0 ? 4 : 0);
  } catch (error) {
    record('gvs', name, 'FAIL', classifyError(error), 0);
  }
}

async function runGvs() {
  clearSlot('gvs');
  const url = getGvsUrl();
  await probeCors(url, 'fetch(url)', {});
  await probeCors(url, 'credentials: omit', { credentials: 'omit' });
  await probeCors(url, 'Range bytes=0-1', { headers: { Range: 'bytes=0-1' } });
  try {
    const response = await fetch(url, { mode: 'no-cors', credentials: 'omit', cache: 'no-store' });
    record('gvs', 'mode: no-cors', 'PARTIAL', 'type=' + response.type + ', status=' + response.status + ', body=' + String(response.body) + ', headers=' + Array.from(response.headers).length + '\n전송 가능성만 있고 bytes를 읽거나 파일로 재구성할 수 없습니다.', 0);
  } catch (error) {
    record('gvs', 'mode: no-cors', 'FAIL', classifyError(error), 0);
  }
}

function openGvs(download) {
  const url = getGvsUrl();
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  if (download) anchor.download = 'Y2Y2-test';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  record('gvs', download ? 'cross-origin download attribute' : 'top-level navigation', 'PARTIAL', '사용자 에이전트에 탐색을 위임했습니다. 실제 Downloads 저장 여부를 확인해 수동 판정하세요. cross-origin download 속성은 서버 Content-Disposition: attachment가 없으면 무시될 수 있습니다.', 3);
}

function loadMedia(kind) {
  const url = getGvsUrl();
  const host = byId('media-host');
  host.innerHTML = '';
  const media = document.createElement(kind);
  media.controls = true;
  media.preload = 'metadata';
  media.src = url;
  media.addEventListener('loadedmetadata', function () {
    record('gvs', '<' + kind + '> media pipeline', 'PARTIAL', 'metadata loaded; duration=' + media.duration + '. 재생은 bytes에 대한 JS 접근을 뜻하지 않습니다.', 0);
  }, { once: true });
  media.addEventListener('error', function () {
    record('gvs', '<' + kind + '> media pipeline', 'FAIL', 'MediaError code=' + (media.error && media.error.code || 'unknown'), 0);
  }, { once: true });
  host.appendChild(media);
  media.load();
}

async function runOpaque() {
  clearSlot('opaque');
  if (!('serviceWorker' in navigator)) {
    record('opaque', 'Service Worker', 'FAIL', '지원되지 않음', 0);
    return;
  }
  const registration = await navigator.serviceWorker.ready;
  const worker = registration.active || registration.waiting || registration.installing;
  if (!worker) {
    record('opaque', 'Service Worker', 'FAIL', 'active worker 없음. 페이지를 새로고침하고 다시 시도하세요.', 0);
    return;
  }
  let target;
  try { target = getGvsUrl(); } catch { target = 'https://i.ytimg.com/vi/' + videoId() + '/hqdefault.jpg'; }
  const channel = new MessageChannel();
  const outcome = await new Promise(function (resolve) {
    const timer = setTimeout(function () { resolve({ error: 'worker timeout' }); }, 12000);
    channel.port1.onmessage = function (event) { clearTimeout(timer); resolve(event.data); };
    worker.postMessage({ type: 'Y2Y2_OPAQUE_PROBE', url: target }, [channel.port2]);
  });
  if (outcome && outcome.ok) record('opaque', 'opaque fetch → CacheStorage', 'PARTIAL', safeText(outcome) + '\n캐시 재사용은 가능하지만 body 추출·변환·Blob 저장은 불가능합니다.', 0, outcome);
  else record('opaque', 'opaque fetch → CacheStorage', 'FAIL', safeText(outcome), 0, outcome);
}

async function runStreaming() {
  clearSlot('streaming');
  let url;
  try { url = getGvsUrl(); } catch (error) { record('streaming', '입력', 'FAIL', error, 0); return; }
  if (/\.m3u8(?:\?|$)/i.test(url) || /manifest\/hls/i.test(url)) {
    try {
      const response = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'no-store' });
      const text = await response.text();
      record('streaming', 'HLS manifest fetch', response.ok && text.includes('#EXTM3U') ? 'PASS' : 'PARTIAL', 'HTTP ' + response.status + ', type=' + response.type + '\n' + text.slice(0, 900), response.ok && text.includes('#EXTM3U') ? 4 : 0);
    } catch (error) { record('streaming', 'HLS manifest fetch', 'FAIL', classifyError(error), 0); }
    return;
  }
  try {
    const response = await fetch(url, { method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store', headers: { 'content-type': 'application/x-protobuf', accept: 'application/vnd.yt-ump' }, body: new Uint8Array() });
    record('streaming', 'SABR-shaped POST', response.ok ? 'PARTIAL' : 'FAIL', 'HTTP ' + response.status + ', content-type=' + response.headers.get('content-type') + '\n빈 protobuf payload는 protocol 성공이 아니라 CORS/HTTP 경계만 검사합니다.', 0);
  } catch (error) { record('streaming', 'SABR-shaped POST', 'FAIL', classifyError(error), 0); }
}

async function runAction(action, button) {
  const runners = { capabilities: runCapabilities, endpoints: runEndpoints, server: runServerResolver, iframe: runIframe, gvs: runGvs, opaque: runOpaque, streaming: runStreaming };
  if (!runners[action]) return;
  button.disabled = true;
  const original = button.textContent;
  button.textContent = '실행 중…';
  try { await runners[action](); }
  catch (error) { record(action === 'server' ? 'server' : action, action, 'FAIL', classifyError(error), 0); }
  finally { button.disabled = false; button.textContent = original; }
}

async function runCore(button) {
  button.disabled = true;
  const original = button.textContent;
  button.textContent = '실험 실행 중…';
  try {
    await runCapabilities();
    await runEndpoints();
    await runServerResolver();
    await runIframe();
    await runOpaque();
  } catch (error) {
    record('endpoints', 'core runner', 'FAIL', classifyError(error), 0);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function exportResults() {
  const report = {
    generatedAt: now(), location: location.href, userAgent: navigator.userAgent,
    highestProvenLevel: state.highestLevel, videoId: byId('video-input').value.trim(), records: state.records
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'y2y2-pure-web-lab-' + Date.now() + '.json';
  anchor.click();
  setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
}

SAMPLES.forEach(function (sample) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'sample';
  button.textContent = sample[1] + ' · ' + sample[0];
  button.addEventListener('click', function () { byId('video-input').value = sample[0]; });
  byId('samples').appendChild(button);
});

document.querySelectorAll('[data-action]').forEach(function (button) {
  button.addEventListener('click', function () {
    const action = button.dataset.action;
    if (action === 'gvs-open') return openGvs(false);
    if (action === 'gvs-download') return openGvs(true);
    if (action === 'gvs-video') return loadMedia('video');
    if (action === 'gvs-audio') return loadMedia('audio');
    return runAction(action, button);
  });
});

byId('run-core-button').addEventListener('click', function () { runCore(byId('run-core-button')); });
byId('export-button').addEventListener('click', exportResults);
byId('clear-button').addEventListener('click', function () {
  state.records = [];
  state.highestLevel = 0;
  byId('highest-level').textContent = 'L0';
  document.querySelectorAll('.result-slot').forEach(function (host) { host.innerHTML = ''; });
  document.querySelectorAll('.level-strip .reached').forEach(function (node) { node.classList.remove('reached'); });
  renderRawLog();
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function (error) {
  record('capabilities', 'Service Worker registration', 'FAIL', classifyError(error), 0);
});
