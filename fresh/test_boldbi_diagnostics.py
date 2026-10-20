"""Protect diagnostic credentials and verify upstream handshake reporting."""
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("diagnostic", Path(__file__).with_name("Read-BoldBIDiagnostics.py"))
diagnostic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostic)


class DiagnosticTests(unittest.TestCase):
    def configuration(self, host="worker.example.workers.dev", expected_token=None):
        token = "test-only-tunnel-secret-at-least-32-characters"
        data = ("UNRELATED_SECRET=never-export-this\0POC_TUNNEL_TOKEN=" + token + "\0POC_TUNNEL_URL=https://" + host + "/_poc/postgres/tunnel\0").encode()
        expected = hashlib.sha256((expected_token or token).encode()).hexdigest()
        with patch("builtins.open", return_value=io.BytesIO(data)), patch.dict(os.environ, {"POC_EXPECTED_TOKEN_SHA256": expected, "POC_EXPECTED_HOST": "worker.example.workers.dev"}):
            result = diagnostic.proxy_configuration()
        self.assertNotIn(token, json.dumps(result[0]))
        self.assertNotIn(expected, json.dumps(result[0]))
        self.assertNotIn("never-export-this", json.dumps(result[0]))
        return result

    def test_compares_runtime_token_without_disclosing_environment(self):
        details, endpoint, token = self.configuration()
        self.assertTrue(details["proxyTokenMatchesWorker"])
        self.assertEqual(endpoint.hostname, "worker.example.workers.dev")
        details, _, _ = self.configuration(expected_token="different-current-worker-token")
        self.assertFalse(details["proxyTokenMatchesWorker"])

    def test_refuses_to_send_credentials_to_an_unexpected_destination(self):
        details, endpoint, _ = self.configuration(host="unexpected.example")
        self.assertFalse(details["tunnelEndpointAllowed"])
        self.assertIsNone(endpoint)

    def test_validates_websocket_upgrade_and_never_exports_auth_header(self):
        key = base64.b64encode(b"x" * 16).decode()
        accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        connection = Mock()
        connection.getresponse.return_value.status = 101
        connection.getresponse.return_value.getheader.return_value = accept
        endpoint = diagnostic.urlsplit("https://worker.example.workers.dev/_poc/postgres/tunnel")
        with patch.object(diagnostic.http.client, "HTTPSConnection", return_value=connection), patch.object(diagnostic.os, "urandom", return_value=b"x" * 16):
            result = diagnostic.probe_upstream(endpoint, "test-secret", upgrade=True)
        self.assertEqual(result, {"directWebSocketHttpStatus": 101, "directWebSocketUpgradeValid": True})
        self.assertNotIn("test-secret", json.dumps(result))
        connection.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
