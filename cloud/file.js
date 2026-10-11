import { WebError, resultUrl } from './core.js';

const MAX_BYTES = 256 * 1024 * 1024;
export async function downloadResponse(raw, format, { fetcher = fetch, signal } = {}) {
  const url = new URL(resultUrl({ url: raw }));
  // File delivery is restricted to the storage endpoint observed in live tests.
  // Never fetch an arbitrary provider-supplied host, port or redirect.
  if (url.hostname !== 's3.fr-par.scw.cloud' || url.port || !['mp4', 'mp3'].includes(format)) {
    throw new WebError('UNSUPPORTED_FILE', '이 파일 저장소를 지원하지 않습니다.', 502);
  }
  let upstream;
  try { upstream = await fetcher(url.href, { redirect: 'error', signal }); }
  catch { throw new WebError('FILE_UNAVAILABLE', '파일에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.', 502); }
  const length = Number(upstream.headers.get('content-length'));
  const type = (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const expectedType = format === 'mp3' ? 'audio/mpeg' : 'video/mp4';
  if (!upstream.ok || !upstream.body || ![expectedType, 'application/octet-stream'].includes(type)) {
    await upstream.body?.cancel(); throw new WebError('FILE_UNAVAILABLE', '파일 링크가 만료됐거나 파일을 받을 수 없습니다. 상태를 다시 확인해 주세요.', 502);
  }
  if (length > MAX_BYTES) {
    await upstream.body.cancel(); throw new WebError('FILE_TOO_LARGE', '웹 저장은 파일당 256MB까지 지원합니다.', 413);
  }
  const reader = upstream.body.getReader(); let bytes = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { reader.releaseLock(); controller.close(); return; }
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) { await reader.cancel(); throw Error('File exceeds size limit'); }
        controller.enqueue(value);
      } catch { await reader.cancel().catch(() => {}); controller.error(new Error('파일 전송이 중단됐습니다. 다시 저장해 주세요.')); }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return new Response(stream, { headers: {
    'Content-Type': format === 'mp3' ? 'audio/mpeg' : 'video/mp4',
    'Content-Disposition': `attachment; filename="Y2Y2.${format}"`,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    ...(Number.isSafeInteger(length) && length > 0 ? { 'Content-Length': String(length) } : {}),
  } });
}
