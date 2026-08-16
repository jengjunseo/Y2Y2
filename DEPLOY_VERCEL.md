# Vercel deployment guide

Y2Y2 v0.2 is Vercel-native. It no longer requires Cloudflare D1, R2, Workers, Workflows, Containers, Wrangler, or Docker.

## 1. Connect the repository

Create/import a Vercel Project from:

```text
https://github.com/jengjunseo/Y2Y2
```

Keep the project root at the repository root. No custom output directory is required.

The repository contains `vercel.json`, so Vercel discovers the static `public/` app and the `api/*.js` Functions at deployment time.

## 2. Deploy

With Git integration, a push to the configured Production Branch is enough. For this repository the intended Production Branch is `main`.

You can also deploy from a locally linked checkout:

```bash
npm install
npx vercel link
npx vercel --prod
```

No R2/D1 UUID, Docker daemon, or Cloudflare billing activation is needed.

## 3. First request / cold start

`GET /api/health` is intentionally cheap and does not wake the media Sandbox.

The first request to `/api/history`, `/api/inspect`, `/api/jobs`, or `/api/download/*` creates or resumes the named persistent Sandbox `y2y2-media`.

On its first creation Y2Y2:

1. creates a Python 3.13 Sandbox with 2 vCPUs;
2. clones this GitHub repository inside the Sandbox;
3. installs/upgrades `yt-dlp` and `imageio-ffmpeg`;
4. starts `sandbox/backend.py` on published port 8080;
5. stores jobs and media under `/vercel/sandbox/y2y2-data`.

The first media API call can therefore be noticeably slower than later requests.

## 4. Persistence and retention

The Sandbox is named and persistent. Vercel snapshots its filesystem when a session stops and restores it when the Sandbox resumes.

Y2Y2 itself applies a 24-hour media retention policy. Expired media files are removed opportunistically on normal API activity. Job history remains, but an expired artifact is marked unavailable.

A Sandbox session may run for up to 45 minutes. If a session ends while `yt-dlp`/ffmpeg is actively processing a file, that item is marked `interrupted` after the next resume and can be retried. Successful items are kept.

## 5. Direct downloads

The public app asks `/api/download/:id` for a ready job. That Function validates state and returns a 307 redirect to the current Sandbox port URL with a short session-derived download token.

The actual MP3/MP4 bytes therefore travel:

```text
Sandbox port 8080 → Browser
```

instead of:

```text
Sandbox → Vercel Function → Browser
```

The Sandbox server supports byte ranges, so browsers can resume/range-request media where supported.

## 6. Verification

After a deployment, verify in this order:

```text
GET /api/health
→ UI should show ONLINE

GET /api/history
→ first call should create/resume the Sandbox

Add one authorized YouTube URL
→ metadata appears

Prepare MP3 256k
→ queued → processing → ready
→ individual download works

Add several authorized URLs with mixed options
→ prepare all
→ ready items remain even if another item fails
→ 와다다 다운로드 sends individual downloads in queue order
```

## 7. Browser multiple-download permission

Chrome-family browsers may ask whether the Y2Y2 hostname may download multiple files. Allow multiple downloads for the site if you want one-click batch behavior.

Y2Y2 does not silently build a ZIP if the browser blocks multi-download. Every Ready item keeps an individual download action.

## 8. Common failures

### UI says ONLINE but history/inspect fails

`/api/health` does not boot the Sandbox. Check the failing Function's runtime logs. The first Sandbox boot may fail because of account entitlements, Sandbox creation, package installation, or networking.

### Sandbox package/install error

The runtime installs current prerelease-compatible `yt-dlp` and `imageio-ffmpeg` on initial creation. If an upstream package or installer changes, inspect Function/Sandbox logs before changing the application contract.

### YouTube extraction error

The source may be unavailable to an unauthenticated server-side client, geo-restricted, login-gated, or YouTube may have changed its delivery behavior. Y2Y2 deliberately does not bypass access controls.

### Video quality is missing

The inspect response only advertises the supported target heights that the source actually exposes. Y2Y2 does not upscale a source and pretend a higher-quality stream exists.

### A processing job becomes interrupted

A Sandbox session ended while that job was active. Retry only the failed item. Completed artifacts should remain available until their retention expires.

## 9. Security / privacy

This is intended as a personal tool. The Sandbox control API uses a session-derived secret header and direct downloads use a separate session-derived token.

If the Vercel deployment itself is publicly reachable, anyone who knows the site URL can still submit jobs through the public Vercel Functions. For a genuinely private deployment, enable Vercel Deployment Protection or another access boundary appropriate to your Vercel plan before treating this as a private service.
