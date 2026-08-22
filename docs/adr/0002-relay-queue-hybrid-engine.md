# ADR 0002 — Relay Queue Hybrid Engine

Status: Proposed for Y2Y2 v0.4

## Context

ADR 0001 established that Y2Y2 must not depend on a cloud/datacenter media processor. The v0.2 Vercel Sandbox prototype proved the web, Vercel function, Sandbox boot and yt-dlp invocation path, but the first real YouTube extraction was rejected by YouTube's "Sign in to confirm you're not a bot" flow. Y2Y2 therefore rejected cookie harvesting, CAPTCHA/bot-challenge bypass, proxy rotation and access-control workarounds and moved yt-dlp/ffmpeg to a Local Engine in v0.3.

That decision remains valid. v0.4 does not make a pure cloud downloader and does not run yt-dlp or ffmpeg in Vercel. The remaining product limitation is reachability: v0.3 requires the current browser device to have its own Engine running. A user who has a trusted Windows PC at home should be able to register it once and, while that PC is online, submit work from another browser without opening an inbound port to the home network.

The relay also needs a bounded temporary artifact path because the completed file must reach the remote browser. Permanent cloud media storage is outside Y2Y2's scope.

## Decision

Y2Y2 v0.4 uses a **Relay Queue Hybrid Engine**.

1. The existing loopback Local Engine path remains first priority and retains Engine Protocol v1, six-digit pairing, Origin checks and device-local bearer authentication.
2. A Windows Local Engine can additionally be registered once as the single Home Engine. Registration uses an owner-authorized one-time Relay ticket and a separate long-lived device credential. The Home Engine makes outbound HTTPS requests only; no Internet-facing Home Engine port is introduced.
3. When no Local Engine is available, the web controller queries Relay presence. It automatically routes to the Home Engine only if that presence is currently confirmed online. Offline, unknown or unconfigured states fail closed.
4. Relay state, device presence, queue entries, leases and owner history are stored in Upstash Redis. Job state is `queued → claimed → processing → done|failed|expired`. Claiming uses an atomic Redis Lua lease so interrupted claims can become eligible for recovery instead of being silently lost.
5. Home Engine uses a persistent `requests.Session` with explicit timeouts, connection reuse and bounded exponential backoff. It polls every 10 seconds while idle and about every 5 seconds while active. This new dependency is preferred over a hand-built long-lived urllib transport because reliable connection reuse, timeout policy and streaming signed uploads are now part of the product contract.
6. Relay job creation is rate-limited atomically before enqueue: 30 create requests per minute and 1000 job items per UTC day by default. A batch charges item count. Exceeding either limit returns 429 and creates no jobs.
7. Remote metadata inspection is a Home Engine job too. Vercel does not inspect the source with yt-dlp.
8. Once a Home Engine has produced a download locally, it requests a short-lived signed PUT and uploads the completed file directly to Vercel Private Blob. Media bytes do not pass through a Vercel Function.
9. The temporary artifact has a logical TTL of one hour from successful upload completion. A durable Vercel Workflow sleeps until `expiresAt`, deletes the Blob and marks the Relay job expired. Download signing also refuses access at/after `expiresAt`, independent of physical deletion timing. If cleanup scheduling fails, the Relay attempts immediate deletion and refuses to mark the remote result successful.
10. A remote browser receives only a short-lived signed GET. Local downloads continue to bypass Blob entirely.

Home registration credentials are intentionally separate from Local pairing credentials. Windows protects the long-lived Home Engine secret with DPAPI and Relay stores only its hash. Android remains a current-device Local Engine in v0.4; Android Home Engine registration is not part of this decision.

## Consequences

- v0.3 remains the fastest, cheapest and most private route when the current device has a Local Engine.
- A registered Windows Home Engine can process jobs submitted from another authenticated browser while it is online.
- The main PC does not receive inbound Internet connections; NAT/router configuration is unnecessary.
- Home Engine availability now depends on outbound Internet connectivity, Relay state and periodic presence. An uncertain status is treated as unavailable rather than optimistic online.
- Remote mode introduces temporary object storage and transfer quota. Large or frequent remote MP4 transfers can exhaust a free tier even though Local mode remains unaffected.
- Relay authentication, rate limits, device leases, artifact signing and cleanup are new security and operational surfaces and require tests.
- Cloud code still never runs yt-dlp/ffmpeg, so this ADR does not reverse ADR 0001.
- The rights boundary is unchanged: no cookie harvesting, CAPTCHA/bot-check bypass, proxy rotation, DRM/paywall/private-content bypass or login-gated access workaround is introduced.
