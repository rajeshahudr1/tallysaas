"""Tests that the per-party outstanding report cannot eat the whole cycle.

WHAT WENT WRONG, LIVE. Tally has no "every party's bills in one call" export —
Ledger Outstandings is a PER-LEDGER report, one round trip per party. On a
company with 3,585 ledgers that ran longer than the sync interval itself, every
cycle. It also ran BEFORE the voucher pull, so the voucher pull was never
reached: the customer had every master mirrored, not one voucher, and an empty
voucher watermark proving the pull had never once completed.

It was invisible too. _send_once logs a distinct request label once per run, and
every party here carries the SAME label — so thousands of round trips printed
one line and then nothing, for as long as they took. That reads as a hung agent,
and was reported as one.

THE THREE RULES PINNED HERE.
  1. Vouchers are pulled BEFORE outstandings, so a slow report cannot starve
     them.
  2. Outstandings runs every OUTSTANDINGS_EVERY cycles, not every cycle — the
     first cycle of a run included, so a fresh install still gets the figure at
     once.
  3. outstandings() reports progress, so a long read is visibly a long read.

Run: python -m unittest discover -s agent/tests
"""

import inspect
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import sync_agent  # noqa: E402
from tally_connector import TallyConnector  # noqa: E402


class VouchersRunFirstTests(unittest.TestCase):
    """Rule 1 — source order, because the cost is paid in the order written."""

    def test_the_voucher_pull_is_reached_before_the_outstanding_report(self):
        src = inspect.getsource(sync_agent._pull_pass)
        vouchers_at = src.index("_pull_voucher_changes(")
        outstanding_at = src.index("_outstandings_due(")
        self.assertLess(
            vouchers_at, outstanding_at,
            "vouchers must be pulled before the per-party outstanding report; "
            "with the order reversed a large company never reaches them")


class OutstandingsCadenceTests(unittest.TestCase):
    """Rule 2 — periodic, but never skipped on the first cycle."""

    def setUp(self):
        sync_agent._outstandings_counter.clear()
        self.addCleanup(sync_agent._outstandings_counter.clear)

    def test_the_first_cycle_of_a_run_always_reads_it(self):
        self.assertTrue(sync_agent._outstandings_due("ACME"))

    def test_the_cycles_after_it_do_not(self):
        sync_agent._outstandings_due("ACME")                    # cycle 1
        for cycle in range(2, sync_agent.OUTSTANDINGS_EVERY + 1):
            self.assertFalse(sync_agent._outstandings_due("ACME"),
                             "cycle %d re-read the whole party list" % cycle)

    def test_it_comes_back_round_after_the_full_period(self):
        for _ in range(sync_agent.OUTSTANDINGS_EVERY):
            sync_agent._outstandings_due("ACME")
        self.assertTrue(sync_agent._outstandings_due("ACME"))

    def test_each_company_keeps_its_own_count(self):
        sync_agent._outstandings_due("ACME")
        self.assertTrue(sync_agent._outstandings_due("OTHER"),
                        "one company's cycle must not consume another's turn")


class _Connector(TallyConnector):
    """A connector whose per-ledger request is a no-op returning no bills."""

    def __init__(self, fail_on=()):
        super().__init__(url="http://localhost:9000")
        self.asked = []
        self._fail_on = set(fail_on)

    def _ledger_outstanding_xml(self, ledger, company, from_date, to_date):
        self.asked.append(ledger)
        if ledger in self._fail_on:
            raise ValueError("unreadable")
        return "<ENVELOPE/>"


class OutstandingsProgressTests(unittest.TestCase):
    """Rule 3 — a silent loop is indistinguishable from a hung one."""

    def _run(self, party_count, **kw):
        c = _Connector(**kw)
        seen = []
        c.outstandings(company="ACME",
                       ledgers=["P%d" % i for i in range(party_count)],
                       on_progress=lambda done, total: seen.append((done, total)))
        return c, seen

    def test_progress_is_reported_while_the_parties_are_read(self):
        every = TallyConnector.OUTSTANDING_PROGRESS_EVERY
        _, seen = self._run(every * 2)
        self.assertEqual(seen, [(every, every * 2), (every * 2, every * 2)])

    def test_the_last_report_names_the_true_total(self):
        every = TallyConnector.OUTSTANDING_PROGRESS_EVERY
        _, seen = self._run(every + 3)
        self.assertEqual(seen[-1], (every + 3, every + 3),
                         "the tail must be reported, so the log ends at N/N")

    def test_a_short_list_still_reports_once(self):
        _, seen = self._run(3)
        self.assertEqual(seen, [(3, 3)])

    def test_no_parties_reports_nothing(self):
        _, seen = self._run(0)
        self.assertEqual(seen, [])

    def test_a_progress_callback_that_raises_cannot_break_the_sync(self):
        c = _Connector()
        def boom(_done, _total):
            raise RuntimeError("the log handler blew up")
        res = c.outstandings(company="ACME", ledgers=["P%d" % i for i in range(5)],
                             on_progress=boom)
        self.assertEqual(res["rows"], [])
        self.assertEqual(len(c.asked), 5, "every party must still be read")

    def test_one_unreadable_party_does_not_cost_the_others(self):
        c, _ = self._run(5, fail_on=("P2",))
        self.assertEqual(len(c.asked), 5)

    def test_blank_party_names_are_not_asked_for(self):
        c = _Connector()
        c.outstandings(company="ACME", ledgers=["A", "", "   ", "B"])
        self.assertEqual(c.asked, ["A", "B"])


if __name__ == "__main__":
    unittest.main()
