"""Tests for WHEN the Tally->Cloud pass uploads.

THE BUG THIS PINS. _pull_pass read everything Tally has, then posted it in one
call at the end. The last thing it read was Tally's bill-wise outstanding, which
is a PER-LEDGER report: one request per party ledger. On a real company — 3,586
ledgers, with a 0.12s throttle between requests — that phase alone runs for
fifteen to twenty-five minutes, and the upload sat behind ALL of it.

The consequence was not a slow sync, it was NO sync. Nothing reached the cloud
until the last ledger had answered, so anything that interrupted the pass
(Tally being closed, the app restarting, an error mid-phase) threw away the
whole cycle's work and the next cycle began again from nothing. On the machine
this was found on, the log covered forty minutes of cycles and contained not one
completed import.

The masters and reports are already in hand long before outstandings starts, so
the fix is ordering, not speed: post what we have, THEN spend twenty minutes
collecting bills, then post those separately. A cycle that dies halfway now
costs the outstanding snapshot instead of everything.

Run: python -m unittest discover -s agent/tests
"""

import logging
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import sync_agent  # noqa: E402


class _Cfg:
    """Just enough Config for _pull_pass."""

    sync_interval = 60
    agent_version = "test"

    def __init__(self):
        self.path = ""

    def get_token(self):
        return "tok"

    def save(self):
        pass


class _Tally:
    """A Tally that answers everything instantly and records the call order."""

    def __init__(self, order):
        self.order = order

    def company_info(self):
        return {"companies": [{"name": "ACME"}]}

    def company_full_info(self, company=None):
        return {"name": company, "features": {}}

    def ledger_list(self, *a, **kw):
        self.order.append("read:ledgers")
        return [{"name": "A Customer", "parent": "Sundry Debtors"}]

    def stock_summary(self, *a, **kw):
        return {"rows": []}

    def godown_list(self, *a, **kw):
        return []

    def group_list(self, *a, **kw):
        return []

    def fetch_all_masters(self, *a, **kw):
        return {}

    def financial_reports(self, *a, **kw):
        return {}

    def financial_reports_by_year(self, *a, **kw):
        return {}

    def extra_reports(self, *a, **kw):
        return {}

    def party_ledger_names(self, *a, **kw):
        return ["A Customer"]

    def outstandings(self, *a, **kw):
        # THE SLOW ONE. In production this is one request per ledger.
        self.order.append("read:outstandings")
        return {"rows": [{"party": "A Customer", "amount": 100, "side": "receivable"}],
                "failed": []}


class _Api:
    def __init__(self, order):
        self.order = order
        self.calls = []

    # Mirrors ApiClient.import_from_tally: everything after stock_items is
    # optional there, and the outstandings-only post relies on that.
    def import_from_tally(self, token, ledgers, stock, vouchers=None,
                          godowns=None, groups=None, company_master=None, **kw):
        self.order.append("upload")
        self.calls.append(kw)
        return {"company_id": 1, "master_alter_id": 0}


class PullOrderTests(unittest.TestCase):

    def setUp(self):
        # Outstandings is now read every OUTSTANDINGS_EVERY cycles (see
        # test_outstandings_does_not_starve_vouchers), and the counter is
        # module-level. Without this every test after the first would run a
        # cycle that legitimately skips the report and fail for the wrong reason.
        sync_agent._outstandings_counter.clear()
        self.addCleanup(sync_agent._outstandings_counter.clear)
        self.order = []
        self.tally = _Tally(self.order)
        self.api = _Api(self.order)
        self.log = logging.getLogger("test-pull")
        self.log.addHandler(logging.NullHandler())
        # The watermark helpers touch config files; neutralise them.
        for name in ("_save_master_watermark", "_load_master_watermark"):
            if hasattr(sync_agent, name):
                setattr(self, "_orig_" + name, getattr(sync_agent, name))
                self.addCleanup(setattr, sync_agent, name,
                                getattr(sync_agent, name))
        sync_agent._save_master_watermark = lambda *a, **kw: None
        sync_agent._load_master_watermark = lambda *a, **kw: 0

    def _run(self):
        sync_agent._pull_pass(_Cfg(), self.log, self.api, self.tally)

    def test_the_upload_happens_before_the_slow_outstandings_read(self):
        """The whole point: the cloud must not wait on a 20-minute report."""
        self._run()
        self.assertIn("upload", self.order, "nothing was uploaded at all")
        self.assertIn("read:outstandings", self.order)
        self.assertLess(self.order.index("upload"),
                        self.order.index("read:outstandings"),
                        "masters still sit behind outstandings: " + repr(self.order))

    def test_outstandings_still_reach_the_cloud(self):
        """Reordering must not quietly drop the bills."""
        self._run()
        sent = [c for c in self.api.calls if c.get("outstandings")]
        self.assertTrue(sent, "the outstanding snapshot was never uploaded")
        self.assertEqual(len(sent[0]["outstandings"]["rows"]), 1)

    def test_the_first_upload_carries_the_masters(self):
        """The early post is the real one, not an empty placeholder."""
        self._run()
        self.assertTrue(self.api.calls, "no upload happened")
        self.assertFalse(self.api.calls[0].get("outstandings"),
                         "the first post should not be waiting on bills")

    def test_a_quarantined_outstandings_report_does_not_kill_the_cycle(self):
        """TallySkipped means 'known to kill Tally, so we did not ask' — the
        ordinary, healthy case once the store has learned the request.

        It is a SUBCLASS of TallyUnavailable, so an `except TallyUnavailable:
        raise` catches it too. That is what happened live: the masters had just
        uploaded, then the skipped outstandings report threw all the way out of
        _pull_pass and ended the cycle with a traceback. Outstandings is the
        last thing the pass does; nothing there may undo what already worked.
        """
        from tally_connector import TallySkipped

        def skipped(*_a, **_kw):
            raise TallySkipped("Skipping [Data Ledger Outstandings]: known bad.")

        self.tally.outstandings = skipped
        self._run()                      # must not raise
        self.assertIn("upload", self.order, "the masters upload was lost")


if __name__ == "__main__":
    unittest.main()
