"""Tests that _push_voucher refuses an unrecognised voucher_kind instead of
silently pushing it to Tally as a payment.

Run: python -m unittest discover -s agent/tests
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sync_agent import _push_voucher  # noqa: E402


class RecordingTally:
    """Stand-in TallyConnector that records any create_* call it receives."""

    def __init__(self):
        self.calls = []

    def _record(self, name):
        def _call(*args, **kwargs):
            self.calls.append(name)
            return "<ENVELOPE><CREATED>1</CREATED></ENVELOPE>"
        return _call

    def __getattr__(self, name):
        if name.startswith("create_"):
            return self._record(name)
        raise AttributeError(name)


def _voucher(kind, **extra):
    v = {"voucher_kind": kind, "record_type": "voucher", "id": 1,
         "company_id": 1, "party": "Acme", "date": "2026-08-06",
         "amount": 100}
    v.update(extra)
    return v


class TestUnknownVoucherKindIsRefused(unittest.TestCase):

    def test_an_unknown_voucher_kind_is_refused_not_treated_as_payment(self):
        """Previously an unknown kind silently became a payment -- i.e. the
        wrong voucher in the customer's books. It must not be created at all.
        """
        tally = RecordingTally()
        res = _push_voucher(tally, _voucher("quotation"))
        self.assertEqual(res["status"], "failed")
        self.assertEqual(tally.calls, [], "no Tally call should have been made")

    def test_the_refusal_names_the_kind_it_could_not_handle(self):
        """The reason must show the kind, so a missed branch is caught fast."""
        tally = RecordingTally()
        res = _push_voucher(tally, _voucher("sales_order"))
        self.assertIn("sales_order", res.get("message", ""))

    def test_the_five_known_kinds_still_go_to_their_own_builders(self):
        """sales, purchase, receipt, journal, payment -- all five unchanged."""
        expected = {
            "sales": "create_sales_voucher",
            "purchase": "create_purchase_voucher",
            "receipt": "create_receipt",
            "journal": "create_journal",
            "payment": "create_payment",
        }
        for kind, builder in expected.items():
            with self.subTest(kind=kind):
                tally = RecordingTally()
                extra = {}
                if kind == "journal":
                    extra = {"dr_ledger": "A", "cr_ledger": "B"}
                res = _push_voucher(tally, _voucher(kind, **extra))
                self.assertEqual(res["status"], "synced")
                self.assertIn(builder, tally.calls)


if __name__ == "__main__":
    unittest.main()
