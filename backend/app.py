"""Small independent API: resolve tracks and relay bounded ranges, never store media."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sys
import time
from urllib.parse import urljoin, urlsplit

import httpx
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, StreamingResponse
from starlette.routing import Route
from starlette.staticfiles import StaticFiles

from .formats import MediaError, media_url, video_id

ROOT = Path(__file__).resolve().parent
CHUNK_SIZE = 4 * 1024 * 1024


class ResponseHeaders:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        async def secured(message):
            if message["type"] == "http.response.start":
                headers = [(k, v) for k, v in message.get("headers", []) if k.lower() != b"cache-control"]
                headers.extend([(b"cache-control", b"no-store"), (b"referrer-policy", b"no-referrer"),
                                (b"x-content-type-options", b"nosniff"),
                                (b"content-security-policy", b"default-src 'self'; worker-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")])
                message["headers"] = headers
            await send(message)
        await self.app(scope, receive, secured)


async def extract_process(ident):
    process = await asyncio.create_subprocess_exec(sys.executable, "-m", "backend.extractor", ident,
                                                  stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    try:
        stdout, _ = await asyncio.wait_for(process.communicate(), timeout=60)
        if len(stdout) > 2 * 1024 * 1024:
            raise ValueError()
        result = json.loads(stdout)
    except asyncio.TimeoutError:
        raise MediaError("SOURCE_TIMEOUT", "원본 분석 시간이 초과됐습니다. 잠시 후 다시 시도해 주세요.", 504) from None
    except (ValueError, KeyError):
        raise MediaError("EXTRACTOR_FAILURE", "서버 분석기를 확인해 주세요.", 503) from None
    finally:
        if process.returncode is None:
            process.kill()
        await process.wait()
    if not result.get("ok"):
        raise MediaError(result.get("error", "SOURCE_UNAVAILABLE"), result.get("message", "원본에 연결하지 못했습니다."), result.get("status", 502))
    return result["data"]


def parse_range(value, size):
    match = re.fullmatch(r"bytes=(\d+)-(\d+)", value or "")
    if not match:
        raise MediaError("BAD_RANGE", "하나의 바이트 구간을 요청해야 합니다.", 416)
    start, end = map(int, match.groups())
    if start > end or end >= size or end - start + 1 > CHUNK_SIZE:
        raise MediaError("BAD_RANGE", "요청한 파일 구간을 확인해 주세요.", 416)
    return start, end


class Limit:
    def __init__(self, count):
        self.count, self.used = count, 0

    def enter(self):
        if self.used >= self.count:
            raise MediaError("BUSY", "다른 전송을 처리하고 있습니다. 잠시 후 다시 시도해 주세요.", 429)
        self.used += 1

    def leave(self):
        self.used -= 1


class ActiveRangeResponse(StreamingResponse):
    """Close the upstream and release its slot even when a browser disconnects."""
    def __init__(self, upstream, limiter, **kwargs):
        self.upstream, self.limiter = upstream, limiter
        super().__init__(upstream.aiter_raw(64 * 1024), **kwargs)

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            await self.upstream.aclose()
            self.limiter.leave()


def create_app(resolver=None, transport=None, password=None):
    resolver = resolver or extract_process
    password = os.environ.get("Y2Y2_WEB_PASSWORD", "") if password is None else password
    manifests, sessions, attempts = {}, {}, {}
    inspect_slots, relay_slots = Limit(1), Limit(4)

    def prune():
        now = time.time()
        for cache in (manifests, sessions, attempts):
            for key, value in list(cache.items()):
                if value["expires"] <= now:
                    del cache[key]

    def check_post(request):
        expected = os.environ.get("Y2Y2_PUBLIC_ORIGIN", "").rstrip("/") or str(request.base_url).rstrip("/")
        if (request.headers.get("x-y2y2") != "1"
                or request.headers.get("origin", expected) != expected
                or request.headers.get("sec-fetch-site") == "cross-site"):
            raise MediaError("ORIGIN", "이 서비스의 웹페이지에서 요청해 주세요.", 403)

    def authenticated(request):
        if not password:
            return True
        record = sessions.get(request.cookies.get("y2y2-session", ""))
        return bool(record and record["expires"] > time.time())

    async def body(request):
        if request.headers.get("content-type", "").split(";")[0] != "application/json":
            raise MediaError("BAD_BODY", "JSON 요청이 필요합니다.", 400)
        data = bytearray()
        async for chunk in request.stream():
            data.extend(chunk)
            if len(data) > 4096:
                raise MediaError("BAD_BODY", "요청이 너무 큽니다.", 413)
        try:
            value = json.loads(data)
            if isinstance(value, dict):
                return value
        except ValueError:
            pass
        raise MediaError("BAD_BODY", "요청 내용을 확인해 주세요.", 400)

    @asynccontextmanager
    async def lifespan(app):
        async with httpx.AsyncClient(transport=transport, timeout=httpx.Timeout(25, connect=10),
                                     follow_redirects=False, trust_env=False) as client:
            app.state.client = client
            yield

    async def health(request):
        return JSONResponse({"ok": True, "mode": "device-storage", "mediaStoredOnServer": False,
                             "passwordRequired": bool(password), "authenticated": authenticated(request),
                             "chunkSize": CHUNK_SIZE})

    async def login(request):
        check_post(request)
        prune()
        if not password:
            return JSONResponse({"ok": True})
        key = request.client.host if request.client else "unknown"
        record = attempts.setdefault(key, {"count": 0, "expires": time.time() + 300})
        if record["count"] >= 10 or len(attempts) > 4096:
            raise MediaError("LOGIN_LIMIT", "잠시 후 다시 접속해 주세요.", 429)
        record["count"] += 1
        value = (await body(request)).get("password", "")
        if not secrets.compare_digest(hashlib.sha256(str(value).encode()).digest(), hashlib.sha256(password.encode()).digest()):
            raise MediaError("PASSWORD", "비밀번호를 확인해 주세요.", 401)
        if len(sessions) >= 128:
            raise MediaError("BUSY", "접속 수가 많습니다. 잠시 후 다시 시도해 주세요.", 429)
        token = secrets.token_urlsafe(32)
        sessions[token] = {"expires": time.time() + 86400}
        response = JSONResponse({"ok": True})
        response.set_cookie("y2y2-session", token, max_age=86400, httponly=True,
                            secure=request.url.scheme == "https", samesite="strict")
        return response

    async def inspect(request):
        check_post(request)
        prune()
        if not authenticated(request):
            raise MediaError("LOGIN", "먼저 접속해 주세요.", 401)
        if len(manifests) >= 16:
            raise MediaError("BUSY", "분석된 작업이 많습니다. 기존 작업을 완료한 뒤 다시 시도해 주세요.", 429)
        ident = video_id((await body(request)).get("url", ""))
        inspect_slots.enter()
        try:
            data = await resolver(ident)
        finally:
            inspect_slots.leave()
        # Keep source URLs only in RAM, with a shorter lifetime than their signatures.
        expiry = time.time() + 3600
        for track in data["tracks"].values():
            from urllib.parse import parse_qs
            source_expiry = parse_qs(urlsplit(track["url"]).query).get("expire", [None])[0]
            if source_expiry and source_expiry.isdigit():
                expiry = min(expiry, int(source_expiry) - 60)
        if expiry <= time.time():
            raise MediaError("EXPIRED", "원본 링크가 만료됐습니다. 다시 분석해 주세요.", 410)
        token = secrets.token_urlsafe(32)
        manifests[token] = {"data": data, "expires": expiry}
        used = {c[role] for c in data["choices"] for role in ("video", "audio") if role in c}
        return JSONResponse({"videoId": data["videoId"], "title": data["title"], "duration": data["duration"],
                             "choices": data["choices"], "id": token, "expires": expiry,
                             "tracks": {key: {"size": data["tracks"][key]["size"],
                                              "url": "/v2/tracks/" + token + "/" + key} for key in used}})

    async def relay(request):
        prune()
        token, key = request.path_params["token"], request.path_params["track"]
        manifest = manifests.get(token)
        if not manifest:
            raise MediaError("EXPIRED", "전송 링크가 만료됐거나 서버가 재시작됐습니다. 다시 분석해 주세요.", 410)
        data = manifest["data"]
        allowed = {c[role] for c in data["choices"] for role in ("video", "audio") if role in c}
        track = data["tracks"].get(key) if key in allowed else None
        if not track:
            raise MediaError("NO_TRACK", "선택한 트랙이 없습니다.", 404)
        start, end = parse_range(request.headers.get("range"), track["size"])
        headers = {**track["headers"], "Range": f"bytes={start}-{end}", "Accept-Encoding": "identity"}
        relay_slots.enter()
        upstream = None
        try:
            url = track["url"]
            for _ in range(4):
                if not media_url(url):
                    raise MediaError("SOURCE_HOST", "허용되지 않은 원본 저장소입니다.", 502)
                upstream = await request.app.state.client.send(request.app.state.client.build_request("GET", url, headers=headers), stream=True)
                if upstream.status_code not in {301, 302, 303, 307, 308}:
                    break
                target = urljoin(url, upstream.headers.get("location", ""))
                await upstream.aclose()
                url = target
            expected = f"bytes {start}-{end}/{track['size']}"
            if (upstream.status_code != 206 or upstream.headers.get("content-range") != expected
                    or upstream.headers.get("content-encoding", "identity") != "identity"
                    or int(upstream.headers.get("content-length", "0")) != end - start + 1):
                raise MediaError("SOURCE_RANGE", "원본의 분할 전송이 거절됐거나 파일이 달라졌습니다. 다시 분석해 주세요.", 502)
            track["url"] = url
            return ActiveRangeResponse(upstream, relay_slots, status_code=206, media_type="application/octet-stream",
                                       headers={"Content-Range": expected, "Content-Length": str(end - start + 1),
                                                "Accept-Ranges": "bytes", "Cache-Control": "no-store"})
        except BaseException as exc:
            if upstream:
                await upstream.aclose()
            relay_slots.leave()
            if not isinstance(exc, Exception):
                raise
            if isinstance(exc, MediaError):
                raise
            raise MediaError("SOURCE_CONNECTION", "원본 연결이 끊어졌습니다. 잠시 후 이어받기를 시도해 주세요.", 502) from None

    async def index(request):
        return FileResponse(ROOT / "public" / "index.html", headers={"Cache-Control": "no-store"})

    async def error(request, exc):
        return JSONResponse({"error": exc.code, "message": exc.message}, status_code=exc.status,
                            headers={"Cache-Control": "no-store", **({"Retry-After": "3"} if exc.status == 429 else {})})

    app = Starlette(routes=[Route("/health", health), Route("/v2/login", login, methods=["POST"]),
                            Route("/v2/inspect", inspect, methods=["POST"]),
                            Route("/v2/tracks/{token}/{track}", relay), Route("/", index)],
                    lifespan=lifespan, exception_handlers={MediaError: error})
    app.mount("/assets", StaticFiles(directory=ROOT / "public", check_dir=False))
    app.add_middleware(ResponseHeaders)
    return app


app = create_app()
