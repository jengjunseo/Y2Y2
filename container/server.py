import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, urlparse

PORT = int(os.getenv("PORT", "8080"))
MAX_CONCURRENT = max(1, int(os.getenv("Y2Y2_MAX_CONCURRENT", "1")))
PROCESS_SLOTS = threading.Semaphore(MAX_CONCURRENT)
ALLOWED_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
}
ALLOWED_MP4 = {360, 720, 1080, 1440, 2160}
ALLOWED_MP3 = {128, 192, 256, 320}


def validate_url(raw: str) -> str:
    if not isinstance(raw, str) or len(raw) > 2048:
        raise ValueError("Invalid URL")
    parsed = urlparse(raw.strip())
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in {"http", "https"} or host not in ALLOWED_HOSTS:
        raise ValueError("Only standard YouTube URLs are supported")
    return raw.strip()


def safe_filename(value: str, fallback: str = "media") -> str:
    value = unicodedata.normalize("NFKC", value or "")
    value = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "_", value)
    value = re.sub(r"\s+", " ", value).strip(" .")
    return (value[:140] or fallback)


def run(args, timeout=1200):
    proc = subprocess.run(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
        check=False,
    )
    if proc.returncode != 0:
        message = (proc.stderr or proc.stdout or "media command failed").strip()
        raise RuntimeError(message[-3000:])
    return proc.stdout


def inspect_media(url: str):
    raw = run([
        "yt-dlp",
        "--dump-single-json",
        "--skip-download",
        "--no-playlist",
        "--no-warnings",
        url,
    ], timeout=90)
    data = json.loads(raw)
    heights = sorted({
        int(f.get("height"))
        for f in data.get("formats", [])
        if f.get("vcodec") not in (None, "none")
        and isinstance(f.get("height"), (int, float))
        and int(f.get("height")) in ALLOWED_MP4
    })
    return {
        "videoId": str(data.get("id") or ""),
        "title": str(data.get("title") or "Untitled"),
        "duration": int(data.get("duration") or 0),
        "thumbnail": str(data.get("thumbnail") or ""),
        "channel": str(data.get("channel") or data.get("uploader") or ""),
        "mp4Qualities": heights,
        "mp3Qualities": sorted(ALLOWED_MP3),
    }


def process_media(payload):
    url = validate_url(payload.get("url", ""))
    media_type = payload.get("mediaType")
    quality = int(payload.get("quality") or 0)
    expected_title = safe_filename(str(payload.get("title") or "media"))

    if media_type == "mp4" and quality not in ALLOWED_MP4:
        raise ValueError("Unsupported MP4 quality")
    if media_type == "mp3" and quality not in ALLOWED_MP3:
        raise ValueError("Unsupported MP3 bitrate")
    if media_type not in {"mp3", "mp4"}:
        raise ValueError("Unsupported media type")

    with PROCESS_SLOTS:
        workdir = Path(tempfile.mkdtemp(prefix="y2y2-"))
        try:
            output = str(workdir / "media.%(ext)s")
            base = [
                "yt-dlp",
                "--no-playlist",
                "--no-warnings",
                "--no-part",
                "--restrict-filenames",
                "-o",
                output,
            ]

            if media_type == "mp3":
                args = base + [
                    "-f",
                    "bestaudio/best",
                    "-x",
                    "--audio-format",
                    "mp3",
                    "--audio-quality",
                    f"{quality}K",
                    url,
                ]
                run(args, timeout=1800)
                candidates = list(workdir.glob("*.mp3"))
                extension = "mp3"
                content_type = "audio/mpeg"
            else:
                fmt = (
                    f"bv*[height={quality}][ext=mp4]+ba[ext=m4a]/"
                    f"b[height={quality}][ext=mp4]/"
                    f"bv*[height={quality}]+ba/b[height={quality}]"
                )
                args = base + [
                    "-f",
                    fmt,
                    "--merge-output-format",
                    "mp4",
                    "--remux-video",
                    "mp4",
                    url,
                ]
                run(args, timeout=1800)
                candidates = list(workdir.glob("*.mp4"))
                extension = "mp4"
                content_type = "video/mp4"

            if not candidates:
                raise RuntimeError("yt-dlp completed without a usable output file")

            path = max(candidates, key=lambda p: p.stat().st_size)
            final_name = f"{expected_title}.{extension}"
            return path, final_name, content_type
        except Exception:
            shutil.rmtree(workdir, ignore_errors=True)
            raise


class Handler(BaseHTTPRequestHandler):
    server_version = "Y2Y2Container/0.1"

    def log_message(self, fmt, *args):
        print(f"container {self.address_string()} {fmt % args}", flush=True)

    def send_json(self, status, payload):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 64 * 1024:
            raise ValueError("Invalid request body")
        return json.loads(self.rfile.read(length))

    def do_GET(self):
        if self.path in {"/ping", "/health"}:
            self.send_json(200, {"ok": True, "service": "y2y2-media"})
            return
        self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        try:
            payload = self.read_json()
            if self.path == "/inspect":
                url = validate_url(payload.get("url", ""))
                self.send_json(200, inspect_media(url))
                return

            if self.path == "/process":
                path, filename, content_type = process_media(payload)
                try:
                    size = path.stat().st_size
                    self.send_response(200)
                    self.send_header("Content-Type", content_type)
                    self.send_header("Content-Length", str(size))
                    self.send_header("X-Y2Y2-Filename", quote(filename, safe=""))
                    self.send_header("X-Y2Y2-Size", str(size))
                    self.end_headers()
                    with path.open("rb") as handle:
                        while True:
                            chunk = handle.read(1024 * 1024)
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                finally:
                    shutil.rmtree(path.parent, ignore_errors=True)
                return

            self.send_json(404, {"error": "Not found"})
        except subprocess.TimeoutExpired:
            self.send_json(504, {"error": "Media processing timed out"})
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json(400, {"error": str(exc)})
        except Exception as exc:
            self.send_json(502, {"error": str(exc)[-3000:]})


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Y2Y2 media container listening on :{PORT}", flush=True)
    server.serve_forever()
