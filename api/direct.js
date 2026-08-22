import { CLIENT_PROFILES, extractVideoId, normalizeFormats, safeFileName, withDownloadTitle } from '../direct/core.js';

function json(payload, status=200) {
  return Response.json(payload, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try { return new URL(origin).host === new URL(request.url).host; } catch { return false; }
}

async function playerRequest(profile, videoId) {
  const client = { ...profile.client, hl: 'en', timeZone: 'UTC', utcOffsetMinutes: 0 };
  const context = { client };
  if (profile.thirdParty) context.thirdParty = profile.thirdParty;
  const body = {
    context,
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
    playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } }
  };
  const endpoint = new URL('https://www.youtube.com/youtubei/v1/player');
  endpoint.searchParams.set('prettyPrint', 'false');
  if (profile.apiKey) endpoint.searchParams.set('key', profile.apiKey);
  const headers = {
    'content-type': 'application/json',
    'x-youtube-client-name': profile.clientId,
    'x-youtube-client-version': profile.client.clientVersion,
    'origin': 'https://www.youtube.com'
  };
  if (profile.client.userAgent) headers['user-agent'] = profile.client.userAgent;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(9000)
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

export async function GET(request) {
  const url = new URL(request.url);
  if (url.searchParams.get('action') === 'health') {
    return json({ ok: true, service: 'y2y2-direct-resolver', version: '1.1.0-experimental', mediaProxy: false });
  }
  return json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
}

export async function POST(request) {
  if (!sameOrigin(request)) return json({ error: 'Cross-site requests are not allowed.', code: 'ORIGIN_REJECTED' }, 403);
  let body = {};
  try { body = await request.json(); } catch {}
  const videoId = extractVideoId(body.url || body.videoId || '');
  if (!videoId) return json({ error: '올바른 YouTube 링크가 아닙니다.', code: 'BAD_URL' }, 400);

  const attempts = [];
  for (const profile of CLIENT_PROFILES) {
    try {
      const { response, data } = await playerRequest(profile, videoId);
      const status = String(data?.playabilityStatus?.status || '');
      const reason = String(data?.playabilityStatus?.reason || '');
      const formats = normalizeFormats(data);
      attempts.push({ profile: profile.key, http: response.status, playability: status || null, reason: reason || null, progressive: formats.progressive.length, adaptiveDirect: formats.adaptive.length });
      if (!response.ok || status !== 'OK' || !formats.progressive.length) continue;
      const title = safeFileName(data?.videoDetails?.title || videoId, videoId);
      const progressive = formats.progressive.map(format => ({
        ...format,
        downloadUrl: withDownloadTitle(format.directUrl, title)
      }));
      return json({
        ok: true,
        mode: 'direct',
        videoId,
        title,
        author: data?.videoDetails?.author || null,
        duration: Number(data?.videoDetails?.lengthSeconds || 0),
        resolverClient: profile.key,
        progressive,
        adaptiveDirectCount: formats.adaptive.length,
        note: 'Media bytes do not pass through Y2Y2. The browser connects directly to GoogleVideo.'
      });
    } catch (error) {
      attempts.push({ profile: profile.key, error: String(error?.message || error).slice(0, 300) });
    }
  }

  const botCheck = attempts.some(a => /sign in to confirm|not a bot/i.test(String(a.reason || a.error || '')));
  return json({
    error: botCheck ? 'YouTube가 현재 Resolver 요청을 bot-check로 차단했습니다.' : '직접 다운로드 가능한 progressive 스트림을 찾지 못했습니다.',
    code: botCheck ? 'UPSTREAM_BOT_CHECK' : 'NO_DIRECT_FORMAT',
    attempts
  }, botCheck ? 502 : 422);
}
