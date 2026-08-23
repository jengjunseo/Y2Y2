const ENDPOINT = 'https://release-youtubei.sandbox.googleapis.com/youtubei/v1/player';
const CLIENTS = [
  { label: 'Android', clientName: 'ANDROID', clientVersion: '20.42.38', androidSdkVersion: 30 },
  { label: 'iOS fallback', clientName: 'IOS', clientVersion: '19.45.4' },
];

const $ = (s) => document.querySelector(s);
const input = $('#url-input');
const resolveButton = $('#resolve-button');
const result = $('#result');
const statusCard = $('#status-card');
const statusLog = $('#status-log');
const resolverState = $('#resolver-state');

$('#paste-button').addEventListener('click', async () => {
  try {
    input.value = await navigator.clipboard.readText();
    if (input.value.trim()) await resolveCurrent();
  } catch {
    toast('클립보드 권한이 없어요. 직접 붙여넣어 주세요.');
  }
});
resolveButton.addEventListener('click', resolveCurrent);
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') resolveCurrent();
});

async function resolveCurrent() {
  const videoId = parseVideoId(input.value.trim());
  if (!videoId) return toast('올바른 YouTube 링크 또는 11자리 영상 ID를 넣어 주세요.');

  setBusy(true);
  result.classList.add('hidden');
  statusCard.classList.remove('hidden');
  statusLog.innerHTML = '';
  setResolverState('RUNNING', 'working');
  log(`영상 ID · ${videoId}`);

  try {
    const resolved = await resolveWithClients(videoId);
    const json = resolved.json;
    const streaming = json.streamingData;
    if (!streaming) throw new Error(json.playabilityStatus?.reason || 'streamingData가 없습니다.');

    log(`${resolved.client.label} client · player 응답 성공`, 'good');
    renderVideo(json, videoId, resolved.client.label);
    renderProgressive(streaming.formats || [], json.videoDetails?.title || videoId);
    renderAdaptive(streaming.adaptiveFormats || [], json.videoDetails?.title || videoId);
    result.classList.remove('hidden');
    setResolverState('SUCCESS', 'good');
  } catch (error) {
    console.error(error);
    log(error.message || String(error), 'bad');
    setResolverState('FAILED', 'bad');
  } finally {
    setBusy(false);
  }
}

async function resolveWithClients(videoId) {
  let lastError = null;
  for (const client of CLIENTS) {
    log(`${client.label} client 시도…`);
    try {
      const payload = {
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
        context: {
          client: {
            hl: 'ko',
            gl: 'KR',
            clientName: client.clientName,
            clientVersion: client.clientVersion,
            ...(client.androidSdkVersion ? { androidSdkVersion: client.androidSdkVersion } : {}),
          },
        },
      };
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`${client.label}: HTTP ${response.status}`);
      const json = await response.json();
      if (!json.streamingData) {
        throw new Error(`${client.label}: ${json.playabilityStatus?.reason || json.playabilityStatus?.status || '스트림 없음'}`);
      }
      return { client, json };
    } catch (error) {
      lastError = error;
      log(error.message || String(error), 'warn');
    }
  }
  throw lastError || new Error('모든 순수 웹 client가 실패했습니다.');
}

function renderVideo(json, videoId, clientLabel) {
  const details = json.videoDetails || {};
  $('#video-title').textContent = details.title || videoId;
  $('#video-subtitle').textContent = [details.author, formatDuration(details.lengthSeconds), clientLabel].filter(Boolean).join(' · ');
  const thumbs = details.thumbnail?.thumbnails || [];
  $('#thumbnail').src = thumbs.at(-1)?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

function renderProgressive(formats, title) {
  const host = $('#progressive-list');
  const usable = formats.filter(hasDirectUrl).sort(sortByQuality);
  if (!usable.length) {
    host.innerHTML = emptyCard('직접 URL이 있는 progressive MP4가 없습니다.');
    return;
  }
  host.innerHTML = usable.map((format) => formatCard(format, 'progressive')).join('');
  bindFormatActions(host, usable, title);
}

function renderAdaptive(formats, title) {
  const host = $('#adaptive-list');
  const usable = formats.filter(hasDirectUrl).sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0));
  if (!usable.length) {
    host.innerHTML = emptyCard('직접 URL이 있는 adaptive 포맷이 없습니다. PO/SABR 제한일 수 있습니다.');
    return;
  }
  host.innerHTML = usable.slice(0, 16).map((format) => formatCard(format, 'adaptive')).join('');
  bindFormatActions(host, usable.slice(0, 16), title);
}

function formatCard(format, kind) {
  const mime = String(format.mimeType || '');
  const isAudio = mime.startsWith('audio/');
  const quality = isAudio
    ? `${Math.round(Number(format.bitrate || 0) / 1000)} kbps audio`
    : `${format.height || '?'}p${format.fps ? ` · ${format.fps}fps` : ''}`;
  const codec = mime.match(/codecs="([^"]+)"/)?.[1] || mime.split(';')[0] || 'unknown';
  const size = format.contentLength ? formatBytes(Number(format.contentLength)) : 'size unknown';
  const tag = kind === 'progressive' ? 'ONE FILE' : isAudio ? 'AUDIO' : 'VIDEO ONLY';
  return `<article class="format-card panel" data-itag="${Number(format.itag || 0)}">
    <div><div class="format-top"><span class="badge mini">${tag}</span><strong>${escapeHtml(quality)}</strong></div><p>${escapeHtml(codec)} · itag ${Number(format.itag || 0)} · ${size}</p></div>
    <div class="format-actions">
      <button class="button secondary open-btn" type="button">직접 열기</button>
      ${kind === 'adaptive' ? '<button class="button ghost probe-btn" type="button">CORS 검사</button>' : ''}
    </div>
    <div class="probe-result muted"></div>
  </article>`;
}

function bindFormatActions(host, formats, title) {
  host.querySelectorAll('.format-card').forEach((card) => {
    const itag = Number(card.dataset.itag);
    const format = formats.find((item) => Number(item.itag) === itag);
    if (!format) return;

    card.querySelector('.open-btn')?.addEventListener('click', () => {
      window.open(withTitle(format.url, title), '_blank', 'noopener,noreferrer');
    });

    card.querySelector('.probe-btn')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const output = card.querySelector('.probe-result');
      button.disabled = true;
      button.textContent = '검사 중…';
      output.textContent = '';
      try {
        const response = await fetch(format.url, {
          method: 'GET',
          mode: 'cors',
          credentials: 'omit',
          redirect: 'follow',
          headers: { Range: 'bytes=0-1' },
        });
        if (!response.ok && response.status !== 206) throw new Error(`HTTP ${response.status}`);
        const chunk = await response.arrayBuffer();
        output.className = 'probe-result good-text';
        output.textContent = `CORS 성공 · JS가 ${chunk.byteLength} bytes 읽음 → 브라우저 변환 가능 후보`;
      } catch (error) {
        output.className = 'probe-result bad-text';
        output.textContent = `CORS 차단/요청 실패 · ${friendlyNetworkError(error)}`;
      } finally {
        button.disabled = false;
        button.textContent = 'CORS 검사';
      }
    });
  });
}

function parseVideoId(value) {
  if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.hostname === 'youtu.be') return validId(url.pathname.split('/').filter(Boolean)[0]);
    if (url.hostname.endsWith('youtube.com')) {
      const watch = validId(url.searchParams.get('v'));
      if (watch) return watch;
      const parts = url.pathname.split('/').filter(Boolean);
      if (['shorts', 'embed', 'live'].includes(parts[0])) return validId(parts[1]);
    }
  } catch {}
  return null;
}

function validId(value) {
  return /^[A-Za-z0-9_-]{11}$/.test(value || '') ? value : null;
}

function hasDirectUrl(format) {
  return typeof format?.url === 'string' && /^https:\/\//.test(format.url);
}

function sortByQuality(a, b) {
  return Number(b.height || 0) - Number(a.height || 0) || Number(b.bitrate || 0) - Number(a.bitrate || 0);
}

function withTitle(raw, title) {
  try {
    const url = new URL(raw);
    url.searchParams.set('title', sanitizeName(title));
    return url.toString();
  } catch {
    return raw;
  }
}

function sanitizeName(value) {
  return String(value || 'Y2Y2').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Y2Y2';
}

function setBusy(busy) {
  resolveButton.disabled = busy;
  resolveButton.textContent = busy ? '분석 중…' : '분석';
  input.disabled = busy;
}

function setResolverState(text, kind = '') {
  resolverState.textContent = text;
  resolverState.className = `badge ${kind}`.trim();
}

function log(message, kind = '') {
  const row = document.createElement('div');
  row.className = `log-row ${kind}`.trim();
  row.textContent = message;
  statusLog.appendChild(row);
}

function emptyCard(message) {
  return `<div class="empty panel">${escapeHtml(message)}</div>`;
}

function formatDuration(seconds) {
  const n = Number(seconds || 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = Math.floor(n % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'size unknown';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(i > 1 ? 2 : 1)} ${units[i]}`;
}

function friendlyNetworkError(error) {
  const text = error?.message || String(error);
  return /Failed to fetch|NetworkError|Load failed/i.test(text) ? '브라우저가 응답 body 접근을 허용하지 않음' : text;
}

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove('show'), 2600);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
