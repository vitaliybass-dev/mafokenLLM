"""Regression checks for the subscription boundary, with no provider requests."""
from contextlib import contextmanager
from http.client import HTTPConnection
import io
import json
import threading
import unittest
from unittest.mock import patch

import server


class LoopbackTestCase(unittest.TestCase):
    def setUp(self):
        self.http = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.http.native_token = b"fixture-session"
        runner = threading.Thread(target=self.http.serve_forever, daemon=True)
        runner.start()
        self.addCleanup(self.http.server_close)
        self.addCleanup(self.http.shutdown)
        self.origin = f"http://127.0.0.1:{self.http.server_port}"

    def call(self, path, data=None, token=None):
        headers = {}
        if data is not None:
            headers.update({"Origin": self.origin, "Content-Type": "application/json"})
        if token is not None:
            headers["X-LocalChat-Native"] = token
        conn = HTTPConnection("127.0.0.1", self.http.server_port, timeout=4)
        try:
            conn.request("GET" if data is None else "POST", path,
                         None if data is None else json.dumps(data), headers)
            with conn.getresponse() as response:
                return response.status, [json.loads(line) for line in response]
        finally:
            conn.close()


class NativeSessionTest(LoopbackTestCase):
    def test_non_native_cannot_use_oauth_or_subscription(self):
        with patch.object(server.account_bridge, "status") as status, patch.object(server.account_bridge, "send") as send:
            for path, data in [
                ("/api/native-health", None), ("/api/account", None), ("/api/account/begin", {}),
                ("/api/account/cancel", {}), ("/api/account/disconnect", {}),
                ("/api/chat", {"mode":"plan", "allowCloud":True}),
            ]:
                for token in [None, "wrong-session"]:
                    with self.subTest(path=path, token=token):
                        self.assertEqual(self.call(path, data, token)[0], 403)
            status.assert_not_called()
            send.assert_not_called()

    def test_native_can_use_status_and_stream_with_chat_consent(self):
        token = self.http.native_token.decode()
        with patch.object(server.account_bridge, "status", return_value={"sharing":True}):
            self.assertEqual(self.call("/api/account", token=token), (200,[{"sharing":True}]))

        @contextmanager
        def subscription(method, path, payload, timeout):
            self.assertEqual(payload["messages"], [{"role":"user","content":"fixture"}])
            yield io.BytesIO(b'{"delta":"local test fixture"}\n{"done":true}\n')

        with patch.object(server.account_bridge, "send", side_effect=subscription) as send:
            chat = {"mode":"plan", "model":"fixture", "messages":[{"role":"user","content":"fixture"}]}
            self.assertIn("error",self.call("/api/chat",chat,token)[1][0])
            send.assert_not_called()
            chat["allowCloud"] = True
            self.assertEqual(self.call("/api/chat",chat,token)[1][-1],{"done":True})

    def test_browser_mode_serves_local_features_without_subscription(self):
        self.http.native_token = b""
        self.assertEqual(self.call("/api/account")[0], 403)
        with patch.object(server, "models", return_value=["fixture"]):
            self.assertEqual(self.call("/api/models")[1][0]["models"], ["fixture"])


if __name__ == "__main__":
    unittest.main()
