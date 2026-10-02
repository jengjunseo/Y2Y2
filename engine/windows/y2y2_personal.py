"""Same-machine web interface. No relay, pairing, cookies or public listener."""
from __future__ import annotations

import json
import os
from pathlib import Path
import secrets
import sys
import threading
import urllib.parse
import webbrowser
from http.server import ThreadingHTTPServer

ROOT = Path(__file__).resolve().parent
os.environ.setdefault("Y2Y2_APP_DATA_DIR", str(ROOT / "personal-data"))
os.environ.setdefault("Y2Y2_DOWNLOAD_DIR", str(ROOT / "downloads"))
os.environ.setdefault("Y2Y2_ENGINE_PORT", "49273")

import y2y2_engine as engine

HOST = "127.0.0.1"
PORT = int(os.environ["Y2Y2_ENGINE_PORT"])
AUTHORITY = f"{HOST}:{PORT}"
ORIGIN = f"http://{AUTHORITY}"
SESSION = secrets.token_urlsafe(32)
ASSETS = ROOT / "personal"


class PersonalHandler(engine.Handler):
    server_version = "Y2Y2Personal/1"

    def _cors(self):
        # Deliberately no CORS: only this server's own page can use this API.
        pass

    def _local(self):
        origin = self.headers.get("Origin")
        fetch_site = self.headers.get("Sec-Fetch-Site")
        return (self.headers.get("Host") == AUTHORITY
                and (origin is None or origin == ORIGIN)
                and fetch_site not in {"cross-site", "same-site"})

    def _require_origin(self):
        if self._local():
            return True
        self._json(403, {"error": "Local page required"})
        return False

    def _require_auth(self):
        if not self._require_origin():
            return False
        token = self.headers.get("Authorization", "")
        if secrets.compare_digest(token, "Bearer " + SESSION):
            return True
        self._json(401, {"error": "페이지를 새로고침해 주세요."})
        return False

    def do_OPTIONS(self):
        self._json(403, {"error": "Cross-origin access disabled"})

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        # A public site may link to the UI, but cannot read its session or API.
        navigation = (self.headers.get("Host") == AUTHORITY
                      and self.headers.get("Sec-Fetch-Mode") == "navigate"
                      and self.headers.get("Sec-Fetch-Dest") == "document")
        if path == "/" and navigation:
            pass
        elif not self._require_origin():
            return
        if path == "/session":
            if self.headers.get("X-Y2Y2-Local") != "1":
                self._json(403, {"error": "Local page required"})
                return
            self._json(200, {"token": SESSION, "outputDirectory": str(engine.downloads_dir()),
                             "version": "personal-2026.09.12"})
            return
        assets = {"/": ("index.html", "text/html; charset=utf-8"),
                  "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                  "/style.css": ("style.css", "text/css; charset=utf-8")}
        if path in assets:
            filename, mime = assets[path]
            content = (ASSETS / filename).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' https://i.ytimg.com https://i9.ytimg.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(content)
            return
        super().do_GET()

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/quit":
            if not self._require_auth():
                return
            if any(j["status"] in {"queued", "processing"} for j in engine.APP.store.list_jobs(100)):
                self._json(409, {"error": "진행 중인 저장이 있습니다. 완료되거나 취소된 뒤 종료해 주세요."})
                return
            self._json(200, {"ok": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        if path == "/v1/pair":
            self._json(404, {"error": "Not available"})
            return
        super().do_POST()


def main():
    try:
        server = ThreadingHTTPServer((HOST, PORT), PersonalHandler)
    except OSError:
        print(f"Port {PORT} is already in use. Close the existing Y2Y2 process or choose another port.")
        return 1
    if "--no-browser" not in sys.argv:
        webbrowser.open(ORIGIN)
    print(f"Y2Y2 Personal: {ORIGIN}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        engine.APP.dispatcher.stop_event.set()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
