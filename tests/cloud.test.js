import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../api/web.js';
import { normalizeFormats, readTicket, resultUrl, signTicket, videoId } from '../cloud/core.js';
import { configured, providerRequest, signingSecret } from '../cloud/provider.js';

const env = { Y2Y2_WEB_PASSWORD: 'test-only-password-at-least-16', Y2Y2_VIDEO_API_USER: 'test-user', Y2Y2_VIDEO_API_PASSWORD: 'test-provider-password' };
const fixture = { title: 'Public test fixture', formats: [
  { format_id: '18', ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a', height: 360 },
  { format_id: '137', ext: 'mp4', vcodec: 'avc1', acodec: 'none', height: 1080 },
  { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a', abr: 128 },
] };
function request(action, body, cookie, origin = 'https://y2y2.example') {
  return new Request('https://y2y2.example/api/web?action=' + action, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function login() {
  const response = await handle(request('login', { password: env.Y2Y2_WEB_PASSWORD }), { env });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
  return cookie.split(';')[0];
}
test('strict single YouTube URL parsing rejects host tricks and arbitrary requests', () => {
  for (const url of ['https://youtu.be/aqz-KE-bpKQ', 'https://youtube.com/watch?v=aqz-KE-bpKQ', 'https://m.youtube.com/shorts/aqz-KE-bpKQ']) assert.equal(videoId(url), 'aqz-KE-bpKQ');
  for (const url of ['https://youtube.com.evil.test/watch?v=aqz-KE-bpKQ', 'https://youtube.com@evil.test/aqz-KE-bpKQ', 'http://127.0.0.1/', 'https://youtube.com:8443/watch?v=aqz-KE-bpKQ', 'https://youtube.com/playlist?list=123', 'https://youtu.be/aqz-KE-bpKQ/extra']) assert.throws(() => videoId(url));
});
test('signed tickets cannot be changed, replayed as another type, or used after expiry', () => {
  const token = signTicket({ id: 'public-test' }, 'secret', 'job', 1000, 10);
  assert.equal(readTicket(token, 'secret', 'job', 11).id, 'public-test');
  for (const [value, secret, kind, now] of [[token + 'x', 'secret', 'job', 11], [token, 'wrong', 'job', 11], [token, 'secret', 'session', 11], [token, 'secret', 'job', 1010]]) assert.throws(() => readTicket(value, secret, kind, now));
});
test('format choices never mislabel silent video as an MP4 with audio', () => {
  const info = normalizeFormats(fixture);
  assert.deepEqual(info.choices.map(c => c.key), ['mp4-18', 'mp3-140']);
  assert.throws(() => normalizeFormats({ formats: [fixture.formats[1]] }));
  assert.throws(() => normalizeFormats({ message: 'not a formats response' }));
});
test('unconfigured or unauthenticated API never calls the provider', async () => {
  let calls = 0; const provider = async () => { calls++; };
  const status = await handle(request('status'), { env: {}, provider });
  assert.deepEqual(await status.json(), { configured: false, authenticated: false, passwordRequired: false });
  assert.equal((await handle(request('inspect', { url: 'aqz-KE-bpKQ' }), { env: {}, provider })).status, 503);
  assert.equal((await handle(request('inspect', { url: 'aqz-KE-bpKQ' }), { env, provider })).status, 401);
  assert.equal(calls, 0);
});
test('cross-origin login and oversized bodies are rejected', async () => {
  assert.equal((await handle(request('login', { password: env.Y2Y2_WEB_PASSWORD }, undefined, 'https://evil.test'), { env })).status, 403);
  assert.equal((await handle(request('login', { password: 'x'.repeat(24001) }), { env })).status, 413);
  assert.equal((await handle(request('login', { password: 'wrong' }), { env })).status, 401);
});
test('owner flow creates a fixed MP3 conversion and exposes a link only after ready', async () => {
  const cookie = await login(); const calls = []; let completed = false;
  const provider = async (path, options) => {
    calls.push({ path, body: options?.body });
    if (path.startsWith('/api/formats?')) return fixture;
    if (path === '/api/download') return { task_id: 'test-task-1234' };
    if (path.startsWith('/api/status/')) return { status: completed ? 'completed' : 'processing' };
    if (path === '/api/download/test-task-1234') return { download_url: 'https://files.example.org/public-test.mp3?signature=fixture' };
    throw new Error('Unexpected provider request');
  };
  const invoke = async (action, body) => handle(request(action, body, cookie), { env, provider });
  const inspect = await (await invoke('inspect', { url: 'https://youtu.be/aqz-KE-bpKQ' })).json();
  assert.equal(inspect.choices.length, 2);
  assert.equal((await invoke('create', { ticket: inspect.ticket, choice: 'mp4-137' })).status, 400);
  const response = await invoke('create', { ticket: inspect.ticket, choice: 'mp3-140' });
  assert.equal(response.status, 201); const job = await response.json();
  assert.deepEqual(calls.find(c => c.path === '/api/download').body, {
    url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', format_id: '140',
    postprocessors: [{ key: 'FFmpegExtractAudio', preferredcodec: 'mp3', preferredquality: '192' }],
  });
  assert.deepEqual(await (await invoke('poll', { ticket: job.ticket })).json(), { state: 'processing' });
  assert.equal(calls.filter(c => c.path === '/api/download/test-task-1234').length, 0);
  completed = true;
  const ready = await (await invoke('poll', { ticket: job.ticket })).json();
  assert.equal(ready.state, 'ready'); assert.equal(ready.format, 'mp3'); assert.match(ready.url, /^https:\/\/files\.example\.org/);
});
test('provider transport uses a fixed authenticated host and refuses redirects or unbounded payloads', async () => {
  await providerRequest('/api/formats?video_url=fixture', { env, fetcher: async (url, options) => {
    assert.equal(new URL(url).host, 'gate.apiscrape.net:16262');
    assert.equal(options.redirect, 'error'); assert.match(options.headers.Authorization, /^Basic /);
    return Response.json(fixture);
  } });
  await assert.rejects(providerRequest('/api/formats', { env, fetcher: async () => new Response('x'.repeat(1024 * 1024 + 1)) }), error => error.code === 'PROVIDER_SCHEMA');
  await assert.rejects(providerRequest('/api/formats', { env, fetcher: async () => new Response('provider secrets', { status: 402 }) }), error => error.code === 'FREE_LIMIT' && !error.message.includes('provider secrets'));
});
test('unsafe file URLs and provider failures never produce a ready response', async () => {
  for (const url of ['http://files.example.org/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://user:password@files.example.org/x', 'javascript:alert(1)']) assert.throws(() => resultUrl({ url }));
  const cookie = await login(); const ticket = signTicket({ id: 'test-task-1234', format: 'mp4' }, signingSecret(env), 'job', 10000);
  for (const status of ['failed', 'mystery']) {
    const response = await handle(request('poll', { ticket }, cookie), { env, provider: async () => ({ status }) });
    assert.ok(response.status >= 400); assert.equal((await response.json()).state, undefined);
  }
});
test('two API credentials enable public use without a site password or cookie', async () => {
  const publicEnv = { ...env, Y2Y2_WEB_PASSWORD: '' };
  assert.equal(configured(publicEnv), true);
  assert.equal(configured({ ...publicEnv, Y2Y2_VIDEO_API_PASSWORD: '' }), false);
  assert.equal(configured({ ...publicEnv, Y2Y2_WEB_PASSWORD: 'short' }), false);
  const status = await handle(request('status'), { env: publicEnv });
  assert.deepEqual(await status.json(), { configured: true, authenticated: true, passwordRequired: false });
  let calls = 0;
  const provider = async path => { calls++; return path.startsWith('/api/formats') ? fixture : { task_id: 'test-task-1234' }; };
  const inspectResponse = await handle(request('inspect', { url: 'aqz-KE-bpKQ' }), { env: publicEnv, provider });
  assert.equal(inspectResponse.status, 200);
  const inspect = await inspectResponse.json();
  assert.equal(JSON.stringify(inspect).includes(publicEnv.Y2Y2_VIDEO_API_PASSWORD), false);
  const forged = inspect.ticket.slice(0, -1) + (inspect.ticket.endsWith('a') ? 'b' : 'a');
  assert.equal((await handle(request('create', { ticket: forged, choice: 'mp4-18' }), { env: publicEnv, provider })).status, 401);
  assert.equal(calls, 1);
  assert.equal((await handle(request('create', { ticket: inspect.ticket, choice: 'mp4-18' }), { env: publicEnv, provider })).status, 201);
});
