const $ = (s) => document.querySelector(s);
const seed = new URLSearchParams(location.hash.slice(1));
if (/^[\w-]{11}$/.test(seed.get('video') || '')) {
  $('#url').value = `https://www.youtube.com/watch?v=${seed.get('video')}`;
}
let token = '', selected = null, busy = false, polling = false, jobSignature = '';
function notice(message, error = false) { $('#notice').textContent = message; $('#notice').className = error ? 'error' : ''; }
function sourceUrl(raw) {
  const value = raw.trim();
  if (/^[\w-]{11}$/.test(value)) return `https://www.youtube.com/watch?v=${value}`;
  let url;
  try { url = new URL(value); } catch { throw new Error('올바른 YouTube 링크를 넣어 주세요.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(url.hostname)) throw new Error('올바른 YouTube 링크를 넣어 주세요.');
  const parts = url.pathname.split('/').filter(Boolean);
  const id = url.hostname === 'youtu.be' ? parts[0] : (url.searchParams.get('v') || (['shorts', 'live', 'embed'].includes(parts[0]) ? parts[1] : ''));
  if (!/^[\w-]{11}$/.test(id || '')) throw new Error('영상 한 개의 링크를 넣어 주세요.');
  return `https://www.youtube.com/watch?v=${id}`;
}
async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(path, { method, cache: 'no-store', headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(path === '/v1/inspect' ? 90000 : 15000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '요청을 처리하지 못했습니다.');
  return data;
}
function friendly(error) {
  const message = error?.message || String(error);
  if (/not a bot|LOGIN_REQUIRED|Sign in/i.test(message)) return 'YouTube에서 이 요청을 허용하지 않았습니다. 다른 공개 영상을 시도하거나 잠시 후 다시 시도해 주세요.';
  if (/fetch|network/i.test(message)) return 'Y2Y2 연결이 끊겼습니다. 실행 중인지 확인해 주세요.';
  if (/timeout|aborted/i.test(message)) return '응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.';
  return message.replace(/https?:\/\/\S+/g, '[주소 생략]').slice(0, 450);
}
function qualities() {
  if (!selected) return;
  const mp3 = $('#type').value === 'mp3';
  const values = mp3 ? selected.mp3Qualities : selected.mp4Qualities;
  $('#quality').replaceChildren(...values.map(value => new Option(`${value}${mp3 ? ' kbps' : 'p'}`, String(value))));
  $('#quality').value = String(values.includes(mp3 ? 192 : 720) ? (mp3 ? 192 : 720) : values.at(-1));
  $('#quality-label').textContent = mp3 ? '음질' : '화질';
  $('#download').disabled = !values.length;
  $('#quality-note').textContent = mp3 ? 'MP3 비트레이트는 출력 설정입니다. 원본보다 음질이 좋아지지는 않습니다.' : values.length ? '원본에서 제공하는 화질만 표시합니다. 영상과 소리를 함께 저장합니다.' : '이 영상에서 저장 가능한 MP4 화질을 찾지 못했습니다.';
}
$('#type').addEventListener('change', qualities);
$('#url').addEventListener('input', () => { selected = null; $('#video').hidden = true; });
$('#form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy || !token) return;
  let url; try { url = sourceUrl($('#url').value); } catch (error) { notice(error.message, true); return; }
  busy = true; selected = null; $('#video').hidden = true; $('#analyze').disabled = true; $('#url').disabled = true; $('#analyze').textContent = '분석 중'; notice('영상 정보를 확인하고 있습니다…');
  try {
    selected = { ...await api('/v1/inspect', { url }), url };
    $('#title').textContent = selected.title;
    $('#meta').textContent = `${selected.channel} · ${Math.floor(selected.duration / 60)}분 ${selected.duration % 60}초`;
    $('#thumbnail').src = selected.thumbnail; qualities(); $('#video').hidden = false; notice('준비됐습니다. 파일 형식과 화질을 골라 주세요.');
  } catch (error) { notice(friendly(error), true); }
  finally { busy = false; $('#analyze').disabled = false; $('#url').disabled = false; $('#analyze').textContent = '분석'; }
});
$('#download').addEventListener('click', async () => {
  if (!selected) return;
  $('#download').disabled = true;
  try { await api('/v1/jobs', { url: selected.url, title: selected.title, mediaType: $('#type').value, quality: Number($('#quality').value) }); notice('저장을 시작했습니다. 아래에서 진행 상황을 확인하세요.'); await refresh(); }
  catch (error) { notice(friendly(error), true); }
  finally { $('#download').disabled = false; }
});
const stages = { queued: '대기 중', processing: '처리 중', downloading: '받는 중', finishing: '영상·오디오 정리 중', ready: '저장 완료', failed: '실패', canceled: '취소됨', canceling: '취소 중', saved: '저장 완료' };
function renderJobs(items) {
  const signature = JSON.stringify(items); if (signature === jobSignature) return; jobSignature = signature;
  $('#count').textContent = `${items.length}개`; if (!items.length) return;
  $('#jobs').replaceChildren(...items.map(job => {
    const card = document.createElement('article'); card.className = 'job';
    const title = document.createElement('h3'); title.textContent = job.title;
    const state = document.createElement('p'); state.textContent = `${job.mediaType.toUpperCase()} · ${job.quality}${job.mediaType === 'mp3' ? ' kbps' : 'p'} · ${stages[job.stage] || stages[job.status] || '처리 중'}`;
    card.append(title, state);
    if (['processing', 'queued'].includes(job.status)) { const progress = document.createElement('progress'); progress.max = 100; progress.value = Math.max(0, Math.min(99, Number(job.progress || 0))); card.append(progress); }
    if (job.status === 'ready') { const file = document.createElement('p'); file.textContent = `${job.filename} · ${(job.sizeBytes / 1048576).toFixed(1)} MB`; card.append(file); }
    if (job.error && job.status === 'failed') { const error = document.createElement('p'); error.className = 'error'; error.textContent = friendly({ message: job.error }); card.append(error); }
    const actions = document.createElement('div'); actions.className = 'job-actions';
    const action = job.status === 'ready' ? ['파일 위치 열기', 'reveal'] : ['failed', 'canceled'].includes(job.status) ? ['다시 시도', 'retry'] : ['취소', 'cancel'];
    const button = document.createElement('button'); button.className = 'secondary'; button.textContent = action[0];
    button.addEventListener('click', async () => { button.disabled = true; try { await api(`/v1/jobs/${job.id}${action[1] === 'cancel' ? '' : '/' + action[1]}`, action[1] === 'cancel' ? undefined : {}, action[1] === 'cancel' ? 'DELETE' : 'POST'); await refresh(); } catch (error) { notice(friendly(error), true); } finally { button.disabled = false; } });
    actions.append(button); card.append(actions); return card;
  }));
}
async function refresh() {
  if (!token || polling) return; polling = true;
  try { renderJobs((await api('/v1/jobs')).items); } catch (error) { notice(friendly(error), true); } finally { polling = false; }
}
try {
  const response = await fetch('/session', { headers: { 'X-Y2Y2-Local': '1' }, cache: 'no-store', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Y2Y2를 다시 실행해 주세요.');
  const session = await response.json(); token = session.token; $('#folder').textContent = session.outputDirectory; await refresh();
} catch (error) { notice(friendly(error), true); $('#analyze').disabled = true; }
const pollTimer = setInterval(refresh, 1500);
$('#quit').addEventListener('click', async () => {
  try {
    await api('/quit', {}); clearInterval(pollTimer); token = ''; selected = null;
    document.querySelectorAll('button, input, select').forEach(element => { element.disabled = true; });
    notice('Y2Y2를 종료했습니다. 이 탭을 닫아도 됩니다.');
  } catch (error) { notice(friendly(error), true); }
});
