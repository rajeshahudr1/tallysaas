"""Tests for POST batch sizing and the release-URL build guard.

TWO FAILURES THAT DO NOT ANNOUNCE THEMSELVES
--------------------------------------------
1. BATCHING BY COUNT ONLY. Vouchers were posted 2000 at a time regardless of
   size. A cash receipt is a few hundred bytes; a sales invoice with 60 stock
   lines, batch/godown allocations, bill references and GST details is tens of
   KB. The cloud rejects a body over its limit, so for a book full of the second
   kind the window fails, the watermark is deliberately NOT advanced, the same
   window is retried next cycle, and fails again. The agent looks alive, logs a
   warning nobody is reading, and that company's backfill never moves. Batching
   by bytes as well as count is what keeps the request inside the limit no
   matter what the vouchers weigh.

2. A DEV URL IN A RELEASE. ``API_BASE_URL`` is baked into the exe and is
   deliberately NOT read from config.ini — repointing an agent at another server
   is not a feature. The price is that a wrong URL cannot be fixed in the field:
   every installed agent talks to an address that does not exist for it, and the
   only remedy is shipping a new exe to every customer. The value that makes
   local testing work is a LAN IP, so a LAN IP is what sits in the file most of
   the time — and when this guard was written, the comment above it said "LIVE
   build" while the value said 192.168.4.28.

Run: python -m unittest discover -s agent/tests
"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import build_exe  # noqa: E402
import sync_agent  # noqa: E402


class _Logger:
    def __init__(self):
        self.warnings = []

    def warning(self, msg, *a):
        self.warnings.append(msg % a if a else msg)

    def debug(self, *_a, **_k):
        pass

    def info(self, *_a, **_k):
        pass


def _voucher(guid, pad=0):
    """A voucher whose encoded size is roughly `pad` bytes."""
    return {"guid": guid, "narration": "x" * pad}


def _encoded(items):
    return len(json.dumps(items, default=str).encode("utf-8"))


class BatchSizingTests(unittest.TestCase):

    def test_small_items_batch_by_count(self):
        items = [_voucher(f"g{i}") for i in range(10)]
        out = sync_agent._size_batches(items, max_count=4, max_bytes=10_000_000)
        self.assertEqual([len(b) for b in out], [4, 4, 2])

    def test_large_items_batch_by_bytes_not_count(self):
        """The case that broke: the count limit is never reached."""
        items = [_voucher(f"g{i}", pad=10_000) for i in range(10)]
        out = sync_agent._size_batches(items, max_count=2000, max_bytes=30_000)
        self.assertGreater(len(out), 1, "must have split on size, not count")
        for b in out:
            self.assertLessEqual(_encoded(b), 40_000)

    def test_every_batch_stays_under_the_byte_limit(self):
        items = [_voucher(f"g{i}", pad=(i % 7) * 3000) for i in range(60)]
        limit = 50_000
        out = sync_agent._size_batches(items, max_count=2000, max_bytes=limit)
        for b in out:
            # A batch may exceed the limit ONLY when it is a single oversized item.
            if len(b) > 1:
                self.assertLessEqual(_encoded(b), limit + 5000)

    def test_nothing_is_dropped_and_order_is_kept(self):
        """A voucher we do not send is a voucher the cloud never has."""
        items = [_voucher(f"g{i}", pad=(i * 811) % 9000) for i in range(97)]
        out = sync_agent._size_batches(items, max_count=10, max_bytes=20_000)
        flat = [v for b in out for v in b]
        self.assertEqual(len(flat), 97)
        self.assertEqual([v["guid"] for v in flat], [v["guid"] for v in items])

    def test_an_oversized_item_is_sent_alone_not_skipped(self):
        items = [_voucher("small-1"), _voucher("huge", pad=200_000), _voucher("small-2")]
        out = sync_agent._size_batches(items, max_count=2000, max_bytes=50_000)
        flat = [v["guid"] for b in out for v in b]
        self.assertEqual(flat, ["small-1", "huge", "small-2"])
        # The huge one is on its own.
        for b in out:
            if any(v["guid"] == "huge" for v in b):
                self.assertEqual(len(b), 1)

    def test_an_oversized_item_is_logged(self):
        log = _Logger()
        sync_agent._size_batches([_voucher("fat", pad=3_000_000)],
                                 max_count=2000, max_bytes=8_000_000,
                                 huge_bytes=1_000_000, logger=log)
        self.assertEqual(len(log.warnings), 1)
        self.assertIn("fat", log.warnings[0])

    def test_empty_input_yields_no_batches(self):
        self.assertEqual(sync_agent._size_batches([], 2000, 8_000_000), [])

    def test_unencodable_item_does_not_raise(self):
        """json.dumps can fail on odd values; a measurement problem must not
        stop the send."""
        class Odd:
            def __repr__(self):
                raise RuntimeError("nope")
        out = sync_agent._size_batches([{"guid": "g", "x": Odd()}], 2000, 8_000_000)
        self.assertEqual(len(out), 1)
        self.assertEqual(len(out[0]), 1)

    def test_defaults_are_sane(self):
        self.assertLessEqual(sync_agent.VOUCHER_BATCH_BYTES, 50 * 1024 * 1024,
                             "must stay under the server's body limit")
        self.assertGreater(sync_agent.VOUCHER_BATCH_BYTES, 1024 * 1024)
        self.assertGreater(sync_agent.VOUCHER_BATCH, 0)


class ReleaseUrlGuardTests(unittest.TestCase):

    def _problems_with(self, api_url, ui_url):
        import constants
        orig = (constants.API_BASE_URL, constants.AGENT_UI_URL)
        constants.API_BASE_URL, constants.AGENT_UI_URL = api_url, ui_url
        try:
            return build_exe._baked_url_problems()
        finally:
            constants.API_BASE_URL, constants.AGENT_UI_URL = orig

    def test_a_production_https_url_passes(self):
        self.assertEqual(
            self._problems_with("https://app.example.com/api/v1",
                                "https://app.example.com/agent-app"), [])

    def test_lan_ip_is_refused(self):
        problems = self._problems_with("http://192.168.4.28:4500/api/v1",
                                       "https://app.example.com/agent-app")
        self.assertEqual(len(problems), 1)
        self.assertIn("192.168.4.28", problems[0])

    def test_every_private_range_is_refused(self):
        for host in ("localhost", "127.0.0.1", "10.0.0.5", "192.168.1.7",
                     "172.16.0.9", "172.31.255.1", "dev.local"):
            problems = self._problems_with(f"http://{host}:4500/api/v1",
                                           "https://app.example.com/agent-app")
            self.assertTrue(problems, f"{host} should have been refused")

    def test_a_public_ip_is_not_treated_as_private(self):
        """172.32.x is OUTSIDE the private range — the regex must not overreach."""
        self.assertEqual(
            self._problems_with("https://172.32.0.1/api/v1",
                                "https://172.32.0.1/agent-app"), [])

    def test_plain_http_to_a_public_host_is_refused(self):
        problems = self._problems_with("http://app.example.com/api/v1",
                                       "https://app.example.com/agent-app")
        self.assertEqual(len(problems), 1)
        self.assertIn("not https", problems[0])

    def test_empty_url_is_refused(self):
        problems = self._problems_with("", "https://app.example.com/agent-app")
        self.assertTrue(any("empty" in p for p in problems))

    def test_junk_url_is_refused_not_crashed_on(self):
        problems = self._problems_with("not-a-url", "https://app.example.com/agent-app")
        self.assertTrue(problems)

    def test_both_urls_are_checked(self):
        problems = self._problems_with("http://192.168.4.28:4500/api/v1",
                                       "http://192.168.4.28:4600/agent-app")
        self.assertEqual(len(problems), 2)


if __name__ == "__main__":
    unittest.main()
