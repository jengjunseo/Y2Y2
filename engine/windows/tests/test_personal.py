"""Real HTTP boundary tests; no upstream network or browser credentials."""
import http.client
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer

tmp = tempfile.TemporaryDirectory(prefix="y2y2-personal-test-")
os.environ["Y2Y2_APP_DATA_DIR"] = str(Path(tmp.name) / "state")
os.environ["Y2Y2_DOWNLOAD_DIR"] = str(Path(tmp.name) / "downloads")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import y2y2_personal as personal


class PersonalHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), personal.PersonalHandler)
        cls.port = cls.server.server_port
        personal.AUTHORITY = f"127.0.0.1:{cls.port}"
        personal.ORIGIN = f"http://{personal.AUTHORITY}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        personal.engine.APP.dispatcher.stop_event.set()
        for thread in personal.engine.APP.dispatcher.threads:
            thread.join(timeout=3)

    def request(self, path, headers=None, method="GET", body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request(method, path, body=body, headers=headers or {})
        response = conn.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        conn.close()
        return result

    def test_page_loads_without_leaking_session(self):
        status, headers, body = self.request("/")
        self.assertEqual(status, 200)
        self.assertNotIn(personal.SESSION.encode(), body)
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])

    def test_local_session_and_authorized_jobs(self):
        status, headers, body = self.request("/session", {"X-Y2Y2-Local": "1", "Sec-Fetch-Site": "same-origin"})
        self.assertEqual(status, 200)
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        token = json.loads(body)["token"]
        self.assertEqual(self.request("/v1/jobs", {"Authorization": f"Bearer {token}"})[0], 200)

    def test_unauthenticated_jobs_denied(self):
        self.assertEqual(self.request("/v1/jobs")[0], 401)
        self.assertEqual(self.request("/session")[0], 403)

    def test_dns_rebinding_denied(self):
        self.assertEqual(self.request("/session", {"Host": "attacker.example", "X-Y2Y2-Local": "1"})[0], 403)
        self.assertEqual(self.request("/", {"Host": "attacker.example"})[0], 403)

    def test_cross_origin_and_same_site_ports_denied(self):
        for origin in ["https://evil.example", "https://y2-y2.vercel.app", "http://127.0.0.1:9999"]:
            self.assertEqual(self.request("/session", {"Origin": origin, "X-Y2Y2-Local": "1"})[0], 403)
        for site in ["cross-site", "same-site"]:
            self.assertEqual(self.request("/session", {"Sec-Fetch-Site": site, "X-Y2Y2-Local": "1"})[0], 403)
        self.assertEqual(self.request("/session", method="OPTIONS")[0], 403)

    def test_pair_and_traversal_unavailable(self):
        self.assertEqual(self.request("/v1/pair", method="POST", body="{}")[0], 404)
        self.assertEqual(self.request("/../y2y2_personal.py")[0], 404)

    def test_invalid_job_does_not_enter_queue(self):
        headers = {"Authorization": "Bearer " + personal.SESSION, "Content-Type": "application/json"}
        before = len(personal.engine.APP.store.list_jobs())
        status, _, _ = self.request("/v1/jobs", headers, "POST", json.dumps({"url": "http://127.0.0.1/secret", "mediaType": "mp3", "quality": 192}))
        self.assertEqual(status, 400)
        self.assertEqual(len(personal.engine.APP.store.list_jobs()), before)


if __name__ == "__main__":
    unittest.main()
