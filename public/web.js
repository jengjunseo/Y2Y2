const $ = selector => document.querySelector(selector);
let inspection = null, jobTicket = null, busy = false, generation = 0;

function notice(message = '', error = false) { $('#notice').textContent = message; $('#notice').className = error ? 'error' : ''; }
function lock(value) {
  busy = value;
  for (const selector of ['#form button', '#create', '#format', '#login button', '#resume', '#logout']) $(selector).disabled = value;
}
async function api(action, body) {
  let response;
  try { response = await fetch('/api/web?action=' + action, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(55000),
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) }); }
  catch { throw new Error('서버 응답을 받지 못했습니다. 잠시 후 다시 시도해 주세요.'); }
  let data;
  try { data = await response.json(); } catch { throw new Error('서버 응답을 확인할 수 없습니다.'); }
  if (!response.ok) { const error = new Error(data.error || '요청에 실패했습니다.'); error.code = data.code; throw error; }
  return data;
}
async function refresh() {
  const status = await api('status');
  $('#connection').textContent = status.configured ? '웹 전용' : '연결 준비 중';
  $('#unavailable').hidden = status.configured;
  $('#login').hidden = !status.configured || status.authenticated;
  $('#workspace').hidden = !status.configured || !status.authenticated;
  $('#logout').hidden = !status.passwordRequired;
}
async function failure(error) {
  notice(error.message, true);
  if (['LOGIN_REQUIRED', 'EXPIRED'].includes(error.code)) await refresh().catch(() => {});
}
$('#login').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return; lock(true); notice();
  try { await api('login', { password: $('#password').value }); $('#password').value = ''; await refresh(); }
  catch (error) { await failure(error); } finally { lock(false); }
});
$('#logout').addEventListener('click', async () => {
  if (busy) return; lock(true); notice();
  try { await api('logout', {}); generation++; inspection = null; jobTicket = null; $('#result').hidden = true; $('#job').hidden = true; await refresh(); }
  catch (error) { await failure(error); } finally { lock(false); }
});
$('#form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return; lock(true); notice('영상의 저장 형식을 확인하고 있습니다.');
  inspection = null; $('#result').hidden = true;
  try {
    const result = await api('inspect', { url: $('#url').value });
    inspection = result.ticket; $('#title').textContent = result.title;
    $('#format').replaceChildren(...result.choices.map(choice => { const option = document.createElement('option'); option.value = choice.key; option.textContent = choice.label; return option; }));
    $('#result').hidden = false; notice();
  } catch (error) { await failure(error); } finally { lock(false); }
});
async function poll() {
  const current = ++generation, deadline = Date.now() + 10 * 60 * 1000;
  $('#resume').hidden = true; $('#progress').hidden = false; $('#download').hidden = true;
  $('#job-title').textContent = '파일을 준비하고 있습니다';
  $('#job-state').textContent = '서버에서 다운로드·변환 중입니다. 화면을 열어 두세요.';
  try {
    while (current === generation) {
      const result = await api('poll', { ticket: jobTicket });
      if (result.state === 'ready') {
        $('#progress').hidden = true; $('#job-title').textContent = '파일 준비 완료';
        $('#job-state').textContent = '아래 버튼을 눌러 이 기기에 저장하세요. 링크에는 유효기간이 있습니다.';
        const link = $('#download'); link.href = result.url; link.download = 'Y2Y2.' + result.format; link.textContent = result.format.toUpperCase() + ' 파일 저장'; link.hidden = false;
        notice(); return;
      }
      if (Date.now() >= deadline) throw new Error('아직 작업 중입니다. 잠시 후 상태를 다시 확인하세요. 새 다운로드를 요청할 필요는 없습니다.');
      await new Promise(resolve => setTimeout(resolve, 4000));
    }
  } catch (error) {
    $('#progress').hidden = true; $('#job-title').textContent = '파일 준비를 확인하지 못했습니다';
    $('#job-state').textContent = error.message; $('#resume').hidden = false; await failure(error);
  }
}
$('#create').addEventListener('click', async () => {
  if (busy || !inspection) return; lock(true); notice('다운로드 작업을 요청하고 있습니다.');
  $('#job').hidden = true; jobTicket = null;
  try {
    const result = await api('create', { ticket: inspection, choice: $('#format').value });
    jobTicket = result.ticket; $('#job').hidden = false; notice(); await poll();
  } catch (error) { await failure(error); } finally { lock(false); }
});
$('#resume').addEventListener('click', async () => {
  if (busy || !jobTicket) return; lock(true); notice();
  try { await poll(); } finally { lock(false); }
});
if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistrations().then(registrations => {
  for (const registration of registrations) if (new URL(registration.scope).origin === location.origin) registration.unregister();
}).catch(() => {});
refresh().catch(error => { $('#connection').textContent = '연결 실패'; notice(error.message, true); });
