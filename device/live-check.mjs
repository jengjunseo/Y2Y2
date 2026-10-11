// Opt-in real-source verification. Never used in CI or against paid download APIs.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';

const video = process.env.Y2Y2_LIVE_VIDEO;
if (!video) throw Error('Set Y2Y2_LIVE_VIDEO to a video you have permission to download.');
const base = process.env.Y2Y2_TEST_ORIGIN || 'http://127.0.0.1:8118';
const key = process.env.Y2Y2_LIVE_FORMAT || '299+140';
const destination = resolve(process.env.Y2Y2_TEST_OUTPUT || '../verification/device-live.mp4');
await mkdir(dirname(destination), { recursive: true });
const profile = await mkdtemp(resolve(tmpdir(), 'y2y2-live-'));
const context = await chromium.launchPersistentContext(profile, { ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}), headless: true, acceptDownloads: true });
const page = await context.newPage();
const failures = [];
page.on('pageerror', error => failures.push(error.message));
let timer;
try {
  await page.goto(base);
  await page.locator('#url').fill(video);
  await page.locator('#inspect').click();
  await page.locator('#result').waitFor({ state: 'visible', timeout: 90000 });
  await page.locator('#format').selectOption(key);
  await page.locator('#create').click();
  if (process.env.Y2Y2_TEST_RESUME === '1') {
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('y2y2-device-jobs-v1') || '[]')[0]?.received >= 4 * 1024 * 1024, null, { timeout: 120000 });
    await page.getByRole('button', { name: '일시중단', exact: true }).click();
    await page.getByRole('button', { name: '이어받기 / 병합 재시도', exact: true }).waitFor({ state: 'visible', timeout: 20000 });
    await page.reload();
    await page.getByRole('button', { name: '이어받기 / 병합 재시도', exact: true }).click();
    console.log('Resumed after pause and page reload.');
  }
  timer = setInterval(async () => {
    try { console.log((await page.locator('.job p[role=status]').allTextContents()).join(' | ')); } catch {}
  }, 15000);
  await page.waitForFunction(() => {
    const job = JSON.parse(localStorage.getItem('y2y2-device-jobs-v1') || '[]')[0];
    return job?.phase === 'ready' || document.querySelector('#notice.error')?.textContent;
  }, null, { timeout: 20 * 60 * 1000 });
  assert.equal(await page.locator('#notice.error').count(), 0, await page.locator('#notice').textContent());
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: '파일 저장', exact: true }).click();
  await (await downloadPromise).saveAs(destination);
  assert.deepEqual(failures, []);
  const sha = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(destination)) { sha.update(chunk); bytes += chunk.length; }
  const job = await page.evaluate(() => {
    const value = JSON.parse(localStorage.getItem('y2y2-device-jobs-v1'))[0];
    return { choice: value.choice, phase: value.phase, message: value.message };
  });
  const result = { checkedAt: new Date().toISOString(), origin: base, source: video, format: key, bytes,
    sha256: sha.digest('hex'), resumeTested: process.env.Y2Y2_TEST_RESUME === '1', ...job };
  await writeFile(destination + '.verification.json', JSON.stringify(result, null, 2));
  await page.screenshot({ path: destination + '.png', fullPage: true });
  console.log(JSON.stringify(result));
} finally { clearInterval(timer); await context.close(); await rm(profile, { recursive: true, force: true }); }
