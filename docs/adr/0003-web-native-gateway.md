# ADR 0003 — Web-Native Gateway and Browser Processing

**Status:** Accepted for Y2Y2 v1.0 beta  
**Date:** 2026-08-22

## Context

ADR 0001 rejected direct cloud media processing after the v0.2 Vercel Sandbox path reached yt-dlp but YouTube returned its bot-confirmation flow. ADR 0002 preserved local processing by adding an outbound Home Engine relay, but that still requires an installed Engine and an available device.

The v1 product goal is a zero-install web experience: paste a permitted YouTube URL, choose MP3/MP4, and receive individual files without pairing or keeping a home PC online.

A browser cannot reliably fetch YouTube media cross-origin. Therefore a completely serverless browser-only design is not a viable primary path.

## Decision

Y2Y2 v1 uses three roles:

1. Vercel serves the PWA and small control APIs.
2. `api/web.js` acts as a narrow YouTube-only resolver/range tunnel. It does not run ffmpeg, persist media, accept arbitrary upstream URLs, collect cookies, rotate proxies, or bypass access controls. Each tunnel response is hard-capped below the Vercel Function payload limit.
3. The browser owns media processing. Direct progressive MP4 is downloaded in bounded ranges to OPFS. Split video/audio is muxed with Mediabunny. MP3 is encoded locally with Mediabunny's LAME-WASM extension.

The v0.4 Local/Home Engine implementation remains in the repository as a frozen fallback until the Web-Native path has sufficient production evidence. The normal v1 UI does not require or expose pairing.

## Consequences

- Normal users install nothing and do not need a home PC.
- Active processing depends on the browser/PWA staying alive.
- Gateway availability still depends on YouTube accepting requests from the deployed network; failures are surfaced explicitly and are not hidden by cookie harvesting, proxy rotation, CAPTCHA workarounds, or fake success.
- Large media is not intentionally buffered as one JavaScript ArrayBuffer; OPFS and ranged/network sources are used.
- The Gateway is intentionally not a general-purpose proxy.
