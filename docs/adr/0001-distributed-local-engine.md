# ADR 0001 — Distributed Local Engine

Status: Accepted for Y2Y2 v0.3

## Context

The Vercel Sandbox prototype proved the web UI, Vercel deployment, server function path, Sandbox boot, and yt-dlp invocation. The first real YouTube extraction then failed with YouTube's "Sign in to confirm you're not a bot" response from a cloud/datacenter network.

The product is a personal cross-device downloader. Moving the same media processor among unrelated cloud hosts does not remove that dependency, and Y2Y2 does not implement cookie harvesting, CAPTCHA/bot-challenge bypass, proxy rotation, paywall/DRM bypass, or login-gated access workarounds.

## Decision

Vercel is the controller/PWA only. Media metadata extraction, yt-dlp execution, ffmpeg processing, batch state, and final media files belong to a Local Engine on the device currently being used.

Engine Protocol v1 is shared by Windows and Android. The web controller talks only to loopback `127.0.0.1:49272`. Control routes require an explicit allowed Origin plus a device-local pairing token. The token never leaves the device except into the paired browser's local storage.

Windows uses a portable Python/PyInstaller engine with pinned yt-dlp, bundled ffmpeg, and bundled Deno. Android uses a foreground service and the maintained youtubedl-android integration, publishing finished files through MediaStore into `Download/Y2Y2`.

## Consequences

- A PC can be completely off while an Android phone/tablet processes its own jobs.
- A Windows PC can process jobs without an Android device.
- Browser tab lifecycle no longer owns active jobs.
- Media bytes do not transit Vercel and no cloud media storage is required.
- Each device has authoritative local job/history and files in v0.3.
- Cross-device metadata sync is intentionally not required for the core v0.3 flow.
- Actual YouTube behavior must be certified on the user's device/network; a cloud CI runner is not equivalent evidence.
