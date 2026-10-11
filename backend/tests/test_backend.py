import copy
import unittest

import httpx
from starlette.testclient import TestClient

from backend.app import CHUNK_SIZE, create_app, parse_range
from backend.formats import MediaError, choices, media_url, video_id


def fixture():
    def fmt(ident, width=0, height=0, video="none", audio="none", size=1024):
        return {"format_id": ident, "width": width, "height": height, "fps": 60,
                "vcodec": video, "acodec": audio, "filesize": size, "protocol": "https",
                "url": "https://rr1.googlevideo.com/videoplayback?clen=" + str(size)}
    return {"formats": [fmt("18", 640, 360, "avc1", "mp4a"),
                        fmt("299", 1920, 1080, "avc1.64002A"), fmt("401", 3840, 2160, "av01"),
                        fmt("140", audio="mp4a.40.2"), fmt("251", audio="opus")]}


class FormatsTest(unittest.TestCase):
    def test_adaptive_1080_and_4k_are_preserved(self):
        available, _ = choices(fixture())
        self.assertEqual(available[0]["key"], "299+140")
        self.assertEqual(available[0]["width"], 1920)
        self.assertTrue(any(c.get("width") == 3840 for c in available))
        self.assertFalse(any(c.get("video") == "18" for c in available))

    def test_no_premux_fallback(self):
        info = fixture()
        info["formats"] = info["formats"][:1]
        with self.assertRaises(MediaError): choices(info)

    def test_source_and_input_restrictions(self):
        self.assertEqual(video_id("https://youtu.be/aqz-KE-bpKQ"), "aqz-KE-bpKQ")
        for url in ["http://127.0.0.1:8000", "https://youtube.com.evil.test/watch?v=aqz-KE-bpKQ", "https://u:p@youtube.com/watch?v=aqz-KE-bpKQ"]:
            with self.assertRaises(MediaError): video_id(url)
        for url in ["https://googlevideo.com.evil.test/a", "http://rr1.googlevideo.com/a", "https://a:b@rr1.googlevideo.com/a", "https://rr1.googlevideo.com:443/a"]:
            self.assertFalse(media_url(url))

    def test_range_is_single_and_bounded(self):
        self.assertEqual(parse_range("bytes=0-1023", 1024), (0, 1023))
        for value in ["bytes=0-", "bytes=-10", "bytes=10-0", "bytes=0-0,1-1", f"bytes=0-{CHUNK_SIZE}", "bytes=0-1024"]:
            with self.assertRaises(MediaError): parse_range(value, 1024)


class RelayTest(unittest.TestCase):
    def app(self, handler, password=""):
        async def resolver(ident):
            available, tracks = choices(fixture())
            return {"videoId": ident, "title": "Fixture", "duration": 10, "choices": available,
                    "tracks": {key: {"url": fmt["url"], "size": 1024, "headers": {}} for key, fmt in tracks.items()}}
        return create_app(resolver=resolver, transport=httpx.MockTransport(handler), password=password)

    def inspect(self, client):
        return client.post("/v2/inspect", json={"url": "aqz-KE-bpKQ"}, headers={"X-Y2Y2": "1"})

    def test_source_url_not_exposed_and_validated_ranges_relay(self):
        def handler(request):
            self.assertEqual(request.headers["range"], "bytes=0-3")
            return httpx.Response(206, headers={"Content-Range": "bytes 0-3/1024", "Content-Length": "4"}, stream=httpx.ByteStream(b"test"))
        with TestClient(self.app(handler)) as client:
            response = self.inspect(client)
            self.assertEqual(response.status_code, 200)
            self.assertNotIn("googlevideo", response.text)
            url = response.json()["tracks"]["299"]["url"]
            result = client.get(url, headers={"Range": "bytes=0-3"})
            self.assertEqual((result.status_code, result.content), (206, b"test"))
            self.assertEqual(result.headers["referrer-policy"], "no-referrer")
            self.assertEqual(client.get(url).status_code, 416)
            self.assertEqual(client.get("/v2/tracks/unknown/299", headers={"Range": "bytes=0-3"}).status_code, 410)

    def test_disallowed_redirect_is_not_fetched(self):
        calls = []
        def handler(request):
            calls.append(str(request.url))
            return httpx.Response(302, headers={"Location": "http://127.0.0.1/secret"}, stream=httpx.ByteStream(b""))
        with TestClient(self.app(handler)) as client:
            url = self.inspect(client).json()["tracks"]["299"]["url"]
            self.assertEqual(client.get(url, headers={"Range": "bytes=0-3"}).status_code, 502)
            self.assertEqual(len(calls), 1)

    def test_ignored_range_and_changed_size_fail(self):
        for status, range_value in [(200, "bytes 0-3/1024"), (206, "bytes 0-3/2048")]:
            def handler(request):
                return httpx.Response(status, headers={"Content-Range": range_value, "Content-Length": "4"}, stream=httpx.ByteStream(b"test"))
            with TestClient(self.app(handler)) as client:
                url = self.inspect(client).json()["tracks"]["299"]["url"]
                self.assertEqual(client.get(url, headers={"Range": "bytes=0-3"}).status_code, 502)

    def test_password_optional_and_cross_site_rejected(self):
        with TestClient(self.app(lambda _: httpx.Response(500), password="example-private-password")) as client:
            self.assertEqual(self.inspect(client).status_code, 401)
            result = client.post("/v2/login", json={"password": "example-private-password"}, headers={"X-Y2Y2": "1"})
            self.assertEqual(result.status_code, 200)
            self.assertEqual(self.inspect(client).status_code, 200)
        with TestClient(self.app(lambda _: httpx.Response(500))) as client:
            self.assertEqual(self.inspect(client).status_code, 200)
            self.assertEqual(client.post("/v2/inspect", json={"url": "aqz-KE-bpKQ"}, headers={"X-Y2Y2": "1", "Origin": "https://evil.test"}).status_code, 403)


if __name__ == "__main__":
    unittest.main()
