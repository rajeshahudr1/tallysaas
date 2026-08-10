"""Tests that DELETE DETECTION honours the same F11 gate as the master pull.

THE BUG THIS PINS, caught on the third verification run. fetch_master refuses to
ask a company for an object type it does not have — TDS masters on a company
without TDS, payroll masters without payroll — because asking does not return
empty, it takes TallyPrime down with "Incorrect Object Type!".

The reconcile pass walks the SAME registry to enumerate live ids for delete
detection, and asked for every kind unconditionally:

    19:04:19  Tally STOPPED ANSWERING (its error box is up) on
              [Collection TSSRecEmployeeGroup company=SHREE DEVPURI SALES]

on a company whose ISPAYROLLON is off — the exact request the gate on the master
side exists to prevent. Gating one caller and not the other means the crash
simply moves from the pull to the reconcile, once every RECONCILE_EVERY cycles,
which is harder to see and no less fatal.

Run: python -m unittest discover -s agent/tests
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import sync_agent                              # noqa: E402
from tally_connector import TallyConnector     # noqa: E402


class _Tally:
    def __init__(self):
        self.asked = []

    def master_ids(self, kind, company=None):
        self.asked.append(kind)
        return [{"master_id": "1", "guid": "g1", "name": "x"}]


class _Api:
    def reconcile_masters(self, *a, **kw):
        return {}

    def __getattr__(self, _name):               # any other endpoint: no-op
        return lambda *a, **kw: {}


class _Cfg:
    reconcile_every = 1
    path = ""


class _Logger:
    def __getattr__(self, _name):
        return lambda *a, **kw: None


class ReconcileGateTests(unittest.TestCase):

    def setUp(self):
        sync_agent._reconcile_counter.clear()
        self.tally = _Tally()

    def _run(self, features):
        sync_agent._reconcile_pass(_Cfg(), _Logger(), _Api(), self.tally,
                                   "tok", "ACME", features=features)

    def test_payroll_is_not_asked_for_when_the_flag_is_off(self):
        """The live failure: ISPAYROLLON off, TSSRecEmployeeGroup sent anyway."""
        self._run({"ISPAYROLLON": "No"})
        for kind in ("employee_group", "employee", "attendance_type", "pay_head"):
            self.assertNotIn(kind, self.tally.asked)

    def test_payroll_is_not_asked_for_when_the_flag_is_absent(self):
        """feature_must_be_on: silence means no, on this side of the fence too."""
        self._run({})
        for kind in ("employee_group", "employee", "attendance_type", "pay_head"):
            self.assertNotIn(kind, self.tally.asked)

    def test_tds_is_not_asked_for_without_the_flag(self):
        self._run({})
        self.assertNotIn("tds_category", self.tally.asked)
        self.assertNotIn("tcs_category", self.tally.asked)

    def test_ungated_masters_are_still_reconciled(self):
        """The protection must not switch delete detection off wholesale."""
        self._run({})
        self.assertIn("ledger", self.tally.asked)
        self.assertIn("group", self.tally.asked)

    def test_a_company_that_really_has_payroll_still_reconciles_it(self):
        """Gating is about absence, not about payroll being unwelcome."""
        self._run({"ISPAYROLLON": "Yes"})
        self.assertIn("employee", self.tally.asked)


class GateHelperTests(unittest.TestCase):
    """The gate itself, shared so the two callers cannot drift apart again."""

    def test_unknown_kinds_are_allowed(self):
        # 'ledger' and 'group' are not registry MasterSpecs; they must pass.
        self.assertTrue(TallyConnector.feature_allows("ledger", {}))

    def test_explicit_no_blocks(self):
        self.assertFalse(TallyConnector.feature_allows("gst_classification",
                                                       {"ISGSTON": "No"}))

    def test_absent_flag_allows_an_ordinary_gated_master(self):
        self.assertTrue(TallyConnector.feature_allows("gst_classification", {}))

    def test_absent_flag_blocks_a_must_be_on_master(self):
        self.assertFalse(TallyConnector.feature_allows("tds_category", {}))


if __name__ == "__main__":
    unittest.main()
