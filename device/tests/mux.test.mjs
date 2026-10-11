import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { mkdtemp, open, rm, stat, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Input, ALL_FORMATS, BlobSource, EncodedPacketSink } from 'mediabunny';
import { muxTracks, verifyMuxed } from '../mux.js';

const ffmpeg = process.env.Y2Y2_TEST_FFMPEG || 'ffmpeg';
const supported = spawnSync(ffmpeg, ['-version'], { stdio: 'ignore' }).status === 0;
function run(args) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

async function packets(path, role) {
  const input = new Input({ source: new BlobSource(await openAsBlob(path)), formats: ALL_FORMATS });
  try {
    const track = role === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
    const hash = createHash('sha256'), times = [];
    for await (const packet of new EncodedPacketSink(track).packets()) {
      hash.update(packet.data); times.push(packet.timestamp);
    }
    return { hash: hash.digest('hex'), times };
  } finally { input.dispose(); }
}

async function writable(path) {
  const file = await open(path, 'w');
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await file.close(); } };
  return new WritableStream({
    async write(chunk) {
      let offset = 0;
      while (offset < chunk.data.length) {
        const { bytesWritten } = await file.write(chunk.data, offset, chunk.data.length - offset, chunk.position + offset);
        assert.ok(bytesWritten); offset += bytesWritten;
      }
    }, close, abort: close,
  });
}

test('H.264 B frames + AAC merge preserves every encoded packet and timestamp', { skip: !supported }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'y2y2-mux-'));
  try {
    const video = join(root, 'video.mp4'), audio = join(root, 'audio.m4a'), output = join(root, 'output.mp4');
    run(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '2', '-g', '30', '-an', video]);
    run(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-c:a', 'aac', '-vn', audio]);
    const result = await muxTracks(await openAsBlob(video), await openAsBlob(audio), await writable(output), { container: 'mp4', width: 1920, height: 1080, fps: 30 });
    assert.equal(result.width, 1920); assert.equal(result.acodec, 'aac');
    for (const role of ['video', 'audio']) {
      const before = await packets(role === 'video' ? video : audio, role), after = await packets(output, role);
      assert.equal(after.hash, before.hash, role + ' packet payload changed');
      assert.equal(after.times.length, before.times.length);
      for (let i = 0; i < before.times.length; i++) assert.ok(Math.abs(before.times[i] - after.times[i]) < 0.0001, role + ' timing changed');
    }
    await verifyMuxed(await openAsBlob(output), result);
    run(['-xerror', '-i', output, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
    await truncate(output, Math.floor((await stat(output)).size / 2));
    await assert.rejects(verifyMuxed(await openAsBlob(output), result));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('4K AV1 + Opus merge keeps original encoded data and is fully readable', { skip: !supported }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'y2y2-original-'));
  try {
    const video = join(root, 'video.mp4'), audio = join(root, 'audio.webm'), output = join(root, 'output.webm');
    run(['-f', 'lavfi', '-i', 'color=size=3840x2160:rate=30', '-t', '0.3', '-c:v', 'libaom-av1', '-cpu-used', '8', '-row-mt', '1', '-an', video]);
    run(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '0.3', '-c:a', 'libopus', '-vn', audio]);
    const result = await muxTracks(await openAsBlob(video), await openAsBlob(audio), await writable(output), { container: 'webm', width: 3840, height: 2160, fps: 30 });
    assert.equal(result.vcodec, 'av1'); assert.equal(result.acodec, 'opus');
    await verifyMuxed(await openAsBlob(output), result);
    for (const role of ['video', 'audio']) {
      const before = await packets(role === 'video' ? video : audio, role), after = await packets(output, role);
      assert.equal(after.hash, before.hash, role + ' packet payload changed');
      assert.equal(after.times.length, before.times.length);
      for (let i = 0; i < before.times.length; i++) assert.ok(Math.abs(before.times[i] - after.times[i]) < 0.001, role + ' timing changed');
    }
    run(['-xerror', '-i', output, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
    await truncate(output, Math.floor((await stat(output)).size / 2));
    await assert.rejects(verifyMuxed(await openAsBlob(output), result));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('incorrect requested resolution fails instead of silently lowering quality', { skip: !supported }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'y2y2-wrong-quality-'));
  try {
    const video = join(root, 'video.mp4'), audio = join(root, 'audio.m4a');
    run(['-f', 'lavfi', '-i', 'color=size=320x180:rate=10', '-t', '1', '-c:v', 'libx264', '-an', video]);
    run(['-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', '-c:a', 'aac', '-vn', audio]);
    await assert.rejects(muxTracks(await openAsBlob(video), await openAsBlob(audio), new WritableStream(), { container: 'mp4', width: 1920, height: 1080 }), /해상도/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
