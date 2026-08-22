import test from 'node:test';
import assert from 'node:assert/strict';
import { extractVideoId, isGoogleVideoUrl, normalizeFormats, safeFileName, withDownloadTitle } from '../direct/core.js';

test('extractVideoId accepts common YouTube URL shapes only', () => {
  assert.equal(extractVideoId('https://www.youtube.com/watch?v=aqz-KE-bpKQ'), 'aqz-KE-bpKQ');
  assert.equal(extractVideoId('https://youtu.be/aqz-KE-bpKQ'), 'aqz-KE-bpKQ');
  assert.equal(extractVideoId('https://www.youtube.com/shorts/aqz-KE-bpKQ'), 'aqz-KE-bpKQ');
  assert.equal(extractVideoId('https://evil.example/watch?v=aqz-KE-bpKQ'), null);
});

test('resolver only accepts HTTPS GoogleVideo media URLs', () => {
  assert.equal(isGoogleVideoUrl('https://r1---sn-test.googlevideo.com/videoplayback?itag=18'), true);
  assert.equal(isGoogleVideoUrl('http://r1---sn-test.googlevideo.com/videoplayback?itag=18'), false);
  assert.equal(isGoogleVideoUrl('https://googlevideo.com.evil.example/videoplayback'), false);
});

test('normalizeFormats exposes only direct GoogleVideo URLs', () => {
  const player = { streamingData: { formats: [
    { itag: 18, url: 'https://r1---sn-test.googlevideo.com/videoplayback?itag=18&ip=1.2.3.4&c=ANDROID_VR', mimeType: 'video/mp4; codecs="avc1, mp4a"', width: 640, height: 360, bitrate: 500000, contentLength: '1234' },
    { itag: 22, url: 'https://evil.example/file.mp4', mimeType: 'video/mp4', width: 1280, height: 720 }
  ] } };
  const out = normalizeFormats(player);
  assert.equal(out.progressive.length, 1);
  assert.equal(out.progressive[0].itag, 18);
  assert.equal(out.progressive[0].ipBound, true);
  assert.equal(out.progressive[0].client, 'ANDROID_VR');
});

test('download title is sanitized before being added to direct URL', () => {
  const result = withDownloadTitle('https://r1---sn-test.googlevideo.com/videoplayback?itag=18', '../bad:name?.mp4');
  const url = new URL(result);
  assert.equal(url.searchParams.get('title'), 'bad name .mp4');
  assert.equal(safeFileName('a/b\\c'), 'a b c');
});
