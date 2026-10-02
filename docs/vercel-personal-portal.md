# Vercel personal portal — 2026-10-02

The production landing page opens the verified same-PC personal application. It does not move yt-dlp or ffmpeg into Vercel functions.

The user starts `Start-Y2Y2.cmd` once per PC session, pastes a URL on the Vercel page and selects **내 PC에서 분석**. A top-level navigation opens `http://127.0.0.1:49273/#video=VIDEO_ID`. The personal page validates that ID and prefills the input. Analysis and file saving still require the user to use the local page's controls. The hosted page makes no API requests to localhost and receives no local token, file list or media bytes.

The local handler permits top-level navigation to its static root. All session and job APIs retain exact Host, local Origin, fetch-site and bearer-token protections. Cross-site navigation does not authorize API access. Cross-origin localhost API access remains disabled.

The previous pure-web experiment is retained at `/experiment.html`. The service-worker cache version and shell assets are updated for the new landing page.

This deployment is useful on the Windows PC with the prepared personal bundle. It does not support Android or another device without its own compatible local application, and does not make an install-free cloud downloader claim.
