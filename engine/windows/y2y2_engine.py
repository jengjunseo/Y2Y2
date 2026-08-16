from __future__ import annotations

import hashlib
import html
import json
import os
import queue
import re
import secrets
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.parse
import webbrowser
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

APP_VERSION = "0.3.0"
PROTOCOL_VERSION = 1
HOST = "127.0.0.1"
PORT = int(os.getenv("Y2Y2_ENGINE_PORT", "49272"))
MAX_BODY = 1_000_000
ALLOWED_MP3 = {128, 192, 256, 320}
ALLOWED_MP4 = {360, 720, 1080, 1440, 2160}
DEFAULT_ALLOWED_ORIGINS = {
    "https://y2-y2.vercel.app",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
}
YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
}
RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


def now_ts() -> int:
    return int(time.time())


def app_data_dir() -> Path:
    configured = os.getenv("Y2Y2_APP_DATA_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    root = os.getenv("LOCALAPPDATA")
    if root:
        return Path(root) / "Y2Y2"
    return Path.home() / ".y2y2"


def downloads_dir() -> Path:
    configured = os.getenv("Y2Y2_DOWNLOAD_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return (Path.home() / "Downloads" / "Y2Y2").resolve()




def bundled_deno_path() -> str | None:
    candidates = []
    bundle_root = getattr(sys, "_MEIPASS", None)
    if bundle_root:
        candidates.append(Path(bundle_root) / "deno.exe")
    found = shutil.which("deno")
    if found:
        candidates.append(Path(found))
    for path in candidates:
        if path.is_file():
            return str(path)
    return None

def validate_source_url(raw: str) -> str:
    if not isinstance(raw, str) or len(raw) > 2048:
        raise ValueError("Invalid URL")
    value = raw.strip()
    parsed = urllib.parse.urlparse(value)
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in {"http", "https"} or host not in YOUTUBE_HOSTS:
        raise ValueError("Only standard YouTube URLs are supported")
    return value


def safe_filename(value: str, fallback: str = "media", max_chars: int = 140) -> str:
    value = unicodedata.normalize("NFKC", value or "")
    value = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "_", value)
    value = re.sub(r"\s+", " ", value).strip(" .")
    if not value:
        value = fallback
    stem_upper = value.split(".", 1)[0].upper()
    if stem_upper in RESERVED_NAMES:
        value = f"_{value}"
    return value[:max_chars].rstrip(" .") or fallback


def safe_prefix(value: str) -> str:
    if not value:
        return ""
    value = unicodedata.normalize("NFKC", str(value))
    value = re.sub(r"[^0-9 _\-.]", "", value)[:16]
    return value


def unique_target(folder: Path, filename: str) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    candidate = folder / filename
    if not candidate.exists():
        return candidate
    stem, suffix = candidate.stem, candidate.suffix
    for index in range(2, 1000):
        candidate = folder / f"{stem} ({index}){suffix}"
        if not candidate.exists():
            return candidate
    raise RuntimeError("Too many filename collisions")


def allowed_origins() -> set[str]:
    values = set(DEFAULT_ALLOWED_ORIGINS)
    extra = os.getenv("Y2Y2_ALLOWED_ORIGINS", "")
    values.update(x.strip().rstrip("/") for x in extra.split(",") if x.strip())
    return values


@dataclass
class EngineConfig:
    token: str
    pair_code: str


class EngineStore:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self.db_path = self.root / "engine.sqlite3"
        self.config_path = self.root / "engine.json"
        self._lock = threading.RLock()
        self.config = self._load_config()
        self._init_db()
        self.recover_interrupted()

    def _load_config(self) -> EngineConfig:
        token = None
        if self.config_path.exists():
            try:
                token = json.loads(self.config_path.read_text("utf-8")).get("token")
            except Exception:
                token = None
        token = token if isinstance(token, str) and len(token) >= 32 else secrets.token_urlsafe(32)
        pair_code = f"{secrets.randbelow(1_000_000):06d}"
        self.config_path.write_text(json.dumps({"token": token}, indent=2), "utf-8")
        return EngineConfig(token=token, pair_code=pair_code)

    def rotate_pair_code(self) -> str:
        with self._lock:
            self.config.pair_code = f"{secrets.randbelow(1_000_000):06d}"
            return self.config.pair_code

    def _connect(self):
        db = sqlite3.connect(self.db_path, timeout=30, check_same_thread=False)
        db.row_factory = sqlite3.Row
        return db

    def _init_db(self):
        with self._connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    url TEXT NOT NULL,
                    video_id TEXT,
                    title TEXT NOT NULL,
                    media_type TEXT NOT NULL,
                    quality INTEGER NOT NULL,
                    filename_prefix TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL,
                    stage TEXT NOT NULL,
                    progress REAL NOT NULL DEFAULT 0,
                    error TEXT,
                    output_path TEXT,
                    filename TEXT,
                    size_bytes INTEGER,
                    cancel_requested INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);
                """
            )

    def recover_interrupted(self):
        with self._connect() as db:
            db.execute(
                "UPDATE jobs SET status='queued', stage='recovered', progress=0, error=NULL, updated_at=? "
                "WHERE status IN ('processing','submitting')",
                (now_ts(),),
            )

    @staticmethod
    def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        data = dict(row)
        data["cancel_requested"] = bool(data.get("cancel_requested"))
        data["downloadUrl"] = None
        data["mediaType"] = data.pop("media_type")
        data["videoId"] = data.pop("video_id")
        data["sizeBytes"] = data.pop("size_bytes")
        data["outputPath"] = data.pop("output_path")
        data["createdAt"] = data.pop("created_at")
        data["updatedAt"] = data.pop("updated_at")
        data["filenamePrefix"] = data.pop("filename_prefix")
        return data

    def create_job(self, payload: dict[str, Any]) -> dict[str, Any]:
        url = validate_source_url(payload.get("url", ""))
        media_type = str(payload.get("mediaType", "")).lower()
        quality = int(payload.get("quality") or 0)
        if media_type == "mp3" and quality not in ALLOWED_MP3:
            raise ValueError("Unsupported MP3 bitrate")
        if media_type == "mp4" and quality not in ALLOWED_MP4:
            raise ValueError("Unsupported MP4 quality")
        if media_type not in {"mp3", "mp4"}:
            raise ValueError("Unsupported media type")
        title = safe_filename(str(payload.get("title") or "media"))
        prefix = safe_prefix(str(payload.get("filenamePrefix") or ""))
        job_id = secrets.token_hex(12)
        stamp = now_ts()
        with self._connect() as db:
            db.execute(
                "INSERT INTO jobs(id,url,video_id,title,media_type,quality,filename_prefix,status,stage,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (
                    job_id,
                    url,
                    str(payload.get("videoId") or ""),
                    title,
                    media_type,
                    quality,
                    prefix,
                    "queued",
                    "queued",
                    stamp,
                    stamp,
                ),
            )
        return self.get_job(job_id)

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        return self.row_to_dict(row)

    def list_jobs(self, limit: int = 50) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit), 100))
        with self._connect() as db:
            rows = db.execute("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
        return [self.row_to_dict(row) for row in rows]

    def next_queued(self) -> dict[str, Any] | None:
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT * FROM jobs WHERE status='queued' AND cancel_requested=0 ORDER BY created_at ASC LIMIT 1"
            ).fetchone()
            if row is None:
                db.commit()
                return None
            db.execute(
                "UPDATE jobs SET status='processing', stage='starting', progress=0, updated_at=? WHERE id=?",
                (now_ts(), row["id"]),
            )
            db.commit()
        return self.get_job(row["id"])

    def update(self, job_id: str, **fields):
        if not fields:
            return
        allowed = {
            "status", "stage", "progress", "error", "output_path", "filename", "size_bytes", "cancel_requested"
        }
        normalized = {k: v for k, v in fields.items() if k in allowed}
        normalized["updated_at"] = now_ts()
        assignments = ",".join(f"{k}=?" for k in normalized)
        with self._connect() as db:
            db.execute(f"UPDATE jobs SET {assignments} WHERE id=?", (*normalized.values(), job_id))

    def retry(self, job_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
            if row is None:
                return None
            if row["status"] in {"processing", "queued"}:
                return self.get_job(job_id)
            db.execute(
                "UPDATE jobs SET status='queued',stage='queued',progress=0,error=NULL,output_path=NULL,filename=NULL,size_bytes=NULL,cancel_requested=0,updated_at=? WHERE id=?",
                (now_ts(), job_id),
            )
        return self.get_job(job_id)

    def cancel(self, job_id: str) -> dict[str, Any] | None:
        job = self.get_job(job_id)
        if not job:
            return None
        if job["status"] == "queued":
            self.update(job_id, status="canceled", stage="canceled", cancel_requested=1)
        elif job["status"] == "processing":
            self.update(job_id, cancel_requested=1, stage="canceling")
        return self.get_job(job_id)

    def is_cancel_requested(self, job_id: str) -> bool:
        with self._connect() as db:
            row = db.execute("SELECT cancel_requested FROM jobs WHERE id=?", (job_id,)).fetchone()
        return bool(row and row[0])


class MediaProcessor:
    def __init__(self, store: EngineStore, output_dir: Path):
        self.store = store
        self.output_dir = output_dir
        self.output_dir.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _imports():
        import yt_dlp
        import imageio_ffmpeg
        return yt_dlp, imageio_ffmpeg

    def inspect(self, raw_url: str) -> dict[str, Any]:
        url = validate_source_url(raw_url)
        yt_dlp, _ = self._imports()
        options = {
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "skip_download": True,
        }
        deno = bundled_deno_path()
        if deno:
            options["js_runtimes"] = {"deno": {"path": deno}}
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=False)
        formats = info.get("formats") or []
        heights = sorted({
            int(f.get("height"))
            for f in formats
            if f.get("vcodec") not in (None, "none")
            and f.get("ext") == "mp4"
            and isinstance(f.get("height"), (int, float))
            and int(f.get("height")) in ALLOWED_MP4
        })
        return {
            "videoId": str(info.get("id") or ""),
            "title": str(info.get("title") or "Untitled"),
            "duration": int(info.get("duration") or 0),
            "thumbnail": str(info.get("thumbnail") or ""),
            "channel": str(info.get("channel") or info.get("uploader") or ""),
            "mp4Qualities": heights,
            "mp3Qualities": sorted(ALLOWED_MP3),
        }

    def process(self, job: dict[str, Any]):
        yt_dlp, imageio_ffmpeg = self._imports()
        job_id = job["id"]
        temp_root = app_data_dir() / "tmp" / job_id
        shutil.rmtree(temp_root, ignore_errors=True)
        temp_root.mkdir(parents=True, exist_ok=True)
        outtmpl = str(temp_root / "media.%(ext)s")
        ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()

        def hook(data):
            if self.store.is_cancel_requested(job_id):
                raise RuntimeError("Y2Y2 job canceled")
            if data.get("status") == "downloading":
                total = data.get("total_bytes") or data.get("total_bytes_estimate") or 0
                done = data.get("downloaded_bytes") or 0
                pct = (float(done) / float(total) * 100.0) if total else 0.0
                self.store.update(job_id, stage="downloading", progress=round(pct, 2))
            elif data.get("status") == "finished":
                self.store.update(job_id, stage="finishing", progress=96.0)

        common = {
            "outtmpl": outtmpl,
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "progress_hooks": [hook],
            "ffmpeg_location": ffmpeg_exe,
            "nopart": False,
        }
        deno = bundled_deno_path()
        if deno:
            common["js_runtimes"] = {"deno": {"path": deno}}
        if job["mediaType"] == "mp3":
            options = {
                **common,
                "format": "bestaudio/best",
                "postprocessors": [{
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "mp3",
                    "preferredquality": str(job["quality"]),
                }],
            }
            wanted_ext = ".mp3"
        else:
            q = int(job["quality"])
            options = {
                **common,
                "format": (
                    f"bestvideo[height={q}][ext=mp4]+bestaudio[ext=m4a]/"
                    f"best[height={q}][ext=mp4]"
                ),
                "merge_output_format": "mp4",
            }
            wanted_ext = ".mp4"

        try:
            with yt_dlp.YoutubeDL(options) as ydl:
                ydl.download([job["url"]])
            if self.store.is_cancel_requested(job_id):
                self.store.update(job_id, status="canceled", stage="canceled", progress=0, error="Canceled")
                return
            candidates = [p for p in temp_root.iterdir() if p.is_file() and p.suffix.lower() == wanted_ext]
            if not candidates:
                raise RuntimeError(f"Processing completed without a {wanted_ext} output")
            source = max(candidates, key=lambda p: p.stat().st_size)
            base = safe_filename(job["title"])
            prefix = safe_prefix(job.get("filenamePrefix") or "")
            target = unique_target(self.output_dir, f"{prefix}{base}{wanted_ext}")
            shutil.move(str(source), str(target))
            size = target.stat().st_size
            self.store.update(
                job_id,
                status="ready",
                stage="saved",
                progress=100.0,
                error=None,
                output_path=str(target),
                filename=target.name,
                size_bytes=size,
                cancel_requested=0,
            )
        except Exception as error:
            if self.store.is_cancel_requested(job_id):
                self.store.update(job_id, status="canceled", stage="canceled", progress=0, error="Canceled")
            else:
                message = str(error).strip() or error.__class__.__name__
                self.store.update(job_id, status="failed", stage="failed", error=message[-3000:])
        finally:
            shutil.rmtree(temp_root, ignore_errors=True)


class Dispatcher:
    def __init__(self, store: EngineStore, processor: MediaProcessor, workers: int = 2):
        self.store = store
        self.processor = processor
        self.workers = max(1, min(workers, 4))
        self.stop_event = threading.Event()
        self.threads: list[threading.Thread] = []

    def start(self):
        for index in range(self.workers):
            thread = threading.Thread(target=self._run, name=f"y2y2-worker-{index+1}", daemon=True)
            thread.start()
            self.threads.append(thread)

    def _run(self):
        while not self.stop_event.is_set():
            job = self.store.next_queued()
            if not job:
                self.stop_event.wait(0.6)
                continue
            self.processor.process(job)


class PairLimiter:
    def __init__(self):
        self._lock = threading.Lock()
        self._events: dict[str, list[float]] = {}

    def allow(self, key: str) -> bool:
        now = time.time()
        with self._lock:
            events = [t for t in self._events.get(key, []) if now - t < 60]
            if len(events) >= 8:
                self._events[key] = events
                return False
            events.append(now)
            self._events[key] = events
            return True


class EngineApp:
    def __init__(self):
        self.store = EngineStore(app_data_dir())
        self.processor = MediaProcessor(self.store, downloads_dir())
        self.dispatcher = Dispatcher(self.store, self.processor, workers=int(os.getenv("Y2Y2_MAX_WORKERS", "2")))
        self.pair_limiter = PairLimiter()
        self.origins = allowed_origins()
        self.dispatcher.start()

    def is_origin_allowed(self, origin: str | None) -> bool:
        if not origin:
            return False
        value = origin.rstrip("/")
        if value in self.origins:
            return True
        return bool(re.fullmatch(r"https://y2-y2-[a-z0-9-]+-wondaes-projects-fe5c826b\.vercel\.app", value))

    def is_authorized(self, header: str | None) -> bool:
        if not header or not header.startswith("Bearer "):
            return False
        return secrets.compare_digest(header[7:], self.store.config.token)


APP = EngineApp()


class Handler(BaseHTTPRequestHandler):
    server_version = "Y2Y2Engine/0.3"

    def log_message(self, fmt, *args):
        if os.getenv("Y2Y2_DEBUG"):
            super().log_message(fmt, *args)

    def _origin(self) -> str | None:
        return self.headers.get("Origin")

    def _cors(self):
        origin = self._origin()
        if APP.is_origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Max-Age", "600")

    def _json(self, status: int, payload: Any):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _html(self, status: int, body: str):
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if length < 0 or length > MAX_BODY:
            raise ValueError("Request body too large")
        if not length:
            return {}
        raw = self.rfile.read(length)
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("JSON object required")
        return data

    def _require_origin(self) -> bool:
        if APP.is_origin_allowed(self._origin()):
            return True
        self._json(HTTPStatus.FORBIDDEN, {"error": "Origin not allowed"})
        return False

    def _require_auth(self) -> bool:
        if not self._require_origin():
            return False
        if APP.is_authorized(self.headers.get("Authorization")):
            return True
        self._json(HTTPStatus.UNAUTHORIZED, {"error": "Engine pairing required", "code": "PAIRING_REQUIRED"})
        return False

    def do_OPTIONS(self):
        if not self._require_origin():
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path == "/":
            code = html.escape(APP.store.config.pair_code)
            self._html(200, f"""<!doctype html><html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>
<style>body{{font-family:system-ui;background:#0b0b0d;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}}main{{width:min(520px,calc(100% - 32px));padding:28px;border:1px solid #303036;border-radius:22px;background:#121216}}h1{{margin:0 0 8px}}p{{color:#aaa}}.code{{font-size:42px;letter-spacing:.2em;font-weight:800;margin:24px 0}}a{{display:inline-block;padding:12px 16px;border-radius:12px;background:#f5f5f6;color:#111;text-decoration:none;font-weight:800}}</style>
<main><h1>Y2Y2 Engine</h1><p>Windows Engine · protocol v{PROTOCOL_VERSION}</p><div class=code>{code}</div><p>Y2Y2 웹의 엔진 연결 칸에 이 6자리 코드를 입력하세요. 코드는 Engine을 다시 시작하면 바뀝니다.</p><a href='https://y2-y2.vercel.app'>Y2Y2 열기</a></main></html>""")
            return
        if path == "/v1/health":
            if not self._require_origin():
                return
            active = sum(1 for j in APP.store.list_jobs(100) if j["status"] in {"queued", "processing"})
            self._json(200, {
                "ok": True,
                "engineVersion": APP_VERSION,
                "protocolVersion": PROTOCOL_VERSION,
                "platform": "windows",
                "engineName": os.getenv("COMPUTERNAME") or "This PC",
                "activeJobs": active,
                "outputDirectory": str(downloads_dir()),
            })
            return
        if path == "/v1/auth-check":
            if not self._require_auth():
                return
            self._json(200, {"ok": True})
            return
        if path == "/v1/jobs":
            if not self._require_auth():
                return
            self._json(200, {"items": APP.store.list_jobs(50)})
            return
        match = re.fullmatch(r"/v1/jobs/([a-f0-9]{24})", path)
        if match:
            if not self._require_auth():
                return
            job = APP.store.get_job(match.group(1))
            if not job:
                self._json(404, {"error": "Job not found"})
            else:
                self._json(200, job)
            return
        self._json(404, {"error": "Not found"})

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            if path == "/v1/pair":
                if not self._require_origin():
                    return
                key = self.client_address[0] + ":" + (self._origin() or "")
                if not APP.pair_limiter.allow(key):
                    self._json(429, {"error": "Too many pairing attempts"})
                    return
                data = self._body()
                if not secrets.compare_digest(str(data.get("code") or ""), APP.store.config.pair_code):
                    self._json(403, {"error": "Pairing code is incorrect"})
                    return
                token = APP.store.config.token
                APP.store.rotate_pair_code()
                self._json(200, {"token": token, "protocolVersion": PROTOCOL_VERSION})
                return
            if path == "/v1/inspect":
                if not self._require_auth():
                    return
                result = APP.processor.inspect(self._body().get("url", ""))
                self._json(200, result)
                return
            if path == "/v1/jobs":
                if not self._require_auth():
                    return
                job = APP.store.create_job(self._body())
                self._json(201, job)
                return
            if path == "/v1/batch":
                if not self._require_auth():
                    return
                data = self._body()
                items = data.get("items")
                if not isinstance(items, list) or not 1 <= len(items) <= 100:
                    raise ValueError("items must contain 1..100 jobs")
                jobs = [APP.store.create_job(item) for item in items if isinstance(item, dict)]
                if len(jobs) != len(items):
                    raise ValueError("Each batch item must be an object")
                self._json(201, {"items": jobs})
                return
            match = re.fullmatch(r"/v1/jobs/([a-f0-9]{24})/(retry|reveal)", path)
            if match:
                if not self._require_auth():
                    return
                job_id, action = match.groups()
                if action == "retry":
                    job = APP.store.retry(job_id)
                    if not job:
                        self._json(404, {"error": "Job not found"})
                    else:
                        self._json(200, job)
                else:
                    job = APP.store.get_job(job_id)
                    output = Path(job.get("outputPath") or "") if job else None
                    if not output or not output.exists():
                        self._json(404, {"error": "Output file not found"})
                    else:
                        try:
                            subprocess.Popen(["explorer", "/select,", str(output)], close_fds=True)
                        except Exception:
                            os.startfile(str(output.parent))  # type: ignore[attr-defined]
                        self._json(200, {"ok": True})
                return
            self._json(404, {"error": "Not found"})
        except ValueError as error:
            self._json(400, {"error": str(error)})
        except Exception as error:
            self._json(500, {"error": str(error) or error.__class__.__name__})

    def do_DELETE(self):
        path = urllib.parse.urlparse(self.path).path
        match = re.fullmatch(r"/v1/jobs/([a-f0-9]{24})", path)
        if not match:
            self._json(404, {"error": "Not found"})
            return
        if not self._require_auth():
            return
        job = APP.store.cancel(match.group(1))
        if not job:
            self._json(404, {"error": "Job not found"})
        else:
            self._json(200, job)


def run_server(open_ui: bool = True):
    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError:
        if open_ui:
            webbrowser.open(f"http://{HOST}:{PORT}/")
        return 0
    if open_ui:
        threading.Timer(0.6, lambda: webbrowser.open(f"http://{HOST}:{PORT}/")).start()
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(run_server())
