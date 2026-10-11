# Install-free Web candidate — 2026-10-11

Status: implementation + local contract tests. NOT end-to-end download verified. NOT released to production.

## What changed

The candidate root page calls `/api/web`; it never connects to localhost or a Home Engine. Vercel authenticates the owner, sends a public YouTube link to the VideoScale developer API, polls the provider's task, and returns its HTTPS file link. VideoScale owns extraction, conversion and delivery. No yt-dlp, ffmpeg, Redis or Blob resource is required on Vercel. The former PC portal is preserved at `/personal.html`.

Only MP4 streams that explicitly contain both video and audio are offered. On the observed public test video this was 360p. MP3 requests use the documented postprocessor field with fixed FFmpegExtractAudio options at 192 kbps. This postprocessor's actual execution must be verified against the connected account; it is not proven by unit tests.

## Free account setup (owner, one time)

1. Open https://videoscale.sh/signup and create your own free account. The provider advertises 10 GB on signup without a payment card. This is a finite signup grant, not a renewing monthly free allowance. Do not add a card, buy bandwidth or enable a paid plan for this request.
2. Find the **API credentials** in the provider dashboard. Use those API credentials, not your website login password.
3. In https://vercel.com/wondaes-projects-fe5c826b/y2-y2/settings/environment-variables add these as **Secret** variables for **Preview** first:

   - `Y2Y2_VIDEO_API_USER`: provider API username
   - `Y2Y2_VIDEO_API_PASSWORD`: provider API password
   - `Y2Y2_WEB_PASSWORD`: a new private-site passphrase, at least 16 characters; do not reuse any account password

4. Do not paste credentials into chat, GitHub or browser JavaScript. Tell Codex when the Preview variables are saved. A new deployment is required for them to take effect.
5. Verify real MP4 and MP3 files in the preview before adding Production variables or promoting the change. Keep the existing production portal until those checks pass.

End users only open the website and enter the site's private passphrase once on their device. They do not install an engine or configure provider credentials.

## Verification required before release

- Vercel can reach the documented provider endpoint using the saved account.
- Capture sanitized actual `/api/formats`, task-create, status and file response shapes. The adapter currently implements the documented fields with limited casing/envelope variants, but the provider publishes no full response examples. Adjust to observed responses as necessary.
- Download the complete public Blender test video `aqz-KE-bpKQ` as MP4 and MP3 from the preview browser. Check MP4 contains video + audio and MP3 is genuinely MP3, not renamed M4A. Play both files and check duration.
- Test another public video and a failed/private/unavailable video; errors must not expose download links.
- Check mobile layout and actual Safari/Android saving if devices are available. A desktop narrow viewport alone does not prove iOS downloads.
- Confirm stopping at the free account's quota does not purchase or top up anything.

## Evidence gathered today

- yt-dlp latest release confirmed via GitHub API: `2026.08.19`.
- Fresh Vercel Python preview `dpl_qvoHvHdhEvc24CBpxqDf5UHHJNRf`, region `iad1`, using that release: `aqz-KE-bpKQ` and `YE7VzlLtp-4` both returned `YOUTUBE_BOT_CHECK`; neither source resolution nor media bytes succeeded. Do not revive this path based on a successful deploy alone.
- VideoScale public website successfully analyzed `aqz-KE-bpKQ` in the browser: 1 video+audio format (MP4 360p, H.264/AAC), 40 video-only and 20 audio-only formats. This proves public format lookup, not authenticated API access or full downloads.
- A Vercel Node preview reached the documented `gate.apiscrape.net:16262` endpoint and received HTTP 401 without credentials, confirming network reachability. It does not prove account access.
- Candidate commit `3390979` deployed successfully to a protected Vercel preview. `/api/web?action=status` returned `{ "configured": false, "authenticated": false }`, and the browser correctly displayed the unavailable state with no local-engine handoff. The GitHub web check passed.
- Local automated tests use an explicit synthetic contract fixture. They verify authentication, input restrictions, ticket integrity, MP3 request construction, polling, finite response limits and failure handling. They are not live provider certification.

## Limits

This design depends on a third-party operator and its free quota. It cannot promise permanent unlimited free downloading. Task state is stored by the provider and its signed reference is held in the current browser page. Closing/reloading the page loses the reference; it does not cancel or refund an existing provider task. A polling timeout permits checking the same task again instead of starting another download.

Source docs: https://videoscale.sh/api-docs and https://videoscale.sh/. Provider documentation and marketing statements are external claims until live-tested. TubePull's MCP personal plan excludes embedding in another app, and its developer free plan permits zero downloads, so it was not integrated. Tunelio offers only a 100-credit signup trial, so it was not chosen over the larger bandwidth grant.
