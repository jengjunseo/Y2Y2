// Read-only local media diagnostics. Hash encoded payloads without loading a whole file.
import { createHash } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { Input, ALL_FORMATS, BlobSource, EncodedPacketSink } from 'mediabunny';

for (const path of process.argv.slice(2)) {
  const input = new Input({ source: new BlobSource(await openAsBlob(path)), formats: ALL_FORMATS });
  try {
    const report = { path, tracks: [] };
    for (const track of await input.getTracks()) {
      if (!track.isVideoTrack() && !track.isAudioTrack()) continue;
      const hash = createHash('sha256'); let packets = 0, bytes = 0, end = 0;
      for await (const packet of new EncodedPacketSink(track).packets()) {
        hash.update(packet.data); packets++; bytes += packet.data.length; end = Math.max(end, packet.timestamp + packet.duration);
      }
      report.tracks.push({ role: track.isVideoTrack() ? 'video' : 'audio', codec: track.codec,
        width: track.isVideoTrack() ? await track.getCodedWidth() : null,
        height: track.isVideoTrack() ? await track.getCodedHeight() : null,
        packets, bytes, end, payloadSha256: hash.digest('hex') });
    }
    console.log(JSON.stringify(report));
  } finally { input.dispose(); }
}
