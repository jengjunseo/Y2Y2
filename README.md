# Y2Y2 v0.4 — Relay Queue Hybrid Engine

**Paste → Queue → Y2Y2 routes automatically.**

Y2Y2 is a personal controller for media that you are authorized to download. v0.4 preserves the v0.3 Local Engine path and adds an optional **Home Engine relay**: when a Local Engine is available on the current device it always wins; when it is absent, an authenticated browser can submit work to one registered Home Engine that is currently online.

```text
                         Y2Y2 PWA (Vercel)
                               │
                     automatic route decision
                         ┌─────┴─────┐
                         │           │
                 Local Engine     Relay API
                 127.0.0.1         │ job metadata
                         │           │ outbound HTTPS polling
                         │       Home Engine (Windows)
                         │         yt-dlp + ffmpeg
                         │           │ signed PUT
                         │       Private Blob
                         │           │ signed GET, <= 1h
                         └──────► user files
```

## What changed from v0.3

v0.3 required the current browser device to run its own Local Engine. v0.4 keeps that path unchanged and fastest, but can additionally register one Windows PC as **Home Engine**. The Home Engine makes only outbound HTTPS requests to the Relay; no Internet-facing port is opened. If the current device has no Local Engine and the registered Home Engine is online, inspect/download jobs are automatically routed to that PC. If the Home Engine is offline or its state cannot be confirmed, Y2Y2 fails closed and starts nothing.

The cloud still does **not** run yt-dlp or ffmpeg. See ADR 0001: the old v0.2 Vercel Sandbox media path reached yt-dlp but YouTube rejected the datacenter extraction with its bot-confirmation flow. v0.4 does not reintroduce that failed architecture.

## Routing order

1. Same-device Local Engine over loopback — no Relay storage and no remote delay.
2. Registered Home Engine if its Relay presence is currently online.
3. Explicit unavailable/offline state. There is no optimistic cloud fallback.

The user does not pick Local versus Remote for each job.

## Relay architecture

- Vercel Functions expose only owner/device authentication, job state, signed artifact URLs and routing metadata.
- Upstash Redis stores Home Engine registration, presence, jobs, leases and queue state.
- The Windows v0.4 Home Engine entrypoint polls outbound over HTTPS every 20 seconds while idle and every 5 seconds while it has active remote work, with timeout and bounded exponential backoff. Presence expires after 50 seconds.
- Remote `inspect` is also executed by Home Engine so title and available qualities come from the same device-side media engine.
- Completed remote media is uploaded **directly from Home Engine to Vercel Private Blob** using a short-lived signed PUT. Media bytes do not pass through a Vercel Function.
- A remote browser gets a short-lived signed GET only while the logical artifact TTL is valid.

The 20-second idle poll is deliberate. One idle poll currently costs at least three Redis operations (device authentication, presence refresh and queue claim), keeping the 30-day always-on idle baseline below 500,000 Redis commands before active-job traffic.

## Temporary result lifetime

Remote artifacts have a default logical TTL of exactly **1 hour from upload completion**. A Vercel Workflow durable sleep schedules physical deletion at that expiration time. API download signing also checks `expiresAt`, so an expired object is unavailable even if physical cleanup is delayed by infrastructure.

If cleanup scheduling cannot be guaranteed after upload, the Relay attempts immediate deletion, marks the job failed, and does not expose it as a successful result.

## Home Engine registration

Home registration is separate from the existing six-digit Local Engine pairing:

1. Pair the browser to the Windows Local Engine normally.
2. Authenticate the browser to Relay with the configured Owner Secret.
3. Choose **이 PC를 Home Engine으로 등록**.
4. Relay issues a one-use 10-minute registration ticket.
5. The paired Local Engine receives that ticket and creates a random device ID and long-lived device secret.
6. The Engine registers outbound with Relay. Relay stores only a hash of the device secret.
7. Windows stores the long-lived secret encrypted with Windows DPAPI in `%LOCALAPPDATA%\Y2Y2\relay-identity.json` and automatically reconnects on later starts.

The original v0.3 pairing token continues to protect localhost control and is not reused as the Internet credential.

Android remains a v0.3-compatible current-device Local Engine in v0.4. v0.4 does not claim Android Home Engine registration.

## Abuse limits

Relay job creation is fail-closed and owner-wide by default:

- 30 create requests per minute
- 1000 job items per UTC day

A batch consumes the daily limit by item count. Redis Lua applies the limit atomically before enqueue. Exceeding a limit returns HTTP 429 and does not add jobs. Limits can be lowered/adjusted through deployment configuration, but missing configuration does not mean unlimited.

## Required Relay configuration

The Local Engine path works without Relay configuration. Home Engine functionality requires:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `Y2Y2_RELAY_OWNER_SECRET` (at least 32 characters)
- `BLOB_READ_WRITE_TOKEN`, normally injected by connecting a Vercel **Private Blob** store to the project
- Vercel Workflow support for the cleanup workflow

Optional:

- `Y2Y2_RELAY_CREATE_PER_MINUTE` — defaults to 30
- `Y2Y2_RELAY_ITEMS_PER_DAY` — defaults to 1000
- `Y2Y2_RELAY_TTL_MS` — defaults to 3600000; production should normally keep the one-hour contract

If any required Relay configuration is missing or invalid, Relay reports an explicit unavailable state and the v0.3 Local Engine flow remains usable. A partially configured Relay never accepts remote work as if it were healthy.

## Features

- Multi-line / multi-URL queue
- Independent MP3/MP4 option per item
- MP3 128/192/256/320 kbps
- MP4 360/720/1080/1440/2160p only when the source exposes that target
- Queue reorder + optional numbered filenames
- Engine-owned persistent batch state
- Partial failures preserve successful jobs
- Retry/cancel and history
- No ZIP batch fallback
- Automatic Local → Home routing
- One-hour temporary remote artifacts

## Windows

The packaged Windows Engine uses the existing Python/PyInstaller local engine plus a v0.4 Relay Agent. The Relay Agent uses a persistent `requests.Session` for outbound keep-alive, explicit connect/read timeouts, signed PUT streaming and bounded retry backoff. The localhost HTTP server remains Python stdlib and still binds only to `127.0.0.1:49272`.

Finished Home Engine jobs are also retained in the PC's local `Downloads/Y2Y2`; the Relay upload is an additional temporary copy for the remote browser.

## Android

Android v0.4 preserves the existing foreground Local Engine behavior. Finished media is published through Android MediaStore into `Download/Y2Y2`. It does not expose an inbound Internet service and is not advertised as a v0.4 Home Engine.

## Development / certification

```bash
npm run check
python -m pytest -q engine/windows/tests
```

### Pure Web diagnostics

Open `/lab/` to run the August 2026 browser-only endpoint, client, GoogleVideo,
opaque-cache, iframe, HLS and SABR boundary probes. The lab reports separate
L1–L8 proof levels and can export a JSON result for comparing Desktop and
Android Chrome. Its same-origin `/api/lab-resolve` probe resolves metadata only;
it never proxies media bytes.

See `docs/pure-web-final-investigation-2026-08.md` for the evidence and final
architecture decision.

`.github/workflows/build-engines.yml` additionally builds the Windows portable executable and Android debug APK and smoke-tests the packaged Windows loopback protocol.

## Security / rights boundary

The Local Engine still binds only to loopback. Local health/pair/control traffic accepts only the Y2Y2 Vercel origin (plus explicit local development origins), and Local control actions require the device-local bearer token obtained through the six-digit pairing flow.

Home Engine relay transport is outbound-only. A distinct long-lived device credential is stored with OS-protected storage on Windows and the Relay stores its hash. Browser access to Home Engine jobs requires the owner session. Relay job creation has bounded rate limits, device claims use leases, and temporary Blob access uses narrow signed URLs.

Use Y2Y2 only for content you own, content whose rights holder permits downloading, or content you otherwise have permission to download. Y2Y2 does **not** implement DRM/paywall/private-content bypasses, automated cookie collection, CAPTCHA/bot-challenge bypasses, account-cookie harvesting, or proxy rotation. The Relay never runs yt-dlp/ffmpeg and is not an access-control bypass service.

See:
- `docs/adr/0001-distributed-local-engine.md`
- `docs/adr/0002-relay-queue-hybrid-engine.md`
