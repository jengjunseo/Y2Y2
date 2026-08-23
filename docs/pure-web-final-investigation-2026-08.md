# Y2Y2 Pure Web 최종 가능성 조사

기준 시점: 2026-08-23 KST  
대상 커밋: `f59306a` 이후 `/lab` PoC  
재현 영상: `Sq5Dj0U06vQ`

## A. 최종 판정

```text
Pure Web Full Y2Y2
불가능
```

일반 Y2Y2 origin 하나만으로는 (1) Innertube player 응답, (2) 유효한 GVS/SABR URL, (3) JS가 읽을 수 있는 media bytes를 지속적으로 모두 얻는 공개 브라우저 경로가 없기 때문이다.

단, 다음 두 가지는 부분 가능하다.

1. 이미 유효한 signed GoogleVideo URL이 있다면 top-level navigation 또는 media element에 넘길 수 있다. 실제 파일 저장은 응답의 `Content-Disposition`과 브라우저 동작에 달렸고, JS bytes 접근은 별개다.
2. tiny server resolver가 그 시점에 차단되지 않고 direct format URL을 받는다면 `resolver → signed URL → browser navigation`의 L2/L3 후보가 된다. 2026년 현재 datacenter egress의 `LOGIN_REQUIRED`, GVS PO Token 및 403 변동 때문에 신뢰 가능한 제품 경로는 아니다.

### 증거 등급

- **CAPTURED**: 2026-08-23 실제 HTTP 요청에서 확인.
- **SOURCE**: 당일 최신 upstream 코드에서 확인.
- **LAB**: `/lab`에서 최종 사용자 브라우저로 재실행 가능.
- **UNVERIFIED**: 이 조사 세션에 Chrome 제어 연결이 없어 Desktop/Android 실기기에서 아직 실행하지 못함.

## B. 최고 성공 경로

### 순수 웹의 최고 이론 경로

```text
YouTube URL
→ public Innertube endpoint (현재 CORS에서 중단)
→ WEB_EMBEDDED_PLAYER 등
→ streamingData direct URL
→ signed googlevideo URL
→ top-level navigation
→ 브라우저가 저장 또는 재생
```

현재 반복 가능하게 증명된 단계는 L0이다. 첫 단계인 cross-origin player POST가 브라우저 CORS 경계에서 끝나므로 client별 포맷 비교까지 도달하지 않는다.

### 설치 없는 UX를 보존하는 최고 현실 경로

```text
Y2Y2 Web
→ same-origin metadata resolver
→ Innertube client + 필요한 공개 session metadata
→ signed URL
→ 가능하면 browser direct save
→ direct save/bytes가 막히면 server media tunnel/remux
```

마지막 단계까지 필요해지면 Cobalt와 같은 server resolver/media proxy 아키텍처가 된다. 이것만이 MP3 및 1080p+ mux를 브라우저·영상별로 일관되게 제공한다. 단, anti-bot 우회, proxy rotation, 사용자 쿠키 수집은 이 제안에 포함하지 않는다.

## C. 성공 기능

| 기능 | Pure Web | 최소 resolver | 신뢰 가능한 server media | 근거 |
|---|---:|---:|---:|---|
| 360p MP4 | △ | △ | ✅ | itag 18/direct progressive가 존재하고 navigation 저장이 성립할 때만 Pure Web 후보 |
| 720p MP4 | △ | △ | ✅ | progressive 720p는 항상 제공되지 않으며 HLS도 2026-07부터 trusted/logged-in 세션 의존 관측 |
| 1080p MP4 | ❌ | △ | ✅ | 보통 video-only + audio-only; bytes 접근과 remux 필요 |
| 1440p/2160p MP4 | ❌ | △ | ✅ | adaptive/SABR + audio mux 필요 |
| MP3 | ❌ | △ | ✅ | 오디오 bytes가 JS에 읽혀야 WebAudio/lame.js 경로 진입 가능 |
| Desktop Chrome | △ | △ | ✅ | direct navigation 후보; 이 세션에서는 실기기 미검증 |
| Android Chrome | △ | △ | ✅ | Android Downloads 동작은 signed URL/headers별 실기기 판정 필요 |

`△`는 조건부 경로이지 제품 성공 판정이 아니다.

## 1. 현재 `Failed to fetch` 원인

### `release-youtubei.sandbox.googleapis.com`

CAPTURED preflight 재현:

```http
OPTIONS /youtubei/v1/player
Origin: https://y2-y2.vercel.app
Access-Control-Request-Method: POST
Access-Control-Request-Headers: content-type

HTTP/1.1 302 Found
Location: https://login.corp.google.com/request?...
Content-Length: 0
```

`Access-Control-Allow-Origin`, `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers`가 없다. CORS preflight redirect는 Y2Y2가 읽을 수 있는 성공 응답이 아니므로 실제 Android/iOS POST는 전송되기 전에 fetch network error가 된다.

따라서 현재 실패는 다음이 아니다.

- DNS: 호스트는 응답했다.
- payload/client mismatch: 본 POST 전에 중단된다.
- API key 누락: 본 POST 전에 중단된다.
- CSP/Permissions-Policy/PNA: 현재 배포에는 fetch를 막는 CSP가 없고 대상은 public HTTPS다.

정확한 원인은 **일반 공개 서비스가 아닌 Google corp-gated sandbox hostname을 브라우저 endpoint로 선택한 것**이다. Android/iOS fallback은 동일 endpoint를 쓰므로 같은 preflight에서 모두 실패한다.

참고로 현재 Vercel 응답의 `Referrer-Policy: no-referrer`는 위 preflight 실패 원인은 아니지만 YouTube official embed 식별에는 불리하다. `/lab`에는 `strict-origin-when-cross-origin`을 별도로 적용했다.

## 2. Innertube endpoint 조사

| endpoint | 용도/상태 | Browser cross-origin POST | API key | 결과 |
|---|---|---:|---:|---|
| `www.youtube.com/youtubei/v1/player` | production | ❌ | WEB 계열은 보통 key 사용 | YouTube.js 브라우저 문서도 proxy 필요 명시 |
| `youtubei.googleapis.com/youtubei/v1/player` | production API base | ❌ | WEB 계열 key 사용 | server/library 경로; 일반 site origin CORS API 아님 |
| `release-youtubei.sandbox.googleapis.com/...` | release sandbox | ❌ | 무관 | CAPTURED: 302 corp login |
| `www.youtube-nocookie.com/youtubei/v1/player` | 공식 player API endpoint로 사용되지 않음 | ❌ | 불명 | 조사 egress에서 403; 공개 CORS contract 없음 |
| green/test/cami/uytfe sandbox | staging/test/internal | ❌ | 무관 | YouTube.js 상수에 존재해도 공개 browser contract가 아님 |

YouTube.js 최신 `Constants.ts`는 production과 여러 sandbox URL을 모두 열거하지만, 같은 저장소의 browser README는 브라우저 사용 시 자체 proxy가 필요하다고 명시한다. URL 상수의 존재는 공개 CORS 허용을 뜻하지 않는다.

## 3. 2026-08 client 조사

최신 yt-dlp `INNERTUBE_CLIENTS`와 YouTube.js `SUPPORTED_CLIENTS`를 교차 확인했다.

| client | 최신 관측 | classic GVS/POT | 비고 |
|---|---|---|---|
| WEB | logged-out metadata 가능성이 있으나 변동 | HTTPS/DASH GVS POT required | cookies 지원 |
| WEB_SAFARI | HLS 후보 | 2026-07부터 일부 trusted/logged-in session에서만 HLS | 1080p까지 pre-merged 관측 주석 |
| WEB_EMBEDDED_PLAYER | embed context로 metadata 후보 | 정책은 영상/세션별 변동 | `thirdParty.embedUrl` 필요; 지속적 no-POT 보장 없음 |
| WEB_CREATOR | 부적합 | GVS POT | 최신 yt-dlp: 모든 영상 sign-in 필요 |
| MWEB | metadata 후보 | HTTPS/DASH GVS POT required | ad playback context 지원 |
| ANDROID | player 응답 후보 | GVS POT required; player token 경로와 결합 | player POT recommended |
| ANDROID_VR | 과거 fallback, 현재 부적합 | GVS POT required | 최신 yt-dlp 주석: 2026-08-17부터 1.65.10의 모든 formats 403 |
| IOS | HLS/live 포함 후보 | HTTPS와 HLS GVS POT required | player POT recommended |
| VISIONOS | 최신 YouTube.js/yt-dlp에 존재 | enforcement 변동 | kids 영상 미지원 주석 |
| TVHTML5 | 세션에 따라 metadata 후보 | logged-out 안정성 없음 | cookies 지원; yt-dlp issue도 POT/provider 필요 지적 |
| TVHTML5_SIMPLY | 제한적 | HTTPS/DASH GVS POT required | client name id는 upstream 간 변경 주의 |
| TV embedded | YouTube.js에 존재 | 안정적 classic URL 보장 없음 | 별도 테스트 필요 |

Client를 3개 영상씩 바꾸는 실험은 Pure Web direct endpoint에서는 의미 있는 player 응답까지 도달하지 못한다. 모든 client가 payload 이전의 동일 CORS 경계에서 종료된다. 대신 `/lab`의 same-origin minimal resolver가 8개 client를 실제 영상별로 순회하고 counts, itag 18, direct/cipher/SABR/HLS를 기록한다.

## 4. `WEB_EMBEDDED_PLAYER`

최신 yt-dlp는 embedded config에 다음을 넣는다.

```json
{
  "context": {
    "client": {
      "clientName": "WEB_EMBEDDED_PLAYER",
      "clientVersion": "2.20260708.00.00"
    },
    "thirdParty": { "embedUrl": "https://www.reddit.com/" }
  }
}
```

`embedUrl`은 유효한 non-YouTube URL이면 된다는 upstream 주석이 있다. 그러나 이는 server/library player request 구성이고 Y2Y2 origin에 CORS 권한을 주지 않는다. `sts/signatureTimestamp`는 cipher/SABR 후속 URL 변환에 필요할 수 있지만 preflight를 바꾸지 않는다.

## 5. GoogleVideo direct URL

단계를 분리해야 한다.

- `<video src>`/`<audio src>`/top-level navigation은 cross-origin 리소스를 브라우저가 소비할 수 있다.
- `fetch(..., mode: no-cors)`는 opaque response라 status 0, 빈 headers, null body다.
- `fetch(..., mode: cors)` 및 Range fetch가 성공하려면 GVS 응답 CORS가 Y2Y2 origin을 허용해야 한다.
- cross-origin `<a download>`는 `Content-Disposition: attachment`가 없으면 download 힌트가 보장되지 않는다.
- `title` query parameter는 filename 힌트가 될 수 있어도 attachment 응답을 강제하는 표준 장치가 아니다.

Kira용 ytc-bridge의 정적 rule이 이 경계를 직접 증명한다. 확장은 GoogleVideo 요청의 Origin/Referer를 YouTube로 바꾸고 응답에 `Access-Control-Allow-Origin: *` 및 허용 methods를 주입한다. 순수 웹에서 이미 가능했다면 이 확장 rule은 필요하지 않다.

## 6. Browser media pipeline

| API | cross-origin media 재구성 가능? | 이유 |
|---|---:|---|
| `<video>` / `<audio>` | 재생만 조건부 | media element가 소비하되 bytes를 JS에 주지 않음 |
| MediaSource / SourceBuffer | ❌ | append할 bytes를 먼저 JS가 읽어야 함 |
| WebCodecs | ❌ | encoded chunks/frames를 먼저 얻어야 함 |
| WebAudio / AudioWorklet | ❌ | CORS-cross-origin media element source는 표준상 silence 출력 |
| canvas | ❌ | cross-origin source는 origin-clean=false, readback SecurityError |
| captureStream / MediaRecorder | ❌ | inaccessible cross-origin track은 muted/silence/frames 비노출 |
| WebRTC | ❌ | cross-origin media 정보를 송출하지 않도록 요구 |

## 7. Service Worker / Cache

Opaque response는 CacheStorage에 저장하고 browser subresource로 재사용할 수 있다. 그러나 filtered response는 status 0, headers empty, body null이므로 `clone`, `tee`, `ReadableStream`, navigation preload를 조합해도 media bytes가 생성되지 않는다. Service Worker는 다른 origin의 네트워크 권한을 상승시키지 않는다.

`/lab`의 worker probe는 실제 cross-origin response를 캐시한 뒤 원본과 cache match 결과를 모두 기록한다.

## 8. iframe / official player / browser cache

공식 IFrame Player API가 공개하는 `getVideoUrl()`은 현재 영상의 YouTube watch URL이다. GoogleVideo URL이나 media bytes API가 아니다. `postMessage`, `BroadcastChannel`, `MessageChannel`은 양쪽 origin이 명시적으로 보내는 데이터만 전달하며 YouTube iframe은 media URL/bytes 전송 API를 제공하지 않는다.

Resource Timing은 cross-origin entry를 보일 수 있지만 Timing-Allow-Origin이 없으면 상세 timing/size가 마스킹되며 response URL 또는 body 획득 수단이 아니다. browser HTTP cache, blob URL, object URL도 타 origin 응답을 Y2Y2 origin의 readable Blob으로 승격하지 않는다.

## 9. HLS / DASH / SABR

| 계열 | Pure Web request/parse/save | 판정 |
|---|---|---|
| classic GVS | signed URL 획득과 CORS가 모두 성립해야 Range/read 가능 | 변동적, 제품 경로 불가 |
| HLS | manifest와 segment 모두 CORS-readable이어야 JS mux/save 가능 | iOS/WEB_SAFARI session/POT 변동, Chrome 직접 저장 불안정 |
| DASH | manifest 또는 format URLs와 Range CORS 필요 | WEB GVS POT required |
| SABR | protobuf POST, UMP streaming parse, ustreamer config, formats, client state, playback cookie, content-bound POT 필요 | googlevideo 라이브러리로 구현 가능하나 Kira는 extension/proxy 사용 |

최신 `googlevideo`의 `SabrStream`은 `application/x-protobuf` POST, `Accept: application/vnd.yt-ump`, clientAbrState, selected format ids, buffered ranges, SABR contexts, playback cookie, client info, PO token을 사용한다. 단순히 `serverAbrStreamingUrl`만 얻는 것은 L2/L4 성공이 아니다.

## 10. Kira / YouTube.js / googlevideo / ytc-bridge

- Kira는 desktop에서 ytc-bridge를 감지해 `proxyFetch`를 사용한다.
- extension이 없으면 사용자가 별도 proxy host/port를 설정해야 하며 모든 요청 URL을 그 proxy로 rewrite한다.
- 모바일 브라우저는 확장 미지원이 많아 README도 proxy가 필요하다고 명시한다.
- SABR downloader는 BotGuard/PO minter, Onesie player response, signed SABR URL, googlevideo `SabrStream`, File System Access adapter를 결합한다.
- ytc-bridge는 Manifest V3 `declarativeNetRequest`로 request Origin/Referer와 response CORS headers를 수정한다.

결론: Kira는 브라우저 UI와 로컬 browser processing의 강한 PoC지만 **설치 0 / proxy 0 Pure Web PoC가 아니다.**

## 11. Cobalt 및 공개 downloader 구조

Cobalt v11.7 source는 다음 구조다.

```text
browser
→ cobalt API server
→ server-side YouTube.js resolver + optional session/POT provider
→ server fetch of GVS/HLS
→ server proxy, ffmpeg remux/transcode, or local-processing response
→ browser download
```

YouTube 고화질은 server에서 video/audio URL을 선택하고 ffmpeg `-c:v copy -c:a copy`로 remux한다. MP3는 server ffmpeg가 변환한다. API 문서도 tunnel이 proxy/remux/transcode라고 명시한다. 설치 없이 동작하는 웹 downloader는 UI가 web일 뿐, Pure Web이라고 볼 근거가 없다.

SaveFrom/y2mate/loader 계열도 client에 signed URL이나 자체 download endpoint를 반환하는 server/hybrid 구조가 일반적이다. 제3자 서비스의 비공개 backend 또는 anti-bot 방식을 복제하지 않았다.

## 12. 브라우저 차이

| 브라우저 | direct navigation | cross-origin download | File System Access | 결론 |
|---|---:|---:|---:|---|
| Chrome Desktop | 가능 | attachment/header 의존 | 지원 | bytes가 확보된 뒤 저장에는 최적 |
| Chrome Android | 가능 | Downloads 동작이 URL/header에 의존 | Chromium 지원 범위 | Y2Y2 핵심 실기기 재검증 필요 |
| Edge Desktop | Chromium과 유사 | header 의존 | 지원 | Y2Y2 bytes 경계는 동일 |
| Firefox Desktop/Android | 가능 | header/브라우저 정책 의존 | 동일 API 미지원/차이 | Blob/download fallback 필요 |
| Safari macOS/iOS | navigation/media 가능 | 플랫폼 정책 의존 | 제한 | HLS 재생에는 유리하나 JS bytes는 CORS 필요 |
| Samsung Internet | Chromium 계열 | 다운로드 관리자 차이 | 버전 차이 | Android 실기기 필요 |

CORS, SOP, opaque response는 브라우저 선택으로 사라지지 않는다.

## D. 실패한 모든 방법

| 실험 | 결과 | 실패 지점 | HTTP/CORS error | 다시 시도 가치 |
|---|---|---|---|---|
| release sandbox Android/iOS | FAIL | preflight | 302 corp login, ACAO 없음 | 없음 |
| youtube.com direct player POST | FAIL | CORS/API contract | browser-readable cross-origin contract 없음 | 낮음; `/lab`로 정책 변화 감시 |
| youtubei.googleapis.com direct POST | FAIL | CORS/API contract | 동일 | 낮음 |
| nocookie player POST | FAIL | endpoint/CORS | 공개 player API가 아님 | 없음 |
| client/version 교체 | FAIL | endpoint 이전 | payload 전에 CORS | endpoint가 바뀔 때만 |
| WEB_EMBEDDED direct browser | FAIL | endpoint CORS | thirdParty로 해결 안 됨 | 낮음 |
| official iframe/postMessage | PARTIAL | SOP/API surface | media URL/bytes API 없음 | 재생 UX에만 |
| Resource Timing/PerformanceObserver | FAIL | privacy masking | TAO/CORS 정보 비노출 | 없음 |
| no-cors fetch | PARTIAL | opaque filter | status 0/body null | 없음 |
| Service Worker/CacheStorage | PARTIAL | opaque 유지 | body unreadable | 없음 |
| `<video>`/`<audio>` | PARTIAL | 재생과 read 분리 | bytes API 없음 | signed URL 재생에만 |
| WebAudio/AudioWorklet | FAIL | cross-origin 보호 | silence | 없음 |
| canvas/WebCodecs | FAIL | origin-clean/input bytes | SecurityError/no chunks | 없음 |
| captureStream/MediaRecorder/WebRTC | FAIL | inaccessible track | muted/silence | 없음 |
| direct navigation/download attr | PARTIAL | server headers/UA | attachment 보장 없음 | signed URL별 실기기 테스트 |
| HLS | PARTIAL | manifest/segments/POT | trusted session 변동 | Safari/서버 fallback만 |
| SABR | PARTIAL | CORS + state + POT | Kira가 extension/proxy 사용 | proxy 허용 시 높음 |
| tiny Vercel resolver | PARTIAL/FAIL | datacenter anti-bot | LOGIN_REQUIRED/403 가능 | provider 정책 변화 감시 |
| Vercel media Range GET | FAIL 가능 | signed URL/POT/IP binding | 403 변동 | 안정적 제품 경로 아님 |

## E. 2026년 기준 가장 현실적인 Y2Y2 아키텍처

### 권장

설치 없는 UX를 절대 조건으로 유지한다면 **명시적인 server resolver + 필요 시 media tunnel/remux**가 유일하게 완결된 구조다.

1. Y2Y2 Web은 URL/옵션/진행 상태만 담당한다.
2. resolver는 공개 영상만 처리하고 private/DRM/age/login-required를 fail closed한다.
3. direct GVS save가 실제로 검증되는 format은 browser redirect를 우선한다.
4. MP3와 1080p+는 server streaming remux/transcode를 사용한다.
5. 세션 쿠키 탈취, CAPTCHA 자동화, proxy rotation, residential proxy는 사용하지 않는다.
6. datacenter 차단으로 YouTube가 resolver를 허용하지 않으면 서비스는 실패를 정직하게 표시한다.

### Pure Web을 계속 감시하는 방법

새 `/lab`을 Canary로 유지한다.

- endpoint/client versions는 upstream source에 맞춰 주기적으로 갱신한다.
- PASS는 L1–L8로 분리한다.
- GVS URL이 생기면 Range CORS, no-cors, navigation, download, media element를 각각 기록한다.
- Android Chrome 결과 JSON을 export해 Desktop 결과와 비교한다.
- L4가 실제로 확인되기 전에는 MP3/1080p mux 기능을 성공으로 표시하지 않는다.

## 구현된 PoC

- `/lab/`: browser capability, endpoint, client, official iframe, GVS, opaque cache, HLS/SABR diagnostics.
- `/api/lab-resolve`: 8개 최신 client를 선택해 두 production endpoint를 검사하는 metadata-only Vercel function.
- `sw.js`: opaque response cache의 보안 경계를 재현하는 message probe.
- JSON export: Desktop/Android 결과를 같은 형식으로 비교.

## 주요 출처

- YouTube.js current clients/endpoints: <https://github.com/LuanRT/YouTube.js/blob/main/src/utils/Constants.ts>
- YouTube.js browser proxy requirement: <https://github.com/LuanRT/YouTube.js/blob/main/examples/browser/README.md>
- yt-dlp 2026 client/POT policies: <https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/youtube/_base.py>
- Kira browser/SABR implementation: <https://github.com/LuanRT/kira>
- ytc-bridge request/response rewrite rules: <https://github.com/LuanRT/ytc-bridge/blob/main/rules.json>
- googlevideo SABR request state: <https://github.com/LuanRT/googlevideo/blob/main/src/core/SabrStream.ts>
- Cobalt YouTube server resolver: <https://github.com/imputnet/cobalt/blob/main/api/src/processing/services/youtube.js>
- Cobalt server proxy/remux: <https://github.com/imputnet/cobalt/blob/main/api/src/stream/proxy.js>
- HTML cross-origin download rule: <https://html.spec.whatwg.org/multipage/links.html#downloading-resources>
- Fetch opaque response: <https://fetch.spec.whatwg.org/#concept-filtered-response-opaque>
- Media capture cross-origin protection: <https://w3c.github.io/mediacapture-fromelement/#security-considerations>
- Web Audio cross-origin silence: <https://webaudio.github.io/web-audio-api/#MediaElementAudioSourceOptions-security>
- Resource Timing cross-origin masking: <https://w3c.github.io/resource-timing/#sec-cross-origin-resources>
- YouTube IFrame Player API surface: <https://developers.google.com/youtube/iframe_api_reference>

## 남은 실기기 검증

이 세션에는 Chrome 제어 연결이 없어서 다음은 UNVERIFIED다.

1. Chrome Desktop에서 `/lab` 핵심 실험 export.
2. Chrome Android에서 동일 export.
3. 살아 있는 signed GVS URL로 navigation/download/media/CORS/Range 재검증.
4. 최소 10개 영상군의 client matrix 실행.

이 항목이 완료되기 전 Android Chrome 성공(특히 L3/L8)은 주장하지 않는다.
