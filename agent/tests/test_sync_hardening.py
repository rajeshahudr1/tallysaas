"""Tests for the sync-engine hardening: incremental masters, retry, gating.

The incremental filter and the reconcile scan look almost identical but must
behave in OPPOSITE ways, and getting that backwards is catastrophic rather than
merely slow: a reconcile that only saw *changed* masters would conclude every
unchanged master had been deleted in Tally and soft-delete the entire book. The
first two tests here exist to make that mistake impossible to land quietly.

Run: python -m unittest discover -s agent/tests
"""

import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import tally_connector as tc  # noqa: E402
from tally_connector import TallyConnector, TallyUnavailable  # noqa: E402


def recording_connector(response: str = "<ENVELOPE/>"):
    """A connector that records the XML it would send instead of sending it."""
    c = TallyConnector("http://localhost:9000")
    c.sent: list[str] = []
    c.send = lambda xml, timeout=None, retries=None: (c.sent.append(xml), response)[1]
    return c


COLLECTION_ID = re.compile(r"<ID>([^<]+)</ID>")


class TestIncrementalMasters(unittest.TestCase):
    BUILDERS = {
        "ledger": TallyConnector._ledger_collection_request_xml,
        "stock":  TallyConnector._stock_collection_request_xml,
        "godown": TallyConnector._godown_collection_request_xml,
        "group":  TallyConnector._group_collection_request_xml,
    }

    def test_watermark_adds_an_alterid_filter(self):
        for name, build in self.BUILDERS.items():
            with self.subTest(master=name):
                xml = build("ACME", 5000)
                self.assertIn("<FILTER>", xml)
                self.assertIn("$AlterID &gt; 5000", xml)

    def test_zero_watermark_fetches_everything(self):
        """First sync (and any cloud-side reset) must NOT filter."""
        for name, build in self.BUILDERS.items():
            with self.subTest(master=name):
                self.assertNotIn("<FILTER>", build("ACME", 0))

    def test_each_incremental_fetch_uses_a_fresh_collection_name(self):
        """Tally caches a TDL collection by NAME for the session. Reusing the
        name with a new filter value re-serves the PREVIOUS window's result, so
        the sync would silently stop seeing changes."""
        a = TallyConnector._ledger_collection_request_xml("ACME", 5000)
        b = TallyConnector._ledger_collection_request_xml("ACME", 6000)
        self.assertNotEqual(COLLECTION_ID.search(a).group(1),
                            COLLECTION_ID.search(b).group(1))

    def test_full_fetch_keeps_a_stable_name(self):
        """An unfiltered collection is cacheable, so it keeps its plain name."""
        a = TallyConnector._ledger_collection_request_xml("ACME", 0)
        b = TallyConnector._ledger_collection_request_xml("ACME", 0)
        self.assertEqual(COLLECTION_ID.search(a).group(1),
                         COLLECTION_ID.search(b).group(1))

    def test_registry_masters_filter_too(self):
        c = recording_connector()
        c.fetch_master("unit", company="ACME", after_alterid=7000)
        self.assertIn("$AlterID &gt; 7000", c.sent[-1])


class TestReconcileMustNeverFilter(unittest.TestCase):
    def test_reconcile_scan_is_always_a_full_scan(self):
        """THE critical invariant. master_ids() feeds delete detection: anything
        it fails to list is treated as deleted in Tally. Filtering it by AlterID
        would report only CHANGED masters, and the cloud would soft-delete every
        unchanged ledger, customer and product in the company."""
        c = recording_connector()
        for kind in ("ledger", "group", "stock_item", "godown", "unit", "cost_centre"):
            with self.subTest(kind=kind):
                c.sent.clear()
                c.master_ids(kind, company="ACME")
                self.assertNotIn("<FILTER>", c.sent[-1])
                self.assertNotIn("$AlterID", c.sent[-1])

    def test_reconcile_fetches_identity_only(self):
        """It runs over every master, so it must stay a small response."""
        c = recording_connector()
        c.master_ids("ledger", company="ACME")
        fetch = re.search(r"<FETCH>([^<]+)</FETCH>", c.sent[-1]).group(1)
        self.assertEqual(set(fetch.split(",")), {"NAME", "GUID", "MASTERID"})


class TestFeatureGating(unittest.TestCase):
    def test_disabled_feature_skips_the_request_entirely(self):
        c = recording_connector()
        rows = c.fetch_master("employee", company="ACME", features={"ISPAYROLLON": "No"})
        self.assertEqual(rows, [])
        self.assertEqual(len(c.sent), 0, "a disabled feature must cost no round trip")

    def test_enabled_feature_is_fetched(self):
        c = recording_connector()
        c.fetch_master("employee", company="ACME", features={"ISPAYROLLON": "Yes"})
        self.assertEqual(len(c.sent), 1)

    def test_absent_flag_still_fetches(self):
        """An absent flag means this Tally build did not report it. Guessing
        'off' would silently drop a master the company really does use."""
        c = recording_connector()
        c.fetch_master("employee", company="ACME", features={})
        self.assertEqual(len(c.sent), 1)


class TestSendRetry(unittest.TestCase):
    def setUp(self):
        self._backoff = tc.SEND_BACKOFF
        tc.SEND_BACKOFF = 0.0          # keep the suite fast

    def tearDown(self):
        tc.SEND_BACKOFF = self._backoff

    def test_recovers_from_a_transient_stall(self):
        """Tally stalls while the user opens a report; one blip must not cost
        the company its whole cycle."""
        c = TallyConnector("http://localhost:9000")
        calls = []

        def flaky(xml, timeout=None):
            calls.append(1)
            if len(calls) < 3:
                raise TallyUnavailable("stalled")
            return "<OK/>"

        c._send_once = flaky
        self.assertEqual(c.send("<X/>"), "<OK/>")
        self.assertEqual(len(calls), 3)

    def test_gives_up_after_the_configured_attempts(self):
        c = TallyConnector("http://localhost:9000")
        calls = []

        def always_down(xml, timeout=None):
            calls.append(1)
            raise TallyUnavailable("down")

        c._send_once = always_down
        with self.assertRaises(TallyUnavailable):
            c.send("<X/>")
        self.assertEqual(len(calls), tc.SEND_RETRIES + 1)

    def test_probe_does_not_retry(self):
        """is_available() answering 'no' fast IS the useful answer — the caller's
        next move is to start Tally, not to wait out the backoff."""
        c = TallyConnector("http://localhost:9000")
        calls = []

        def always_down(xml, timeout=None):
            calls.append(1)
            raise TallyUnavailable("down")

        c._send_once = always_down
        self.assertFalse(c.is_available())
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
