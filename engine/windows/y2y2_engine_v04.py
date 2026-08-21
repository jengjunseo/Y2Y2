from __future__ import annotations

import json
import urllib.parse
from http import HTTPStatus

import y2y2_engine as base
from relay_agent import RelayAgent

APP_VERSION = "0.4.0"
RELAY = RelayAgent(base.APP, base.app_data_dir())


class V04Handler(base.Handler):
    server_version = "Y2Y2Engine/0.4"

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/v1/relay/status":
            if not self._require_auth():
                return
            self._json(HTTPStatus.OK, {
                "registered": RELAY.registered,
                "connected": RELAY.registered and RELAY.last_error is None,
                "lastError": RELAY.last_error,
            })
            return
        super().do_GET()

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/v1/relay/register":
            if not self._require_auth():
                return
            try:
                payload = self._body()
                result = RELAY.register(str(payload.get("ticket") or ""))
                self._json(HTTPStatus.CREATED, result)
            except ValueError as error:
                self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            except Exception as error:
                self._json(HTTPStatus.BAD_GATEWAY, {"error": str(error) or error.__class__.__name__})
            return
        super().do_POST()


base.APP_VERSION = APP_VERSION
base.Handler = V04Handler
RELAY.start()

if __name__ == "__main__":
    raise SystemExit(base.run_server())
