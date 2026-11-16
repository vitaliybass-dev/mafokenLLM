import base64
import http.client
import io
import json
from http.server import ThreadingHTTPServer
from threading import Thread
import unittest

from iphone import Companion, PhoneHandler


class IPhoneTests(unittest.TestCase):
    origin = "http://mac.example.ts.net:8780"
    login = "owner@example.test"

    def setUp(self):
        self.state = Companion(lambda: ["test-local"], lambda *args, **kwargs: io.BytesIO(
            b'{"message":{"content":"fixture reply"}}\n{"done":true}\n'), "test-local"
        )
        self.handler = ThreadingHTTPServer(("127.0.0.1", 0), PhoneHandler)
        self.handler.companion = self.state
        thread = Thread(target=self.handler.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.handler.server_close)
        self.addCleanup(self.handler.shutdown)

    def call(self, path, body=None, token=None, login="owner@example.test", origin=origin):
        headers = {"Host": self.origin.split("://")[1], "Tailscale-User-Login": login}
        if token:
            headers["Authorization"] = "Bearer " + token
        if body is not None:
            headers["Content-Type"] = "application/json"
            headers["Origin"] = origin
        client = http.client.HTTPConnection("127.0.0.1", self.handler.server_port, timeout=4)
        try:
            client.request("GET" if body is None else "POST", path,
                           None if body is None else json.dumps(body), headers)
            response = client.getresponse()
            return response.status, response.read()
        finally:
            client.close()

    def start(self):
        return self.state.manage({"action": "start", "origin": self.origin, "login": self.login})["code"]

    def pair(self, code):
        status, body = self.call("/api/pair", {"code": code})
        self.assertEqual(status, 200)
        return json.loads(body)["token"]

    def test_access_requires_owner_and_once_only_pairing_then_revokes(self):
        self.assertEqual(self.call("/")[0], 403)
        code = self.start()
        self.assertEqual(self.call("/", login="other@example.test")[0], 403)
        self.assertEqual(self.call("/api/models")[0], 401)
        self.assertEqual(self.call("/api/pair", {"code": code}, origin="http://evil.example")[0], 403)
        token = self.pair(code)
        self.assertEqual(self.call("/api/pair", {"code": code})[0], 401)
        self.assertEqual(self.call("/api/models", token=token)[0], 200)
        self.assertEqual(self.call("/api/account", token=token)[0], 404)
        self.assertEqual(self.call("/api/logout", {}, token)[0], 200)
        self.assertEqual(self.call("/api/models", token=token)[0], 401)
        self.state.manage({"action": "stop"})
        self.assertEqual(self.call("/api/models", token=token)[0], 403)

    def test_chat_stream_and_mac_approval_for_screenshot(self):
        token = self.pair(self.start())
        request = {"model": "test-local", "messages": [{"role": "user", "content": "local question"}]}
        status, stream = self.call("/api/chat", request, token)
        self.assertEqual((status, [json.loads(line) for line in stream.splitlines()]),
                         (200, [{"delta": "fixture reply"}, {"done": True}]))
        self.assertEqual(self.call("/api/command", {"kind": "unsupported"}, token)[0], 400)
        status, payload = self.call("/api/command", {"kind": "screenshot"}, token)
        self.assertEqual(status, 202)
        identifier = json.loads(payload)["id"]
        self.assertEqual(self.call("/api/screenshot", token=token)[0], 404)
        self.assertEqual(self.call("/api/command", {"kind": "mute"}, token)[0], 409)
        self.assertEqual(self.state.manage({"action": "status"})["command"]["id"], identifier)
        image = b"\xff\xd8fixture"
        self.state.manage({"action": "result", "id": identifier, "message": "approved", "jpeg": base64.b64encode(image).decode()})
        self.assertEqual(self.call("/api/screenshot", token=token), (200, image))
        self.assertEqual(self.call("/api/screenshot", token="wrong")[0], 401)
        self.start()
        self.assertEqual(self.call("/api/screenshot", token=token)[0], 401)
