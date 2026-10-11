const $ = id => document.getElementById(id);
const STORAGE = 'y2y2-device-jobs-v1';
const files = new Map();
let jobs = [], manifest, worker, active;
try { jobs = JSON.parse(localStorage.getItem(STORAGE) || '[]'); if (!Array.isArray(jobs)) jobs = []; } catch {}

const size = value => value > 1024 ** 3 ? (value / 1024 ** 3).toFixed(2) + ' GB' : (value / 1024 ** 2).toFixed(1) + ' MB';
const notice = (message, error = false) => { $('notice').textContent = message; $('notice').className = error ? 'error' : ''; };
const persist = () => { try { localStorage.setItem(STORAGE, JSON.stringify(jobs)); } catch { notice('작업 기록을 보관하지 못했습니다. 이 페이지를 닫으면 작업 복구가 어려울 수 있습니다.', true); } };
const button = (text, action) => { const value = document.createElement('button'); value.type = 'button'; value.textContent = text; value.className = 'secondary'; value.onclick = action; return value; };

function render() {
  $('history').replaceChildren();
  for (const job of jobs.slice().reverse()) {
    const section = document.createElement('section'); section.className = 'job'; section.dataset.job = job.id;
    const title = document.createElement('h3'); title.textContent = job.manifest.title;
    const info = document.createElement('p'); info.textContent = job.choice.label;
    const status = document.createElement('p'); status.setAttribute('role', 'status'); status.textContent = job.message || '기기에 보관된 작업';
    const actions = document.createElement('div'); actions.className = 'job-actions';
    if (job.id === active) {
      const progress = document.createElement('progress'); progress.setAttribute('aria-label', '기기에 저장 중');
      if (job.phase === 'download' && job.total) { progress.max = job.total; progress.value = job.received || 0; }
      section.append(progress);
      actions.append(button('일시중단', () => worker.postMessage({ type: 'pause' })));
    } else {
      const entry = files.get(job.id);
      if (entry) {
        const link = document.createElement('a'); link.className = 'download'; link.href = entry.url;
        link.download = entry.filename; link.textContent = '파일 저장'; actions.append(link);
        if (typeof window.showSaveFilePicker === 'function') {
          actions.append(button('저장 위치 선택', async () => {
            try {
              const handle = await window.showSaveFilePicker({ suggestedName: entry.filename });
              await entry.file.stream().pipeTo(await handle.createWritable());
              notice('선택한 위치에 저장했습니다.');
            } catch (error) { if (error.name !== 'AbortError') notice('파일을 저장하지 못했습니다: ' + error.message, true); }
          }));
        }
      } else {
        const resume = button(job.phase === 'ready' ? '파일 다시 열기' : '이어받기 / 병합 재시도', () => start(job));
        resume.disabled = Boolean(active); actions.append(resume);
      }
      const remove = button('기기 보관 파일 삭제', () => deleteJob(job)); remove.disabled = Boolean(active); actions.append(remove);
    }
    section.prepend(title, info, status); section.append(actions); $('history').append(section);
  }
  $('count').textContent = jobs.length + '개';
  $('create').disabled = Boolean(active) || !manifest;
}

async function deleteJob(job) {
  try {
    await navigator.locks.request('y2y2-device-work', { ifAvailable: true }, async lock => {
      if (!lock) throw Error('다른 탭에서 저장 중입니다.');
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle('y2y2-device', { create: true });
      await directory.removeEntry(job.id, { recursive: true }).catch(error => { if (error.name !== 'NotFoundError') throw error; });
      if (files.has(job.id)) URL.revokeObjectURL(files.get(job.id).url);
      files.delete(job.id); jobs = jobs.filter(value => value.id !== job.id); persist(); render();
    });
  } catch (error) { notice(error.message, true); }
}

function start(job) {
  if (active) return;
  active = job.id;
  notice('선택한 원본 화질로 기기에 저장하고 있습니다.');
  worker?.terminate();
  worker = new Worker('/assets/device-worker.js', { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') {
      Object.assign(job, { phase: data.phase, received: data.received, total: data.total });
      job.message = data.phase === 'download' ? `${size(data.received)} / ${size(data.total)}를 기기에 기록했습니다.` :
        data.phase === 'verify' ? '완성 파일의 영상·음성 데이터가 모두 있는지 확인하고 있습니다.' : '받은 영상·음성을 원본 화질로 합치고 있습니다.';
    } else if (data.type === 'ready') {
      if (files.has(job.id)) URL.revokeObjectURL(files.get(job.id).url);
      files.set(job.id, { url: URL.createObjectURL(data.file), file: data.file, filename: data.filename });
      job.phase = 'ready'; job.message = `${size(data.file.size)} · 병합 완료. 파일 저장을 누르세요.`; active = null;
    } else {
      job.message = data.message; active = null;
      notice(data.message, data.type === 'error');
    }
    persist(); render();
  };
  worker.onerror = () => { job.message = '저장 작업이 중단됐습니다. 이어받기를 시도해 주세요.'; active = null; persist(); render(); };
  job.message = '기기 저장 공간과 보관된 조각을 확인하고 있습니다.';
  render(); worker.postMessage({ type: 'run', job: structuredClone(job) });
}

async function api(path, data) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Y2Y2': '1' }, body: JSON.stringify(data) });
  const value = await response.json();
  if (!response.ok) throw Error(value.message || '서버에 연결하지 못했습니다.');
  return value;
}

$('form').onsubmit = async event => {
  event.preventDefault(); $('inspect').disabled = true; manifest = null; $('result').hidden = true; render(); notice('원본 화질과 오디오를 분석하고 있습니다.');
  try {
    manifest = await api('/v2/inspect', { url: $('url').value });
    $('title').textContent = manifest.title; $('format').replaceChildren();
    for (const choice of manifest.choices) {
      const option = document.createElement('option'); option.value = choice.key;
      option.textContent = choice.label + ' · 약 ' + size(choice.bytes); $('format').append(option);
    }
    $('result').hidden = false; notice('제공되는 원본 화질을 선택하세요. 선택한 화질을 자동으로 낮추지 않습니다.'); render();
  } catch (error) { notice(error.message, true); }
  finally { $('inspect').disabled = false; }
};

$('create').onclick = () => {
  if (!manifest || active) return;
  if (jobs.length >= 8) { notice('보관된 작업이 많습니다. 필요 없는 기기 보관 파일을 삭제한 뒤 시작해 주세요.', true); return; }
  const choice = manifest.choices.find(value => value.key === $('format').value);
  if (!choice) return;
  const selected = structuredClone(manifest);
  selected.tracks = Object.fromEntries([choice.video, choice.audio].filter(Boolean).map(key => [key, selected.tracks[key]]));
  delete selected.choices;
  const job = { id: crypto.randomUUID(), manifest: selected, choice: structuredClone(choice), phase: 'download' };
  jobs.push(job); persist(); start(job);
};

$('login').onsubmit = async event => {
  event.preventDefault();
  try { await api('/v2/login', { password: $('password').value }); $('password').value = ''; $('login').hidden = true; $('workspace').hidden = false; notice('접속했습니다.'); }
  catch (error) { notice(error.message, true); }
};

render();
try {
  const response = await fetch('/health', { cache: 'no-store' });
  const status = await response.json();
  if (!response.ok || status.mode !== 'device-storage') throw Error();
  $('connection').textContent = '기기에 분할 저장';
  $('login').hidden = status.authenticated; $('workspace').hidden = !status.authenticated;
  if (!navigator.storage?.getDirectory || !navigator.locks) {
    notice('이 브라우저는 기기 분할 저장에 필요한 기능을 지원하지 않습니다. 최신 브라우저를 사용해 주세요.', true);
    $('inspect').disabled = true;
  }
} catch { $('connection').textContent = '서버 연결 확인 필요'; notice('다운로드 서버에 연결하지 못했습니다.', true); }
