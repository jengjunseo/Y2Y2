# Device storage web — October 11, 2026

This implementation receives separate source video and audio tracks into the **receiving device's browser storage**, then combines their encoded packets into one file without re-encoding. It removes the previous premux-only selection that excluded high-resolution adaptive tracks. The existing Vercel production page still uses the older provider API; this separate deployment has not replaced production.

```text
YouTube → owned Python resolver / bounded range relay → browser Worker
                                                       ↓ 4 MiB chunks
                                                       device OPFS tracks
                                                       ↓ packet copy
                                                       MP4 / WebM file
                                                       ↓ user selects Save
                                                       device Downloads / Files
```

The backend uses yt-dlp with bundled EJS and Node. It keeps signed source URLs and short-lived manifests in RAM, relays a maximum of 4 MiB per request with backpressure, and writes no media to server storage. The browser writes and flushes chunks to OPFS, records committed offsets atomically, and resumes from those offsets. It lazily reads the track files with Mediabunny and writes the output through a positioned, chunked stream. No whole-file ArrayBuffer, FFmpeg WASM, browser decoder/encoder, scaling, provider download quota, object bucket, or server media volume is used.

The output is committed before verification. A second read checks each track's packet count, payload byte count, end timestamp and resolution before marking the job ready. On failure, the original track files remain available for another merge. On success, those input copies are removed. The automated media tests separately compare every original and output encoded-packet payload with SHA-256 and decode the resulting file with FFmpeg.

## Quality and formats

- Compatible option: H.264 video + AAC audio in MP4, at the actual source dimensions and frame rate.
- Original option: AV1 or VP9 + Opus in WebM, including 4K when available. Playback support depends on the app/device; this option preserves the source instead of transcoding it.
- Audio only: original AAC in M4A or Opus in WebM. This path does not yet offer MP3 conversion.
- Live/HLS-only, DRM, unsupported codecs and unknown exact track sizes fail explicitly. The service never substitutes a lower resolution after the user chooses one.

## What “device storage” means

OPFS is disk-backed, origin-private browser storage, not immediately a visible Downloads file. Inputs and output temporarily need roughly twice the source size. The page estimates quota before starting, and handles actual quota errors without claiming completion. Private browsing may have a much lower limit.

Once ready, **파일 저장** exports the disk-backed File with a browser download. Browsers exposing `showSaveFilePicker` additionally offer **저장 위치 선택**, using a streaming file copy. iOS/Safari still uses its browser download/save interface. Support is determined by OPFS and Web Locks capability checks; physical Android/iPhone export has not been certified. See [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) and [save picker compatibility](https://developer.mozilla.org/en-US/docs/Web/API/Window/showSaveFilePicker).

Closing the tab, backgrounding a mobile browser, or suspending the device may pause work. It does not keep downloading when the browser is closed. Completed chunks survive a reload on the same browser and origin. Browser data clearing or storage eviction removes them. Source manifests expire within one hour and are lost on server restart; incomplete transfers then need a new analysis/job. Fully received tracks can still be merged after link expiry. A completed file can be reopened from the history without contacting the origin. The baseline uses one process and one replica because manifests are in RAM.

## Local development and verification

```sh
python -m pip install -r backend/requirements.txt
npm ci
npm run build:device
python -m backend.extractor --runtime
python -m uvicorn backend.app:app --host 127.0.0.1 --port 8118 --workers 1 --no-access-log
```

Open `http://127.0.0.1:8118`. Node >=22 is required for extraction; the container bundles Node 24.12.0. The runtime command prints only versions. Do not publish the raw output of `backend.extractor VIDEO_ID`, which contains private signed source URLs for the relay.

Tests (FFmpeg is required for the media fixtures):

```sh
python -m unittest discover -s backend/tests -v
node --test device/tests/mux.test.mjs
npx playwright install chromium
node --test device/tests/browser.test.mjs
```

Optional environment variables: `Y2Y2_TEST_FFMPEG` selects an installed test FFmpeg, `PLAYWRIGHT_CHROMIUM` selects a local browser executable, and `Y2Y2_TEST_BROWSER` selects `chromium`, `firefox` or `webkit` for the browser fixture. `device/live-check.mjs` is an opt-in real-source UI check; it is not run against YouTube in CI. It takes `Y2Y2_LIVE_VIDEO`, `Y2Y2_LIVE_FORMAT`, `Y2Y2_TEST_ORIGIN`, `Y2Y2_TEST_OUTPUT` and `Y2Y2_TEST_RESUME` (see script). Keep generated media/evidence outside the repository. `device/inspect-media.mjs FILE` reports encoded-payload hashes without loading the full file into RAM.

## Railway deployment prepared, not provisioned

The deployable unit includes both UI and backend at one origin. Use repository root as the build context, `backend/railway.toml` as the Railway config file, and `backend/Dockerfile` as the Dockerfile. Expose the provided `PORT`, healthcheck `/health`, one replica, no volume. No VideoScale credentials, Blob token, Redis or FFmpeg runtime are required. `Y2Y2_WEB_PASSWORD` is optional; omitting it enables password-free use. Optionally set `Y2Y2_PUBLIC_ORIGIN` to the final HTTPS origin with no trailing slash. The health endpoint proves service liveness, **not YouTube access**.

Deploying the relay still consumes compute and outbound bandwidth. Device storage eliminates server media retention and server muxing; it does not eliminate the relay, YouTube server-IP restrictions, or network cost. Railway Hobby currently has a $5 monthly minimum with $5 usage included; outbound bandwidth is $0.05/GB. Usage above the allowance adds cost. [Official pricing](https://docs.railway.com/pricing/plans).

The user's existing free-only budget has not been changed. No paid Railway project, plan upgrade or service deployment has been authorized/provisioned by this change. Existing unrelated Railway resources are untouched. After cost approval, deploy to an isolated service and test actual extraction, small range relay, full 1080p/4K saving and mobile export there **before** routing production traffic. Cloud origin access may fail even though the same extractor succeeds on this PC; do not hide that failure with a lower-quality or quota-provider fallback.

## Observed evidence

On October 11 using this PC's network, a public Blender fixture (`aqz-KE-bpKQ`, about 10:34) exposed H.264/AAC 1080p60 and AV1/Opus 2160p60. Real 1080p source extraction, range relay, browser OPFS saving, pause/reload/resume, MP4 export, and full video/audio decode passed. The final real-source 4K UI run also completed extraction, range relay, pause/reload/resume and WebM export: 722,647,490 input bytes, 722,743,857 output bytes, 38,074 video packets and 31,730 audio packets. All 4K output encoded video/audio payloads match the original track hashes. Desktop Chrome was used; resizing the viewport is not physical mobile testing. The generated 1080p fixture also passed in Firefox 157. The Windows Playwright WebKit build rejects `createSyncAccessHandle` despite exposing it; a macOS WebKit CI check is included to test the Apple implementation separately. Physical Safari/iPhone verification remains outstanding.

An earlier 4K run exposed truncated output under browser storage pressure. Native atomic output writes and the independent post-merge completeness check were added, and the regular-profile browser test then preserved every packet. Private-window quota exhaustion now fails instead of displaying a false successful download. These results establish the client storage/mux path; Railway source access and all-device production use remain unverified.
