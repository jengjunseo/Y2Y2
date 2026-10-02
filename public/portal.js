const form = document.querySelector('#form');
const input = document.querySelector('#url');
const notice = document.querySelector('#notice');
const openButton = document.querySelector('#open-personal');
const LOCAL = 'http://127.0.0.1:49273/';

function videoId(raw) {
  const value = raw.trim();
  if (/^[\w-]{11}$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(url.hostname)) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    const id = url.hostname === 'youtu.be' ? parts[0] : url.searchParams.get('v') || (['shorts', 'live', 'embed'].includes(parts[0]) ? parts[1] : null);
    return /^[\w-]{11}$/.test(id || '') ? id : null;
  } catch { return null; }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  const id = videoId(input.value);
  if (!id) {
    notice.textContent = '올바른 YouTube 영상 링크를 넣어 주세요.';
    notice.className = 'error';
    input.focus();
    return;
  }
  const target = new URL(LOCAL);
  target.hash = new URLSearchParams({ video: id }).toString();
  window.location.assign(target.href);
});

openButton.href = LOCAL;
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
