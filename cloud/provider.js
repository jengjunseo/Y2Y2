import { WebError } from './core.js';

const BASE = 'https://gate.apiscrape.net:16262';
export function configured(env = process.env) {
  return Boolean(env.Y2Y2_VIDEO_API_USER && env.Y2Y2_VIDEO_API_PASSWORD && env.Y2Y2_WEB_PASSWORD?.length >= 16);
}
export async function providerRequest(path, { body, env = process.env, fetcher = fetch } = {}) {
  const auth = Buffer.from(env.Y2Y2_VIDEO_API_USER + ':' + env.Y2Y2_VIDEO_API_PASSWORD).toString('base64');
  let response;
  try {
    response = await fetcher(BASE + path, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(45000),
      headers: { Authorization: 'Basic ' + auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch { throw new WebError('PROVIDER_UNAVAILABLE', '다운로드 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.', 502); }
  if ([402, 429].includes(response.status)) { await response.body?.cancel(); throw new WebError('FREE_LIMIT', '무료 이용 한도에 도달했거나 요청이 많습니다. 결제는 자동으로 진행되지 않습니다.', 429); }
  if ([401, 403].includes(response.status)) { await response.body?.cancel(); throw new WebError('PROVIDER_AUTH', '다운로드 서비스 계정 설정을 확인해야 합니다.', 503); }
  if (!response.ok) { await response.body?.cancel(); throw new WebError('PROVIDER_ERROR', '다운로드 서비스가 요청을 처리하지 못했습니다.', 502); }
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) { await reader.cancel(); throw Error(); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw new WebError('PROVIDER_SCHEMA', '다운로드 서비스의 응답을 확인할 수 없습니다.', 502); }
  finally { reader.releaseLock(); }
}
