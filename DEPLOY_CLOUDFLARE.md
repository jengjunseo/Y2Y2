# Cloudflare deployment guide

Y2Y2 uses Workers Static Assets, D1, R2, Workflows, and Containers. Containers require a Workers Paid plan and Docker for the local image build performed by Wrangler.

## 1. Prerequisites

Install:

- Node.js supported by current Wrangler
- Docker Desktop (or another Docker-compatible engine)
- a Cloudflare account with Workers Paid enabled

Then:

```bash
npm install
npx wrangler login
npx wrangler whoami
```

## 2. Create D1

```bash
npx wrangler d1 create y2y2-db --location apac
```

Wrangler prints the database UUID. Replace the sentinel value in `wrangler.jsonc`:

```json
"database_id": "00000000-0000-0000-0000-000000000000"
```

with the real UUID.

Apply the schema:

```bash
npx wrangler d1 migrations apply y2y2-db --remote
```

For local development you can also apply it locally:

```bash
npx wrangler d1 migrations apply y2y2-db --local
```

## 3. Create R2

```bash
npx wrangler r2 bucket create y2y2-artifacts
```

Keep the bucket private. The Worker is the download boundary.

Set a one-day artifact lifecycle so Y2Y2 remains a temporary download cache rather than a permanent media library:

```bash
npx wrangler r2 bucket lifecycle add y2y2-artifacts expire-y2y2-artifacts artifacts/ --expire-days 1
```

Verify:

```bash
npx wrangler r2 bucket lifecycle list y2y2-artifacts
```

## 4. Check Docker

```bash
docker info
```

The `containers.image` entry points to `./container/Dockerfile`. `wrangler deploy` builds and pushes this image as part of the deployment.

## 5. Validate locally

Static/code checks:

```bash
npm run check
```

Local Cloudflare runtime:

```bash
npx wrangler dev
```

Wrangler locally simulates D1/R2/Workflows and Containers; Containers require Docker.

Open the URL Wrangler prints, usually `http://localhost:8787`.

Smoke-test:

1. add one authorized YouTube URL
2. wait for metadata
3. prepare MP3 256k
4. verify the job reaches Ready
5. download the file
6. add several URLs with mixed options
7. prepare all
8. click `와다다 다운로드`

## 6. Deploy

```bash
npx wrangler deploy
```

Wrangler deploys the Worker, static assets, Workflow definition, Durable Object migration, and Container image declared in `wrangler.jsonc`.

After deployment:

```bash
npx wrangler tail
```

Open the `workers.dev` URL and repeat the representative single + mixed-batch flow.

## 7. Protect it with Cloudflare Access

Y2Y2 is intended to be private. Do not leave it as an anonymous public downloader.

In the Cloudflare dashboard:

1. Zero Trust → Access controls → Applications
2. Create application
3. Choose **Self-hosted and private**
4. Select/protect the Y2Y2 Worker (or its custom hostname)
5. Create an **Allow** policy for only your email / identity
6. Keep all other users denied

Protecting the Worker by name is preferable when available because Access then sits in front of every route, including the API.

## 8. Optional custom domain

After Access is working, attach a custom hostname in Workers settings. Keep Access applied to that hostname too.

## 9. Performance tuning

The checked-in baseline is:

```json
"max_instances": 4,
"instance_type": "standard-1"
```

and each container allows one yt-dlp/ffmpeg process at a time. That gives a bounded maximum of roughly four active media processes while preserving predictable CPU/disk use.

For frequent 1440p/2160p jobs, measure first. If disk/CPU is the bottleneck, move to `standard-2`. Do not raise both container size and concurrency blindly.

Useful evidence:

- Workflow duration
- Container errors / start failures
- R2 object sizes
- D1 job stage / error
- batch wall-clock time

## 10. Browser multi-download behavior

The batch button first prepares every item server-side. Once processing is terminal, it becomes **와다다 다운로드**. That click sends individual download requests in queue order.

Chrome-family browsers may ask whether the site may download multiple files. Allow it for the Y2Y2 hostname. If the browser blocks multiple downloads, each Ready item still has its own download button; Y2Y2 does not silently fall back to ZIP.

## 11. Common failures

### `database_id` invalid

You did not replace the sentinel UUID in `wrangler.jsonc`. Run `wrangler d1 create` and paste the actual UUID.

### Container build fails

Check:

```bash
docker info
```

and ensure Docker is running.

### Job fails with a YouTube extraction error

The source may be unavailable to an unauthenticated server-side client, geo-restricted, login-gated, or YouTube may have changed its delivery behavior. Y2Y2 intentionally does not implement authentication/access-control bypasses. Inspect `wrangler tail` and the job error before changing code.

### 4K file exhausts temporary disk

Use a larger Container instance type or lower the selected quality. The app does not transcode video just to fake a requested resolution.

## Production checklist

- [ ] real D1 UUID is in `wrangler.jsonc`
- [ ] D1 migration applied remotely
- [ ] R2 bucket exists and is private
- [ ] 1-day R2 lifecycle exists
- [ ] Workers Paid enabled
- [ ] Docker running for deployment
- [ ] `npm run check` passes
- [ ] `wrangler deploy` succeeds
- [ ] single MP3 flow verified
- [ ] single MP4 flow verified
- [ ] mixed batch verified
- [ ] partial-failure behavior verified
- [ ] duplicate output reuses the R2 artifact
- [ ] Cloudflare Access restricts the app to your identity
