"""Exercise cloud discovery and fallback without external services."""
import io
import json
from unittest.mock import patch
from urllib.error import HTTPError

from test_native_session import LoopbackTestCase
import server


class CatalogAndFallbackTest(LoopbackTestCase):
    def test_gemini_catalog_paginates_and_filters_non_chat(self):
        def upstream(url, headers, timeout):
            self.assertEqual(headers["x-goog-api-key"], "fixture-key")
            self.assertNotIn("Authorization", headers)
            self.assertNotIn("fixture-key", url)
            if url.endswith("/v1beta/models"):
                result = {"models": [
                    {"name": "models/gemini-first", "supportedGenerationMethods": ["generateContent"]},
                    {"name": "models/embedding", "supportedGenerationMethods": ["embedContent"]},
                ], "nextPageToken": "next&="}
            else:
                self.assertEqual(url, "https://generativelanguage.googleapis.com/v1beta/models?pageToken=next%26%3D")
                result = {"models": [
                    {"name": "models/gemini-second", "supportedGenerationMethods": ["generateContent"]},
                ]}
            return io.BytesIO(json.dumps(result).encode())

        with patch.object(server, "request", side_effect=upstream) as get:
            status, packets = self.call("/api/cloud-models", {
                "endpoint": "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
                "key": "fixture-key", "kind": "openai",
            })
            self.assertEqual((status, packets), (200, [{"state": "verified", "models": ["gemini-first", "gemini-second"]}]))
            self.assertEqual(get.call_count, 2)

    def test_custom_catalog_keeps_host_and_labels_explicit_region_denial(self):
        url = "https://catalog.example/team/v1/models"
        response = io.BytesIO(b'{"error":{"code":"unsupported_country_region_territory"}}')
        with patch.object(server, "request", side_effect=HTTPError(url, 403, "", {}, response)) as get:
            _, packets = self.call("/api/cloud-models", {
                "endpoint": "https://catalog.example/team/v1/chat/completions",
                "key": "fixture-key", "kind": "openai",
            })
            self.assertEqual(get.call_args.args[0], url)
            self.assertEqual(get.call_args.kwargs["headers"]["Authorization"], "Bearer fixture-key")
            self.assertIn("региона", packets[0]["message"])
            self.assertNotIn("models", packets[0])

    def chat(self, mode):
        return {"mode": mode, "model": "local-fixture", "allowCloud": True, "shareHistory": False,
                "messages": [{"role": "user", "content": "previous local"}, {"role": "assistant", "content": "answer"},
                             {"role": "user", "content": "latest"}],
                "provider": {"model": "cloud-fixture", "kind": "openai", "limitField": "max_tokens",
                             "endpoint": "https://catalog.example/v1/chat/completions"}, "key": "fixture-key"}

    def test_auto_uses_only_local_after_denial_and_explicit_cloud_stays_cloud(self):
        def request(url, body, headers, **options):
            if url.startswith("https://"):
                self.assertEqual(body["messages"][-1]["content"], "latest")
                self.assertEqual(len(body["messages"]), 2)
                raise HTTPError(url, 403, "", {}, None)
            self.assertEqual(url, server.OLLAMA + "/api/chat")
            self.assertEqual(body["model"], "local-fixture")
            self.assertEqual(body["messages"][1]["content"], "previous local")
            self.assertEqual(headers, {})
            return io.BytesIO(b'{"message":{"content":"local"},"done":true,"prompt_eval_count":42,"eval_count":1}\n')

        with patch.object(server, "route", return_value=True), patch.object(server, "models", return_value=["local-fixture"]):
            with patch.object(server, "request", side_effect=request) as upstream:
                _, packets = self.call("/api/chat", self.chat("auto"))
                self.assertEqual([p["model"] for p in packets if "source" in p], ["cloud-fixture", "local-fixture"])
                self.assertTrue(any("fallback" in p for p in packets))
                self.assertEqual(packets[-3:], [{"delta": "local"}, {"usage": {"input": 42, "output": 1}}, {"done": True}])
                self.assertEqual(upstream.call_count, 2)
            with patch.object(server, "request", side_effect=request) as upstream:
                _, packets = self.call("/api/chat", self.chat("cloud"))
                self.assertIn("403", packets[-1]["error"])
                self.assertEqual(upstream.call_count, 1)

    def test_partial_cloud_reply_is_not_mixed_with_local(self):
        stream = io.BytesIO(b'data: {"choices":[{"delta":{"content":"cloud"}}]}\n')
        with patch.object(server, "route", return_value=True), patch.object(server, "models", return_value=["local-fixture"]):
            with patch.object(server, "request", return_value=stream) as upstream:
                _, packets = self.call("/api/chat", self.chat("auto"))
        self.assertIn({"delta": "cloud"}, packets)
        self.assertIn("error", packets[-1])
        self.assertEqual(upstream.call_count, 1)
