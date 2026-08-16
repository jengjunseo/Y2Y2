# Y2Y2 v0.3 — Distributed Local Engine

**Paste → Queue → Choose → Download on this device.**

Y2Y2 is a personal controller for media that you are authorized to download. The Vercel site is only the responsive PWA/controller. MP3/MP4 extraction, conversion, queue ownership and final files stay on the device running **Y2Y2 Engine**.

```text
Y2Y2 PWA (Vercel)
        │ Engine Protocol v1 over loopback
        ├───────────────┐
        ▼               ▼
Windows Engine      Android Engine
127.0.0.1:49272     127.0.0.1:49272
 yt-dlp + ffmpeg     yt-dlp + ffmpeg
        │               │
Downloads/Y2Y2      Download/Y2Y2
```

## What changed from v0.2

The Vercel Sandbox downloader has been removed from the product path. That prototype reached yt-dlp successfully but cloud/datacenter extraction was rejected by YouTube's bot-confirmation path. v0.3 therefore moves the media engine to the current device rather than adding cookie harvesting, proxy rotation, or access-control bypasses.

## Features

- Multi-line / multi-URL queue
- Independent MP3/MP4 option per item
- MP3 128/192/256/320 kbps
- MP4 360/720/1080/1440/2160p only when the source exposes that target
- Queue reorder + optional numbered filenames
- Engine-owned persistent batch state; browser can close after submission
- Partial failures do not discard successful files
- Retry/cancel and local history
- No ZIP batch fallback
- No media upload to Vercel
- Pairing token + Origin boundary for local engine control

## Install artifacts

GitHub Actions workflow **Build Distributed Engines** produces:

- `Y2Y2-Engine-Windows-x64` — portable Windows executable
- `Y2Y2-Engine-Android-debug` — installable debug APK for Android phone/tablet certification

Open the workflow run and download the matching artifact. The debug APK is intentionally reported as a debug build until a real Android release-signing key exists.

## Windows

Run `Y2Y2-Engine-Windows-x64.exe`. It opens a small localhost page showing a six-digit pairing code. Open the Vercel Y2Y2 site, enter the code once, then use the queue normally. Finished files go to `Downloads/Y2Y2`.

No separate Python, Node, yt-dlp, ffmpeg or Deno installation is intended for the packaged artifact.

## Android

Install the APK, open **Y2Y2 Engine**, and leave the foreground Engine service running while downloading. Open Y2Y2 from the app, pair with the six-digit code, and submit the batch. Finished media is published through Android MediaStore to `Download/Y2Y2` so it is visible to file/media apps.

## Local development

Web syntax:

```bash
npm run check
```

Windows engine tests:

```bash
python -m pip install pytest
python -m pytest -q engine/windows/tests
```

Full Windows packaging and Android Gradle compilation are performed by `.github/workflows/build-engines.yml` on their appropriate CI runtimes.

## Security / rights boundary

The Engine binds only to loopback. Health/pair/control traffic accepts only the Y2Y2 Vercel origin (plus explicit local development origins), and control actions require a device-local bearer token obtained through the six-digit pairing flow.

Use Y2Y2 only for content you own, content whose rights holder permits downloading, or content you otherwise have permission to download. Y2Y2 does not implement DRM/paywall/private-content bypasses, automated cookie collection, CAPTCHA/bot-challenge bypasses, or proxy rotation.

See `docs/adr/0001-distributed-local-engine.md` for the architecture decision.
