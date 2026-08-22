const YOUTUBE_HOSTS = new Set(['youtube.com','www.youtube.com','m.youtube.com','youtu.be','music.youtube.com']);

export function extractVideoId(input='') {
  const raw = String(input || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;
  let url;
  try { url = new URL(raw); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase()) && !YOUTUBE_HOSTS.has(host)) return null;
  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0] || '';
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  }
  let id = url.searchParams.get('v') || '';
  if (!id) {
    const parts = url.pathname.split('/').filter(Boolean);
    if (['shorts','embed','live'].includes(parts[0])) id = parts[1] || '';
  }
  return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

export function safeFileName(name, fallback='video') {
  const cleaned = String(name || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();
  return (cleaned || fallback).slice(0, 140);
}

export function isGoogleVideoUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'googlevideo.com' || host.endsWith('.googlevideo.com'));
  } catch { return false; }
}

export function withDownloadTitle(value, title) {
  const url = new URL(value);
  url.searchParams.set('title', safeFileName(title));
  return url.toString();
}

export function normalizeFormats(player) {
  const streaming = player?.streamingData || {};
  const progressive = Array.isArray(streaming.formats) ? streaming.formats : [];
  const adaptive = Array.isArray(streaming.adaptiveFormats) ? streaming.adaptiveFormats : [];
  const map = (f, kind) => {
    if (!f?.url || !isGoogleVideoUrl(f.url)) return null;
    const mime = String(f.mimeType || '');
    const parsed = new URL(f.url);
    return {
      kind,
      itag: Number(f.itag),
      mime,
      width: Number(f.width || 0),
      height: Number(f.height || 0),
      bitrate: Number(f.bitrate || 0),
      contentLength: Number(f.contentLength || 0),
      qualityLabel: f.qualityLabel || null,
      audioQuality: f.audioQuality || null,
      directUrl: f.url,
      ipBound: parsed.searchParams.has('ip'),
      client: parsed.searchParams.get('c') || null
    };
  };
  return {
    progressive: progressive.map(f => map(f, 'progressive')).filter(Boolean).sort((a,b) => b.height - a.height || b.bitrate - a.bitrate),
    adaptive: adaptive.map(f => map(f, 'adaptive')).filter(Boolean)
  };
}

export const CLIENT_PROFILES = [
  {
    key: 'android_vr', clientId: '28', apiKey: '',
    client: {
      clientName: 'ANDROID_VR', clientVersion: '1.65.10', deviceMake: 'Oculus', deviceModel: 'Quest 3',
      androidSdkVersion: 32, userAgent: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
      osName: 'Android', osVersion: '12L'
    }
  },
  {
    key: 'web_embedded', clientId: '56', apiKey: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
    client: { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: '2.20260708.00.00' },
    thirdParty: { embedUrl: 'https://www.reddit.com/' }
  },
  {
    key: 'tv', clientId: '7', apiKey: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
    client: {
      clientName: 'TVHTML5', clientVersion: '7.20260707.07.00',
      userAgent: 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/25.lts.30.1034943-gold (unlike Gecko), Unknown_TV_Unknown_0/Unknown (Unknown, Unknown)'
    }
  },
  {
    key: 'tv_downgraded', clientId: '7', apiKey: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
    client: { clientName: 'TVHTML5', clientVersion: '5.20260707', userAgent: 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version' }
  }
];
