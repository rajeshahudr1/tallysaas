"""Tests that the expensive voucher sweep runs periodically, not every cycle.

WHAT WAS COSTING THE MACHINE. Every cycle read the complete {guid, alterid} list
for EVERY voucher type — 24 types over 11,038 vouchers on the company this was
measured on — whether or not a single voucher had changed. Timed from the live
log, one cycle:

    21:03:44  cycle starts, masters + reports done in ~4s
    21:03:48  first TSSVch id sweep
    21:06:xx  still sweeping

~2.5 minutes of the ~3 minute cycle, repeated every 60 seconds, so TallyPrime
was never idle and the Dashboard never stopped saying "Uploading". Nothing was
wrong — the same zero rows were fetched, compared and discarded each time.

WHY THE SWEEP EXISTS AT ALL, and why it is kept: a watermark walk only moves
forward, so a window skipped because Tally stalled is never revisited and the
sync quietly stays incomplete. Comparing full id lists finds those gaps however
old they are, and finds DELETES at the same time (voucher_ids' own docstring).
That argument is about it running SOMETIMES, not about it running every minute —
the reconcile pass makes exactly the same trade already.

So: the cheap AlterID-incremental pull every cycle, which is what actually
carries new and edited vouchers to the cloud promptly, and the full sweep every
VOUCHER_SWEEP_EVERY cycles to heal gaps and detect deletes.

Run: python -m unittest discover -s agent/tests
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import sync_agent  # noqa: E402


class VoucherSweepCadenceTests(unittest.TestCase):

    def setUp(self):
        self.calls = []
        sync_agent._voucher_sweep_counter.clear()

        self._sweep = sync_agent._pull_vouchers_by_type
        self._incr = sync_agent._pull_vouchers
        self.addCleanup(setattr, sync_agent, "_pull_vouchers_by_type", self._sweep)
        self.addCleanup(setattr, sync_agent, "_pull_vouchers", self._incr)

        sync_agent._pull_vouchers_by_type = lambda *a, **kw: self.calls.append("sweep") or 0
        sync_agent._pull_vouchers = lambda *a, **kw: self.calls.append("incremental") or 0

    def _cycle(self):
        sync_agent._pull_voucher_changes(None, _Logger(), None, None, "tok", "ACME")

    def test_the_first_cycle_sweeps(self):
        """A fresh install must not wait to find the history it has never seen."""
        self._cycle()
        self.assertIn("sweep", self.calls)

    def test_the_cycles_in_between_are_the_cheap_one(self):
        self._cycle()                       # the sweeping one
        self.calls.clear()
        self._cycle()
        self.assertEqual(self.calls, ["incremental"],
                         "an ordinary cycle must not re-read every voucher id")

    def test_the_sweep_comes_back_around(self):
        """Gap healing and delete detection must not be lost, only spaced out."""
        every = sync_agent.VOUCHER_SWEEP_EVERY
        for _ in range(every + 1):
            self._cycle()
        self.assertEqual(self.calls.count("sweep"), 2,
                         "expected one sweep at the start and one after "
                         + str(every) + " cycles: " + repr(self.calls))

    def test_no_cycle_is_ever_a_no_op(self):
        """Every cycle does one or the other — a cycle that looked for nothing
        would let a voucher sit unsynced for up to VOUCHER_SWEEP_EVERY minutes.
        (The sweeping cycle needs no incremental beside it: the sweep already
        covers everything the incremental would have found.)"""
        for _ in range(4):
            self._cycle()
        self.assertEqual(len(self.calls), 4, repr(self.calls))
        self.assertEqual(self.calls.count("incremental"), 3)
        self.assertEqual(self.calls.count("sweep"), 1)

    def test_the_cadence_is_per_company(self):
        """Two companies must not share a counter, or one starves the other."""
        sync_agent._pull_voucher_changes(None, _Logger(), None, None, "t", "A")
        sync_agent._pull_voucher_changes(None, _Logger(), None, None, "t", "B")
        self.assertEqual(self.calls.count("sweep"), 2)


class _Logger:
    def __getattr__(self, _name):
        return lambda *a, **kw: None


if __name__ == "__main__":
    unittest.main()
