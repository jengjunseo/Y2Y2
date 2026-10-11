import { muxTracks, verifyMuxed } from './mux.js';

const CHUNK = 4 * 1024 * 1024;
let running = false, controller;

function writeAll(access, bytes, offset) {
  let written = 0;
  while (written < bytes.byteLength) {
    const count = access.write(bytes.subarray(written), { at: offset + written });
    if (!count) throw Error('기기 저장 공간에 기록하지 못했습니다.');
    written += count;
  }
}

async function saveState(directory, state) {
  const handle = await directory.getFileHandle('state.json', { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(JSON.stringify(state));
    await writable.close();
  } catch (error) { await writable.abort().catch(() => {}); throw error; }
}

async function fetchChunk(url, start, end, size, signal) {
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    try {
      const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal, cache: 'no-store' });
      if ([429, 502, 503, 504].includes(response.status) && attempt < 2) {
        await response.body?.cancel();
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      if (response.status === 410) throw Error('원본 전송 링크가 만료됐습니다. 다시 분석한 뒤 새 작업을 시작해 주세요.');
      if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end}/${size}`) {
        await response.body?.cancel();
        throw Error('분할 전송 응답이 올바르지 않습니다. 다른 화질로 대체하지 않습니다.');
      }
      // At most one 4 MiB chunk is materialized, never the full media file.
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== end - start + 1) throw Error('전송된 조각의 길이가 맞지 않습니다.');
      return bytes;
    } catch (error) {
      if (signal.aborted || attempt === 2 || ![TypeError].some(type => error instanceof type)) throw error;
    }
  }
  throw Error('분할 전송을 완료하지 못했습니다.');
}

async function downloadTrack(directory, state, role, signal) {
  const track = state.manifest.tracks[state.choice[role]];
  const handle = await directory.getFileHandle(role + '.track', { create: true });
  const access = await handle.createSyncAccessHandle();
  try {
    let offset = state.committed[role] || 0;
    if (access.getSize() < offset) offset = 0;
    access.truncate(offset); // Discard bytes not committed before an interrupted write.
    while (offset < track.size) {
      signal.throwIfAborted();
      const end = Math.min(offset + CHUNK, track.size) - 1;
      const bytes = await fetchChunk(track.url, offset, end, track.size, signal);
      writeAll(access, bytes, offset);
      access.flush();
      offset += bytes.length;
      state.committed[role] = offset;
      await saveState(directory, state);
      postMessage({ type: 'progress', phase: 'download', received: Object.values(state.committed).reduce((a, b) => a + b, 0), total: state.choice.bytes });
    }
  } finally { access.close(); }
  const file = await handle.getFile();
  if (file.size !== track.size) throw Error('기기에 기록된 원본 트랙의 길이가 맞지 않습니다. 이어받기를 다시 시도해 주세요.');
  return file;
}

async function run(job, signal) {
  if (!navigator.storage?.getDirectory) throw Error('이 브라우저에서는 기기 분할 저장을 사용할 수 없습니다. 최신 브라우저를 사용해 주세요.');
  const root = await navigator.storage.getDirectory();
  const jobs = await root.getDirectoryHandle('y2y2-device', { create: true });
  const directory = await jobs.getDirectoryHandle(job.id, { create: true });
  let state;
  try { state = JSON.parse(await (await (await directory.getFileHandle('state.json')).getFile()).text()); }
  catch { state = { ...job, committed: {}, phase: 'download' }; }
  if (state.id !== job.id || state.choice.key !== job.choice.key || state.manifest.id !== job.manifest.id) throw Error('저장된 작업 정보가 일치하지 않습니다.');
  const filename = 'Y2Y2.' + state.choice.container;
  if (state.phase === 'ready') {
    const file = await (await directory.getFileHandle(filename)).getFile();
    postMessage({ type: 'ready', file, filename, verification: state.verification });
    return;
  }
  const roles = state.choice.video ? ['video', 'audio'] : ['audio'];
  const needsDownload = roles.some(role => (state.committed[role] || 0) < state.manifest.tracks[state.choice[role]].size);
  if (needsDownload && Date.now() / 1000 >= state.manifest.expires) throw Error('원본 전송 링크가 만료됐습니다. 다시 분석한 뒤 새 작업을 시작해 주세요.');
  // A failed verification may leave an output copy. Inputs remain available to retry.
  await directory.removeEntry(filename).catch(error => { if (error.name !== 'NotFoundError') throw error; });
  const estimate = await navigator.storage.estimate();
  const committed = Object.values(state.committed).reduce((a, b) => a + b, 0);
  const needed = (state.choice.bytes * 2.1) - committed;
  if (Number.isFinite(estimate.quota) && needed > estimate.quota - (estimate.usage || 0)) {
    throw Error('영상·음성 조각과 완성 파일을 함께 둘 기기 저장 공간이 부족합니다. 보관 파일을 지우거나 다른 화질을 직접 선택해 주세요.');
  }
  await saveState(directory, state);
  const video = state.choice.video ? await downloadTrack(directory, state, 'video', signal) : null;
  const audio = await downloadTrack(directory, state, 'audio', signal);
  postMessage({ type: 'progress', phase: 'merge', received: state.choice.bytes, total: state.choice.bytes });
  const outputHandle = await directory.getFileHandle(filename, { create: true });
  // Native positioned writes commit the completed file when the stream closes.
  const writable = await outputHandle.createWritable();
  try {
    state.verification = await muxTracks(video, audio, writable, state.choice, { signal,
      onProgress: seconds => postMessage({ type: 'progress', phase: 'merge', seconds, duration: state.manifest.duration }) });
  } catch (error) { await writable.abort().catch(() => {}); throw error; }
  if (state.manifest.duration && Object.values(state.verification.tracks).some(track =>
    Math.abs(track.seconds - state.manifest.duration) > Math.max(2, state.manifest.duration * 0.01))) {
    throw Error('완성 파일의 재생 시간이 원본과 다릅니다. 저장 완료로 처리하지 않습니다.');
  }
  const file = await outputHandle.getFile();
  if (!file.size) throw Error('완성 파일이 비어 있습니다.');
  state.phase = 'verify';
  await saveState(directory, state);
  postMessage({ type: 'progress', phase: 'verify' });
  await verifyMuxed(file, state.verification, signal);
  state.phase = 'ready';
  await saveState(directory, state);
  // Keep only the final file and small metadata; release original track copies.
  for (const role of ['video', 'audio']) await directory.removeEntry(role + '.track').catch(() => {});
  postMessage({ type: 'ready', file, filename, verification: state.verification });
}

self.onmessage = async ({ data }) => {
  if (data.type === 'pause') { controller?.abort(); return; }
  if (data.type !== 'run' || running) return;
  running = true;
  controller = new AbortController();
  try {
    if (!/^[a-zA-Z0-9-]{10,80}$/.test(data.job.id)) throw Error('작업 번호가 올바르지 않습니다.');
    if (!navigator.locks) throw Error('이 브라우저에서는 안전한 작업 잠금을 지원하지 않습니다.');
    await navigator.locks.request('y2y2-device-work', { ifAvailable: true }, async lock => {
      if (!lock) throw Error('다른 탭에서 저장하고 있습니다. 해당 작업을 마친 뒤 다시 시도해 주세요.');
      await run(data.job, controller.signal);
    });
  } catch (error) {
    postMessage({ type: controller.signal.aborted ? 'paused' : 'error', message: controller.signal.aborted ? '기기에 받은 조각을 보관했습니다. 이어받기를 누르면 계속합니다.' :
      error.name === 'QuotaExceededError' ? '브라우저의 기기 저장 한도가 부족합니다. 비공개 모드라면 일반 창을 사용하거나 보관 파일을 삭제해 주세요. 낮은 화질을 원하면 직접 선택해 주세요.' :
      error.name === 'NotSupportedError' ? '이 브라우저에서는 기기 분할 기록을 지원하지 않습니다. 최신 브라우저의 일반 창을 사용해 주세요.' : error.message });
  } finally { running = false; }
};
