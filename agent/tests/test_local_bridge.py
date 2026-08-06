"""Tests for the loopback bridge the server-served UI calls.

This is the piece that turns "the UI is a web page" from an idea into an attack
surface: an HTTP server on 127.0.0.1 is reachable by every page the customer's
browser has open. So the tests that matter are the ones that prove a HOSTILE
page cannot use it — wrong origin, missing token, wrong token, state change over
GET. The happy path gets one test; the refusals get the rest.

Run: python -m unittest discover -s agent/tests
"""

import json
import os
import sys
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from local_bridge import LocalBridge, parse_bridge_fragment  # noqa: E402

ORIGIN = "https://app.example.test"


class BridgeTestCase(unittest.TestCase):

    def setUp(self):
        self.calls = []

        def status(body):
            self.calls.append(("status", body))
            return {"state": "idle"}

        def boom(body):
            raise RuntimeError("tally is not running")

        self.bridge = LocalBridge({"status": status, "boom": boom},
                                  allowed_origin=ORIGIN)
        self.port = self.bridge.start()
        self.addCleanup(self.bridge.stop)

    def call(self, path, *, token=None, origin=ORIGIN, method="POST", body=None):
        url = f"http://127.0.0.1:{self.port}/{path}"
        data = json.dumps(body or {}).encode() if method == "POST" else None
        req = urllib.request.Request(url, data=data, method=method)
        if origin is not None:
            req.add_header("Origin", origin)
        if token is not None:
            req.add_header("Authorization", "Bearer " + token)
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                raw = resp.read().decode() or "{}"
                return resp.status, json.loads(raw)
        except urllib.error.HTTPError as exc:
            # HTTPError is itself a response object; leaving it unclosed leaks a
            # socket and fills the test output with ResourceWarnings.
            with exc:
                raw = exc.read().decode() or "{}"
            return exc.code, json.loads(raw)


class HappyPathTests(BridgeTestCase):

    def test_a_correct_call_reaches_the_handler(self):
        status, payload = self.call("status", token=self.bridge.token,
                                    body={"x": 1})
        self.assertEqual(status, 200)
        self.assertEqual(payload["data"], {"state": "idle"})
        self.assertEqual(self.calls[0][1], {"x": 1})

    def test_ping_needs_no_token(self):
        # A liveness probe only. It reveals nothing and changes nothing, so the
        # shell can use it to wait for the port to come up.
        status, payload = self.call("ping", method="GET", origin=None)
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])


class RefusalTests(BridgeTestCase):

    def test_a_call_with_no_token_is_refused(self):
        status, _ = self.call("status")
        self.assertEqual(status, 401)
        self.assertEqual(self.calls, [], "handler ran without a token")

    def test_a_call_with_the_wrong_token_is_refused(self):
        status, _ = self.call("status", token="not-the-token")
        self.assertEqual(status, 401)
        self.assertEqual(self.calls, [])

    def test_a_call_from_another_origin_is_refused_even_with_the_token(self):
        # The exact scenario this design has to survive: the customer opens a
        # hostile page while the agent is running. It cannot know the token,
        # but the origin check refuses it before the token is even considered.
        status, _ = self.call("status", token=self.bridge.token,
                              origin="https://evil.example")
        self.assertEqual(status, 403)
        self.assertEqual(self.calls, [])

    def test_a_lookalike_origin_is_refused(self):
        # A prefix or substring match would let this through.
        status, _ = self.call("status", token=self.bridge.token,
                              origin=ORIGIN + ".evil.example")
        self.assertEqual(status, 403)

    def test_state_changing_paths_are_not_reachable_by_GET(self):
        # Stops <img src="http://127.0.0.1:PORT/sync-now"> from working.
        status, _ = self.call("status", method="GET", origin=None)
        self.assertEqual(status, 404)
        self.assertEqual(self.calls, [])

    def test_an_unknown_path_is_a_404_not_a_crash(self):
        status, _ = self.call("no-such-thing", token=self.bridge.token)
        self.assertEqual(status, 404)

    def test_malformed_json_is_rejected_cleanly(self):
        url = f"http://127.0.0.1:{self.port}/status"
        req = urllib.request.Request(url, data=b"{not json", method="POST")
        req.add_header("Origin", ORIGIN)
        req.add_header("Authorization", "Bearer " + self.bridge.token)
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                code = resp.status
        except urllib.error.HTTPError as exc:
            with exc:
                code = exc.code
        self.assertEqual(code, 400)
        self.assertEqual(self.calls, [])

    def test_a_handler_error_becomes_a_500_with_its_message(self):
        # The UI must be able to say WHY, not just fail silently.
        status, payload = self.call("boom", token=self.bridge.token)
        self.assertEqual(status, 500)
        self.assertIn("tally is not running", payload["error"])


class CorsTests(BridgeTestCase):

    def test_the_reply_is_readable_only_by_our_own_origin(self):
        url = f"http://127.0.0.1:{self.port}/status"
        req = urllib.request.Request(url, data=b"{}", method="POST")
        req.add_header("Origin", ORIGIN)
        req.add_header("Authorization", "Bearer " + self.bridge.token)
        with urllib.request.urlopen(req, timeout=5) as resp:
            allow = resp.headers.get("Access-Control-Allow-Origin")
            self.assertEqual(allow, ORIGIN)
            self.assertNotEqual(allow, "*")
            # Machine state must not sit in any cache.
            self.assertEqual(resp.headers.get("Cache-Control"), "no-store")

    def test_preflight_from_a_foreign_origin_is_refused(self):
        status, _ = self.call("status", method="OPTIONS", origin="https://evil.example")
        self.assertEqual(status, 403)


class TokenAndUrlTests(unittest.TestCase):

    def test_each_run_gets_a_different_token(self):
        a = LocalBridge({}, ORIGIN)
        b = LocalBridge({}, ORIGIN)
        self.assertNotEqual(a.token, b.token)
        self.assertGreaterEqual(len(a.token), 32)

    def test_the_token_travels_in_the_fragment_not_the_query(self):
        # A query string reaches the server, its access log and any Referer
        # header. A fragment does not leave the browser.
        bridge = LocalBridge({}, ORIGIN)
        bridge.port = 51234
        url = bridge.ui_url("https://app.example.test/agent/")
        self.assertIn("#", url)
        head, fragment = url.split("#", 1)
        self.assertNotIn("token", head)
        self.assertNotIn("?", head)
        parsed = parse_bridge_fragment(fragment)
        self.assertEqual(parsed["port"], "51234")
        self.assertEqual(parsed["token"], bridge.token)


if __name__ == "__main__":
    unittest.main()
