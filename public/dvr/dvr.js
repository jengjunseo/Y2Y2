const $ = (selector) => document.querySelector(selector);

const state = {
  player: null,
  playerReady: false,
  captureStream: null,
  restrictedStream: null,
  recorder: null,
  chunks: [],
  writer: null,
  writeChain: Promise.resolve(),
  outputUrl: null,
  startedAt: 0,
  pausedAt: 0,
  pausedTotal: 0,
  timerId: null,
  mimeType: "",
  outputKind: "video",
  events: [],
};

const MIME_CANDIDATES = {
  video: [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/webm",
  ],
  audio: ["audio/webm;codecs=opus", "audio/mp4;codecs=mp4a.40.2", "audio/webm"],
};

function log(message, detail) {
  const entry = { at: new Date().toISOString(), message, ...(detail === undefined ? {} : { detail }) };
  state.events.push(entry);
  $("#log").textContent = state.events.map((item) => `[${item.at.slice(11, 19)}] ${item.message}${item.detail === undefined ? "" : `\n${JSON.stringify(item.detail, null, 2)}`}`).join("\n");
  $("#log").scrollTop = $("#log").scrollHeight;
}

function setBadge(selector, text, tone = "idle") {
  const element = $(selector);
  element.textContent = text;
  element.className = `badge ${tone}`;
}

function formatTime(milliseconds) {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function extractVideoId(value) {
  const input = value.trim();
  if (/^[\w-]{11}$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (url.hostname === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] || "";
    if (url.pathname.startsWith("/shorts/") || url.pathname.startsWith("/embed/")) return url.pathname.split("/")[2] || "";
    return url.searchParams.get("v") || "";
  } catch {
    return "";
  }
}

function supportedMime(kind) {
  if (!("MediaRecorder" in window)) return "";
  return MIME_CANDIDATES[kind].find((mime) => MediaRecorder.isTypeSupported(mime)) || "";
}

function renderCapabilities() {
  const videoTrack = state.captureStream?.getVideoTracks()[0];
  const capabilities = [
    ["Secure context", window.isSecureContext],
    ["getDisplayMedia", Boolean(navigator.mediaDevices?.getDisplayMedia)],
    ["MediaRecorder", "MediaRecorder" in window],
    ["Element Capture", "RestrictionTarget" in window && Boolean(videoTrack?.restrictTo || window.BrowserCaptureMediaStreamTrack?.prototype?.restrictTo)],
    ["Region Capture", "CropTarget" in window && Boolean(videoTrack?.cropTo || window.BrowserCaptureMediaStreamTrack?.prototype?.cropTo)],
    ["File System Access", "showSaveFilePicker" in window],
    ["WebM video", Boolean(supportedMime("video"))],
    ["WebM audio", Boolean(supportedMime("audio"))],
  ];
  $("#capability-list").innerHTML = capabilities.map(([name, value]) => `<div class="capability"><span>${name}</span><i class="${value ? "yes" : "no"}">${value ? "YES" : "NO"}</i></div>`).join("");
}

function updateTargetSize() {
  const rect = $("#capture-target").getBoundingClientRect();
  $("#source-size").textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)} CSS px`;
}

window.onYouTubeIframeAPIReady = () => log("YouTube IFrame API 준비 완료");

function onPlayerStateChange(event) {
  const labels = { "-1": "시작 전", 0: "종료", 1: "재생 중", 2: "일시정지", 3: "버퍼링", 5: "준비됨" };
  $("#player-state").textContent = labels[event.data] || `상태 ${event.data}`;
  if (event.data === 0 && $("#auto-stop").checked && state.recorder?.state !== "inactive") {
    stopRecording("플레이어 종료 이벤트");
  }
}

function loadPlayer() {
  const videoId = extractVideoId($("#video-input").value);
  if (!videoId) {
    setBadge("#player-badge", "INVALID ID", "bad");
    log("올바른 YouTube URL 또는 영상 ID가 아닙니다.");
    return;
  }
  if (!window.YT?.Player) {
    setBadge("#player-badge", "API LOADING", "warn");
    log("IFrame API가 아직 준비되지 않았습니다. 잠시 후 다시 시도하세요.");
    return;
  }
  if (state.player?.destroy) state.player.destroy();
  $("#capture-target").innerHTML = '<div id="player"></div>';
  state.playerReady = false;
  setBadge("#player-badge", "LOADING", "warn");
  state.player = new YT.Player("player", {
    width: "100%",
    height: "100%",
    videoId,
    playerVars: { playsinline: 1, rel: 0, origin: location.origin },
    events: {
      onReady: () => {
        state.playerReady = true;
        setBadge("#player-badge", "READY", "good");
        $("#record-button").disabled = !state.captureStream;
        $("#player-state").textContent = "플레이어 준비됨";
        log("공식 플레이어 준비 완료", { videoId });
      },
      onStateChange: onPlayerStateChange,
      onPlaybackRateChange: (event) => log("재생 속도 변경", { rate: event.data }),
      onError: (event) => {
        setBadge("#player-badge", `ERROR ${event.data}`, "bad");
        log("플레이어 오류", { code: event.data });
      },
    },
  });
}

function stopTracks(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}

async function restrictToPlayer(videoTrack) {
  const target = $("#capture-target");
  const errors = [];
  if ("RestrictionTarget" in window && typeof RestrictionTarget.fromElement === "function" && typeof videoTrack.restrictTo === "function") {
    try {
      const restrictionTarget = await RestrictionTarget.fromElement(target);
      await videoTrack.restrictTo(restrictionTarget);
      return "Element Capture";
    } catch (error) {
      errors.push(`Element Capture: ${error.name}: ${error.message}`);
    }
  }
  if ("CropTarget" in window && typeof CropTarget.fromElement === "function" && typeof videoTrack.cropTo === "function") {
    try {
      const cropTarget = await CropTarget.fromElement(target);
      await videoTrack.cropTo(cropTarget);
      return "Region Capture";
    } catch (error) {
      errors.push(`Region Capture: ${error.name}: ${error.message}`);
    }
  }
  throw new Error(errors.join(" | ") || "이 브라우저에는 Element/Region Capture가 없습니다.");
}

async function startSession() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getDisplayMedia) {
    log("보안 컨텍스트의 getDisplayMedia가 필요합니다.");
    setBadge("#capture-mode", "UNSUPPORTED", "bad");
    return;
  }
  $("#session-button").disabled = true;
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "browser" },
      audio: { suppressLocalAudioPlayback: false },
      preferCurrentTab: true,
      selfBrowserSurface: "include",
      systemAudio: "exclude",
      surfaceSwitching: "exclude",
      monitorTypeSurfaces: "exclude",
    });
    const videoTrack = stream.getVideoTracks()[0];
    const settings = videoTrack?.getSettings?.() || {};
    if (!videoTrack || (settings.displaySurface && settings.displaySurface !== "browser")) {
      stopTracks(stream);
      throw new Error("현재 탭이 아닌 화면/창이 선택되었습니다. 현재 탭을 선택하세요.");
    }
    const mode = await restrictToPlayer(videoTrack);
    state.captureStream = stream;
    state.restrictedStream = new MediaStream(stream.getTracks());
    videoTrack.addEventListener("ended", () => endSession("브라우저 공유 종료"), { once: true });
    setBadge("#capture-mode", mode.toUpperCase(), "good");
    $("#record-button").disabled = !state.playerReady;
    $("#end-session-button").disabled = false;
    $("#session-note").textContent = stream.getAudioTracks().length ? "탭 오디오 트랙을 확인했습니다. 다른 탭 소리는 포함되지 않습니다." : "오디오 트랙이 없습니다. Chrome 공유 창에서 ‘탭 오디오 공유’를 선택했는지 확인하세요.";
    log("캡처 세션 준비 완료", { mode, displaySurface: settings.displaySurface || "unknown", audioTracks: stream.getAudioTracks().length, videoSettings: settings });
    renderCapabilities();
  } catch (error) {
    setBadge("#capture-mode", "FAILED", "bad");
    $("#session-button").disabled = false;
    log("캡처 세션 실패", { name: error.name, message: error.message });
  }
}

function recorderStream(kind) {
  const tracks = kind === "audio" ? state.restrictedStream.getAudioTracks() : state.restrictedStream.getTracks();
  if (!tracks.length) throw new Error(kind === "audio" ? "캡처된 오디오 트랙이 없습니다." : "캡처 트랙이 없습니다.");
  return new MediaStream(tracks);
}

function extensionFor(mime) {
  if (mime.startsWith("video/mp4")) return "mp4";
  if (mime.startsWith("audio/mp4")) return "m4a";
  return "webm";
}

async function prepareWriter(filename, mimeType) {
  if (!$("#disk-mode").checked || !("showSaveFilePicker" in window)) return null;
  const extension = extensionFor(mimeType);
  const handle = await showSaveFilePicker({
    suggestedName: `${filename}.${extension}`,
    types: [{ description: `${extension.toUpperCase()} media`, accept: { [mimeType.split(";")[0]]: [`.${extension}`] } }],
  });
  return handle.createWritable();
}

async function startRecording() {
  if (!state.restrictedStream || !state.playerReady) return;
  const kind = $("#record-kind").value;
  const mimeType = supportedMime(kind);
  if (!mimeType) {
    log("선택한 출력에 사용할 MediaRecorder 포맷이 없습니다.", { kind });
    return;
  }
  $("#record-button").disabled = true;
  try {
    const filename = `y2y2-dvr-${extractVideoId($("#video-input").value) || Date.now()}`;
    state.writer = await prepareWriter(filename, mimeType);
    state.writeChain = Promise.resolve();
    state.chunks = [];
    state.mimeType = mimeType;
    state.outputKind = kind;
    const recorder = new MediaRecorder(recorderStream(kind), kind === "video" ? { mimeType, videoBitsPerSecond: 6_000_000, audioBitsPerSecond: 192_000 } : { mimeType, audioBitsPerSecond: 192_000 });
    state.recorder = recorder;
    recorder.addEventListener("dataavailable", (event) => {
      if (!event.data.size) return;
      if (state.writer) state.writeChain = state.writeChain.then(() => state.writer.write(event.data));
      else state.chunks.push(event.data);
    });
    recorder.addEventListener("stop", finalizeRecording, { once: true });
    recorder.addEventListener("error", (event) => log("MediaRecorder 오류", { name: event.error?.name, message: event.error?.message }));
    recorder.start(1000);
    const requestedRate = Number($("#playback-rate").value);
    state.player.setPlaybackRate(requestedRate);
    state.player.playVideo();
    state.startedAt = performance.now();
    state.pausedAt = 0;
    state.pausedTotal = 0;
    state.timerId = setInterval(updateTimer, 250);
    $("#pause-button").disabled = false;
    $("#stop-button").disabled = false;
    setBadge("#output-badge", "RECORDING", "bad");
    log("녹화 시작", { kind, mimeType, directToDisk: Boolean(state.writer), requestedRate });
  } catch (error) {
    $("#record-button").disabled = false;
    log(error.name === "AbortError" ? "파일 선택이 취소되었습니다." : "녹화 시작 실패", { name: error.name, message: error.message });
  }
}

function updateTimer() {
  const end = state.pausedAt || performance.now();
  $("#timer").textContent = formatTime(end - state.startedAt - state.pausedTotal);
}

function togglePause() {
  if (!state.recorder || state.recorder.state === "inactive") return;
  if (state.recorder.state === "recording") {
    state.recorder.pause();
    state.player.pauseVideo();
    state.pausedAt = performance.now();
    $("#pause-button").textContent = "계속 녹화";
    setBadge("#output-badge", "PAUSED", "warn");
    log("녹화 일시정지");
  } else {
    state.recorder.resume();
    state.player.playVideo();
    state.pausedTotal += performance.now() - state.pausedAt;
    state.pausedAt = 0;
    $("#pause-button").textContent = "일시정지";
    setBadge("#output-badge", "RECORDING", "bad");
    log("녹화 재개");
  }
}

function stopRecording(reason = "사용자 요청") {
  if (!state.recorder || state.recorder.state === "inactive") return;
  state.player.pauseVideo();
  state.recorder.stop();
  $("#pause-button").disabled = true;
  $("#stop-button").disabled = true;
  log("녹화 정지 요청", { reason });
}

async function finalizeRecording() {
  clearInterval(state.timerId);
  updateTimer();
  const duration = $("#timer").textContent;
  try {
    await state.writeChain;
    if (state.writer) {
      await state.writer.close();
      $("#preview").hidden = true;
      $("#download-link").hidden = true;
      $("#empty-output").hidden = false;
      $("#empty-output").textContent = "선택한 파일에 직접 기록을 완료했습니다.";
      $("#output-meta").textContent = `${state.mimeType} · ${duration} · 직접 저장`;
    } else {
      if (state.outputUrl) URL.revokeObjectURL(state.outputUrl);
      const blob = new Blob(state.chunks, { type: state.mimeType });
      state.outputUrl = URL.createObjectURL(blob);
      const preview = $("#preview");
      preview.src = state.outputUrl;
      preview.hidden = false;
      $("#empty-output").hidden = true;
      const link = $("#download-link");
      link.href = state.outputUrl;
      link.download = `y2y2-dvr-${Date.now()}.${extensionFor(state.mimeType)}`;
      link.hidden = false;
      link.textContent = `${extensionFor(state.mimeType).toUpperCase()} 다운로드`;
      $("#output-meta").textContent = `${state.mimeType} · ${duration} · ${(blob.size / 1024 / 1024).toFixed(1)} MiB`;
    }
    setBadge("#output-badge", "COMPLETE", "good");
    log("녹화 파일 완료", { mimeType: state.mimeType, duration, chunks: state.chunks.length, directToDisk: Boolean(state.writer) });
  } catch (error) {
    setBadge("#output-badge", "WRITE FAILED", "bad");
    log("파일 마무리 실패", { name: error.name, message: error.message });
  } finally {
    state.writer = null;
    state.recorder = null;
    state.chunks = [];
    $("#record-button").disabled = !state.captureStream || !state.playerReady;
    $("#pause-button").textContent = "일시정지";
  }
}

function endSession(reason = "사용자 요청") {
  if (!state.captureStream) return;
  if (state.recorder?.state !== "inactive") stopRecording("캡처 세션 종료");
  const stream = state.captureStream;
  state.captureStream = null;
  state.restrictedStream = null;
  stopTracks(stream);
  $("#session-button").disabled = false;
  $("#record-button").disabled = true;
  $("#end-session-button").disabled = true;
  setBadge("#capture-mode", "NOT CAPTURED", "idle");
  $("#session-note").textContent = "권한은 저장되지 않지만, 한 캡처 세션 안에서는 여러 영상을 연속 녹화할 수 있습니다.";
  log("캡처 세션 종료", { reason });
  renderCapabilities();
}

function exportDiagnostics() {
  const payload = {
    exportedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    secureContext: window.isSecureContext,
    capabilities: {
      getDisplayMedia: Boolean(navigator.mediaDevices?.getDisplayMedia),
      mediaRecorder: "MediaRecorder" in window,
      restrictionTarget: "RestrictionTarget" in window,
      cropTarget: "CropTarget" in window,
      fileSystemAccess: "showSaveFilePicker" in window,
      videoMime: supportedMime("video"),
      audioMime: supportedMime("audio"),
    },
    capture: state.captureStream ? {
      video: state.captureStream.getVideoTracks().map((track) => track.getSettings()),
      audioTrackCount: state.captureStream.getAudioTracks().length,
    } : null,
    events: state.events,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `y2y2-dvr-diagnostics-${Date.now()}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$("#load-button").addEventListener("click", loadPlayer);
$("#session-button").addEventListener("click", startSession);
$("#record-button").addEventListener("click", startRecording);
$("#pause-button").addEventListener("click", togglePause);
$("#stop-button").addEventListener("click", () => stopRecording());
$("#end-session-button").addEventListener("click", () => endSession());
$("#export-button").addEventListener("click", exportDiagnostics);
$("#video-input").addEventListener("keydown", (event) => { if (event.key === "Enter") loadPlayer(); });
window.addEventListener("resize", updateTargetSize);
window.addEventListener("beforeunload", () => { stopTracks(state.captureStream); if (state.outputUrl) URL.revokeObjectURL(state.outputUrl); });

try {
  navigator.mediaDevices?.setCaptureHandleConfig?.({ handle: "y2y2-local-dvr", exposeOrigin: true, permittedOrigins: [location.origin] });
} catch (error) {
  log("Capture Handle 설정 생략", { name: error.name, message: error.message });
}

renderCapabilities();
updateTargetSize();
log("런타임 기능 진단 완료", { secureContext: window.isSecureContext, userAgent: navigator.userAgent });

