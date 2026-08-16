import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import unicodedata
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

VERSION = "0.2.0"
PORT = int(os.getenv("PORT", "8080"))
CONTROL_TOKEN = os.environ["Y2Y2_CONTROL_TOKEN"]
DOWNLOAD_TOKEN = os.environ["Y2Y2_DOWNLOAD_TOKEN"]
DATA_DIR = Path(os.getenv("Y2Y2_DATA_DIR", "/vercel/sandbox/y2y2-data"))
ARTIFACT_DIR = DATA_DIR / "artifacts"
STATE_FILE = DATA_DIR / "jobs.json"
RETENTION_SECONDS = 24 * 60 * 60
MAX_WORKERS = max(1, min(4, int(os.getenv("Y2Y2_MAX_WORKERS", "2"))))
ALLOWED_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
}
ALLOWED_MP4 = {360, 720, 1080, 1440, 2160}
ALLOWED_MP3 = {128, 192, 256, 320}
OUTPUT_CONTRACT_VERSION = "vercel-v1"

DATA_DIR.mkdir(parents=True, exist_ok=True)
ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
STATE_LOCK = threading.RLock()
EXECUTOR = ThreadPoolExecutor(max_workers=MAX_WORKERS, thread_name_prefix="y2y2")


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def validate_url(raw):
    if not isinstance(raw, str) or len(raw) > 2048:
        raise ValueError("Invalid URL")
    parsed = urlparse(raw.strip())
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in {"http", "https"} or host not in ALLOWED_HOSTS:
        raise ValueError("Only standard YouTube URLs are supported")
    return raw.strip()


def safe_filename(value, fallback="media"):
    value = unicodedata.normalize("NFKC", str(value or ""))
    value = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", value)
    value = re.sub(r"\s+", " ", value).strip(" .")
    return (value[:160] or fallback)


def read_state():
    with STATE_LOCK:
        if not STATE_FILE.exists():
            return {"jobs": {}}
        try:
            data = json.loads(STATE_FILE.read_text("utf-8"))
            if not isinstance(data, dict) or not isinstance(data.get("jobs"), dict):
                return {"jobs": {}}
            return data
        except Exception:
            return {"jobs": {}}


def write_state(data):
    with STATE_LOCK:
        tmp = STATE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), "utf-8")
        tmp.replace(STATE_FILE)


def mutate_job(job_id, **patch):
    with STATE_LOCK:
        data = read_state()
        job = data["jobs"].get(job_id)
        if not job:
            return None
        job.update(patch)
        job["updatedAt"] = now_iso()
        write_state(data)
        return dict(job)


def load_job(job_id):
    with STATE_LOCK:
        data = read_state()
        job = data["jobs"].get(job_id)
        return dict(job) if job else None


def public_job(job):
    return {
        "id": job["id"],
        "videoId": job.get("videoId"),
        "title": job.get("title") or "Untitled",
        "mediaType": job.get("mediaType"),
        "quality": job.get("quality"),
        "status": job.get("status"),
        "stage": job.get("stage"),
        "filename": job.get("filename"),
        "sizeBytes": job.get("sizeBytes"),
        "error": job.get("error"),
        "createdAt": job.get("createdAt"),
        "updatedAt": job.get("updatedAt"),
    }


def history_job(job):
    return {
        "id": job["id"],
        "video_id": job.get("videoId"),
        "title": job.get("title") or "Untitled",
        "media_type": job.get("mediaType") or "mp3",
        "quality": job.get("quality") or 0,
        "status": job.get("status") or "failed",
        "stage": job.get("stage") or "unknown",
        "filename": job.get("filename"),
        "size_bytes": job.get("sizeBytes"),
        "error": job.get("error"),
        "created_at": job.get("createdAt"),
        "updated_at": job.get("updatedAt"),
    }


def cache_key(video_id, media_type, quality):
    raw = f"{video_id}|{media_type}|{quality}|{OUTPUT_CONTRACT_VERSION}".encode()
    return hashlib.sha256(raw).hexdigest()


def artifact_path(key, media_type):
    return ARTIFACT_DIR / f"{key}.{media_type}"


def run_command(args, timeout):
    proc = subprocess.run(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
        check=False,
    )
    if proc.returncode != 0:
        msg = (proc.stderr or proc.stdout or "media command failed").strip()
        raise RuntimeError(msg[-5000:])
    return proc.stdout


def ffmpeg_exe():
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def ytdlp_base():
    return [sys.executable, "-m", "yt_dlp"]


def inspect_media(url):
    url = validate_url(url)
    raw = run_command(
        ytdlp_base()
        + [
            "--dump-single-json",
            "--skip-download",
            "--no-playlist",
            "--no-warnings",
            url,
        ],
        120,
    )
    data = json.loads(raw)
    heights = sorted(
        {
            int(f.get("height"))
            for f in data.get("formats", [])
            if f.get("vcodec") not in (None, "none")
            and isinstance(f.get("height"), (int, float))
            and int(f.get("height")) in ALLOWED_MP4
        }
    )
    return {
        "videoId": str(data.get("id") or ""),
        "title": str(data.get("title") or "Untitled"),
        "duration": int(data.get("duration") or 0),
        "thumbnail": str(data.get("thumbnail") or ""),
        "channel": str(data.get("channel") or data.get("uploader") or ""),
        "mp4Qualities": heights,
        "mp3Qualities": sorted(ALLOWED_MP3),
    }


def remove_temp(prefix):
    for path in ARTIFACT_DIR.glob(f"{prefix}*"):
        try:
            path.unlink()
        except OSError:
            pass


def process_job(job_id):
    job = load_job(job_id)
    if not job:
        return
    mutate_job(job_id, status="processing", stage="processing", error=None)
    target = artifact_path(job["cacheKey"], job["mediaType"])
    if target.exists() and target.stat().st_size > 0:
        mutate_job(
            job_id,
            status="ready",
            stage="reused",
            filename=job["filename"],
            sizeBytes=target.stat().st_size,
            error=None,
        )
        return

    temp_prefix = f"tmp-{job_id}-"
    output = str(ARTIFACT_DIR / f"{temp_prefix}%(ext)s")
    base = ytdlp_base() + [
        "--no-playlist",
        "--no-warnings",
        "--no-part",
        "--ffmpeg-location",
        ffmpeg_exe(),
        "-o",
        output,
    ]
    try:
        if job["mediaType"] == "mp3":
            args = base + [
                "-f",
                "bestaudio/best",
                "-x",
                "--audio-format",
                "mp3",
                "--audio-quality",
                f"{job['quality']}K",
                job["url"],
            ]
        else:
            q = job["quality"]
            fmt = (
                f"bv*[height={q}][ext=mp4]+ba[ext=m4a]/"
                f"b[height={q}][ext=mp4]/"
                f"bv*[height={q}]+ba/b[height={q}]"
            )
            args = base + [
                "-f",
                fmt,
                "--merge-output-format",
                "mp4",
                "--remux-video",
                "mp4",
                job["url"],
            ]
        run_command(args, 2400)
        candidates = [
            p
            for p in ARTIFACT_DIR.glob(f"{temp_prefix}*")
            if p.is_file() and p.suffix.lower() == f".{job['mediaType']}"
        ]
        if not candidates:
            raise RuntimeError("yt-dlp completed without a usable output file")
        source = max(candidates, key=lambda p: p.stat().st_size)
        source.replace(target)
        remove_temp(temp_prefix)
        mutate_job(
            job_id,
            status="ready",
            stage="ready",
            filename=job["filename"],
            sizeBytes=target.stat().st_size,
            error=None,
        )
    except subprocess.TimeoutExpired:
        remove_temp(temp_prefix)
        mutate_job(job_id, status="failed", stage="timeout", error="Media processing timed out")
    except Exception as exc:
        remove_temp(temp_prefix)
        mutate_job(job_id, status="failed", stage="failed", error=str(exc)[-3000:])


def create_job(payload):
    url = validate_url(payload.get("url", ""))
    video_id = str(payload.get("videoId") or "").strip()[:128]
    title = str(payload.get("title") or "Untitled").strip()[:512]
    media_type = payload.get("mediaType")
    try:
        quality = int(payload.get("quality"))
    except Exception:
        raise ValueError("Invalid quality")
    if not video_id:
        raise ValueError("Invalid videoId")
    if media_type == "mp3" and quality not in ALLOWED_MP3:
        raise ValueError("Unsupported MP3 bitrate")
    if media_type == "mp4" and quality not in ALLOWED_MP4:
        raise ValueError("Unsupported MP4 quality")
    if media_type not in {"mp3", "mp4"}:
        raise ValueError("mediaType must be mp3 or mp4")

    key = cache_key(video_id, media_type, quality)
    filename = f"{safe_filename(title)}.{media_type}"
    target = artifact_path(key, media_type)
    with STATE_LOCK:
        data = read_state()
        for existing in sorted(data["jobs"].values(), key=lambda x: x.get("createdAt", ""), reverse=True):
            if existing.get("cacheKey") != key:
                continue
            if existing.get("status") in {"queued", "processing"}:
                return public_job(existing)
            if existing.get("status") == "ready" and target.exists() and target.stat().st_size > 0:
                copy = dict(existing)
                return public_job(copy)

        job_id = str(uuid.uuid4())
        stamp = now_iso()
        job = {
            "id": job_id,
            "cacheKey": key,
            "url": url,
            "videoId": video_id,
            "title": title,
            "mediaType": media_type,
            "quality": quality,
            "status": "ready" if target.exists() and target.stat().st_size > 0 else "queued",
            "stage": "reused" if target.exists() and target.stat().st_size > 0 else "queued",
            "filename": filename,
            "sizeBytes": target.stat().st_size if target.exists() else None,
            "error": None,
            "createdAt": stamp,
            "updatedAt": stamp,
        }
        data["jobs"][job_id] = job
        write_state(data)

    if job["status"] == "queued":
        EXECUTOR.submit(process_job, job_id)
    return public_job(job)


def cleanup():
    cutoff = time.time() - RETENTION_SECONDS
    for path in ARTIFACT_DIR.glob("*"):
        if path.name.startswith("tmp-"):
            if path.stat().st_mtime < time.time() - 3600:
                try:
                    path.unlink()
                except OSError:
                    pass
            continue
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink()
        except OSError:
            pass

    with STATE_LOCK:
        data = read_state()
        changed = False
        for job in data["jobs"].values():
            if job.get("status") == "ready":
                target = artifact_path(job.get("cacheKey", ""), job.get("mediaType", "mp3"))
                if not target.exists():
                    job.update(
                        status="failed",
                        stage="artifact-expired",
                        error="The temporary file expired. Prepare it again.",
                        updatedAt=now_iso(),
                    )
                    changed = True
        if changed:
            write_state(data)


def recover_interrupted_jobs():
    with STATE_LOCK:
        data = read_state()
        changed = False
        for job in data["jobs"].values():
            if job.get("status") in {"queued", "processing"}:
                job.update(
                    status="failed",
                    stage="interrupted",
                    error="The Sandbox session ended while this item was processing. Retry it.",
                    updatedAt=now_iso(),
                )
                changed = True
        if changed:
            write_state(data)


def require_control(handler):
    return handler.headers.get("X-Y2Y2-Token", "") == CONTROL_TOKEN


def valid_download_token(query):
    return (query.get("token") or [""])[0] == DOWNLOAD_TOKEN


def read_json(handler):
    length = int(handler.headers.get("Content-Length", "0") or "0")
    if length <= 0 or length > 64 * 1024:
        raise ValueError("Invalid request body")
    return json.loads(handler.rfile.read(length))


def content_disposition(filename):
    encoded = quote(filename, safe="")
    fallback = re.sub(r"[^A-Za-z0-9._ -]", "_", filename)[:160] or "media"
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{encoded}"


class Handler(BaseHTTPRequestHandler):
    server_version = "Y2Y2VercelSandbox/0.2"

    def log_message(self, fmt, *args):
        print(f"y2y2 {self.address_string()} {fmt % args}", flush=True)

    def send_json(self, status, payload):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        if parsed.path == "/health":
            self.send_json(200, {"ok": True, "service": "y2y2-sandbox", "version": VERSION})
            return

        download_match = re.fullmatch(r"/download/([A-Za-z0-9-]+)", parsed.path)
        if download_match:
            if not valid_download_token(query):
                self.send_json(403, {"error": "Forbidden"})
                return
            self.serve_download(download_match.group(1), query)
            return

        if not require_control(self):
            self.send_json(403, {"error": "Forbidden"})
            return

        if parsed.path == "/history":
            cleanup()
            data = read_state()
            rows = sorted(data["jobs"].values(), key=lambda x: x.get("createdAt", ""), reverse=True)[:100]
            self.send_json(200, {"items": [history_job(x) for x in rows]})
            return

        job_match = re.fullmatch(r"/jobs/([A-Za-z0-9-]+)", parsed.path)
        if job_match:
            job = load_job(job_match.group(1))
            if not job:
                self.send_json(404, {"error": "Job not found"})
                return
            if job.get("status") == "ready":
                target = artifact_path(job.get("cacheKey", ""), job.get("mediaType", "mp3"))
                if not target.exists():
                    job = mutate_job(
                        job["id"],
                        status="failed",
                        stage="artifact-expired",
                        error="The temporary file expired. Prepare it again.",
                    )
            self.send_json(200, public_job(job))
            return

        self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        if not require_control(self):
            self.send_json(403, {"error": "Forbidden"})
            return
        try:
            payload = read_json(self)
            if self.path == "/inspect":
                self.send_json(200, inspect_media(payload.get("url", "")))
                return
            if self.path == "/jobs":
                cleanup()
                self.send_json(202, create_job(payload))
                return
            self.send_json(404, {"error": "Not found"})
        except subprocess.TimeoutExpired:
            self.send_json(504, {"error": "Media inspection timed out"})
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json(400, {"error": str(exc)})
        except Exception as exc:
            self.send_json(502, {"error": str(exc)[-3000:]})

    def serve_download(self, job_id, query):
        cleanup()
        job = load_job(job_id)
        if not job or job.get("status") != "ready":
            self.send_json(404, {"error": "File is not ready"})
            return
        path = artifact_path(job.get("cacheKey", ""), job.get("mediaType", "mp3"))
        if not path.exists():
            self.send_json(410, {"error": "Temporary file expired"})
            return
        prefix = unquote((query.get("prefix") or [""])[0])
        if not re.fullmatch(r"\d{2,3} - ", prefix):
            prefix = ""
        filename = safe_filename(prefix + (job.get("filename") or f"media.{job.get('mediaType', 'mp3')}"))
        total = path.stat().st_size
        start, end = 0, total - 1
        status = 200
        range_header = self.headers.get("Range")
        if range_header:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
            if match:
                if match.group(1):
                    start = int(match.group(1))
                if match.group(2):
                    end = min(int(match.group(2)), total - 1)
                if start > end or start >= total:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{total}")
                    self.end_headers()
                    return
                status = 206
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", "audio/mpeg" if job.get("mediaType") == "mp3" else "video/mp4")
        self.send_header("Content-Disposition", content_disposition(filename))
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "private, no-store")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{total}")
        self.end_headers()
        with path.open("rb") as handle:
            handle.seek(start)
            remaining = length
            while remaining > 0:
                chunk = handle.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)


if __name__ == "__main__":
    cleanup()
    recover_interrupted_jobs()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Y2Y2 Vercel Sandbox backend {VERSION} listening on :{PORT}", flush=True)
    server.serve_forever()
