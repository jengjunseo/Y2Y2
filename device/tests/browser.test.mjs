import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { chromium, firefox, webkit } from '@playwright/test';

test('browser stores chunks in OPFS, resumes after reload, muxes, verifies, and exports a file', { timeout: 300000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'y2y2-browser-'));
  let server, browser;
  try {
    const ffmpeg = process.env.Y2Y2_TEST_FFMPEG || 'ffmpeg';
    let video = process.env.Y2Y2_FIXTURE_VIDEO, audio = process.env.Y2Y2_FIXTURE_AUDIO;
    const large = Boolean(video);
    if (!video) {
      video = join(root, 'video.mp4'); audio = join(root, 'audio.m4a');
      for (const args of [
        ['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '2', '-an', video],
        ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '8', '-c:a', 'aac', '-vn', audio],
      ]) {
        const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
      }
    }
    const paths = { v: resolve(video), a: resolve(audio) };
    const sizes = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, (await stat(path)).size])));
    const choice = { key: 'v+a', video: 'v', audio: 'a', container: large ? 'webm' : 'mp4', profile: 'original',
      width: large ? 3840 : 1920, height: large ? 2160 : 1080, fps: large ? 60 : 30, bytes: sizes.v + sizes.a, label: 'Fixture' };
    const manifest = { id: 'fixture-manifest', videoId: 'aqz-KE-bpKQ', title: 'Local fixture', expires: Date.now() / 1000 + 3600,
      duration: large ? 634.58 : 8, choices: [choice], tracks: { v: { url: '/fixture/v', size: sizes.v }, a: { url: '/fixture/a', size: sizes.a } } };
    const ranges = [];
    server = createServer(async (request, response) => {
      const json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
      if (request.url === '/health') return json({ mode: 'device-storage', authenticated: true });
      if (request.url === '/v2/inspect') return json(manifest);
      if (request.url.startsWith('/fixture/')) {
        const key = request.url.split('/').pop();
        const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
        if (!match || !paths[key]) { response.writeHead(416).end(); return; }
        const start = Number(match[1]), end = Number(match[2]); ranges.push({ key, start, end });
        response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${sizes[key]}`, 'Content-Length': end - start + 1, 'Cache-Control': 'no-store' });
        // Give the test enough time to pause between chunks without depending on WAN speed.
        setTimeout(() => createReadStream(paths[key], { start, end }).pipe(response), 50);
        return;
      }
      const assets = { '/': 'index.html', '/assets/device-app.js': 'device-app.js', '/assets/device-worker.js': 'device-worker.js', '/assets/style.css': 'style.css' };
      if (!assets[request.url]) { response.writeHead(404).end(); return; }
      response.setHeader('Content-Type', request.url.endsWith('.js') ? 'text/javascript' : request.url.endsWith('.css') ? 'text/css' : 'text/html');
      response.end(await readFile(resolve('backend/public', assets[request.url])));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browserType = { chromium, firefox, webkit }[process.env.Y2Y2_TEST_BROWSER || 'chromium'];
    assert.ok(browserType, 'unknown browser');
    const context = await browserType.launchPersistentContext(join(root, 'browser-profile'), {
      ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}), headless: true, acceptDownloads: true });
    browser = context;
    const page = await context.newPage();
    await page.goto(origin);
    await page.locator('#url').fill('aqz-KE-bpKQ'); await page.locator('#inspect').click();
    await page.locator('#result').waitFor({ state: 'visible' }); await page.locator('#create').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('y2y2-device-jobs-v1') || '[]')[0]?.received >= 4 * 1024 * 1024 || document.querySelector('#notice.error')?.textContent);
    assert.equal(await page.locator('#notice.error').count(), 0, await page.locator('#notice').textContent());
    await page.getByRole('button', { name: '일시중단', exact: true }).click();
    await page.getByRole('button', { name: '이어받기 / 병합 재시도', exact: true }).waitFor({ state: 'visible' });
    await page.reload();
    const resumeIndex = ranges.length;
    await page.getByRole('button', { name: '이어받기 / 병합 재시도', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.job .download') || document.querySelector('#notice.error')?.textContent, null, { timeout: 240000 });
    const diagnostic = await page.evaluate(async () => {
      const job = JSON.parse(localStorage.getItem('y2y2-device-jobs-v1'))[0];
      const root = await navigator.storage.getDirectory(); const jobs = await root.getDirectoryHandle('y2y2-device');
      const directory = await jobs.getDirectoryHandle(job.id);
      const raw = await (await (await directory.getFileHandle('state.json')).getFile()).text();
      let state; try { state = JSON.parse(raw); } catch { state = { verification: { invalidStateLength: raw.length } }; }
      const sizes = {};
      for await (const [name, handle] of directory.entries()) if (handle.kind === 'file') sizes[name] = (await handle.getFile()).size;
      return { verification: state.verification, sizes, storage: await navigator.storage.estimate(), notice: document.querySelector('#notice').textContent };
    });
    console.log(JSON.stringify(diagnostic));
    assert.equal(await page.locator('#notice.error').count(), 0, diagnostic.notice);
    assert.ok(ranges.slice(resumeIndex).filter(r => r.key === 'v').every(r => r.start >= 4 * 1024 * 1024), 'completed chunks were downloaded again');
    const pending = page.waitForEvent('download'); await page.getByRole('link', { name: '파일 저장', exact: true }).click();
    const destination = process.env.Y2Y2_BROWSER_OUTPUT || join(root, 'saved.' + choice.container);
    await (await pending).saveAs(destination);
    assert.equal((await stat(destination)).size, diagnostic.sizes['Y2Y2.' + choice.container]);
    if (!large) {
      const decoded = spawnSync(ffmpeg, ['-v', 'error', '-xerror', '-i', destination, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], { encoding: 'utf8' });
      assert.equal(decoded.status, 0, decoded.stderr);
      assert.equal(decoded.stderr.trim(), '', 'decoder reported incomplete media');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByRole('button', { name: '기기 보관 파일 삭제', exact: true }).click();
    await page.locator('.job').waitFor({ state: 'hidden' });
  } finally {
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await rm(root, { recursive: true, force: true });
  }
});
