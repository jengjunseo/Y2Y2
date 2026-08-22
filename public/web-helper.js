const Y2Y2_ORIGIN = 'https://y2-y2.vercel.app';
const HELPER_PARAM = 'helper';

function helperBookmarklet() {
  (async () => {
    const APP = 'https://y2-y2.vercel.app';
    const isYouTube = /(^|\.)youtube\.com$/i.test(location.hostname);
    if (!isYouTube) {
      alert('Y2Y2 Helper는 YouTube 영상 페이지에서 실행하세요.');
      return;
    }

    const currentVideoId = (() => {
      try {
        const u = new URL(location.href);
        const watch = u.searchParams.get('v');
        if (/^[\w-]{11}$/.test(watch || '')) return watch;
        const parts = u.pathname.split('/').filter(Boolean);
        if (['shorts', 'embed', 'live'].includes(parts[0]) && /^[\w-]{11}$/.test(parts[1] || '')) return parts[1];
      } catch {}
      return null;
    })();

    if (!currentVideoId) {
      alert('현재 페이지에서 YouTube 영상 ID를 찾지 못했습니다.');
      return;
    }

    function parseMaybe(value) {
      if (!value) return null;
      if (typeof value === 'object') return value;
      try { return JSON.parse(value); } catch { return null; }
    }

    async function resolvePlayer() {
      const candidates = [
        parseMaybe(window.ytplayer?.config?.args?.raw_player_response),
        parseMaybe(window.ytplayer?.config?.args?.player_response),
        parseMaybe(window.ytInitialPlayerResponse)
      ];
      const existing = candidates.find((item) => item?.videoDetails?.videoId === currentVideoId && item?.streamingData);
      if (existing) return existing;

      const cfg = window.ytcfg;
      const key = cfg?.get?.('INNERTUBE_API_KEY');
      const context = cfg?.get?.('INNERTUBE_CONTEXT');
      if (!key || !context) throw new Error('YouTube player context를 찾지 못했습니다. 새로고침 후 다시 시도하세요.');
      const response = await fetch(`/youtubei/v1/player?key=${encodeURIComponent(key)}&prettyPrint=false`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ context, videoId: currentVideoId, contentCheckOk: true, racyCheckOk: true })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.playabilityStatus?.status !== 'OK') {
        throw new Error(data?.playabilityStatus?.reason || `YouTube 응답 ${response.status}`);
      }
      return data;
    }

    function directOnly(list) {
      return (Array.isArray(list) ? list : []).filter((f) => {
        if (typeof f?.url !== 'string' || !f.url.startsWith('https://')) return false;
        try {
          const h = new URL(f.url).hostname;
          return h === 'googlevideo.com' || h.endsWith('.googlevideo.com');
        } catch { return false; }
      });
    }

    function compact(f) {
      return {
        itag: Number(f.itag || 0),
        mimeType: String(f.mimeType || ''),
        bitrate: Number(f.bitrate || 0),
        width: Number(f.width || 0) || null,
        height: Number(f.height || 0) || null,
        fps: Number(f.fps || 0) || null,
        contentLength: Number(f.contentLength || 0) || null,
        audioQuality: f.audioQuality || null,
        url: f.url
      };
    }

    let player;
    try {
      player = await resolvePlayer();
    } catch (error) {
      alert(`Y2Y2 Helper: ${error?.message || error}`);
      return;
    }

    const progressive = directOnly(player?.streamingData?.formats)
      .filter((f) => /video\/mp4/i.test(String(f.mimeType || '')))
      .sort((a, b) => Number(b.height || 0) - Number(a.height || 0))
      .slice(0, 6)
      .map(compact);
    const audio = directOnly(player?.streamingData?.adaptiveFormats)
      .filter((f) => /audio\//i.test(String(f.mimeType || '')))
      .sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0))
      .slice(0, 6)
      .map(compact);

    if (!progressive.length && !audio.length) {
      alert('Y2Y2 Helper: 현재 player response에 직접 사용할 수 있는 스트림 URL이 없습니다.');
      return;
    }

    const nonce = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    const receiver = window.open(`${APP}/?helper=1#${encodeURIComponent(nonce)}`, 'Y2Y2_WEB_HELPER');
    if (!receiver) {
      alert('Y2Y2 창을 열지 못했습니다. 팝업 허용 후 다시 시도하세요.');
      return;
    }

    const media = {
      title: String(player?.videoDetails?.title || currentVideoId),
      videoId: currentVideoId,
      progressive,
      audio
    };

    function withTitle(raw, title) {
      try {
        const url = new URL(raw);
        url.searchParams.set('title', String(title || 'Y2Y2').replace(/[\\/:*?\"<>|]/g, '_').slice(0, 120));
        return url.toString();
      } catch { return raw; }
    }

    async function streamToReceiver(item) {
      const response = await fetch(item.url, { mode: 'cors', credentials: 'omit', redirect: 'follow' });
      if (!response.ok || !response.body) throw new Error(`GoogleVideo 응답 ${response.status}`);
      const total = Number(response.headers.get('content-length') || item.contentLength || 0);
      receiver.postMessage({ type: 'Y2Y2_MEDIA_START', nonce, mimeType: response.headers.get('content-type') || item.mimeType, total }, APP);
      const reader = response.body.getReader();
      let loaded = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        loaded += value.byteLength;
        const copy = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
        receiver.postMessage({ type: 'Y2Y2_MEDIA_CHUNK', nonce, loaded, total, chunk: copy }, APP, [copy]);
      }
      receiver.postMessage({ type: 'Y2Y2_MEDIA_DONE', nonce, loaded, total }, APP);
    }

    const listener = async (event) => {
      if (event.origin !== APP || event.source !== receiver || event.data?.nonce !== nonce) return;
      if (event.data.type === 'Y2Y2_HELPER_READY') {
        receiver.postMessage({ type: 'Y2Y2_MEDIA_INFO', nonce, media }, APP);
        return;
      }
      if (event.data.type === 'Y2Y2_DIRECT_DOWNLOAD') {
        const item = progressive.find((f) => Number(f.itag) === Number(event.data.itag));
        if (!item) return;
        window.open(withTitle(item.url, media.title), '_blank', 'noopener');
        return;
      }
      if (event.data.type === 'Y2Y2_FETCH_AUDIO') {
        const requested = audio.find((f) => Number(f.itag) === Number(event.data.itag));
        const fallback = progressive[progressive.length - 1] || progressive[0];
        const item = requested || fallback;
        if (!item) {
          receiver.postMessage({ type: 'Y2Y2_MEDIA_ERROR', nonce, error: '전송 가능한 오디오 스트림이 없습니다.' }, APP);
          return;
        }
        try {
          await streamToReceiver(item);
        } catch (error) {
          receiver.postMessage({ type: 'Y2Y2_MEDIA_ERROR', nonce, error: String(error?.message || error) }, APP);
        }
      }
    };
    window.addEventListener('message', listener);
    setTimeout(() => receiver?.postMessage({ type: 'Y2Y2_PING', nonce }, APP), 500);
  })();
}

function bookmarkletHref() {
  return `javascript:(${helperBookmarklet.toString()})()`;
}

function addStyle() {
  const style = document.createElement('style');
  style.textContent = `
    .web-helper-panel{border:1px solid #34343a;background:linear-gradient(180deg,#121216,#0d0d10);border-radius:24px;padding:24px;margin-bottom:18px}
    .web-helper-top{display:flex;justify-content:space-between;gap:18px;align-items:center;flex-wrap:wrap}
    .web-helper-copy strong{font-size:24px;display:block;margin:5px 0 8px}.web-helper-copy p{margin:0;color:#a6a6b2;line-height:1.55}
    .web-helper-actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.web-helper-bookmark{display:inline-flex;align-items:center;justify-content:center;padding:13px 18px;border-radius:14px;background:#f3f3f5;color:#111116;text-decoration:none;font-weight:800}
    .web-helper-note{margin-top:16px;padding-top:16px;border-top:1px solid #2b2b31;color:#8e8e9a;font-size:14px;line-height:1.55}
    .helper-shell{max-width:860px;margin:0 auto;padding:24px 16px 80px}.helper-card{border:1px solid #2d2d33;background:#101014;border-radius:24px;padding:24px}.helper-card h1{margin:0 0 8px}.helper-status{color:#aaaab5;margin:0 0 20px}.helper-title{font-size:21px;font-weight:800;margin:16px 0}.helper-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.helper-box{border:1px solid #303038;border-radius:18px;padding:18px;background:#15151a}.helper-box h2{font-size:16px;margin:0 0 12px}.helper-select{width:100%;padding:12px;border-radius:12px;background:#0d0d10;color:#eee;border:1px solid #34343a;margin-bottom:10px}.helper-btn{width:100%;padding:13px;border:0;border-radius:12px;font-weight:800;cursor:pointer;background:#f1f1f3;color:#111}.helper-btn.secondary{background:#24242b;color:#eee}.helper-progress{height:8px;background:#26262d;border-radius:999px;overflow:hidden;margin-top:14px}.helper-progress>div{height:100%;background:#ededf1;width:0}.helper-log{color:#aaaab5;font-size:14px;margin-top:10px;min-height:20px}@media(max-width:650px){.helper-grid{grid-template-columns:1fr}.web-helper-copy strong{font-size:20px}}
  `;
  document.head.appendChild(style);
}

function injectLauncher() {
  const engine = document.getElementById('engine-panel');
  if (!engine) return;
  const section = document.createElement('section');
  section.className = 'web-helper-panel';
  section.innerHTML = `
    <div class="web-helper-top">
      <div class="web-helper-copy">
        <span class="eyebrow">WEB HELPER · USER ORIGIN</span>
        <strong>Engine 없이, 내 브라우저에서 직접</strong>
        <p>아래 Helper를 북마크에 저장하고 YouTube 영상 페이지에서 누르면 됩니다. 서버가 YouTube를 대신 요청하지 않습니다.</p>
      </div>
      <div class="web-helper-actions">
        <a id="y2y2-bookmarklet" class="web-helper-bookmark" href="#">Y2Y2 Helper</a>
        <button id="copy-y2y2-helper" class="chip">Helper 코드 복사</button>
      </div>
    </div>
    <div class="web-helper-note">PC: <b>Y2Y2 Helper</b> 버튼을 북마크바로 드래그 → YouTube 영상 페이지에서 클릭. 모바일은 북마크 URL을 Helper 코드로 바꿔 실행할 수 있습니다. MP4는 GoogleVideo 직통, MP3는 브라우저에서 변환합니다.</div>
  `;
  engine.parentNode.insertBefore(section, engine);
  const href = bookmarkletHref();
  const link = section.querySelector('#y2y2-bookmarklet');
  link.href = href;
  section.querySelector('#copy-y2y2-helper').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(href);
      const toast = document.getElementById('toast');
      if (toast) { toast.textContent = 'Y2Y2 Helper 코드를 복사했습니다.'; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 2200); }
    } catch { prompt('아래 코드를 북마크 URL에 넣으세요.', href); }
  });
}

function safeName(value, ext) {
  const base = String(value || 'Y2Y2').replace(/[\\/:*?\"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 140) || 'Y2Y2';
  return `${base}.${ext}`;
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function floatTo16Bit(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

async function loadLame() {
  if (window.lamejs?.Mp3Encoder) return window.lamejs;
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js';
    script.onload = resolve;
    script.onerror = () => reject(new Error('MP3 encoder를 불러오지 못했습니다.'));
    document.head.appendChild(script);
  });
  if (!window.lamejs?.Mp3Encoder) throw new Error('MP3 encoder 초기화 실패');
  return window.lamejs;
}

async function encodeMp3(bytes, title, bitrate, setStatus) {
  setStatus('오디오 디코딩 중…');
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error('이 브라우저는 Web Audio를 지원하지 않습니다.');
  const ctx = new AudioCtx();
  try {
    const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const audio = await ctx.decodeAudioData(source);
    const lamejs = await loadLame();
    const channels = Math.min(2, audio.numberOfChannels || 1);
    const left = floatTo16Bit(audio.getChannelData(0));
    const right = channels > 1 ? floatTo16Bit(audio.getChannelData(1)) : null;
    const encoder = new lamejs.Mp3Encoder(channels, audio.sampleRate, bitrate);
    const chunks = [];
    const block = 1152;
    for (let i = 0; i < left.length; i += block) {
      const l = left.subarray(i, i + block);
      const encoded = channels > 1 ? encoder.encodeBuffer(l, right.subarray(i, i + block)) : encoder.encodeBuffer(l);
      if (encoded.length) chunks.push(new Uint8Array(encoded));
      if ((i / block) % 120 === 0) {
        setStatus(`MP3 변환 중… ${Math.min(99, Math.round((i / left.length) * 100))}%`);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    const tail = encoder.flush();
    if (tail.length) chunks.push(new Uint8Array(tail));
    const blob = new Blob(chunks, { type: 'audio/mpeg' });
    downloadBlob(blob, safeName(title, 'mp3'));
    setStatus(`완료 · ${(blob.size / 1024 / 1024).toFixed(1)} MB MP3`);
  } finally {
    ctx.close().catch(() => {});
  }
}

function renderReceiver() {
  addStyle();
  const nonce = decodeURIComponent(location.hash.slice(1) || '');
  document.title = 'Y2Y2 Web Helper';
  document.body.innerHTML = `
    <main class="helper-shell">
      <div class="helper-card">
        <span class="eyebrow">Y2Y2 WEB HELPER</span>
        <h1>브라우저 직접 다운로드</h1>
        <p id="helper-status" class="helper-status">YouTube 탭과 연결하는 중…</p>
        <div id="helper-content" hidden>
          <div id="helper-title" class="helper-title"></div>
          <div class="helper-grid">
            <div class="helper-box"><h2>MP4 · GoogleVideo 직통</h2><select id="helper-mp4" class="helper-select"></select><button id="helper-mp4-btn" class="helper-btn">MP4 다운로드</button></div>
            <div class="helper-box"><h2>MP3 · 이 브라우저에서 변환</h2><select id="helper-audio" class="helper-select"></select><select id="helper-bitrate" class="helper-select"><option value="128">128k</option><option value="192">192k</option><option value="256" selected>256k</option><option value="320">320k</option></select><button id="helper-mp3-btn" class="helper-btn secondary">MP3 만들기</button></div>
          </div>
          <div class="helper-progress"><div id="helper-progress-bar"></div></div><div id="helper-log" class="helper-log"></div>
        </div>
      </div>
    </main>`;

  const opener = window.opener;
  const status = document.getElementById('helper-status');
  const content = document.getElementById('helper-content');
  const titleEl = document.getElementById('helper-title');
  const mp4Select = document.getElementById('helper-mp4');
  const audioSelect = document.getElementById('helper-audio');
  const bitrateSelect = document.getElementById('helper-bitrate');
  const log = document.getElementById('helper-log');
  const bar = document.getElementById('helper-progress-bar');
  let media = null;
  let chunks = [];
  let received = 0;

  const validYouTubeOrigin = (origin) => {
    try { const h = new URL(origin).hostname; return h === 'youtube.com' || h.endsWith('.youtube.com'); } catch { return false; }
  };
  const setStatus = (text) => { log.textContent = text; };

  window.addEventListener('message', async (event) => {
    if (!validYouTubeOrigin(event.origin) || event.source !== opener || event.data?.nonce !== nonce) return;
    const data = event.data;
    if (data.type === 'Y2Y2_PING') {
      opener?.postMessage({ type: 'Y2Y2_HELPER_READY', nonce }, event.origin);
      return;
    }
    if (data.type === 'Y2Y2_MEDIA_INFO') {
      media = data.media;
      status.textContent = 'YouTube 탭 연결됨 · 미디어 바이트는 서버를 통과하지 않습니다.';
      titleEl.textContent = media.title || media.videoId;
      mp4Select.innerHTML = (media.progressive || []).map((f) => `<option value="${f.itag}">${f.height || '?'}p · MP4 · ${f.fps || 30}fps</option>`).join('') || '<option value="">직접 MP4 없음</option>';
      audioSelect.innerHTML = (media.audio || []).map((f) => `<option value="${f.itag}">${Math.round((f.bitrate || 0) / 1000)} kbps · ${String(f.mimeType || '').split(';')[0]}</option>`).join('') || '<option value="">progressive MP4에서 오디오 추출</option>';
      content.hidden = false;
      return;
    }
    if (data.type === 'Y2Y2_MEDIA_START') {
      chunks = []; received = 0; bar.style.width = '0%';
      setStatus(`오디오 전송 시작${data.total ? ` · ${(data.total / 1024 / 1024).toFixed(1)} MB` : ''}`);
      return;
    }
    if (data.type === 'Y2Y2_MEDIA_CHUNK') {
      const chunk = new Uint8Array(data.chunk);
      chunks.push(chunk); received += chunk.byteLength;
      if (data.total) bar.style.width = `${Math.min(100, (received / data.total) * 100)}%`;
      setStatus(`YouTube → 브라우저 ${(received / 1024 / 1024).toFixed(1)} MB`);
      return;
    }
    if (data.type === 'Y2Y2_MEDIA_DONE') {
      const all = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
      chunks = [];
      try { await encodeMp3(all, media?.title, Number(bitrateSelect.value || 256), setStatus); bar.style.width = '100%'; }
      catch (error) { setStatus(`MP3 실패: ${error?.message || error}`); }
      return;
    }
    if (data.type === 'Y2Y2_MEDIA_ERROR') setStatus(`전송 실패: ${data.error || 'unknown error'}`);
  });

  document.getElementById('helper-mp4-btn').addEventListener('click', () => {
    if (!media || !mp4Select.value) return;
    opener?.postMessage({ type: 'Y2Y2_DIRECT_DOWNLOAD', nonce, itag: Number(mp4Select.value) }, '*');
    setStatus('GoogleVideo 직접 다운로드를 열었습니다.');
  });
  document.getElementById('helper-mp3-btn').addEventListener('click', () => {
    if (!media) return;
    chunks = []; received = 0; bar.style.width = '0%';
    opener?.postMessage({ type: 'Y2Y2_FETCH_AUDIO', nonce, itag: Number(audioSelect.value || 0) }, '*');
    setStatus('YouTube 탭에서 오디오를 가져오는 중… 탭을 닫지 마세요.');
  });

  if (!opener || !nonce) status.textContent = 'YouTube 페이지의 Y2Y2 Helper 북마크에서 이 창을 여세요.';
  else opener.postMessage({ type: 'Y2Y2_HELPER_READY', nonce }, '*');
}

const helperMode = new URL(location.href).searchParams.get(HELPER_PARAM) === '1';
window.__Y2Y2_HELPER_MODE__ = helperMode;
if (helperMode) renderReceiver();
else {
  addStyle();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectLauncher, { once: true });
  else injectLauncher();
}
