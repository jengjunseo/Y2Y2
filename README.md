# Y2Y2 v1.0 beta — Web-Native

**Paste → Queue → Download. No Engine required.**

Y2Y2 is a personal web controller for media that you are authorized to download. The v1 default path removes EXE/APK installation, six-digit pairing, Home Engine registration, and the requirement to keep a PC online.

```text
Y2Y2 PWA (Vercel)
        │ small inspect requests
        ▼
YouTube-only Web Gateway
resolver + bounded Range tunnel
NO ffmpeg / NO permanent media storage
        │
        ▼
Browser
OPFS + Mediabunny + MP3 LAME WASM
        │
        ▼
individual MP3 / MP4 files
```

## What changed from v0.4

v0.4 routed work to a Local Engine or registered Windows Home Engine. v1 keeps that implementation frozen in the repository as a fallback/reference, but the normal UI is Web-Native and requires no pairing.

The cloud does not encode, mux, or permanently store results. `api/web.js` resolves public YouTube stream metadata and tunnels only bounded byte ranges selected by validated video ID + itag. MP3 encoding and MP4 muxing happen in the current browser.

## Processing paths

- Progressive MP4: bounded Range download → OPFS → browser download.
- Split MP4: separate video/audio Range sources → Mediabunny transmux/mux → OPFS → browser download.
- MP3: audio Range source → browser decode → Mediabunny MP3 encoder (LAME WASM) → OPFS → browser download.
- Batch output is always individual files; Y2Y2 does not create ZIP archives.

## Browser contract

Keep the Y2Y2 page/PWA alive while an active item is downloading, muxing, or encoding. Y2Y2 may request a screen wake lock when supported. It does not claim that work survives a fully terminated browser.

OPFS support is required for the v1 beta so large files are not intentionally held in one giant JS buffer.

## Gateway boundary

The Web Gateway:

- accepts supported YouTube video IDs/URLs only;
- does not expose an arbitrary upstream URL proxy;
- caps every byte-range response;
- rejects cross-site browser requests;
- does not run yt-dlp or ffmpeg;
- does not persist completed media;
- does not collect browser/account cookies;
- does not implement CAPTCHA/bot-challenge bypass, proxy rotation, DRM/paywall/private-content bypasses, or account-cookie harvesting.

If YouTube rejects the deployed Gateway, Y2Y2 fails closed with an explicit error rather than pretending the file is ready.

## Development

```bash
npm install
npm run check
npm run build
```

The existing Windows and Android Engine tests remain in CI as regression evidence while the legacy fallback is frozen.

See:
- `docs/adr/0001-distributed-local-engine.md`
- `docs/adr/0002-relay-queue-hybrid-engine.md`
- `docs/adr/0003-web-native-gateway.md`
