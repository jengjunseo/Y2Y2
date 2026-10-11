import { configured, providerRequest, signingSecret } from '../cloud/provider.js';
import { WebError, downloadSpec, equalSecret, normalizeFormats, readTicket, resultUrl, signTicket, taskId, taskState, videoId } from '../cloud/core.js';

const COOKIE = '__Host-y2y2_web';
function json(data, status = 200, headers = {}) { return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } }); }
function session(request, secret, passwordRequired = true) {
  if (!passwordRequired) return;
  const token = (request.headers.get('cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  if (!token) throw new WebError('LOGIN_REQUIRED', '개인용 비밀번호로 먼저 접속해 주세요.', 401);
  readTicket(token, secret, 'session');
}
function requireOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') throw new WebError('BAD_ORIGIN', '이 사이트에서 직접 요청해 주세요.', 403);
}
async function bodyOf(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new WebError('BAD_BODY', 'JSON 요청이 필요합니다.', 415);
  const reader = request.body?.getReader();
  if (!reader) throw new WebError('BAD_BODY', '요청을 확인해 주세요.');
  const chunks = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 24000) { await reader.cancel(); throw new WebError('TOO_LARGE', '요청이 너무 큽니다.', 413); } chunks.push(value); }
    try { const body = JSON.parse(Buffer.concat(chunks).toString()); if (body && typeof body === 'object' && !Array.isArray(body)) return body; } catch {}
    throw new WebError('BAD_BODY', '요청을 확인해 주세요.');
  } finally { reader.releaseLock(); }
}
export async function handle(request, { env = process.env, provider = providerRequest } = {}) {
  try {
    const action = new URL(request.url).searchParams.get('action') || 'status';
    const secret = signingSecret(env), passwordRequired = Boolean(env.Y2Y2_WEB_PASSWORD);
    if (request.method === 'GET' && action === 'status') {
      let authenticated = false;
      if (configured(env)) { try { session(request, secret, passwordRequired); authenticated = true; } catch {} }
      return json({ configured: configured(env), authenticated, passwordRequired });
    }
    if (request.method !== 'POST') return json({ error: '허용되지 않은 요청입니다.' }, 405, { Allow: 'GET, POST' });
    requireOrigin(request);
    if (!configured(env)) throw new WebError('NOT_CONFIGURED', '웹 다운로드 서비스가 아직 연결되지 않았습니다.', 503);
    const body = await bodyOf(request);
    const cookie = token => `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`;
    if (action === 'login') {
      if (!passwordRequired) return json({ ok: true });
      if (!equalSecret(body.password || '', env.Y2Y2_WEB_PASSWORD)) throw new WebError('BAD_PASSWORD', '비밀번호를 확인해 주세요.', 401);
      return json({ ok: true }, 200, { 'Set-Cookie': cookie(signTicket({}, secret, 'session', 604800000)) });
    }
    session(request, secret, passwordRequired);
    if (action === 'logout') return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
    if (action === 'inspect') {
      const id = videoId(body.url);
      const info = normalizeFormats(await provider('/api/formats?video_url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id), { env }));
      return json({ videoId: id, title: info.title || id, choices: info.choices.map(({ key, kind, label }) => ({ key, kind, label })),
        ticket: signTicket({ id, choices: info.choices }, secret, 'inspect', 1800000) });
    }
    if (action === 'create') {
      const info = readTicket(body.ticket, secret, 'inspect');
      const choice = info.choices?.find(c => c.key === body.choice);
      if (!choice) throw new WebError('BAD_FORMAT', '형식을 다시 선택해 주세요.');
      const id = taskId(await provider('/api/download', { env, body: downloadSpec(info.id, choice) }));
      return json({ ticket: signTicket({ id, format: choice.kind }, secret, 'job', 86400000), state: 'processing' }, 201);
    }
    if (action === 'poll') {
      const job = readTicket(body.ticket, secret, 'job');
      const state = taskState(await provider('/api/status/' + encodeURIComponent(job.id), { env }));
      if (state === 'failed') throw new WebError('DOWNLOAD_FAILED', '파일 생성에 실패했습니다. 새 다운로드를 요청하기 전에 영상과 무료 한도를 확인해 주세요.', 422);
      if (state !== 'ready') return json({ state });
      const url = resultUrl(await provider('/api/download/' + encodeURIComponent(job.id), { env }));
      return json({ state: 'ready', url, format: job.format });
    }
    throw new WebError('BAD_ACTION', '요청을 확인해 주세요.', 404);
  } catch (error) {
    if (error instanceof WebError) return json({ error: error.message, code: error.code }, error.status);
    return json({ error: '요청을 처리하지 못했습니다.', code: 'INTERNAL' }, 500);
  }
}
export const GET = request => handle(request);
export const POST = request => handle(request);
