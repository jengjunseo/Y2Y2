import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function app(fetch = () => { throw Error('Unexpected network'); }) {
  const node = () => ({ addEventListener() {}, appendChild() {}, classList: { add() {}, remove() {} } });
  const code = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  return vm.runInNewContext(code + '\n({parseVideoId, resolveWithClients})', {
    document: { querySelector: node, createElement: node }, navigator: {}, URL, AbortSignal, fetch, console,
  });
}

test('accepts watch, short links and Shorts; rejects lookalike domains and credentials', () => {
  const { parseVideoId } = app();
  const id = 'aqz-KE-bpKQ';
  for (const url of [id, `https://youtu.be/${id}`, `https://www.youtube.com/watch?v=${id}`, `https://m.youtube.com/shorts/${id}`]) assert.equal(parseVideoId(url), id);
  for (const url of [`https://notyoutube.com/watch?v=${id}`, `https://youtube.com.evil.test/watch?v=${id}`, `https://x:y@youtu.be/${id}`, `ftp://youtu.be/${id}`]) assert.equal(parseVideoId(url), null);
});

test('cipher-only response does not suppress the next client', async () => {
  let calls = 0;
  const { resolveWithClients } = app(async (_, options) => {
    assert.equal(options.credentials, 'omit');
    assert.ok(options.signal instanceof AbortSignal);
    calls++;
    return { ok: true, json: async () => ({ streamingData: { formats: calls === 1 ? [{ signatureCipher: 'redacted' }] : [{ url: 'https://example.test/media' }] } }) };
  });
  const result = await resolveWithClients('aqz-KE-bpKQ');
  assert.equal(calls, 2);
  assert.equal(result.client.clientName, 'IOS');
});

test('empty streaming data is never reported as a usable response', async () => {
  const { resolveWithClients } = app(async () => ({ ok: true, json: async () => ({ streamingData: {} }) }));
  await assert.rejects(resolveWithClients('aqz-KE-bpKQ'), /다운로드 준비가 완료되지/);
});
