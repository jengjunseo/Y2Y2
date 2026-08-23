# Y2Y2 Local/Cloud Web DVR feasibility — 2026-08

## Executive verdict

The new framing changes the technical answer, but not every product constraint.

| Question | Verdict |
| --- | --- |
| Can desktop Chrome turn an explicitly authorized self-tab capture into a local file without an install? | **Yes, conditionally.** |
| Does this bypass CORS/PO Token/SABR extraction? | **Yes.** It records compositor pixels and tab audio, not media response bytes. |
| Is it an original-stream downloader? | **No.** It is real-time decode → render → capture → re-encode. |
| Is it reliable on Android Chrome? | **No.** The required display/element capture surface is desktop-only. |
| Is arbitrary YouTube-to-file distribution compliant with the YouTube IFrame API policies? | **No safe claim.** The published policy prohibits API clients from enabling offline copies/downloads without approval. |

The correct conclusion is therefore:

> **Desktop Local Web DVR is a valid technical PoC for content the user owns or is authorized to record. It is not a safe replacement for the public Y2Y2 download product without YouTube approval and a rights model.**

## What the attachment got right

1. `getDisplayMedia()` is a different security path from `iframe.captureStream()`, Web Audio, canvas extraction, or CORS fetch. The user grants access to a browser-selected rendered surface.
2. Chrome's Element Capture documentation explicitly gives a third-party iframe as a motivating use case. A self-captured tab video track can be restricted to a DOM subtree using `RestrictionTarget.fromElement()` and `track.restrictTo()`.
3. Region Capture is a useful fallback. `CropTarget.fromElement()` plus `track.cropTo()` crops to the element's current visible bounding rectangle.
4. `MediaRecorder` can encode the resulting `MediaStream`, and `MediaRecorder.isTypeSupported()` is the correct runtime gate.
5. A single capture session can remain active across multiple recordings. The browser still requires a fresh explicit prompt when a new session starts.

## Corrections and missing constraints

### 1. Element/Region Capture affects video, not audio

`restrictTo()` and `cropTo()` operate on the display-capture **video track**. The audio track remains the selected tab's complete audio mix. Y2Y2 must avoid UI sounds and clearly tell the user to choose tab audio.

### 2. Current-tab selection is a hint, not a command

`preferCurrentTab`, `selfBrowserSurface`, `displaySurface`, and `systemAudio` shape the picker. They cannot remove the user's choice or silently approve capture. The PoC rejects a screen/window selection and only proceeds after Element/Region Capture succeeds.

### 3. Stability is conditional, not “almost guaranteed”

The transport becomes more stable because the official player owns YouTube protocol changes, but the recorder still depends on:

- the video allowing embedding;
- normal player playback, ads, consent, age/region/login state and DRM behavior;
- the user selecting the current tab and enabling tab audio;
- desktop Chrome support and a secure context;
- MediaRecorder resource limits and codec/container support;
- the tab remaining visible enough for the selected target to produce frames;
- adaptive player quality, which the IFrame API does not allow the app to force.

Ads, captions, controls, annotations and player overlays inside the target are part of the recording.

### 4. MP4 and MP3 are not immediate guarantees

Chrome can always be queried for its current MediaRecorder MIME support. WebM is the conservative output. MP4 availability is runtime-dependent. Audio-only WebM/Opus is not MP3; MP3 requires a separate decode/encode path and should not be claimed by this PoC.

### 5. 2× playback does not create a normal-speed file

The IFrame API's `setPlaybackRate(2)` is advisory. When accepted, MediaRecorder records the actual 2× playback. Restoring the original timeline would require video retiming and pitch-preserving audio time-stretch/re-encoding. v1 therefore defaults to 1× and labels 2× output as 2×.

### 6. Long recordings need streaming output

Keeping every chunk in memory is risky. The PoC uses the File System Access API when available and selected, writing MediaRecorder chunks to a user-chosen file. It falls back to an in-memory Blob for short tests.

## Implemented PoC

Open `/dvr/` on desktop Chrome over HTTPS.

Flow:

1. Load an authorized video through the official YouTube IFrame API.
2. Start a capture session from a user click.
3. Select **This Tab** and enable **Share tab audio** in Chrome.
4. Restrict the video track with Element Capture, falling back to Region Capture.
5. Choose video+audio or audio-only recording.
6. Write chunks directly to a selected local file when File System Access is available, otherwise assemble a Blob.
7. Stop automatically on the official player's `ENDED` event, or stop manually.
8. Keep the capture session alive for another video until the user explicitly ends it.

The page exports runtime evidence as JSON, including API presence, selected surface settings, audio-track count, MIME choice and event history.

## Cloud DVR and Home Browser

Browserless documents paid remote-browser WebM screen recording with audio, so the generic infrastructure premise is technically real. That does **not** validate a YouTube downloader use case. A Cloud DVR adds the hardest product risks:

- YouTube API policy explicitly disallows downloading/storing audiovisual content or offline playback without written approval;
- remote automation may encounter login, consent, ads, region limits, bot defenses and protected playback;
- server-side recording and artifact delivery reintroduce cost, abuse controls, storage, privacy and content-rights enforcement;
- it is no longer Pure Web infrastructure even if the end user installs nothing.

For those reasons this change does not implement Cloud DVR or remote YouTube automation. A Home Browser/WebRTC node is technically possible, but it is still a second online device and needs signaling, authorization, backpressure, encrypted transfer and explicit per-session capture consent. It should be evaluated as a separate authorized-content product, not described as “installation-free on one device.”

## Final architecture decision

- Keep the existing Pure Web extraction verdict: **full original-stream download is not sustainable**.
- Promote Local Web DVR from “emergency fallback” to an **experimental desktop-only authorized-content mode**.
- Do not advertise MP3, MP4, source quality, faster-than-real-time, Android or policy compliance until each has independent evidence.
- Do not ship Cloud DVR against arbitrary YouTube URLs without written platform approval and a rights/compliance design.

## Primary references

- Chrome, Element Capture: <https://developer.chrome.com/docs/web-platform/element-capture>
- Chrome, screen-sharing controls: <https://developer.chrome.com/docs/web-platform/screen-sharing-controls>
- W3C Region Capture draft: <https://w3c.github.io/mediacapture-region/>
- MDN `getDisplayMedia()` security and permission model: <https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia>
- MDN `MediaRecorder.isTypeSupported()`: <https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static>
- YouTube IFrame API: <https://developers.google.com/youtube/iframe_api_reference>
- YouTube API Services Developer Policies: <https://developers.google.com/youtube/terms/developer-policies>
- Browserless screen recording: <https://docs.browserless.io/baas/monitor-sessions/screen-recording>

