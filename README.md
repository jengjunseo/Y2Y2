# Y2Y2

Private, cross-device YouTube media queue for content you are authorized to download.

**Paste → Queue → Choose → Prepare → Download.**

Y2Y2 lets you add many links, choose MP3/MP4 and quality per item, prepare them in the background, then trigger individual downloads in sequence. It never needs to build a ZIP for batch download.

## Architecture

```text
Browser / PWA
    ↓
Cloudflare Worker + Static Assets
    ├─ D1: job/history metadata
    ├─ Workflows: durable per-file jobs
    ├─ R2: temporary finished artifacts
    └─ Container Durable Objects
          ↓
       yt-dlp + ffmpeg
```

The Worker only accepts standard YouTube hostnames. The container does not implement login, DRM, paywall, age-gate, or access-control bypasses.

## Features

- Multiple URL queue, including multi-line paste
- Per-item MP3 / MP4 selection
- MP3: 128 / 192 / 256 / 320 kbps
- MP4: source-available 360 / 720 / 1080 / 1440 / 2160p
- Reorder queue for playlist-style numbered filenames
- Durable background processing with Cloudflare Workflows
- R2 artifact reuse so identical output is not processed twice
- Partial failure: successful items stay downloadable
- Cross-device history through D1
- Responsive desktop / tablet / phone UI
- Installable PWA shell
- No ZIP batch fallback

## Local checks

```bash
npm install
npm run check
```

For local Container development, Docker must be running. Before `wrangler dev`, configure a real or local D1 binding as described in `DEPLOY_CLOUDFLARE.md`.

## Deployment

See [`DEPLOY_CLOUDFLARE.md`](./DEPLOY_CLOUDFLARE.md).

## Important boundary

Use Y2Y2 only for content you own, content whose rights holder permits downloading, or content you otherwise have permission to download. The project intentionally does not add mechanisms to bypass access controls.
