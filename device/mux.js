import { Input, ALL_FORMATS, BlobSource, EncodedPacketSink, Output, StreamTarget,
  Mp4OutputFormat, WebMOutputFormat, EncodedVideoPacketSource, EncodedAudioPacketSource } from 'mediabunny';

// Packet copy only. No VideoDecoder, VideoEncoder, WASM, scaling, or lossy fallback.
export async function muxTracks(videoFile, audioFile, writable, choice, { signal, onProgress = () => {} } = {}) {
  const inputs = [];
  let output;
  const input = file => {
    const value = new Input({ source: new BlobSource(file, { maxCacheSize: 1024 * 1024 }), formats: ALL_FORMATS });
    inputs.push(value);
    return value;
  };
  try {
    const video = videoFile ? await input(videoFile).getPrimaryVideoTrack() : null;
    const audio = await input(audioFile).getPrimaryAudioTrack();
    if (!audio?.codec || (videoFile && !video?.codec)) throw Error('영상 또는 음성 트랙이 없습니다.');
    if (video && (await video.getCodedWidth() !== choice.width || await video.getCodedHeight() !== choice.height)) {
      throw Error('받은 영상의 실제 해상도가 선택한 화질과 다릅니다.');
    }
    const format = choice.container === 'webm' ? new WebMOutputFormat() : new Mp4OutputFormat({ fastStart: false });
    if (!format.getSupportedAudioCodecs().includes(audio.codec) ||
        (video && !format.getSupportedVideoCodecs().includes(video.codec))) {
      throw Error('원본 코덱을 이 파일 형식에 그대로 합칠 수 없습니다. 다른 형식을 선택해 주세요.');
    }
    output = new Output({ format, target: new StreamTarget(writable, { chunked: true, chunkSize: 1024 * 1024 }) });
    const states = [];
    for (const track of [video, audio].filter(Boolean)) {
      const isVideo = track === video;
      const source = isVideo ? new EncodedVideoPacketSource(track.codec) : new EncodedAudioPacketSource(track.codec);
      const config = await track.getDecoderConfig();
      if (!config) throw Error('원본 트랙의 코덱 정보를 읽을 수 없습니다.');
      if (isVideo) output.addVideoTrack(source, { rotation: await track.getRotation(), ...(choice.fps ? { frameRate: choice.fps } : {}) });
      else output.addAudioTrack(source);
      const iterator = new EncodedPacketSink(track).packets();
      states.push({ source, config, iterator, next: await iterator.next(), first: true, count: 0, bytes: 0, role: isVideo ? 'video' : 'audio', end: 0 });
    }
    await output.start();
    let count = 0, lastProgress = 0;
    while (states.some(state => !state.next.done)) {
      signal?.throwIfAborted();
      // Interleave tracks while preserving each track's decode order, including B frames.
      const state = states.filter(s => !s.next.done).sort((a, b) => a.next.value.timestamp - b.next.value.timestamp)[0];
      const packet = state.next.value;
      await state.source.add(packet, state.first ? { decoderConfig: state.config } : undefined);
      state.first = false;
      state.count++;
      state.bytes += packet.data.length;
      state.end = Math.max(state.end, packet.timestamp + packet.duration);
      state.next = await state.iterator.next();
      if (state.next.done) state.source.close();
      lastProgress = Math.max(lastProgress, packet.timestamp + packet.duration);
      if (++count % 240 === 0) {
        onProgress(lastProgress);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    if (states.some(state => !state.count)) throw Error('영상 또는 음성 데이터가 비어 있습니다.');
    signal?.throwIfAborted();
    await output.finalize();
    return { width: video ? await video.getCodedWidth() : null, height: video ? await video.getCodedHeight() : null,
      vcodec: video?.codec ?? null, acodec: audio.codec, seconds: lastProgress, packets: count,
      tracks: Object.fromEntries(states.map(state => [state.role, { seconds: state.end, packets: state.count, bytes: state.bytes }])) };
  } catch (error) {
    if (output && !['finalized', 'canceled'].includes(output.state)) await output.cancel().catch(() => {});
    throw error;
  } finally {
    for (const value of inputs) value.dispose();
  }
}

export async function verifyMuxed(file, expected, signal) {
  const input = new Input({ source: new BlobSource(file, { maxCacheSize: 1024 * 1024 }), formats: ALL_FORMATS });
  try {
    for (const [role, value] of Object.entries(expected.tracks)) {
      const track = role === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
      if (!track) throw Error('완성 파일의 트랙이 누락됐습니다.');
      if (role === 'video' && (await track.getCodedWidth() !== expected.width || await track.getCodedHeight() !== expected.height)) throw Error('완성 파일의 해상도가 다릅니다.');
      let count = 0, bytes = 0, end = 0;
      for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) {
        signal?.throwIfAborted();
        count++; bytes += packet.byteLength; end = Math.max(end, packet.timestamp + packet.duration);
        if (count % 1000 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (count !== value.packets || bytes !== value.bytes || Math.abs(end - value.seconds) > 0.1) {
        throw Error('병합 결과에서 데이터 누락을 확인했습니다. 파일 저장을 중단합니다. 받은 조각으로 병합을 다시 시도해 주세요.');
      }
    }
  } finally { input.dispose(); }
}
