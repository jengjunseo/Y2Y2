# Y2Y2

Private, cross-device media queue for YouTube content you are authorized to download.

**Paste → Queue → Choose → Prepare → Download.**

Y2Y2 lets you add many links, choose MP3/MP4 and quality per item, prepare them in the background, then trigger individual downloads in queue order. Batch download never requires a ZIP.

## Vercel architecture

```text
Browser / PWA
    ↓
Vercel static app + Functions
    ↓ control API
Named persistent Vercel Sandbox (Python 3.13)
    ├─ yt-dlp
    ├─ ffmpeg
    ├─ job/history JSON
    └─ 24h temporary media cache
         ↓ direct port 8080 download
      Browser
```

The Vercel Functions are intentionally thin. Metadata extraction, conversion, job state and temporary media files live in one named persistent Sandbox. Large files are downloaded directly from the Sandbox's published port rather than being proxied through a Function.

## Features

- Multiple-URL queue, including multiline paste
- Per-item MP3 / MP4 selection
- MP3: 128 / 192 / 256 / 320 kbps
- MP4: source-available 360 / 720 / 1080 / 1440 / 2160p
- Queue reordering and optional numbered filenames
- Up to two media jobs processed concurrently in the Sandbox
- Artifact reuse for the same video / output option while the file is retained
- Partial failures do not discard successful items
- Recent job history shared across devices through the persistent Sandbox filesystem
- Responsive desktop / tablet / phone UI and installable PWA shell
- No ZIP batch fallback

## Deploy

The repository is intended to be connected to a Vercel Project through Git integration. Pushes to `main` deploy automatically when Production Branch is `main`.

See [`DEPLOY_VERCEL.md`](./DEPLOY_VERCEL.md) for deployment and troubleshooting details.

## Local static checks

```bash
npm install
npm run check
```

The live Sandbox path is a Vercel service, so full runtime certification should be done on a Vercel Preview or Production deployment rather than inferred from static checks.

## Important boundary

Use Y2Y2 only for content you own, content whose rights holder permits downloading, or content you otherwise have permission to download. The project intentionally does not implement login, DRM, paywall, age-gate, or other access-control bypasses.
