# Y2Y2 Web — 2026-10-11

Status: real provider downloads verified. Physical iOS/Android saving remains untested. Production deployment status is reported separately from these source-level verification notes.

## What changed

The root page calls `/api/web`; it never connects to localhost or a Home Engine. Vercel optionally checks a site password, sends a public YouTube link to the VideoScale developer API, polls the provider's task, and streams its prepared file as a signed same-origin attachment. VideoScale owns extraction and conversion. No yt-dlp, ffmpeg, Redis or Blob resource is required on Vercel. The former PC portal is preserved at `/personal.html`.

Only MP4 streams that explicitly contain both video and audio are offered. On the observed public test video this was 360p. MP3 requests use the documented postprocessor field with fixed FFmpegExtractAudio options at 192 kbps. Actual MP3 conversion was verified with a complete downloaded file, as recorded below.

## Free account setup (owner, one time)

1. Open https://videoscale.sh/signup and create your own free account. The provider advertises 10 GB on signup without a payment card. This is a finite signup grant, not a renewing monthly free allowance. Do not add a card, buy bandwidth or enable a paid plan for this request.
2. Find the **API credentials** in the provider dashboard. Use those API credentials, not your website login password.
3. In https://vercel.com/wondaes-projects-fe5c826b/y2-y2/settings/environment-variables add these as **Secret** variables for **Preview** first:

   - `Y2Y2_VIDEO_API_USER`: provider API username
   - `Y2Y2_VIDEO_API_PASSWORD`: provider API password
   - Optional `Y2Y2_WEB_PASSWORD`: leave unset for password-free access, or set a new private-site passphrase of at least 16 characters. Do not reuse any account password.

4. Do not paste credentials into chat, GitHub or browser JavaScript. Tell Codex when the Preview variables are saved. A new deployment is required for them to take effect.
5. Verify real MP4 and MP3 files in the preview before adding Production variables or promoting the change. Keep the existing production portal until those checks pass.

End users only open the website. If the owner sets the optional password, users enter it once on their device. Without a password, anyone who knows the URL can consume the same provider quota. Signed task and format tickets remain enforced in either mode. End users do not install an engine or configure provider credentials.

## Live verification

Preview code commit `439af4d` passed the GitHub web, Windows and Android checks. Local tests passed: **21**. Against the saved API account, `aqz-KE-bpKQ` produced:

| File | Complete size | Decoded content | Duration | SHA-256 |
|---|---:|---|---|---|
| MP4 | 28,523,658 bytes | H.264 640×360 + AAC stereo | 10:34.58 | `7493d231bca3a0a8ac9262a212b29e628d074a2128d5a3f537429a0e0a5c1f06` |
| MP3 | 15,232,463 bytes | MP3 192 kbps, 48 kHz stereo | 10:34.66 | `e19303a086c2bb318c751e24da569bc48d03b3cbbe1382e31e8b762d4722309a` |

Both complete files decoded to the end with FFmpeg exit code 0. The MP4 was also saved through the Vercel attachment stream: all 28,523,658 bytes arrived with the same SHA-256, proving it was not truncated at a buffered-response limit. The MP3 is genuinely MP3, not renamed M4A. Browser format selection, creation, polling and a ready link used the real account. Nonexistent video `aaaaaaaaaaa` returned HTTP 422 `NO_FORMATS`, without a file link.

A second public Blender video `YE7VzlLtp-4` was analyzed and converted through the browser on the same code. Clicking **MP3 파일 저장** completed an actual browser download to `Y2Y2.mp3`: 14,318,351 bytes, MP3 192 kbps/48 kHz/stereo, duration 9:56.57, fully decoded with exit code 0. The save action stayed on the website instead of navigating to a media player.

The observed intermediate status `trying_combination` is treated as processing. The observed file response uses `download_url` at `http://s3.fr-par.scw.cloud/...`; only this known HTTPS-capable endpoint has its scheme upgraded, preserving the signed path/query. The complete HTTPS downloads above verified this. File delivery rejects redirects and restricts fetching to that exact storage endpoint. Transfers have a 256 MB limit and 250-second timeout, use `Content-Disposition: attachment`, and are never buffered or stored on Vercel.

## Release verification checklist for future changes

- Vercel can reach the documented provider endpoint using the saved account.
- Capture sanitized actual `/api/formats`, task-create, status and file response shapes. The adapter currently implements the documented fields with limited casing/envelope variants, but the provider publishes no full response examples. Adjust to observed responses as necessary.
- Download the complete public Blender test video `aqz-KE-bpKQ` as MP4 and MP3 from the preview browser. Check MP4 contains video + audio and MP3 is genuinely MP3, not renamed M4A. Play both files and check duration.
- Test another public video and a failed/private/unavailable video; errors must not expose download links.
- Check mobile layout and actual Safari/Android saving if devices are available. A desktop narrow viewport alone does not prove iOS downloads.
- Confirm stopping at the free account's quota does not purchase or top up anything.

## Earlier investigation evidence

- yt-dlp latest release confirmed via GitHub API: `2026.08.19`.
- Fresh Vercel Python preview `dpl_qvoHvHdhEvc24CBpxqDf5UHHJNRf`, region `iad1`, using that release: `aqz-KE-bpKQ` and `YE7VzlLtp-4` both returned `YOUTUBE_BOT_CHECK`; neither source resolution nor media bytes succeeded. Do not revive this path based on a successful deploy alone.
- VideoScale public website successfully analyzed `aqz-KE-bpKQ` in the browser: 1 video+audio format (MP4 360p, H.264/AAC), 40 video-only and 20 audio-only formats. This proves public format lookup, not authenticated API access or full downloads.
- A Vercel Node preview reached the documented `gate.apiscrape.net:16262` endpoint and received HTTP 401 without credentials, confirming network reachability. It does not prove account access.
- Candidate commit `3390979` deployed successfully to a protected Vercel preview. `/api/web?action=status` returned `{ "configured": false, "authenticated": false }`, and the browser correctly displayed the unavailable state with no local-engine handoff. The GitHub web check passed.
- Local automated tests use an explicit synthetic contract fixture. They verify authentication, input restrictions, ticket integrity, MP3 request construction, polling, finite response limits and failure handling. They are not live provider certification.

## Limits

This design depends on a third-party operator and finite free allowances on both services. It cannot promise permanent unlimited free downloading. Web delivery is limited to 256 MB per file; discovering an oversized prepared file does not refund provider quota. Task state is stored by the provider and its signed reference is held in the current browser page. Closing/reloading the page loses the reference; it does not cancel or refund an existing provider task. A polling timeout permits checking the same task again instead of starting another download. Physical iOS and Android saving has not been tested.

Source docs: https://videoscale.sh/api-docs and https://videoscale.sh/. Provider documentation and marketing statements are external claims until live-tested. TubePull's MCP personal plan excludes embedding in another app, and its developer free plan permits zero downloads, so it was not integrated. Tunelio offers only a 100-credit signup trial, so it was not chosen over the larger bandwidth grant.
