"""Tests that a request known to kill Tally can only ever cost the cheapest thing.

THE PROBLEM THAT REMAINS AFTER THE GATE. The F11 gate stops us asking a company
for a feature it does not have. It cannot help when the company says it HAS the
feature and Tally still cannot serve it — which is exactly this customer: F11
reports ISTDSON=Yes, and TallyPrime EDU has no TDSCategory object. The first
cycle on a fresh machine therefore MUST meet the error box once; only the skip
store can prevent the second.

So the question is not "can we avoid it" but "what does it cost when it
happens". Measured on the live machine it cost everything:

    19:15:20  TSSMTDSCategory  — 120s stalled, then Tally down
    ...        every later step of the cycle fails against a dead Tally

Two things are pinned here, and together they make that one crash harmless:

  • The fragile masters are fetched LAST, after every ordinary master. A crash
    then costs only masters nobody could read anyway — and because the upload
    already runs before outstandings, the customer's data is in the cloud
    before the dangerous request is ever sent.

  • They get a SHORT timeout. These are tiny masters against small tables; one
    that has not answered in seconds is not busy, it is behind the modal box.
    Waiting the full two minutes only delays the rest of the cycle.

Run: python -m unittest discover -s agent/tests
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tally_schema import MASTERS               # noqa: E402
from tally_connector import TallyConnector     # noqa: E402


class FragileOrderingTests(unittest.TestCase):

    def test_every_fragile_master_is_fetched_after_every_ordinary_one(self):
        order = TallyConnector.master_fetch_order()
        kinds = [s.kind for s in order]
        self.assertEqual(sorted(kinds), sorted(s.kind for s in MASTERS),
                         "reordering must not drop or duplicate a master")

        fragile_at = [i for i, s in enumerate(order) if s.feature_must_be_on]
        safe_at = [i for i, s in enumerate(order) if not s.feature_must_be_on]
        self.assertTrue(fragile_at and safe_at, "the fixture assumes both exist")
        self.assertGreater(min(fragile_at), max(safe_at),
                           "a master that can kill Tally is being asked for "
                           "before ones that cannot: " + repr(kinds))

    def test_the_ordinary_masters_keep_their_registry_order(self):
        """Only the dangerous ones move. Everything else stays as registered —
        stock groups before stock items, and so on."""
        order = [s.kind for s in TallyConnector.master_fetch_order()
                 if not s.feature_must_be_on]
        registry = [s.kind for s in MASTERS if not s.feature_must_be_on]
        self.assertEqual(order, registry)


class FragileTimeoutTests(unittest.TestCase):

    def test_a_fragile_master_is_not_waited_on_for_two_minutes(self):
        self.assertLessEqual(TallyConnector.master_timeout("tds_category"), 20,
                             "a tiny master that has not answered in seconds is "
                             "behind the error box, not busy")

    def test_an_ordinary_master_keeps_the_generous_timeout(self):
        """Stock items on a real company genuinely take a while."""
        self.assertGreaterEqual(TallyConnector.master_timeout("stock_item_full"), 60)


if __name__ == "__main__":
    unittest.main()
