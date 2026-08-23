const ENDPOINTS = [
  'https://youtubei.googleapis.com/youtubei/v1/player',
  'https://www.youtube.com/youtubei/v1/player'
];

const CLIENTS = {
  web_embedded: {
    numeric: 56,
    client: { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: '2.20260708.00.00' },
    thirdParty: { embedUrl: 'https://y2-y2.vercel.app/lab/' }
  },
  web: { numeric: 1, client: { clientName: 'WEB', clientVersion: '2.20260708.00.00' } },
  mweb: {
    numeric: 2,
    client: {
      clientName: 'MWEB', clientVersion: '2.20260708.05.00',
      userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1,gzip(gfe)'
    }
  },
  android: {
    numeric: 3,
    client: {
      clientName: 'ANDROID', clientVersion: '21.26.364', androidSdkVersion: 30,
      userAgent: 'com.google.android.youtube/21.26.364 (Linux; U; Android 11) gzip', osName: 'Android', osVersion: '11'
    }
  },
  android_vr: {
    numeric: 28,
    client: {
      clientName: 'ANDROID_VR', clientVersion: '1.65.10', androidSdkVersion: 32,
      deviceMake: 'Oculus', deviceModel: 'Quest 3', osName: 'Android', osVersion: '12L',
      userAgent: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip'
    }
  },
  ios: {
    numeric: 5,
    client: {
      clientName: 'IOS', clientVersion: '21.26.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2',
      userAgent: 'com.google.ios.youtube/21.26.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)', osName: 'iPhone', osVersion: '18.3.2.22D82'
    }
  },
  visionos: {
    numeric: 101,
    client: {
      clientName: 'VISIONOS', clientVersion: '1.02', deviceMake: 'Apple', deviceModel: 'RealityDevice17,1',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
      osName: 'visionOS', osVersion: '26.5.23O471'
    }
  },
  tv: {
    numeric: 7,
    client: {
      clientName: 'TVHTML5', clientVersion: '7.20260707.07.00',
      userAgent: 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/25.lts.30.1034943-gold (unlike Gecko), Unknown_TV_Unknown_0/Unknown (Unknown, Unknown)'
    }
  }
};

function jsonResponse(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
}

function summarize(player) {
  const streaming = player && player.streamingData || {};
  const formats = Array.isArray(streaming.formats) ? streaming.formats : [];
  const adaptive = Array.isArray(streaming.adaptiveFormats) ? streaming.adaptiveFormats : [];
  const direct = function (format) { return typeof format.url === 'string' && format.url.startsWith('https://'); };
  const cipher = function (format) { return Boolean(format.signatureCipher || format.cipher); };
  return {
    playabilityStatus: player && player.playabilityStatus && player.playabilityStatus.status || null,
    playabilityReason: player && player.playabilityStatus && player.playabilityStatus.reason || null,
    formats: formats.length,
    adaptiveFormats: adaptive.length,
    directFormats: formats.filter(direct).length,
    directAdaptiveFormats: adaptive.filter(direct).length,
    cipherFormats: formats.filter(cipher).length + adaptive.filter(cipher).length,
    itag18: formats.some(function (format) { return Number(format.itag) === 18; }),
    audioFormats: adaptive.filter(function (format) { return String(format.mimeType || '').startsWith('audio/'); }).length,
    highResolutionFormats: adaptive.filter(function (format) { return Number(format.height || 0) >= 1080; }).length,
    serverAbrStreamingUrl: Boolean(streaming.serverAbrStreamingUrl),
    hlsManifestUrl: Boolean(streaming.hlsManifestUrl),
    dashManifestUrl: Boolean(streaming.dashManifestUrl),
    drm: formats.concat(adaptive).some(function (format) { return Boolean(format.drmFamilies || format.drmTrackType); })
  };
}

async function requestPlayer(endpoint, profile, videoId) {
  const context = { client: Object.assign({ hl: 'ko', gl: 'KR' }, profile.client) };
  if (profile.thirdParty) context.thirdParty = profile.thirdParty;
  const fields = 'playabilityStatus,streamingData,videoDetails,playerConfig,responseContext.mainAppWebResponseContext.datasyncId';
  const apiKey = String(process.env.Y2Y2_INNERTUBE_API_KEY || '');
  const query = new URLSearchParams({ prettyPrint: 'false', '$fields': fields });
  if (apiKey) query.set('key', apiKey);
  const url = endpoint + '?' + query.toString();
  const started = Date.now();
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
      headers: {
        accept: '*/*',
        'content-type': 'application/json',
        origin: 'https://www.youtube.com',
        referer: 'https://www.youtube.com/',
        'user-agent': profile.client.userAgent || 'Mozilla/5.0',
        'x-youtube-client-name': String(profile.numeric),
        'x-youtube-client-version': profile.client.clientVersion
      },
      body: JSON.stringify({
        videoId: videoId,
        contentCheckOk: true,
        racyCheckOk: true,
        context: context
      })
    });
  } catch (error) {
    return { endpoint: endpoint, elapsedMs: Date.now() - started, networkError: error && error.message || String(error) };
  }

  const text = await response.text();
  let player = null;
  try { player = JSON.parse(text); } catch {}
  return {
    endpoint: endpoint,
    elapsedMs: Date.now() - started,
    status: response.status,
    finalUrl: response.url,
    contentType: response.headers.get('content-type'),
    accessControlAllowOrigin: response.headers.get('access-control-allow-origin'),
    player: player,
    bodyPreview: player ? null : text.slice(0, 1000)
  };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Allow', 'POST, OPTIONS');
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    jsonResponse(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    return;
  }

  if (!String(req.headers && req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    jsonResponse(res, 415, { error: 'APPLICATION_JSON_REQUIRED' });
    return;
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  } catch {
    jsonResponse(res, 400, { error: 'INVALID_JSON' });
    return;
  }
  const videoId = String(body.videoId || '');
  const clientId = String(body.client || 'web_embedded');
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    jsonResponse(res, 400, { error: 'INVALID_VIDEO_ID' });
    return;
  }
  const profile = CLIENTS[clientId];
  if (!profile) {
    jsonResponse(res, 400, { error: 'UNKNOWN_CLIENT', allowedClients: Object.keys(CLIENTS) });
    return;
  }

  const attempts = [];
  let selected = null;
  for (const endpoint of ENDPOINTS) {
    const attempt = await requestPlayer(endpoint, profile, videoId);
    attempts.push({
      endpoint: attempt.endpoint,
      elapsedMs: attempt.elapsedMs,
      status: attempt.status || null,
      finalUrl: attempt.finalUrl || null,
      contentType: attempt.contentType || null,
      accessControlAllowOrigin: attempt.accessControlAllowOrigin || null,
      networkError: attempt.networkError || null,
      bodyPreview: attempt.bodyPreview || null,
      summary: attempt.player ? summarize(attempt.player) : null
    });
    if (attempt.player) selected = attempt;
    if (attempt.player && attempt.player.streamingData) break;
  }

  if (!selected) {
    jsonResponse(res, 502, { error: 'UPSTREAM_UNREADABLE', client: clientId, diagnostics: attempts });
    return;
  }

  const summary = summarize(selected.player);
  const ok = Boolean(selected.player.streamingData);
  jsonResponse(res, ok ? 200 : 424, {
    client: clientId,
    endpoint: selected.endpoint,
    upstreamStatus: selected.status,
    summary: summary,
    diagnostics: attempts,
    player: selected.player
  });
}
