import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export class WebError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export function videoId(raw) {
  const value = String(raw || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value;
  if (value.length > 2048) throw new WebError('BAD_URL', 'YouTube 영상 링크를 확인해 주세요.');
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) throw Error();
    if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(url.hostname)) throw Error();
    const parts = url.pathname.split('/').filter(Boolean);
    const id = url.hostname === 'youtu.be' && parts.length === 1 ? parts[0] :
      url.pathname === '/watch' ? url.searchParams.get('v') :
      ['shorts', 'live', 'embed'].includes(parts[0]) && parts.length === 2 ? parts[1] : null;
    if (/^[A-Za-z0-9_-]{11}$/.test(id || '')) return id;
  } catch {}
  throw new WebError('BAD_URL', 'YouTube 영상 링크를 확인해 주세요.');
}
export function equalSecret(a, b) {
  const hash = value => createHash('sha256').update(String(value)).digest();
  return timingSafeEqual(hash(a), hash(b));
}
export function signTicket(payload, secret, kind, ttlMs, now = Date.now()) {
  const data = Buffer.from(JSON.stringify({ ...payload, kind, exp: now + ttlMs })).toString('base64url');
  return data + '.' + createHmac('sha256', secret).update(data).digest('base64url');
}
export function readTicket(token, secret, kind, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 24000) throw new WebError('EXPIRED', '사용 시간이 만료됐습니다. 다시 분석해 주세요.', 401);
  const [data, signature, extra] = token.split('.');
  const expected = createHmac('sha256', secret).update(data || '').digest('base64url');
  if (extra !== undefined || !signature || !equalSecret(signature, expected)) throw new WebError('EXPIRED', '인증을 확인해 주세요.', 401);
  let payload;
  try { payload = JSON.parse(Buffer.from(data, 'base64url').toString()); } catch {}
  if (!payload || payload.kind !== kind || !Number.isFinite(payload.exp) || payload.exp <= now) throw new WebError('EXPIRED', '사용 시간이 만료됐습니다. 다시 분석해 주세요.', 401);
  return payload;
}
export function normalizeFormats(payload) {
  const data = payload?.data ?? payload;
  const list = Array.isArray(data) ? data : data?.formats ?? data?.FORMATS;
  if (!Array.isArray(list)) throw new WebError('PROVIDER_SCHEMA', '다운로드 서비스의 형식 응답을 확인할 수 없습니다.', 502);
  const formats = list.slice(0, 500).map(item => ({
    id: String(item.format_id ?? item.FORMAT_ID ?? ''),
    ext: String(item.ext ?? item.EXT ?? '').toLowerCase(),
    video: String(item.vcodec ?? item.VCODEC ?? ''),
    audio: String(item.acodec ?? item.ACODEC ?? ''),
    height: Number(item.height ?? item.HEIGHT ?? 0),
    abr: Number(item.abr ?? item.ABR ?? 0),
  })).filter(f => /^[A-Za-z0-9_.-]{1,100}$/.test(f.id));
  // Never offer silent video-only streams as finished MP4 files.
  const mp4 = formats.filter(f => f.ext === 'mp4' && f.video && f.video !== 'none' && f.audio && f.audio !== 'none');
  mp4.sort((a, b) => b.height - a.height);
  const choices = mp4.slice(0, 12).map(f => ({ key: 'mp4-' + f.id, kind: 'mp4', formatId: f.id, label: 'MP4 · ' + (f.height ? f.height + 'p' : '영상 + 오디오') }));
  const audio = formats.filter(f => f.video === 'none' && f.audio && f.audio !== 'none').sort((a, b) => b.abr - a.abr)[0];
  if (audio) choices.push({ key: 'mp3-' + audio.id, kind: 'mp3', formatId: audio.id, label: 'MP3 · 192 kbps 변환' });
  if (!choices.length) throw new WebError('NO_FORMATS', '저장할 수 있는 MP4·MP3 형식이 없습니다.', 422);
  return { title: String(data?.title || payload?.title || '').slice(0, 300), choices };
}
export function downloadSpec(id, choice) {
  const spec = { url: 'https://www.youtube.com/watch?v=' + videoId(id), format_id: choice.formatId };
  if (choice.kind === 'mp3') spec.postprocessors = [{ key: 'FFmpegExtractAudio', preferredcodec: 'mp3', preferredquality: '192' }];
  return spec;
}
export function taskId(payload) {
  const data = payload?.data ?? payload;
  const id = String(data?.task_id ?? data?.taskId ?? data?.TASK_ID ?? '');
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(id)) throw new WebError('PROVIDER_SCHEMA', '다운로드 작업 번호를 확인할 수 없습니다.', 502);
  return id;
}
export function taskState(payload) {
  const data = payload?.data ?? payload;
  const status = String(data?.status ?? data?.state ?? data?.STATUS ?? '').toLowerCase();
  if (['completed', 'complete', 'finished', 'done', 'success', 'succeeded'].includes(status)) return 'ready';
  if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) return 'failed';
  if (['pending', 'queued', 'processing', 'downloading', 'running', 'started', 'in_progress', 'postprocessing'].includes(status)) return 'processing';
  throw new WebError('PROVIDER_SCHEMA', '다운로드 서비스의 작업 상태를 확인할 수 없습니다.', 502);
}
export function resultUrl(payload) {
  const data = payload?.data ?? payload;
  const raw = data?.download_url ?? data?.downloadUrl ?? data?.url ?? data?.DOWNLOAD_URL;
  let url;
  try { url = new URL(raw); } catch {}
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.hash ||
      !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname) ||
      /(^|\.)(localhost|local|internal|test|invalid)$/i.test(url.hostname)) {
    throw new WebError('PROVIDER_SCHEMA', '안전한 파일 주소를 확인할 수 없습니다.', 502);
  }
  return url.href;
}
