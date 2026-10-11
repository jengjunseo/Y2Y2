"""Isolated yt-dlp process. Raw signed source URLs never go to browser or logs."""
from __future__ import annotations

import importlib.metadata
import json
import os
import shutil
import subprocess
import sys

from .formats import MediaError, choices, track_size, video_id


def runtime_info():
    executable = shutil.which(os.environ.get("Y2Y2_NODE", "node"))
    if not executable:
        raise MediaError("RUNTIME_MISSING", "서버의 JavaScript 런타임이 준비되지 않았습니다.", 503)
    version = subprocess.check_output([executable, "--version"], timeout=5, text=True).strip()
    if int(version.lstrip("v").split(".")[0]) < 22:
        raise MediaError("RUNTIME_OLD", "서버의 JavaScript 런타임 업데이트가 필요합니다.", 503)
    return {"node": version, "ytDlp": importlib.metadata.version("yt-dlp"),
            "ejs": importlib.metadata.version("yt-dlp-ejs")}


class SilentLogger:
    def debug(self, *args, **kwargs): pass
    def warning(self, *args, **kwargs): pass
    def error(self, *args, **kwargs): pass


def extract(value):
    import yt_dlp
    runtime_info()
    ident = video_id(value)
    options = {"quiet": True, "no_warnings": True, "logger": SilentLogger(), "noplaylist": True,
               "skip_download": True, "socket_timeout": 12, "retries": 1, "extractor_retries": 1,
               "cachedir": False, "js_runtimes": {"node": {"path": shutil.which(os.environ.get("Y2Y2_NODE", "node"))}}}
    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info("https://www.youtube.com/watch?v=" + ident, download=False)
        available, tracks = choices(info)
        return {"videoId": ident, "title": str(info.get("title", ""))[:300],
                "duration": info.get("duration"), "choices": available,
                "tracks": {key: {"url": fmt["url"], "size": track_size(fmt),
                                  "headers": {k: str(v) for k, v in fmt.get("http_headers", {}).items()
                                              if k.lower() in {"user-agent", "referer", "origin", "accept"}}}
                           for key, fmt in tracks.items()}}
    except MediaError:
        raise
    except yt_dlp.utils.DownloadError as exc:
        # Classify without exposing signed URLs, account data, or extractor output.
        message = str(exc).lower()
        if any(word in message for word in ("not a bot", "sign in to confirm", "bot check")):
            raise MediaError("SOURCE_ACCESS", "이 서버에서 원본 영상 접근이 거절됐습니다. 다른 화질로 대체하지 않습니다.", 502) from None
        raise MediaError("SOURCE_UNAVAILABLE", "원본을 분석하지 못했습니다. 공개 여부와 서버 접속 상태를 확인해 주세요.", 502) from None


if __name__ == "__main__":
    try:
        data = runtime_info() if sys.argv[1:] == ["--runtime"] else extract(sys.argv[1])
        print(json.dumps({"ok": True, "data": data}, ensure_ascii=True))
    except MediaError as exc:
        print(json.dumps({"ok": False, "error": exc.code, "message": exc.message, "status": exc.status}, ensure_ascii=True))
        sys.exit(1)
    except Exception:
        print(json.dumps({"ok": False, "error": "EXTRACTOR_FAILURE", "message": "서버 분석기를 확인해 주세요.", "status": 503}))
        sys.exit(1)
